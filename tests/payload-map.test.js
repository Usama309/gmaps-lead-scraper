import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAYLOAD_MAP, PAYLOAD_MAP_VERSION, CANARY_RULES,
  extractRecord, extractPage, extractRecords, runCanary,
} from '../src/sources/payload-map.js';

const GOOD = JSON.parse(readFileSync(new URL('./fixtures/payload-record.json', import.meta.url), 'utf8'));
const firstRaw = GOOD[64][0][1];

/** Mutate every record's value at a mapped field path. */
function drift(field, value) {
  const copy = structuredClone(GOOD);
  const path = PAYLOAD_MAP.record[field];
  for (const entry of copy[64]) {
    let cursor = entry[PAYLOAD_MAP.recordWrapper];
    for (const index of path.slice(0, -1)) cursor = cursor[index];
    cursor[path[path.length - 1]] = value;
  }
  return copy;
}

test('the map declares a version so drift is traceable', () => {
  assert.match(PAYLOAD_MAP_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test('every mapped path is an array of indices', () => {
  for (const [field, path] of Object.entries(PAYLOAD_MAP.record)) {
    assert.ok(Array.isArray(path), `${field} path must be an array`);
    assert.ok(path.every((i) => Number.isInteger(i)), `${field} path must be all integers`);
  }
});

test('extractRecord pulls every field from the fixture', () => {
  const lead = extractRecord(firstRaw);
  assert.equal(lead.name, 'Al-Shifa Dental Clinic');
  assert.equal(lead.rating, 4.3);
  assert.equal(lead.reviewCount, 87);
  assert.deepEqual(lead.categories, ['Dentist', 'Dental clinic']);
  assert.equal(lead.phone, '+92 57 261 2201');
  assert.equal(lead.website, 'https://alshifadental.com.pk/');
  assert.equal(lead.domain, 'alshifadental.com.pk');
  assert.equal(lead.lat, 33.7621);
  assert.equal(lead.lng, 72.3489);
  assert.equal(lead.placeId, 'ChIJTestPlaceId0');
  assert.match(lead.cid, /^0x[0-9a-f]+:0x[0-9a-f]+$/);
  assert.equal(lead.address, 'Pleader Lane, Attock, Punjab');
  assert.equal(lead.provenance, 'google-payload');
});

test('extractRecord survives missing optional fields without inventing data', () => {
  const sparse = []; sparse[11] = 'Nameless Shop'; sparse[10] = '0x1:0x2';
  const lead = extractRecord(sparse);
  assert.equal(lead.name, 'Nameless Shop');
  assert.equal(lead.rating, null, 'a missing rating must be null, never 0');
  assert.equal(lead.reviewCount, null);
  assert.equal(lead.phone, null);
  assert.equal(lead.websiteTech, 'none');
});

test('extractPage reads all records and reports the raw count', () => {
  const page = extractPage(GOOD);
  assert.equal(page.leads.length, 8);
  assert.equal(page.rawCount, 8);
  assert.equal(page.skipped, 0);
});

test('extractPage distinguishes an empty container from records that all failed', () => {
  const empty = []; empty[64] = [];
  assert.deepEqual(extractPage(empty), { leads: [], rawCount: 0, skipped: 0 });

  // Eight records present, none with a derivable identity. This must NOT look
  // the same as an empty page, because the harvester reads an empty page as the
  // normal end of a leg and would report a completed search.
  const allBad = []; allBad[64] = Array.from({ length: 8 }, () => {
    const r = []; r[11] = 'Has A Name But No Identity';
    const entry = []; entry[PAYLOAD_MAP.recordWrapper] = r; return entry;
  });
  const page = extractPage(allBad);
  assert.equal(page.leads.length, 0);
  assert.equal(page.rawCount, 8, 'raw count must survive so total extraction failure is detectable');
  assert.equal(page.skipped, 8);
});

test('extractRecords stays available as a thin wrapper', () => {
  assert.equal(extractRecords(GOOD).length, 8);
  assert.deepEqual(extractRecords([]), []);
  assert.deepEqual(extractRecords(null), []);
});

test('canary passes on a good payload and judges coverage', () => {
  const result = runCanary(GOOD);
  assert.equal(result.ok, true, `unexpected problems: ${result.problems.join('; ')}`);
  assert.equal(result.sampled, 8);
  assert.equal(result.coverageJudged, true);
});

test('canary FAILS when the record container is missing entirely', () => {
  const { ok, problems } = runCanary({});
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /no records/i.test(p)));
});

test('canary FAILS when the name index has drifted to null', () => {
  const { ok, problems } = runCanary(drift('name', null));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /name/i.test(p)));
});

