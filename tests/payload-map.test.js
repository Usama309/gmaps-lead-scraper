import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAYLOAD_MAP, PAYLOAD_MAP_VERSION, extractRecord, extractRecords, runCanary,
} from '../src/sources/payload-map.js';

const payload = JSON.parse(readFileSync(new URL('./fixtures/payload-record.json', import.meta.url), 'utf8'));
const rawRecord = payload[64][0][1];

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
  const lead = extractRecord(rawRecord);
  assert.equal(lead.name, 'Al-Shifa Dental Clinic');
  assert.equal(lead.rating, 4.3);
  assert.equal(lead.reviewCount, 87);
  assert.deepEqual(lead.categories, ['Dentist', 'Dental clinic']);
  assert.equal(lead.phone, '+92 57 261 2201');
  assert.equal(lead.website, 'https://alshifadental.com.pk/');
  assert.equal(lead.domain, 'alshifadental.com.pk');
  assert.equal(lead.lat, 33.7621);
  assert.equal(lead.lng, 72.3489);
  assert.equal(lead.placeId, 'ChIJTestPlaceId');
  assert.equal(lead.cid, '0x38df9a1b2c3d4e5f:0x1234567890abcdef');
  assert.equal(lead.address, 'Pleader Lane, Attock, Punjab');
  assert.equal(lead.provenance, 'google-payload');
});

test('extractRecord survives missing optional fields', () => {
  const sparse = []; sparse[11] = 'Nameless Shop'; sparse[10] = '0x1:0x2';
  const lead = extractRecord(sparse);
  assert.equal(lead.name, 'Nameless Shop');
  assert.equal(lead.rating, null);
  assert.equal(lead.phone, null);
  assert.equal(lead.websiteTech, 'none');
});

test('extractRecords reads the record container and skips holes', () => {
  const withHole = structuredClone(payload);
  withHole[64].push(null);
  withHole[64].push([null, null]);
  assert.equal(extractRecords(withHole).length, 1);
});

test('extractRecords returns an empty array for an empty payload', () => {
  const empty = []; empty[64] = [];
  assert.deepEqual(extractRecords(empty), []);
  assert.deepEqual(extractRecords([]), []);
  assert.deepEqual(extractRecords(null), []);
});

test('canary passes on a good payload', () => {
  const { ok, problems } = runCanary(payload);
  assert.equal(ok, true, `unexpected problems: ${problems.join('; ')}`);
});

test('canary FAILS when the name index has drifted', () => {
  const drifted = structuredClone(payload);
  drifted[64][0][1][11] = null;
  const { ok, problems } = runCanary(drifted);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /name/i.test(p)));
});

test('canary FAILS when the record container is missing entirely', () => {
  const { ok, problems } = runCanary({});
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /no records/i.test(p)));
});

test('canary FAILS when ratings are no longer numeric', () => {
  const drifted = structuredClone(payload);
  drifted[64][0][1][4][7] = 'four point three';
  const { ok, problems } = runCanary(drifted);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /rating/i.test(p)));
});
