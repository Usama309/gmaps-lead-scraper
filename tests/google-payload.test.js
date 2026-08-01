import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSource, assertStopReason, STOP_REASONS } from '../src/sources/source.js';
import { CONFIG } from '../src/core/config.js';
import { setPbOffset, setPbCentre, setPbQuery, pbOrigin, googlePayloadSource } from '../src/sources/google-payload.js';

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

test('setPbCentre substitutes latitude and longitude', () => {
  const out = setPbCentre(PB, { lat: 31.5204, lng: 74.3587 });
  assert.match(out, /!2d74\.3587/);
  assert.match(out, /!3d31\.5204/);
});

test('SETPBCENTRE LEAVES THE VIEWPORT EXTENT ALONE', () => {
  // An earlier version rewrote !1d from the zoom level as 2 ** (21 - zoom) * 0.6,
  // which at zoom 14 gives 77 against the 53071.8 a real 13z Maps view captures: out
  // by a factor of roughly seven hundred.
  //
  // Measured 2026-07-31, harvesting Kansas City from a pb captured in Attock. With
  // the extent left alone, 20 of 20 records came back within 250 km, all Kansas City.
  // With it rewritten to 77, only 14 did, and the other six were Attock businesses
  // 11,808 km away: a nonsensical extent made Google fall back toward whatever the pb
  // was originally captured for. That is precisely the failure that makes a location
  // feature look like it works and then harvest the wrong city.
  const captured = '!1sdentist!4m8!1m3!1d53071.80400987886!2d72.342874!3d33.7609824!7i20';
  const out = setPbCentre(captured, { lat: 39.0904394, lng: -94.9058341, zoom: 14 });
  assert.match(out, /!1d53071\.80400987886/, 'the captured extent must survive untouched');
  assert.match(out, /!2d-94\.9058341/, 'while the centre still moves');
  assert.match(out, /!3d39\.0904394/);
});

test('setPbCentre refuses coordinates it cannot use', () => {
  assert.throws(() => setPbCentre(PB, { lat: null, lng: 74 }), /coordinates/i);
});

test('googlePayloadSource conforms to the source interface', () => {
  assertSource(googlePayloadSource);
});

test('assertSource rejects an object missing harvestLeg', () => {
  assert.throws(() => assertSource({ id: 'x' }), /harvestLeg/);
});

test('assertStopReason rejects an unknown reason instead of letting it reach a caller', () => {
  // STOP_REASONS used to be documentation nothing checked. A typo would have
  // produced a reason no caller branches on, which falls through every branch and
  // reads as success.
  for (const reason of STOP_REASONS) {
    assert.equal(assertStopReason(reason), reason);
  }
  assert.throws(() => assertStopReason('blockd'), /unknown stopReason/);
  assert.throws(() => assertStopReason(undefined), /unknown stopReason/);
});