test('canary FAILS on a constant-offset shift that lands name on the CID', () => {
  // The subtle case: name is still a string, so a bare typeof check waves it
  // through. Only a format check catches it.
  const { ok, problems } = runCanary(drift('name', '0x38df9a1b2c3d4e5f:0x1234567890abcdef'));
  assert.equal(ok, false, 'a CID-shaped name means the indices shifted');
  assert.ok(problems.some((p) => /name/i.test(p)));
});

test('canary FAILS when the cid index lands on shared text, which would merge businesses', () => {
  const { ok, problems } = runCanary(drift('cid', 'Pleader Lane, Attock, Punjab'));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /cid/i.test(p)));
});

test('canary FAILS when the phone index is lost, the field the operator actually calls', () => {
  const { ok, problems } = runCanary(drift('phone', null));
  assert.equal(ok, false, 'total phone loss must not pass');
  assert.ok(problems.some((p) => /phone/i.test(p)));
});

test('canary FAILS when ratings stop being numeric', () => {
  const { ok, problems } = runCanary(drift('rating', 'four point three'));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /rating/i.test(p)));
});

test('canary FAILS when ratings go all-null, closing the empty-set escape hatch', () => {
  // An earlier version only validated non-null ratings, so a drift that nulled
  // every rating left nothing to check and reported healthy.
  const { ok, problems } = runCanary(drift('rating', null));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /rating/i.test(p)));
});

test('canary FAILS when coordinates drift out of valid range', () => {
  assert.equal(runCanary(drift('lat', 999)).ok, false);
  assert.equal(runCanary(drift('lng', 'seventy two')).ok, false);
});

test('canary FAILS when review counts stop being integers', () => {
  assert.equal(runCanary(drift('reviewCount', 'eighty seven')).ok, false);
});

test('a small sample skips coverage floors but still enforces identity fields', () => {
  const oneRecord = []; oneRecord[64] = [GOOD[64][0]];
  const healthy = runCanary(oneRecord);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.coverageJudged, false, 'one record is too few to judge a percentage');

  // Identity fields are still absolute, at any sample size.
  const broken = structuredClone(oneRecord);
  broken[64][0][PAYLOAD_MAP.recordWrapper][11] = null;
  assert.equal(runCanary(broken).ok, false, 'a missing name must fail even on one record');
});

test('CRITICAL GAP 1: total field loss is caught even below the coverage sample size', () => {
  // A four-record page skips coverage percentages, and an earlier version let a
  // complete wipeout of phone, rating, reviewCount, lat and lng report healthy.
  // A niche keyword in a small town legitimately returns four results, so this
  // window is reachable in normal use.
  const four = []; four[64] = GOOD[64].slice(0, 4).map((e) => structuredClone(e));
  for (const entry of four[64]) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    r[178] = null; r[4] = null; r[9] = null;
  }
  const result = runCanary(four);
  assert.equal(result.coverageJudged, false, 'four records is below the coverage threshold');
  assert.equal(result.ok, false, 'total loss must still abort at a small sample size');
  assert.ok(result.problems.some((p) => /ALL 4 records/.test(p)));
});

test('a single record is too noisy to judge total loss, and says so', () => {
  const one = []; one[64] = [structuredClone(GOOD[64][0])];
  one[64][0][PAYLOAD_MAP.recordWrapper][178] = null;
  const result = runCanary(one);
  assert.equal(result.ok, true, 'one business genuinely lacking a phone is not drift');
});

