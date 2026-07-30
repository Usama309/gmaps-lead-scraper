import { CONFIG } from '../core/config.js';
import { extractPage, runCanary } from './payload-map.js';
import { classifyTransport, classifyPage, nextDelayMs } from '../pipeline/guard.js';

const SEARCH_ENDPOINT = 'https://www.google.com/search';

/**
 * Substitute the result offset into a captured pb blob.
 *
 * The pb blob is opaque and long. We do not synthesise it: the Maps page builds a
 * valid one for its own request and a content script captures it. Only the offset
 * field `!8i<N>` needs changing to page through results.
 */
export function setPbOffset(pb, offset) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`setPbOffset requires a non-negative integer offset, got ${offset}`);
  }
  if (/!8i\d+/.test(pb)) return pb.replace(/!8i\d+/, `!8i${offset}`);
  return `${pb}!8i${offset}`;
}

/** Substitute the map centre and zoom into a captured pb blob. */
export function setPbCentre(pb, { lat, lng, zoom }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('setPbCentre requires finite coordinates');
  }
  let out = pb;
  out = /!2d-?[\d.]+/.test(out) ? out.replace(/!2d-?[\d.]+/, `!2d${lng}`) : `${out}!2d${lng}`;
  out = /!3d-?[\d.]+/.test(out) ? out.replace(/!3d-?[\d.]+/, `!3d${lat}`) : `${out}!3d${lat}`;
  if (Number.isFinite(zoom) && /!1d[\d.]+/.test(out)) {
    // pb encodes an extent rather than a zoom level; larger value means wider view.
    out = out.replace(/!1d[\d.]+/, `!1d${Math.round(2 ** (21 - zoom) * 0.6)}`);
  }
  return out;
}

/**
 * Default page fetcher. Kept separate so tests inject a fake and never hit the network.
 *
 * `credentials: 'omit'` is a binding requirement, not a default: it guarantees no
 * Google account is attached to any request, so there is no account to suspend.
 */
async function defaultFetchPage({ query, pb, signal }) {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('tbm', 'map');
  url.searchParams.set('authuser', '0');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('q', query);
  url.searchParams.set('pb', pb);

  const started = Date.now();
  const response = await fetch(url, { credentials: 'omit', signal });
  const body = await response.text();
  return { status: response.status, body, latencyMs: Date.now() - started };
}

function parseBody(body) {
  const newline = body.indexOf('\n');
  const json = newline === -1 ? body.slice(CONFIG.guard.validPrefix.length) : body.slice(newline + 1);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const googlePayloadSource = {
  id: 'google-payload',

  /**
   * Harvest one leg: a single query at a single map centre, paged to exhaustion
   * or to the 247 cap, whichever comes first.
   */
  async harvestLeg({
    query,
    pb,
    // Required, not optional. The canary's proximity check is the only thing that
    // catches a latitude/longitude swap, and it can only run with a point to
    // compare against. Defaulting these to null silently disabled it.
    lat,
    lng,
    onPage = () => {},
    signal = null,
    fetchPage = defaultFetchPage,
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('harvestLeg requires the queried lat and lng so the canary can verify record proximity');
    }

    const leads = [];
    let offset = 0;
    let canaryChecked = false;

    while (offset < CONFIG.harvest.perQueryCap) {
      if (signal?.aborted) return { leads, stopReason: 'aborted', problems: [] };

      const page = await fetchPage({ query, pb: setPbOffset(pb, offset), signal });
      const transport = classifyTransport(page);

      if (transport.state === 'blocked') {
        // Never retry through a block. Stop and let the operator decide.
        return { leads, stopReason: 'blocked', problems: [transport.reason] };
      }

      const parsed = parseBody(page.body);
      if (parsed === null) {
        return { leads, stopReason: 'blocked', problems: ['payload did not parse as JSON'] };
      }

      // Validate the index map against the very first real page, before trusting
      // 247 records' worth of extraction.
      if (!canaryChecked) {
        canaryChecked = true;
        // Passing the queried point enables the proximity check, which is the
        // only thing that catches a latitude/longitude swap.
        const canary = runCanary(parsed, { lat, lng });
        if (!canary.ok) {
          return { leads, stopReason: 'canary_failed', problems: canary.problems };
        }
      }

      const extracted = extractPage(parsed);
      const pageLeads = extracted.leads;
      const verdict = classifyPage({
        transport, recordCount: pageLeads.length, rawCount: extracted.rawCount,
      });

      if (verdict.state === 'end_of_list') {
        return { leads, stopReason: 'end_of_list', problems: [] };
      }

      if (verdict.state === 'extraction_failed') {
        return { leads, stopReason: 'canary_failed', problems: [verdict.reason] };
      }

      leads.push(...pageLeads);
      onPage({ offset, count: pageLeads.length, total: leads.length, latencyMs: page.latencyMs });

      offset += CONFIG.harvest.pageSize;
      if (offset < CONFIG.harvest.perQueryCap) await delay(nextDelayMs());
    }

    return { leads, stopReason: 'cap_reached', problems: [] };
  },
};