test('every stopReason harvestLeg can actually return is declared in STOP_REASONS', () => {
  // Guards the drift the doc comment already suffered: the array gained a reason
  // while the prose list did not. Reading the source keeps them from separating.
  const source = readFileSync(new URL('../src/sources/google-payload.js', import.meta.url), 'utf8');
  // Anchored on `return finish(` rather than `finish(` alone. The looser pattern
  // could not tell code from prose, so an illustrative mention in a comment would
  // have counted as a real exit, inflating the total and masking a deleted call.
  const returned = [...source.matchAll(/return finish\('([a-z_]+)'/g)].map((m) => m[1]);

  // The floor is load-bearing, not decoration. This scan is a regex, so if the
  // call shape ever changed it would match nothing and the assertion below would
  // pass vacuously over an empty list. Counting the calls is what stops a silent
  // no-op from reading as a clean result.
  const handBuilt = [...source.matchAll(/stopReason:\s*'/g)].length;
  assert.equal(handBuilt, 0, `${handBuilt} returns build stopReason by hand, bypassing validation`);
  assert.ok(returned.length >= 10,
    `expected every exit to route through finish(), found only ${returned.length}`);
  for (const reason of new Set(returned)) {
    assert.ok(STOP_REASONS.includes(reason), `${reason} is returned but not declared`);
  }
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

test('CRITICAL: a rejected fetch returns a result instead of throwing away the run', async () => {
  // The most common real failure. Every lead already collected lives in the
  // returned object, so a throw here would discard a completed page of work.
  let call = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    fetchPage: async () => {
      call += 1;
      if (call === 1) return { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) };
      throw new Error('network reset');
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'network_error');
  assert.equal(result.leads.length, 20, 'page one leads must survive a page two failure');
  assert.ok(result.problems.some((p) => /network reset/.test(p)));
});

test('CRITICAL: an abort mid-flight returns aborted and keeps what was harvested', async () => {
  // The Stop button. A real fetch rejects with AbortError while in flight, which
  // is the realistic case: checking the signal only between pages misses it.
  let call = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    fetchPage: async () => {
      call += 1;
      if (call === 1) return { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) };
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.leads.length, 20, 'stopping must not discard collected leads');
});

test('a pre-aborted signal stops before any request is made', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    signal: controller.signal,
    fetchPage: async () => { called += 1; return { status: 200, body: '' }; },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(called, 0);
});

test('a malformed response object classifies rather than throwing', async () => {
  for (const bad of [undefined, null, 'a string', 42]) {
    const result = await googlePayloadSource.harvestLeg({
      query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
      fetchPage: async () => bad,
      delay: async () => {},
    });
    assert.ok(['network_error', 'blocked'].includes(result.stopReason),
      `response ${JSON.stringify(bad)} produced ${result.stopReason}`);
    assert.equal(result.leads.length, 0);
  }
});

test('the cap counts RECORDS, not offsets, so it cannot overshoot', async () => {
  // Paging by 20 up to an offset of 247 admits 13 full pages, which is 260
  // records. The old code only honoured the cap because Google happens to
  // self-truncate its final page, which is an assumption about someone else's
  // server rather than a guarantee.
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    fetchPage: async () => ({ status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'cap_reached');
  assert.equal(result.leads.length, CONFIG.harvest.perQueryCap,
    `expected exactly ${CONFIG.harvest.perQueryCap} records, got ${result.leads.length}`);
});

test('harvestLeg stops paging once the cap is reached', async () => {
  let calls = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    lat: 33.7609824,
    lng: 72.342874,
    fetchPage: async () => {
      calls += 1;
      return { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) };
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'cap_reached');
  const expectedCalls = Math.ceil(CONFIG.harvest.perQueryCap / CONFIG.harvest.pageSize);
  assert.equal(calls, expectedCalls, `paged ${calls} times, expected ${expectedCalls}`);
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
    // Two thirds carry a website, matching the 67% measured live. The canary
    // requires at least one, since a total loss of this field would make every
    // business look like a perfect no-website lead.
    if (i % 3 !== 0) r[7] = [`https://business${i}.pk/`, `business${i}.pk`];
    records.push([null, r]);
  }
  const p = []; p[64] = records;
  return p;
}

/** Same page, but every rating whole and every count tiny: the unreadable case. */
function ambiguousPayload(count) {
  const p = payloadWith(count);
  p[64].forEach((entry, i) => {
    const r = entry[1];
    r[4][7] = [5, 4, 3][i % 3];
    r[4][8] = [1, 2, 3, 4][i % 4];
  });
  return p;
}

test('a page the canary cannot read yields a NOTICE, and the leg still succeeds', async () => {
  // This is the wiring, end to end, through the real source. Tests that injected a
  // fake source could not see it: deleting the line that collects canary warnings,
  // or dropping `notices` from the leg result, both left the whole suite green while
  // the observation silently stopped reaching the operator.
  let call = 0;
  const pages = [
    { status: 200, body: ")]}'\n" + JSON.stringify(ambiguousPayload(8)) },
    { status: 200, body: ")]}'\n" + JSON.stringify({ 64: [] }) },
  ];
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    fetchPage: async () => pages[Math.min(call++, pages.length - 1)],
    delay: async () => {},
  });

  assert.equal(result.stopReason, 'end_of_list', 'an unreadable page must not stop the leg');
  assert.equal(result.problems.length, 0, 'a notice is not a problem');
  assert.ok(result.notices.some((n) => /cannot be told apart/i.test(n)),
    `expected the ambiguity notice, got ${JSON.stringify(result.notices)}`);
  assert.ok(result.leads.length > 0, 'the leads are still harvested');
});

test('a readable page produces no notices at all', async () => {
  // Guards the other direction: a notice that fires on ordinary data is noise, and
  // noise on every run is how the real one gets ignored.
  let call = 0;
  const pages = [
    { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(8)) },
    { status: 200, body: ")]}'\n" + JSON.stringify({ 64: [] }) },
  ];
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    fetchPage: async () => pages[Math.min(call++, pages.length - 1)],
    delay: async () => {},
  });
  assert.deepEqual(result.notices, []);
});