test('CRITICAL GAP 2: a lat/lng swap is caught by proximity to the queried point', () => {
  // Range checks cannot catch this: a longitude of 72 is a valid latitude, which
  // is true for most of the inhabited world.
  const swapped = structuredClone(GOOD);
  for (const entry of swapped[64]) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    const lat = r[9][2]; const lng = r[9][3];
    r[9][2] = lng; r[9][3] = lat;
  }
  const blind = runCanary(swapped);
  assert.equal(blind.proximityJudged, false, 'without a query point there is nothing to compare against');

  const seeing = runCanary(swapped, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(seeing.proximityJudged, true);
  assert.equal(seeing.ok, false, 'a coordinate swap must abort');
  assert.ok(seeing.problems.some((p) => /exchanged/i.test(p)),
    'the message should name the swap, not just report distance');
});

test('proximity passes when coordinates genuinely surround the queried point', () => {
  const result = runCanary(GOOD, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(result.ok, true, `unexpected problems: ${result.problems.join('; ')}`);
  assert.equal(result.proximityJudged, true);
});

test('CRITICAL GAP 3: a plausible string landing in name is caught by cross-field collision', () => {
  // The sharpest case. An address string in the name slot is non-empty and not a
  // CID, so every format check passes. Only comparing fields against each other
  // reveals the shift.
  const shifted = structuredClone(GOOD);
  for (const entry of shifted[64]) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    r[11] = r[18];
  }
  const { ok, problems } = runCanary(shifted);
  assert.equal(ok, false, 'name holding the address value means the indices shifted');
  assert.ok(problems.some((p) => /name.*address.*identical/i.test(p)));
});

test('the collision sweep catches a shift onto ANY mapped field, not an enumerated few', () => {
  // An earlier version listed name's forbidden twins explicitly, so a shift
  // landing name on the phone or the placeId evaded it entirely.
  for (const [label, index] of [['phone', 178], ['placeId', 78]]) {
    const shifted = structuredClone(GOOD);
    for (const entry of shifted[64]) {
      const r = entry[PAYLOAD_MAP.recordWrapper];
      r[11] = index === 178 ? r[178][0][0] : r[78];
    }
    const { ok } = runCanary(shifted);
    assert.equal(ok, false, `name holding the ${label} value must abort`);
  }
});

test('CRITICAL: a cid repeated across records aborts, since it would collapse every lead into one', () => {
  // cid is the primary dedupe key. Format and coverage both pass when every
  // record carries the SAME well-formed cid, and the export would show one row
  // where eight businesses existed.
  const collapsed = structuredClone(GOOD);
  for (const entry of collapsed[64]) {
    entry[PAYLOAD_MAP.recordWrapper][10] = '0xdeadbeef:0x11112222';
  }
  const { ok, problems } = runCanary(collapsed);
  assert.equal(ok, false, 'a repeated dedupe key must abort');
  assert.ok(problems.some((p) => /distinct/i.test(p)));
});

test('a partial lat/lng swap does not hide behind a majority rule', () => {
  const partial = structuredClone(GOOD);
  for (const entry of partial[64].slice(0, 3)) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    const lat = r[9][2]; const lng = r[9][3];
    r[9][2] = lng; r[9][3] = lat;
  }
  const { ok } = runCanary(partial, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(ok, false, 'three of eight records off-target is drift, not noise');
});

test('a field collision at a quarter of records aborts, closing the boundary gap', () => {
  // The previous threshold was a strict majority, so an exact 50 percent
  // collision passed. Genuine data essentially never collides at all.
  const quarter = structuredClone(GOOD);
  for (const entry of quarter[64].slice(0, 3)) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    r[11] = r[18];
  }
  assert.equal(runCanary(quarter).ok, false);
});

test('the phone coverage floor sits near its live baseline, not far below it', () => {
  // Measured 98% live. An earlier 50% floor meant a drift halving real coverage
  // on the field the operator dials raised no alarm.
  const phoneRule = CANARY_RULES.fields.find((f) => f.field === 'phone');
  assert.ok(phoneRule.minCoverage >= 0.75, `floor ${phoneRule.minCoverage} is too permissive`);

  const halfLost = structuredClone(GOOD);
  for (const entry of halfLost[64].slice(0, 4)) {
    entry[PAYLOAD_MAP.recordWrapper][178] = null;
  }
  assert.equal(runCanary(halfLost).ok, false, 'losing half the phones must abort');
});

