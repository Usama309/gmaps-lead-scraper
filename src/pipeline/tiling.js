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
 * Split a circular search area into a square grid of sub-centres.
 *
 * Spacing is a fraction of the radius so neighbouring tiles overlap, which
 * matters because Google ranks by relevance to the query point and a business
 * sitting between two tile centres would otherwise fall through the gap.
 *
 * Tiles outside the circle are discarded, so the returned set is a disc, not a square.
 */
export function tileRadius({ lat, lng, radiusKm }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('tileRadius requires finite coordinates');
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error('tileRadius requires a positive radius');
  }

  const centre = { lat, lng };
  const spacingKm = radiusKm * CONFIG.tiling.spacingFactor;

  // A small area needs no tiling: one query already covers it, and firing nine
  // redundant queries would spend rate-limit budget for no extra results.
  // Compared against an absolute threshold, never against a fraction of the
  // radius itself, which would be a condition that can never be true.
  if (radiusKm <= CONFIG.tiling.minRadiusForTilingKm) return [centre];

  const stepsPerSide = Math.ceil(radiusKm / spacingKm);
  const latStep = spacingKm / KM_PER_DEGREE_LAT;
  const lngStep = spacingKm / (KM_PER_DEGREE_LAT * Math.cos(toRad(lat)));

  const tiles = [];
  for (let i = -stepsPerSide; i <= stepsPerSide; i += 1) {
    for (let j = -stepsPerSide; j <= stepsPerSide; j += 1) {
      const tile = { lat: lat + i * latStep, lng: lng + j * lngStep };
      if (haversineKm(centre, tile) <= radiusKm) tiles.push(tile);
    }
  }

  // Sort by distance from centre so the densest area is harvested first. If the
  // cap truncates the job, the operator still gets the most relevant results.
  tiles.sort((a, b) => haversineKm(centre, a) - haversineKm(centre, b));

  return tiles.slice(0, CONFIG.tiling.maxTiles);
}
