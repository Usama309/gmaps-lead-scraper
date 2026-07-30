import { CONFIG } from '../core/config.js';

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 110.574;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Plan the sub-centres for a circular search area.
 *
 * A single Google query is hard-capped at 247 results, so covering a real market
 * means firing the same keyword at several centres and merging on the dedupe key.
 * Tiles overlap deliberately: Google ranks by relevance to the query point, so a
 * business sitting between two centres would otherwise fall through the gap.
 *
 * Spacing is ABSOLUTE. An earlier version spaced tiles at a fraction of the
 * requested radius, which cancels the radius out of ceil(radius / spacing) and
 * pins the grid to a constant 9 tiles at every scale, so a 30 km search fired
 * exactly as many queries as a 6 km one and coverage density fell as 1/radius^2.
 *
 * Returns coverage metadata alongside the tiles, because hitting maxTiles shrinks
 * the area actually searched and the operator has to be told rather than handed a
 * short list that looks complete.
 */
export function planTiles({ lat, lng, radiusKm }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('planTiles requires finite coordinates');
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error('planTiles requires a positive radius');
  }

  const centre = { lat, lng };

  if (radiusKm <= CONFIG.tiling.minRadiusForTilingKm) {
    return {
      tiles: [centre],
      truncated: false,
      candidateCount: 1,
      requestedRadiusKm: radiusKm,
      effectiveRadiusKm: radiusKm,
    };
  }

  const spacingKm = CONFIG.tiling.spacingKm;
  const stepsPerSide = Math.ceil(radiusKm / spacingKm);
  const latStep = spacingKm / KM_PER_DEGREE_LAT;
  const lngStep = spacingKm / (KM_PER_DEGREE_LAT * Math.cos(toRad(lat)));

  const candidates = [];
  for (let i = -stepsPerSide; i <= stepsPerSide; i += 1) {
    for (let j = -stepsPerSide; j <= stepsPerSide; j += 1) {
      const tile = { lat: lat + i * latStep, lng: lng + j * lngStep };
      if (haversineKm(centre, tile) <= radiusKm) candidates.push(tile);
    }
  }

  // Nearest first, so truncation keeps the centre of the requested area rather
  // than an arbitrary slice of its edge.
  candidates.sort((a, b) => haversineKm(centre, a) - haversineKm(centre, b));

  const truncated = candidates.length > CONFIG.tiling.maxTiles;
  const tiles = candidates.slice(0, CONFIG.tiling.maxTiles);
  const effectiveRadiusKm = truncated
    ? haversineKm(centre, tiles[tiles.length - 1])
    : radiusKm;

  return {
    tiles,
    truncated,
    candidateCount: candidates.length,
    requestedRadiusKm: radiusKm,
    effectiveRadiusKm,
  };
}

/** Convenience wrapper for callers that do not need the coverage metadata. */
export function tileRadius(args) {
  return planTiles(args).tiles;
}