test('every leg exit carries the notices it gathered, including a blocked one', async () => {
  // `finish` is called from a dozen sites. A notice gathered on page one must not be
  // lost because the leg later hit a block.
  let call = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB, lat: 33.7609824, lng: 72.342874,
    fetchPage: async () => (call++ === 0
      ? { status: 200, body: ")]}'\n" + JSON.stringify(ambiguousPayload(8)) }
      : { status: 429, body: '' }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'blocked');
  assert.ok(result.notices.some((n) => /cannot be told apart/i.test(n)),
    'a notice must survive an exit that happens later in the leg');
});

test('setPbQuery replaces the search term the pb was captured with', () => {
  // The pb opens with !1s<whatever the operator typed into Maps>, and Google reads
  // it. Leaving it while moving the coordinates harvests a mixture of the two places.
  const pb = '!1sdentist in Attock!4m8!1m3!1d53071.8!2d72.342874!3d33.7609824!7i20';
  const out = setPbQuery(pb, 'dental clinic');
  assert.match(out, /^!1sdental clinic!4m8/);
  assert.doesNotMatch(out, /Attock/, 'the old search term must be gone entirely');
});

test('setPbQuery leaves every other pb field untouched', () => {
  // The coordinates and the page size sit in the same blob, and a greedy replace
  // would eat them, which would look like a working search returning nothing.
  const pb = '!1sdentist in Attock!4m8!1m3!1d53071.8!2d72.342874!3d33.7609824!7i20!8i0';
  const out = setPbQuery(pb, 'gym');
  assert.match(out, /!2d72\.342874/);
  assert.match(out, /!3d33\.7609824/);
  assert.match(out, /!7i20/);
  assert.match(out, /!8i0/);
});

test('setPbQuery composes with setPbCentre, which is how a real leg is built', () => {
  // MEASURED 2026-07-31: a pb captured from "dentist in Attock", re-centred on Kansas
  // City but with its query left alone, returned only 14 of 20 records anywhere near
  // Kansas City. The proximity canary stopped the run, correctly, on a search that
  // was half in Punjab and half in Missouri. Both fields have to move together.
  const captured = '!1sdentist in Attock!4m8!1m3!1d53071.8!2d72.342874!3d33.7609824!7i20';
  const leg = setPbQuery(setPbCentre(captured, { lat: 39.0904394, lng: -94.9058341 }), 'dental clinic');
  assert.match(leg, /!1sdental clinic/);
  assert.match(leg, /!2d-94\.9058341/);
  assert.match(leg, /!3d39\.0904394/);
  assert.doesNotMatch(leg, /Attock/);
});

test('setPbQuery refuses an empty query rather than blanking the field', () => {
  assert.throws(() => setPbQuery('!1sx!7i20', ''), /non-empty/i);
  assert.throws(() => setPbQuery('!1sx!7i20', null), /non-empty/i);
});

test('pbOrigin reports where the captured search was centred', () => {
  // Used to warn before a run rather than let the canary abort halfway. A pb carries
  // a session token bound to its original search, so retargeting one across the world
  // returns real businesses from BOTH places, which is worse than failing because the
  // export looks full.
  const pb = '!1sdentist in Attock!4m8!1m3!1d53071.8!2d72.342874!3d33.7609824!7i20';
  assert.deepEqual(pbOrigin(pb), { lat: 33.7609824, lng: 72.342874 });
});

test('pbOrigin handles a western hemisphere capture', () => {
  assert.deepEqual(pbOrigin('!1sx!2d-94.9058341!3d39.0904394'), { lat: 39.0904394, lng: -94.9058341 });
});

test('pbOrigin returns null when there is no centre, which is not an error', () => {
  assert.equal(pbOrigin('!1sdentist!7i20'), null);
  assert.equal(pbOrigin(''), null);
  assert.equal(pbOrigin(null), null);
});

test('the drift threshold is generous enough not to trip inside one metro', () => {
  // Kansas City to its own outskirts is tens of km. The threshold exists to catch a
  // capture on the wrong CONTINENT, not to police a city.
  assert.ok(CONFIG.capture.maxDriftFromCaptureKm >= 100,
    'a threshold this tight would fire on normal use');
  const attockToKansasCity = 11800;
  assert.ok(CONFIG.capture.maxDriftFromCaptureKm < attockToKansasCity,
    'and it must still catch the case that produced a mixed list');
});
