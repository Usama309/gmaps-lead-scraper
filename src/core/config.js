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
  },

  enrich: {
    domainCacheTtlDays: 30,
    maxExtraPages: 2,
    fetchTimeoutMs: 12000,
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
