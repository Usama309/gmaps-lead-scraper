import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLegs, runHarvest } from '../src/pipeline/harvest.js';
import { makeLead } from '../src/core/schema.js';

const CENTRE = { lat: 33.7609824, lng: 72.342874, zoom: 14.98 };

test('planLegs multiplies keywords by tiles', () => {
  const { legs } = planLegs({ keywords: ['dentist', 'orthodontist'], ...CENTRE, radiusKm: 2 });
  assert.equal(legs.length, 2, 'one tile at 2 km, so one leg per keyword');
  assert.deepEqual(legs.map((l) => l.query), ['dentist', 'orthodontist']);
});

test('planLegs produces more legs for a larger radius', () => {
  const small = planLegs({ keywords: ['dentist'], ...CENTRE, radiusKm: 2 }).legs;
  const large = planLegs({ keywords: ['dentist'], ...CENTRE, radiusKm: 30 }).legs;
  assert.ok(large.length > small.length);
});

test('planLegs appends categories to the query text', () => {
  const { legs } = planLegs({ keywords: ['clinic'], categories: ['Dentist'], ...CENTRE, radiusKm: 2 });
  assert.match(legs[0].query, /clinic/);
  assert.match(legs[0].query, /Dentist/);
});

test('planLegs gives every leg a stable unique id', () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 30 });
  const ids = legs.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'leg ids must be unique');
  const again = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 30 }).legs;
  assert.deepEqual(again.map((l) => l.id), ids, 'leg ids must be stable across calls');
});

test('planLegs rejects an empty keyword list', () => {
  assert.throws(() => planLegs({ keywords: [], ...CENTRE, radiusKm: 5 }), /keyword/i);
});

test('planLegs caps total legs so a job cannot run away', () => {
  const { legs, coverage } = planLegs({
    keywords: ['a', 'b', 'c', 'd', 'e', 'f'], ...CENTRE, radiusKm: 500,
  });
  assert.ok(legs.length <= 60, `${legs.length} legs exceeds the cap`);
  assert.equal(coverage.tilesTruncated, true, 'a truncated tile plan must say so');
  assert.equal(coverage.legsTruncated, true, 'a truncated leg queue must say so');
});

/** A fake source that returns a fixed set of leads per leg. */
function fakeSource(perLeg, stopReason = 'end_of_list') {
  return {
    id: 'fake',
    async harvestLeg({ query }) {
      return {
        leads: perLeg.map((n) => makeLead({ cid: `0x${n}:0x${n}`, name: `B${n}`, phone: '+92 1' })),
        stopReason,
        problems: [],
      };
    },
  };
}

test('runHarvest merges legs and deduplicates across them', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 2 });
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    source: fakeSource([1, 2, 3]),
    delay: async () => {},
  });
  assert.equal(result.leads.length, 3, 'the same three businesses across two legs dedupe to three');
  assert.equal(result.completedLegs, 2);
  assert.equal(result.stopReason, 'completed');
});

test('runHarvest stops the whole job when a leg reports a block', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b', 'c'], ...CENTRE, radiusKm: 2 });
  let called = 0;
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    source: {
      id: 'fake',
      async harvestLeg() {
        called += 1;
        return { leads: [], stopReason: 'blocked', problems: ['HTTP 429'] };
      },
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'blocked');
  assert.equal(called, 1, 'a block must halt the queue, not continue to the next leg');
  assert.deepEqual(result.problems, ['HTTP 429']);
});

test('runHarvest stops the whole job when the canary fails', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 2 });
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    source: {
      id: 'fake',
      async harvestLeg() {
        return { leads: [], stopReason: 'canary_failed', problems: ['name index drifted'] };
      },
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'canary_failed');
});

test('a leg that throws does not discard leads from completed legs', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b', 'c'], ...CENTRE, radiusKm: 2 });
  let call = 0;
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    source: {
      id: 'fake',
      async harvestLeg() {
        call += 1;
        if (call === 1) {
          return { leads: [makeLead({ cid: '0x1:0x1', name: 'Survivor', phone: '+92 1' })],
            stopReason: 'end_of_list', problems: [] };
        }
        throw new Error('socket hang up');
      },
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'leg_threw');
  assert.equal(result.leads.length, 1, 'the completed leg must survive');
  assert.ok(result.problems.some((p) => /socket hang up/.test(p)));
});

test('runHarvest reports progress per leg', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 2 });
  const seen = [];
  await runHarvest({
    legs, pb: '!7i20!8i0',
    source: fakeSource([1, 2]),
    onProgress: (p) => seen.push(p),
    delay: async () => {},
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].legIndex, 1);
  assert.equal(seen[1].totalLegs, 2);
  assert.equal(seen[1].uniqueLeads, 2);
});

test('runHarvest resumes from startAt, skipping completed legs', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b', 'c'], ...CENTRE, radiusKm: 2 });
  const queried = [];
  await runHarvest({
    legs, pb: '!7i20!8i0', startAt: 2,
    source: {
      id: 'fake',
      async harvestLeg({ query }) {
        queried.push(query);
        return { leads: [], stopReason: 'end_of_list', problems: [] };
      },
    },
    delay: async () => {},
  });
  assert.deepEqual(queried, ['c'], 'only the third leg should run');
});

test('runHarvest honours an abort signal between legs', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b', 'c'], ...CENTRE, radiusKm: 2 });
  const controller = new AbortController();
  let called = 0;
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    signal: controller.signal,
    source: {
      id: 'fake',
      async harvestLeg() { called += 1; controller.abort(); return { leads: [], stopReason: 'end_of_list', problems: [] }; },
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(called, 1);
});
