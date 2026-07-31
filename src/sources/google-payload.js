import { CONFIG } from '../core/config.js';
import { assertStopReason } from './source.js';
import { extractPage, runCanary } from './payload-map.js';
import { classifyTransport, classifyPage, nextDelayMs, createLatencyWatch } from '../pipeline/guard.js';
import { markerParam } from './anon-cookie.js';



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
 *
 * You will nonetheless see a Cookie header on the wire, and it is not this line
 * failing. Google drops the review count from every record on a cookieless request,
 * so src/sources/anon-cookie.js writes the header back from an explicit allowlist of
 * account-free cookie names. Keeping `omit` here is what makes that an allowlist:
 * Chrome contributes nothing, so the only cookie that can travel is one we named.
 */
export function buildSearchUrl({ query, pb }) {
  const url = new URL(CONFIG.googleSearchUrl);
  url.searchParams.set('tbm', 'map');
  url.searchParams.set('authuser', '0');
  url.searchParams.set('hl', 'en');
  // The marker the cookie rule matches on. This is the ONLY line that writes it, and
  // it is what makes the rule's scope exact rather than "anything without a tab".
  // Exported, and tested against the rule that consumes it: deleting this line used
  // to leave the whole suite green while the cookie silently stopped travelling.
  const marker = markerParam();
  url.searchParams.set(marker.name, marker.value);
  url.searchParams.set('q', query);
  url.searchParams.set('pb', pb);
  return url;
}

async function defaultFetchPage({ query, pb, signal }) {
  const url = buildSearchUrl({ query, pb });

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

    // Things the canary could not confirm on a page, as opposed to things it found
    // wrong. These never stop the leg, but they must reach the operator, so every
    // exit carries them.
    const notices = [];

    // Wired, not decorative. This was hardened across three review rounds and then
    // had no callers, so only hard block detection was live. Sustained slowdown is
    // the earliest warning we get that we are pushing too hard, well before a 429.
    const latency = createLatencyWatch();

    // Single exit shape. Every return goes through here, so a mistyped reason
    // throws at the point of return instead of reaching a caller that branches on
    // it and silently falls through to treating the run as successful.
    //
    // Deliberately called as `return finish` with a string literal at every site.
    // The test that scans this file can only see literals anchored on a return, so
    // passing a variable would compile fine and silently escape that check.
    const finish = (stopReason, problems = []) => ({
      leads,
      stopReason: assertStopReason(stopReason),
      problems: [...notices, ...problems],
    });

    while (offset < CONFIG.harvest.perQueryCap) {
      if (signal?.aborted) return finish('aborted');

      // No OPERATIONAL failure may escape this loop as a throw. `leads` already
      // holds everything harvested so far, and a rejected fetch that escaped would
      // discard all of it. The two most common real-world failures both arrive as
      // rejections rather than responses: a flaky network, and the operator
      // pressing Stop while a request is in flight.
      //
      // Stated precisely because the distinction matters: finish() can still throw,
      // via assertStopReason, on a mistyped reason. That is a PROGRAMMING error and
      // should be loud during development. A network fault is an operational one and
      // must come back as data. Only the second category is caught here.
      let page;
      try {
        page = await fetchPage({ query, pb: setPbOffset(pb, offset), signal });
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
          return finish('aborted');
        }
        return finish('network_error', [
          `request failed at offset ${offset}: ${error?.message ?? String(error)}`,
        ]);
      }

      if (!page || typeof page !== 'object') {
        return finish('network_error', [
          `fetchPage returned ${page === null ? 'null' : typeof page} instead of a response`,
        ]);
      }

      const transport = classifyTransport(page);

      if (transport.state === 'blocked') {
        // Never retry through a block. Stop and let the operator decide.
        return finish('blocked', [transport.reason]);
      }

      const parsed = parseBody(page.body);
      if (parsed === null) {
        return finish('blocked', ['payload did not parse as JSON']);
      }

      // Validate the index map against the very first real page, before trusting
      // 247 records' worth of extraction.
      if (!canaryChecked) {
        canaryChecked = true;
        // Passing the queried point enables the proximity check, which is the
        // only thing that catches a latitude/longitude swap.
        const canary = runCanary(parsed, { lat, lng });
        if (!canary.ok) {
          return finish('canary_failed', canary.problems);
        }
        // Warnings do not stop the leg. They travel out with it, so a page the canary
        // could not fully read is reported to the operator rather than either halting
        // the job or vanishing.
        if (canary.warnings?.length) notices.push(...canary.warnings);
      }

      const extracted = extractPage(parsed);
      const pageLeads = extracted.leads;
      const verdict = classifyPage({
        transport, recordCount: pageLeads.length, rawCount: extracted.rawCount,
      });

      if (verdict.state === 'end_of_list') {
        return finish('end_of_list');
      }

      if (verdict.state === 'extraction_failed') {
        return finish('canary_failed', [
          `${verdict.reason} (${extracted.skipped} of ${extracted.rawCount} records were unusable)`,
        ]);
      }

      // Keep this page BEFORE deciding whether to stop. These records already cost a
      // request and a throttle delay, and discarding them on the way out would make
      // the safety signal itself lose data.
      leads.push(...pageLeads);

      if (Number.isFinite(page.latencyMs) && latency.observe(page.latencyMs)) {
        return finish('blocked', [
          `responses slowed sustainedly (last ${Math.round(page.latencyMs)}ms across `
          + `${CONFIG.guard.consecutiveBreachesToHalt} consecutive pages), which is the earliest `
          + 'sign of rate limiting. Stopping rather than pushing through.',
        ]);
      }

      // Enforce the cap on RECORDS, not on the offset. Paging by 20 up to an
      // offset of 247 admits 13 full pages, which is 260 records, so the cap was
      // only honoured because Google happens to self-truncate its last page. That
      // is an assumption about someone else's server, not a guarantee.
      if (leads.length >= CONFIG.harvest.perQueryCap) {
        leads.length = CONFIG.harvest.perQueryCap;
        onPage({ offset, count: pageLeads.length, total: leads.length, latencyMs: page.latencyMs });
        return finish('cap_reached');
      }

      onPage({ offset, count: pageLeads.length, total: leads.length, latencyMs: page.latencyMs });

      offset += CONFIG.harvest.pageSize;
      if (offset < CONFIG.harvest.perQueryCap) await delay(nextDelayMs());
    }

    return finish('cap_reached');
  },
};
