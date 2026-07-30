import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileRadius, haversineKm } from '../src/pipeline/tiling.js';
import { CONFIG } from '../src/core/config.js';

const ATTOCK = { lat: 33.7609824, lng: 72.342874 };

test('haversineKm returns zero for identical points', () => {
  assert.equal(haversineKm(ATTOCK, ATTOCK), 0);
});

test('haversineKm matches a known distance within one percent', () => {
  // Attock to Islamabad measures about 66 km great-circle.
  const islamabad = { lat: 33.6844, lng: 73.0479 };
  const d = haversineKm(ATTOCK, islamabad);
  assert.ok(d > 63 && d < 68, `unexpected distance: ${d}`);
});

test('a small radius produces a single tile at the centre', () => {
  const tiles = tileRadius({ ...ATTOCK, radiusKm: 2 });
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].lat, ATTOCK.lat);
  assert.equal(tiles[0].lng, ATTOCK.lng);
});

test('the tiling threshold is an absolute distance, not a fraction of the radius', () => {
  assert.equal(tileRadius({ ...ATTOCK, radiusKm: CONFIG.tiling.minRadiusForTilingKm }).length, 1);
  assert.ok(tileRadius({ ...ATTOCK, radiusKm: CONFIG.tiling.minRadiusForTilingKm + 25 }).length > 1);
});

test('a large radius produces multiple tiles', () => {
  const tiles = tileRadius({ ...ATTOCK, radiusKm: 30 });
  assert.ok(tiles.length > 1, 'a 30 km radius must be tiled');
});

test('the centre is always included as a tile', () => {
  const tiles = tileRadius({ ...ATTOCK, radiusKm: 50 });
  assert.ok(tiles.some((t) => t.lat === ATTOCK.lat && t.lng === ATTOCK.lng));
});

test('every tile lies inside the requested radius', () => {
  const radiusKm = 30;
  for (const tile of tileRadius({ ...ATTOCK, radiusKm })) {
    const d = haversineKm(ATTOCK, tile);
    assert.ok(d <= radiusKm + 0.001, `tile ${d} km out exceeds radius ${radiusKm}`);
  }
});

test('tiles overlap enough to cover the gaps between them', () => {
  const radiusKm = 30;
  const tiles = tileRadius({ ...ATTOCK, radiusKm });
  const spacing = CONFIG.tiling.spacingKm;
  // Nearest-neighbour distance must not exceed the spacing, or coverage has holes.
  for (const a of tiles) {
    const nearest = Math.min(...tiles.filter((b) => b !== a).map((b) => haversineKm(a, b)));
    assert.ok(nearest <= spacing * 1.5, `tile isolated by ${nearest} km`);
  }
});

test('tile count grows with radius, so coverage density does not collapse', () => {
  // Guards the bug this module shipped with once: spacing as a fraction of the
  // radius cancels the radius out, pinning the grid to 9 tiles at every scale.
  const small = planTiles({ ...ATTOCK, radiusKm: 8 }).candidateCount;
  const medium = planTiles({ ...ATTOCK, radiusKm: 20 }).candidateCount;
  const large = planTiles({ ...ATTOCK, radiusKm: 40 }).candidateCount;
  assert.ok(medium > small, `medium ${medium} must exceed small ${small}`);
  assert.ok(large > medium, `large ${large} must exceed medium ${medium}`);
});

test('the tile cap actually engages and is reported, never silent', () => {
  const plan = planTiles({ ...ATTOCK, radiusKm: 500 });
  assert.equal(plan.tiles.length, CONFIG.tiling.maxTiles, 'the cap must bind');
  assert.ok(plan.candidateCount > CONFIG.tiling.maxTiles, 'the cap must have something to cut');
  assert.equal(plan.truncated, true, 'truncation must be reported');
  assert.ok(plan.effectiveRadiusKm < plan.requestedRadiusKm,
    'a truncated plan covers less than was asked for and must say so');
});

test('an untruncated plan reports its full radius as effective', () => {
  const plan = planTiles({ ...ATTOCK, radiusKm: 8 });
  assert.equal(plan.truncated, false);
  assert.equal(plan.effectiveRadiusKm, plan.requestedRadiusKm);
});

test('tiling throws on invalid coordinates rather than emitting nonsense', () => {
  assert.throws(() => tileRadius({ lat: null, lng: 72, radiusKm: 10 }), /coordinates/i);
  assert.throws(() => tileRadius({ lat: 33, lng: 72, radiusKm: 0 }), /radius/i);
  assert.throws(() => tileRadius({ lat: 33, lng: 72, radiusKm: -5 }), /radius/i);
});
