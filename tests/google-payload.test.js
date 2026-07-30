import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSource } from '../src/sources/source.js';
import { setPbOffset, setPbCentre, googlePayloadSource } from '../src/sources/google-payload.js';

const PB = '!4m12!1m3!1d5000!2d72.342874!3d33.7609824!2m3!1f0!2f0!3f0!7i20!8i0!10b1';

test('setPbOffset replaces an existing offset field', () => {
  assert.match(setPbOffset(PB, 40), /!8i40!/);
  assert.doesNotMatch(setPbOffset(PB, 40), /!8i0!/);
});

test('setPbOffset appends the offset when the field is absent', () => {
  assert.match(setPbOffset('!7i20', 60), /!8i60/);
});

test('setPbOffset leaves the page size untouched', () => {
  assert.match(setPbOffset(PB, 100), /!7i20/);
});

test('setPbOffset rejects a negative or non-integer offset', () => {
  assert.throws(() => setPbOffset(PB, -1), /offset/i);
  assert.throws(() => setPbOffset(PB, 1.5), /offset/i);
});

test('setPbCentre substitutes latitude, longitude and zoom', () => {
  const out = setPbCentre(PB, { lat: 31.5204, lng: 74.3587, zoom: 12 });
  assert.match(out, /!2d74\.3587/);
  assert.match(out, /!3d31\.5204/);
});

test('setPbCentre rejects invalid coordinates', () => {
  assert.throws(() => setPbCentre(PB, { lat: null, lng: 74, zoom: 12 }), /coordinates/i);
});

test('googlePayloadSource conforms to the source interface', () => {
  assertSource(googlePayloadSource);
});

test('assertSource rejects an object missing harvestLeg', () => {
  assert.throws(() => assertSource({ id: 'x' }), /harvestLeg/);
});

test('assertSource rejects an object missing an id', () => {
  assert.throws(() => assertSource({ harvestLeg: () => {} }), /id/);
});

test('harvestLeg refuses to run without the queried coordinates', async () => {
  // Without a point to compare against, the canary cannot check proximity, and
  // proximity is the only thing that catches a latitude/longitude swap. Silently
  // defaulting to null disabled that protection.
  await assert.rejects(
    () => googlePayloadSource.harvestLeg({ query: 'dentist', pb: PB, fetchPage: async () => ({}) }),
    /lat and lng/i
  );
});

test('harvestLeg pages until end_of_list and returns accumulated leads', async () => {
  // Two full pages then an empty one. `fetchPage` is injected so this test
  // never touches the network.
  const pages = [
    { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) },
    { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) },
    { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(0)) },
  ];
  let call = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    lat: 33.7609824,
    lng: 72.342874,
    fetchPage: async () => pages[call++],
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'end_of_list');
  assert.equal(result.leads.length, 40);
  assert.equal(call, 3);
});

test('harvestLeg stops immediately on a block and reports it', async () => {
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    lat: 33.7609824,
    lng: 72.342874,
    fetchPage: async () => ({ status: 429, body: '' }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'blocked');
  assert.equal(result.leads.length, 0);
});

test('harvestLeg never retries through a block', async () => {
  let calls = 0;
  await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    lat: 33.7609824,
    lng: 72.342874,
    fetchPage: async () => { calls += 1; return { status: 429, body: '' }; },
    delay: async () => {},
  });
  assert.equal(calls, 1, 'a block must stop the leg on the first occurrence');
});

test('harvestLeg respects the per query cap', async () => {
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    lat: 33.7609824,
    lng: 72.342874,
    fetchPage: async () => ({ status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'cap_reached');
  assert.ok(result.leads.length <= 260, `runaway: ${result.leads.length}`);
});

test('harvestLeg treats total extraction failure as drift, not a finished leg', async () => {
  // Twenty records arrive, none has a derivable identity. Reading that as
  // end_of_list would report a completed search over a truncated list.
  const allBad = []; allBad[64] = Array.from({ length: 20 }, () => {
    const r = []; r[11] = 'Named But Unidentifiable';
    return [null, r];
  });
  let call = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    fetchPage: async () => {
      call += 1;
      return call === 1
        ? { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) }
        : { status: 200, body: ")]}'\n" + JSON.stringify(allBad) };
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'canary_failed');
  assert.ok(result.problems.some((p) => /drift/i.test(p)));
});

test('harvestLeg aborts when the canary fails on the first page', async () => {
  const drifted = []; drifted[64] = [[null, []]];
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    lat: 33.7609824,
    lng: 72.342874,
    fetchPage: async () => ({ status: 200, body: ")]}'\n" + JSON.stringify(drifted) }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'canary_failed');
  assert.ok(result.problems.length > 0);
});

/**
 * Build a payload carrying `count` records healthy enough to pass the canary.
 *
 * Every field the canary enforces has to be populated here: phone, coordinates,
 * categories, placeId and address all carry coverage floors, so a thinner fixture
 * would be rejected as drift. That is the canary working, not a nuisance, so the
 * fixture has to look like real data.
 */
function payloadWith(count) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const r = [];
    r[11] = `Business ${i}`;
    r[10] = `0xaaa${i.toString(16)}:0xbbb${i.toString(16)}`;
    r[4] = (() => { const a = []; a[7] = 4.2; a[8] = 50; return a; })();
    r[178] = [[`+92 57 261 ${(1000 + i).toString().padStart(4, '0')}`]];
    r[9] = (() => { const a = []; a[2] = 33.76 + i * 0.001; a[3] = 72.34 + i * 0.001; return a; })();
    r[13] = ['Dentist'];
    r[78] = `ChIJFakePlace${i}`;
    r[18] = `Street ${i}, Attock, Punjab`;
    records.push([null, r]);
  }
  const p = []; p[64] = records;
  return p;
}
