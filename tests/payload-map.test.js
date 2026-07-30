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

test('CANARY_RULES marks name and cid as required, since they are the record identity', () => {
  const required = CANARY_RULES.fields.filter((f) => f.required).map((f) => f.field);
  assert.deepEqual(required.sort(), ['cid', 'name']);
  for (const rule of CANARY_RULES.fields) {
    assert.equal(typeof rule.valid, 'function', `${rule.field} needs a validator`);
    assert.ok(rule.why, `${rule.field} needs an explanation for the operator`);
  }
});