test('categories, placeId and address are validated, since scoring and export depend on them', () => {
  for (const field of ['categories', 'placeId', 'address']) {
    assert.ok(CANARY_RULES.fields.some((f) => f.field === field), `${field} has no rule`);
  }
  // A categories drift silently blinds appointment detection in scoring and the
  // category filter, so it must not pass quietly.
  const broken = structuredClone(GOOD);
  for (const entry of broken[64]) entry[PAYLOAD_MAP.recordWrapper][13] = 'Dentist';
  assert.equal(runCanary(broken).ok, false, 'categories as a bare string must abort');
});

test('website has a canary rule requiring at least one valid record, but deliberately no coverage floor', () => {
  // Live coverage was 67% and a thin market could be lower, so a percentage
  // threshold here would cry wolf. But this field carries 40 of the 100 score
  // points and the flagship filter, so total loss must still abort.
  const websiteRule = CANARY_RULES.fields.find((f) => f.field === 'website');
  assert.ok(websiteRule, 'website has no rule');
  assert.equal(websiteRule.minAnyValid, true);
  assert.equal(websiteRule.minCoverage, undefined,
    'website coverage varies by market and must not have a floor');
});

test('canary FAILS when website is absent on every record, since it drives the largest score component', () => {
  const noWebsite = structuredClone(GOOD);
  for (const entry of noWebsite[64]) {
    entry[PAYLOAD_MAP.recordWrapper][7] = null;
  }
  const { ok, problems } = runCanary(noWebsite);
  assert.equal(ok, false, 'total website loss must not pass');
  assert.ok(problems.some((p) => /website/i.test(p)));
});

test('canary does not fail on thin website coverage, since a niche market can genuinely have few sites', () => {
  // Only one of eight records carries a website. There is deliberately no
  // coverage floor on this field, so sparse-but-nonzero coverage must not be
  // treated as drift.
  const thin = structuredClone(GOOD);
  for (const entry of thin[64].slice(1)) {
    entry[PAYLOAD_MAP.recordWrapper][7] = null;
  }
  const { ok, problems } = runCanary(thin);
  assert.equal(ok, true, `unexpected problems: ${problems.join('; ')}`);
});

test('a phone and placeId SWAP aborts, since both would otherwise look valid', () => {
  // The hardest class: two fields exchange values and each still passes a loose
  // validator. A digit-heavy place ID satisfied "has seven digits" and a phone
  // number satisfied "is a non-empty string", so the swap was invisible.
  const swapped = structuredClone(GOOD);
  for (const entry of swapped[64]) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    const phone = r[178][0][0];
    r[178][0][0] = r[78];
    r[78] = phone;
  }
  const { ok, problems } = runCanary(swapped, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(ok, false, 'a phone/placeId exchange must abort');
  assert.ok(problems.some((p) => /phone|placeId/i.test(p)));
});

test('a real rating and reviewCount swap aborts on the rating range check', () => {
  // With genuine values, exchanging the two puts a review count like 87 into the
  // rating slot, which the 0 to 5 range check rejects outright.
  const swapped = structuredClone(GOOD);
  for (const entry of swapped[64]) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    const rating = r[4][7];
    r[4][7] = r[4][8];
    r[4][8] = rating;
  }
  const { ok, problems } = runCanary(swapped, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /rating/i.test(p)));
});

