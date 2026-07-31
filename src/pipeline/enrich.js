import { CONFIG } from '../core/config.js';
import {
  detectTech, detectChatbot, detectBooking, detectSocials, detectMobileFriendly,
} from '../core/fingerprints.js';

/**
 * Addresses that match a naive email regex but are not a way to reach the
 * business. Checked with `includes` for tracking-vendor domains (the address is
 * a generated ID somewhere inside a longer string, e.g. a Sentry DSN) and with
 * `endsWith` for file extensions (an asset filename like `logo@2x.png` parses as
 * a syntactically valid address under the same regex that finds real ones).
 */
const EMAIL_NOISE_CONTAINS = ['sentry.io', 'sentry-cdn.com', 'wixpress.com', 'example.com', 'godaddy.com'];
const EMAIL_NOISE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'];

function isNoiseEmail(candidate) {
  const lower = candidate.toLowerCase();
  return EMAIL_NOISE_CONTAINS.some((noise) => lower.includes(noise))
    || EMAIL_NOISE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const EMAIL_TEXT_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * `mailto:` first, since a link is a deliberate "email us" signal rather than a
 * regex guessing at plain text. The query string (`?subject=`, `?body=`) is cut
 * because it is form-prefill data, not part of the address. Falls back to a
 * text-level scan for sites that print an address without wrapping it in a link,
 * then rejects anything that looks like tracking-vendor noise or an image
 * filename before accepting the first genuine candidate.
 */
function extractEmail(html) {
  const candidates = [];
  const mailto = html.match(/href=["']mailto:([^"'?]+)/i);
  if (mailto) candidates.push(mailto[1].trim());
  candidates.push(...(html.match(EMAIL_TEXT_RE) ?? []));

  for (const candidate of candidates) {
    if (candidate && !isNoiseEmail(candidate)) return candidate;
  }
  return null;
}

/** First anchor href whose value contains `keyword`, in document order. */
function findLinkContaining(html, keyword) {
  const linkRe = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
  let match;
  while ((match = linkRe.exec(html))) {
    if (match[1].toLowerCase().includes(keyword)) return match[1];
  }
  return null;
}

/**
 * Same-origin /contact then /about candidates found in the homepage markup,
 * capped at `maxExtraPages`. Off-origin links are dropped rather than followed:
 * a prospect's own "Contact us" link can point anywhere (a booking platform, a
 * CRM form, a joke), and following arbitrary links off their site is not
 * something this tool does. `new URL(href, base)` also rejects `mailto:` and
 * `tel:` hrefs that happen to contain the keyword, since neither shares the
 * page's origin.
 */
function findSameOriginCandidates(html, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const candidates = [];
  for (const keyword of ['contact', 'about']) {
    const href = findLinkContaining(html, keyword);
    if (!href) continue;
    let resolved;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.origin !== base.origin) continue;
    candidates.push(resolved.href);
  }
  return candidates.slice(0, CONFIG.enrich.maxExtraPages);
}

/**
 * Scan raw HTML text for every website-intel signal. PURE: no network, no DOM.
 * `DOMParser` and `document` are both unavailable in the MV3 service worker, and
 * every signal here is a substring of the raw markup anyway, which is what
 * tech-detection tools match on.
 *
 * A response can be too small to mean anything: a client-rendered single-page
 * app returns HTTP 200 with a near-empty shell whose real content only exists
 * after JavaScript runs. Reporting `hasBooking: false` there would be a
 * confident false negative in the expensive direction, since a client-rendered
 * build is exactly the kind of modern site that DOES tend to carry a booking
 * widget. Below `minUsefulHtmlBytes`, those signals stay `null` (never
 * inspected) and `enriched` stays `false`, so the lead stays provisional instead
 * of being told a fact nobody established.
 *
 * `websiteTech`, `email` and `socials` are not gated by the size check. A script
 * `src` or a generator meta tag can survive in even a tiny shell, and a `mailto:`
 * link or a printed address is read directly off the markup rather than inferred
 * from how much of it there is, so a minimal page can still hand over a real
 * contact route even though it says nothing about booking or chat widgets.
 */
export function scanHtml(html) {
  const text = html ?? '';
  const bytes = new TextEncoder().encode(text).length;
  const readable = bytes >= CONFIG.enrich.minUsefulHtmlBytes;

  return {
    enriched: readable,
    websiteTech: detectTech(text),
    mobileFriendly: readable ? detectMobileFriendly(text) : null,
    hasBooking: readable ? detectBooking(text) : null,
    hasChatbot: readable ? detectChatbot(text) : null,
    email: extractEmail(text),
    socials: detectSocials(text),
  };
}

/**
 * A domain that could not be reached at all: DNS failure, connection refused, or
 * our own timeout firing. This is a 35-point SCORING SIGNAL (see
 * scoring-config.js), not an error, so `enriched` is `true`.
 */
function deadPatch() {
  return {
    enriched: true, websiteTech: 'dead',
    mobileFriendly: null, hasBooking: null, hasChatbot: null, email: null, socials: [],
  };
}

/**
 * A fetch failed for a reason that is neither "the site is down" nor "the site
 * responded". Recording this as `dead` would permanently brand a live business a
 * 35-point lead over a fault that has nothing to do with its website, so nothing
 * is recorded at all: `websiteTech` stays `null` (unchanged) and `enriched`
 * stays `false`, leaving the lead exactly as provisional as before this attempt.
 */
function unexplainedPatch() {
  return {
    enriched: false, websiteTech: null,
    mobileFriendly: null, hasBooking: null, hasChatbot: null, email: null, socials: [],
  };
}

// What fetch() throws for a network-level failure (DNS, connection refused,
// offline) and what AbortSignal.timeout produces when it fires, verified live in
// Node: `fetch()` rejects with `TypeError` for the former and `TimeoutError` for
// the latter. Anything else is not one of those two known-shape failures.
const NETWORK_FAILURE_NAMES = new Set(['TypeError', 'TimeoutError', 'AbortError']);

async function fetchExtraPage(url, fetchPage) {
  try {
    const response = await fetchPage({ url, signal: AbortSignal.timeout(CONFIG.enrich.fetchTimeoutMs) });
    if (!response || response.status >= 400) return null;
    return response.body ?? '';
  } catch {
    // Best effort. A broken /contact page must not fail the whole lead: the
    // homepage already settled enriched/websiteTech, this is only chasing email.
    return null;
  }
}

/**
 * Email is the one signal that may need more than the homepage. Follows at most
 * `CONFIG.enrich.maxExtraPages` same-origin candidates, `/contact` then
 * `/about`, and only ever called when the homepage yielded no address.
 */
async function findEmailOnExtraPages({ homepageHtml, baseUrl, fetchPage }) {
  const candidates = findSameOriginCandidates(homepageHtml, baseUrl);
  for (const url of candidates) {
    const body = await fetchExtraPage(url, fetchPage);
    if (body === null) continue;
    const email = extractEmail(body);
    if (email) return email;
  }
  return null;
}

/**
 * Read at most `maxResponseBytes` off the response stream. `response.text()`
 * would buffer the WHOLE body before anything could be trimmed, so a huge or
 * runaway response would already have exhausted the worker by the time a
 * post-hoc slice ran. Reading chunk by chunk and stopping once the cap is
 * reached is what actually bounds memory, rather than just bounding what
 * scanHtml later sees.
 */
async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return (await response.text()).slice(0, CONFIG.enrich.maxResponseBytes);

  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  while (bytesRead < CONFIG.enrich.maxResponseBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

async function defaultFetchPage({ url, signal }) {
  // `credentials: 'omit'` is binding, not a default: we are not logged in to a
  // prospect's website and must never appear to be.
  const response = await fetch(url, { credentials: 'omit', signal });
  return { status: response.status, body: await readCapped(response) };
}

/**
 * Fetch and classify one lead's website. Owns fetching, timeouts and failure
 * classification only; every actual signal comes from `scanHtml`, which this
 * calls with the response body.
 *
 * `fetchPage` is injected so no test here ever hits the network.
 */
export async function enrichOne({ lead, fetchPage = defaultFetchPage }) {
  let response;
  try {
    response = await fetchPage({
      url: lead.website,
      signal: AbortSignal.timeout(CONFIG.enrich.fetchTimeoutMs),
    });
  } catch (error) {
    return NETWORK_FAILURE_NAMES.has(error?.name) ? deadPatch() : unexplainedPatch();
  }

  if (!response || typeof response.status !== 'number' || response.status >= 400) {
    return deadPatch();
  }

  const homepageHtml = response.body ?? '';
  const patch = scanHtml(homepageHtml);

  // The only gate is "no address yet", not "the homepage was fully readable": a
  // shell homepage still names a /contact link in its own minimal markup, and
  // that page may not be client-rendered even when the homepage is.
  if (patch.email === null) {
    patch.email = await findEmailOnExtraPages({ homepageHtml, baseUrl: lead.website, fetchPage });
  }

  return patch;
}

/**
 * Enrich a batch of leads. Only leads with a real website are attempted: a lead
 * already known to have none, or only a Facebook page, has nothing to fetch.
 *
 * Sequential and abortable: `signal` is checked between leads (not mid-fetch,
 * since enrichOne owns its own per-request timeout), and whatever has already
 * been enriched when the signal fires is returned rather than discarded.
 */
export async function enrichLeads({ leads, fetchPage, now = Date.now, signal = null, onProgress = () => {} }) {
  const candidates = leads.filter((lead) => lead.hasRealWebsite && lead.website);

  const patches = [];
  const stats = {
    total: leads.length,
    candidates: candidates.length,
    enriched: 0,
    dead: 0,
    unresolved: 0,
    startedAt: new Date(now()).toISOString(),
  };

  for (const lead of candidates) {
    if (signal?.aborted) break;

    const patch = await enrichOne({ lead, fetchPage });
    patches.push({ key: lead.key, ...patch });

    if (patch.websiteTech === 'dead') stats.dead += 1;
    else if (patch.enriched) stats.enriched += 1;
    else stats.unresolved += 1;

    onProgress({ lead, patch, done: patches.length, total: candidates.length });
  }

  stats.finishedAt = new Date(now()).toISOString();
  return { patches, stats };
}
