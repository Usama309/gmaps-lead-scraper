/**
 * Every tunable in the project. Nothing else may define a magic number.
 * Deep-frozen so a runtime mutation fails loudly instead of silently
 * changing behaviour halfway through a run.
 */
function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const CONFIG = deepFreeze({
  harvest: {
    // Measured against live Google Maps on 2026-07-29.
    pageSize: 20,
    perQueryCap: 247,
    // Randomised inter-request delay. Recon could not trigger a block at a far
    // higher rate, but the downside of being wrong is asymmetric.
    delayMs: { min: 1200, max: 2800 },
    maxParallel: 1,
    maxLegsPerRun: 60,
  },

  capture: {
    // How far the requested search area may sit from the captured search before the
    // panel refuses to start. A pb carries a session token bound to the search it came
    // from, and retargeting it across that kind of distance mixes the two markets:
    // measured, an Attock capture retargeted to Kansas City returned 67 genuine Kansas
    // City businesses and then Pakistani clinics 11,835 km away. Generous enough that
    // moving around one metropolitan area never trips it.
    maxDriftFromCaptureKm: 300,
  },

  tiling: {
    // Absolute distance between tile centres. This must NOT be a fraction of the
    // requested radius: ceil(radius / (radius * factor)) cancels the radius out,
    // pinning the grid to a constant size and making query density fall as
    // 1/radius^2. A query's real catch-area depends on business density around
    // the query point, not on how wide the operator drew the circle, so the
    // spacing that matters is absolute.
    // 6 km chosen against the UI's own 15 km default radius: it yields 21 tiles,
    // comfortably under maxTiles, so the common case never truncates. Tighter
    // spacing (3 km) tripled the query count for heavily overlapping coverage and
    // truncated the default search down to about 8 km.
    spacingKm: 6,
    // Hard ceiling on queries per run. Reaching it means the requested radius was
    // larger than maxTiles can cover, which is reported to the operator rather
    // than silently truncating coverage.
    maxTiles: 25,
    // Below this radius one query already covers the area, so skip tiling.
    minRadiusForTilingKm: 5,
  },

  guard: {
    validPrefix: ")]}'",
    blockedStatuses: [302, 429, 403, 503],
    latencyEwmaAlpha: 0.3,
    // Pause if smoothed latency exceeds this multiple of the baseline.
    latencyBreachMultiple: 4,
    // The baseline comes from this many opening samples, not from the first one.
    // A single unlucky slow request used to set it permanently and silently
    // disable the entire pressure signal.
    baselineSamples: 5,
    // Never let the baseline fall below this. One anomalously fast response (a
    // cached reply) would otherwise make ordinary latency look like a breach.
    baselineFloorMs: 200,
    // An absolute ceiling, so a high baseline cannot switch detection off
    // altogether. Recon saw 980 ms normally and 2.2 s under burst.
    absoluteLatencyCeilingMs: 15000,
    // Below this, latency variation is ordinary noise rather than pressure. Without
    // it, a leg whose first pages happened to be fast set a baseline near 160 ms and
    // then treated recon's own NORMAL 980 ms as a breach. Set above recon's observed
    // burst figure of 2.2 s and well above its 980 ms baseline, so a genuinely
    // degraded multi-second response still counts.
    latencyPressureFloorMs: 3000,
    // Consecutive breaching samples required before acting. One stalled request is
    // a hiccup; three in a row is a trend. The counter resets on any sample below
    // the floor, so a single spike cannot accumulate its way to a halt through a
    // slowly decaying average.
    consecutiveBreachesToHalt: 3,
  },

  /**
   * Google omits the review count entirely unless the request carries an anonymous
   * session cookie. Measured live on 2026-07-30, same pb, same context, back to
   * back: cookieless 5% coverage, cookie-bearing 95%. Nothing else in the record
   * changed, so this single field is the whole cost.
   *
   * `credentials: 'omit'` stays, because it is what guarantees Chrome attaches
   * nothing of its own. The cookie header is then rebuilt from this ALLOWLIST by a
   * declarativeNetRequest rule. An allowlist rather than a denylist is the point: a
   * Google ACCOUNT cookie cannot ride along even if Google ships a new cookie name
   * tomorrow, because anything not named here is simply never written.
   */
  // The one endpoint the harvester calls, and the one the cookie rule matches. Both
  // halves read it from here: two literals in two files decided whether the cookie
  // travelled at all, and changing either would have made the rule match nothing
  // while every test stayed green.
  googleSearchUrl: 'https://www.google.com/search',

  anonCookie: {
    // NID is Google's anonymous preferences cookie. It carries no account.
    allow: ['NID'],
    ruleId: 1,
    // A marker WE put on our own requests, and the only thing the rule matches on.
    //
    // Scoping by `tabIds: [-1]` alone was wrong. That value means "not associated
    // with a tab", which is a larger set than "sent by this worker": a website's own
    // service worker lands in it too, and google.com registers one. Since the rule
    // SETS the header rather than appending, a Google-originated service worker
    // request to /search would have gone out carrying only our cookie, with the
    // operator's real session stripped. Matching a marker only we ever write closes
    // that, because no request we did not build can carry it.
    marker: 'mpsrc',
    markerValue: '1',
    resourceTypes: ['xmlhttprequest', 'other'],
    // Kept as a second condition alongside the marker. Belt and braces: either one
    // alone would do, and neither costs anything.
    workerOnlyTabId: -1,
  },

  /**
   * The review pass: a second read over the RENDERED place panel, because owner
   * replies and review recency exist nowhere else. Confirmed on 2026-07-31 by
   * scanning every numeric leaf of a live search payload: no timestamps at all.
   *
   * This is the only stage that cannot use `credentials: 'omit'`, because a rendered
   * page needs a real session. It is therefore the one attributable thing the product
   * does, which is why it paces conservatively and stops dead on any block.
   */
  reviewPass: {
    // Measured live 2026-07-31: about 7 seconds of interaction plus 5 to 8 of page
    // load. Used to warn the operator what a run will cost BEFORE it starts, since
    // 500 leads is nearly two hours.
    secondsPerLead: 13,
    // A lead read this recently is not worth 13 seconds again. Review activity moves
    // on a scale of weeks, not hours.
    recheckAfterDays: 30,
    placeUrlPrefix: 'https://www.google.com/maps/place/?q=place_id:',
  },

  enrich: {
    domainCacheTtlDays: 30,
    maxExtraPages: 2,
    fetchTimeoutMs: 12000,
    // Measured live 2026-07-30: a client-rendered shell
    // (smilecraftbysohail.bolt.host) returned exactly 1 KB of markup for a page
    // whose real content only exists after JavaScript runs. Set well above that
    // and well below the smallest real page recon saw (19 KB), so a genuinely
    // terse static page is never mistaken for a shell we learned nothing from.
    minUsefulHtmlBytes: 2048,
    // Bounds how much of a response body enrichment ever holds in memory. Sized
    // generously above the largest real page recon measured (302 KB) so no real
    // prospect site ever hits it; it exists only so one huge or runaway response
    // cannot exhaust the worker.
    maxResponseBytes: 2 * 1024 * 1024,
  },

  export: {
    csvDelimiter: ',',
    csvNewline: '\r\n',
  },

  db: {
    name: 'mapprospector',
    version: 1,
  },
});