test('a swap of small in-range values is still caught, by the integer check', () => {
  // The genuinely hard case: both fields stay numeric and stay inside their own
  // valid range, so no range check and no equality sweep can see it. What gives it
  // away is that real ratings are fractional, so a swap lands 4.5 in a slot that
  // must hold a whole number of reviews.
  const swapped = structuredClone(GOOD);
  for (const entry of swapped[64]) {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    const rating = r[4][7];
    r[4][7] = r[4][8] > 5 ? 4 : r[4][8]; // keep the rating slot in range
    r[4][8] = rating;                     // fractional rating into the count slot
  }
  const { ok, problems } = runCanary(swapped, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(ok, false, 'a fractional value in the reviewCount slot is a swap');
  assert.ok(problems.some((p) => /reviewCount/i.test(p)));
});

test('a market full of one-review businesses is harvested, not rejected', () => {
  // This is the case that halted the first live run. Live in Attock, 8 of 19 real
  // dentists carried a 5.0 rating with one to four reviews, and a per-record
  // ordering rule read every one of them as a swapped index and aborted the whole
  // harvest. Businesses with almost no reviews are the target market, not drift.
  //
  // The real page also carried established businesses, up to 209 reviews, which is
  // what makes the sample readable at all. That mix is reproduced here.
  const thin = structuredClone(GOOD);
  const ratings = [5, 5, 4.8, 5, 4.9];
  const counts = [1, 4, 209, 2, 96];
  thin[64].forEach((entry, i) => {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    r[4][7] = ratings[i % ratings.length];
    r[4][8] = counts[i % counts.length];
  });
  const { ok, problems } = runCanary(thin, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(ok, true, `a thin market must harvest, got: ${problems.join('; ')}`);
});

test('an unreadable page warns and keeps harvesting, it does not abort the run', () => {
  // Two earlier attempts at this were both wrong, in opposite directions, and the
  // second one was worse.
  //
  // Attempt one: a per-record `reviewCount >= rating` rule. Ratings cap at 5, so it
  // could only fire on businesses with four reviews or fewer, and it aborted the
  // first live run on real Attock dentists.
  //
  // Attempt two: refuse the page outright when every rating is whole and every count
  // is tiny. That reads as rigour and is actually far more damaging: `canary_failed`
  // is a HALTING reason, so a single six-record outer tile of a rural run killed the
  // entire sixty-leg job. Thin rural markets are what this product sells into.
  //
  // Ambiguity is not evidence of drift, it is the absence of evidence. It is
  // reported and harvesting continues.
  const build = (swap) => {
    const p = structuredClone(GOOD);
    const ratings = [5, 4, 3, 5, 4];
    const counts = [1, 2, 3, 4, 5];
    p[64].forEach((entry, i) => {
      const r = entry[PAYLOAD_MAP.recordWrapper];
      r[4][7] = swap ? counts[i % counts.length] : ratings[i % ratings.length];
      r[4][8] = swap ? ratings[i % ratings.length] : counts[i % counts.length];
    });
    return p;
  };
  for (const swap of [false, true]) {
    const result = runCanary(build(swap), { lat: 33.7609824, lng: 72.342874 });
    assert.equal(result.ok, true, `swap=${swap} must not halt the run`);
    assert.ok(result.warnings.some((w) => /cannot be told apart/i.test(w)),
      `swap=${swap} must still be reported: ${JSON.stringify(result.warnings)}`);
  }
});

test('a genuinely thin market is harvested without even a halt-worthy problem', () => {
  // The exact shape that aborted a sixty-leg run: a six-record outer tile of real
  // new listings.
  const thin = structuredClone(GOOD);
  thin[64] = thin[64].slice(0, 6);
  const ratings = [5, 5, 4, 5, 3, 5];
  const counts = [1, 2, 1, 4, 1, 3];
  thin[64].forEach((entry, i) => {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    r[4][7] = ratings[i]; r[4][8] = counts[i];
  });
  const { ok, problems } = runCanary(thin, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(ok, true, `a thin tile must not abort the job, got: ${problems.join('; ')}`);
});

test('a fractional value in the reviewCount slot is a PROBLEM, not merely a warning', () => {
  // This is what actually carries swap detection, and it must be verifiable on its
  // own. A previous version of this file claimed the integer check carried it while
  // the assertion only matched the string "reviewCount", which the ambiguity warning
  // also contains, so removing Number.isInteger left the suite green.
  const fractional = structuredClone(GOOD);
  fractional[64].forEach((entry, i) => {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    r[4][7] = 4.6;
    r[4][8] = i === 0 ? 4.3 : 40 + i; // one fractional count, sample otherwise readable
  });
  const { ok, problems } = runCanary(fractional, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(ok, false, 'a non-integer review count must stop the run');
  assert.ok(problems.some((p) => /wrong shape/i.test(p) && /reviewCount/.test(p)),
    `expected a shape problem naming reviewCount, got: ${problems.join('; ')}`);
});

test('a phone number is rejected in the placeId slot and vice versa', () => {
  const phoneAsPlaceId = structuredClone(GOOD);
  for (const entry of phoneAsPlaceId[64]) {
    entry[PAYLOAD_MAP.recordWrapper][78] = '+92 57 261 2201';
  }
  assert.equal(runCanary(phoneAsPlaceId).ok, false, 'a phone must not pass as a place ID');

  const placeIdAsPhone = structuredClone(GOOD);
  for (const entry of placeIdAsPhone[64]) {
    entry[PAYLOAD_MAP.recordWrapper][178][0][0] = 'ChIJ1234567890';
  }
  assert.equal(runCanary(placeIdAsPhone).ok, false, 'a place ID must not pass as a phone');
});

test('every canary threshold is a named number on CANARY_RULES, never an inline literal', () => {
  // All tunables belong in one place. A threshold was briefly written inline as
  // `paired.length * 0.9` while every sibling was named, so this asserts the whole
  // set rather than merely noting the drift.
  const thresholds = [
    'minRecordsToJudgeCoverage',
    'minRecordsToRequireAnyValid',
    'minRecordsNearQuery',
    'maxFieldCollisionRatio',
    'maxDistanceFromQueryKm',
  ];
  for (const key of thresholds) {
    assert.equal(typeof CANARY_RULES[key], 'number', `${key} must be a named number`);
    assert.ok(CANARY_RULES[key] > 0, `${key} must be positive`);
  }
});

test('CANARY_RULES marks name and cid as required, since they are the record identity', () => {
  const required = CANARY_RULES.fields.filter((f) => f.required).map((f) => f.field);
  assert.deepEqual(required.sort(), ['cid', 'name']);
  for (const rule of CANARY_RULES.fields) {
    assert.equal(typeof rule.valid, 'function', `${rule.field} needs a validator`);
    assert.ok(rule.why, `${rule.field} needs an explanation for the operator`);
  }
});

test('swapCeiling is pinned to the rating ceiling, in both directions', () => {
  // It is not a free tunable. It is the maximum a rating can be, and that is the
  // whole reason the ambiguity exists: a count at or below it could equally be a
  // rating. Raising it silently widens the warning to pages that are perfectly
  // readable; lowering it stops the warning firing at all. Only the range check's
  // own upper bound is correct here.
  const ratingRule = CANARY_RULES.fields.find((f) => f.field === 'rating');
  assert.equal(CANARY_RULES.swapCeiling, 5);
  assert.equal(ratingRule.valid(CANARY_RULES.swapCeiling), true, 'the ceiling must be a valid rating');
  assert.equal(ratingRule.valid(CANARY_RULES.swapCeiling + 0.1), false,
    'anything above the ceiling must fail the rating range check, which is what makes a swap visible');
});

test('the ambiguity warning is gated at the SMALL-page threshold, not the coverage one', () => {
  // Swapping this gate from 2 to 5 left the whole suite green while reintroducing
  // the four-record blind spot the file had already closed once for total field
  // loss. The gate is load-bearing, so it gets an assertion rather than a comment.
  const four = structuredClone(GOOD);
  four[64] = four[64].slice(0, 4);
  four[64].forEach((entry, i) => {
    const r = entry[PAYLOAD_MAP.recordWrapper];
    r[4][7] = [5, 4, 3, 5][i];
    r[4][8] = [1, 2, 3, 4][i];
  });
  const result = runCanary(four, { lat: 33.7609824, lng: 72.342874 });
  assert.equal(result.ok, true, 'still must not halt');
  assert.ok(result.warnings.some((w) => /cannot be told apart/i.test(w)),
    'a four-record page must still be reported as unreadable, not silently accepted');
});
