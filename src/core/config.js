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
    // Tile spacing as a fraction of the requested radius. 0.6 gives overlapping
    // coverage so businesses near a tile edge are not missed.
    spacingFactor: 0.6,
    maxTiles: 25,
    // Below this radius, one query already covers the area. Must be an absolute
    // distance: comparing the radius against a fraction of itself is a condition
    // that can never be true.
    minRadiusForTilingKm: 5,
  },

  guard: {
    validPrefix: ")]}'",
    blockedStatuses: [302, 429, 403, 503],
    latencyEwmaAlpha: 0.3,
    // Pause if smoothed latency exceeds this multiple of the first observed latency.
    latencyBreachMultiple: 4,
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
