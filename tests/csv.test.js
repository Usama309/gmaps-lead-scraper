import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, EXPORT_COLUMNS } from '../src/export/csv.js';
import { CONFIG } from '../src/core/config.js';

const NL = CONFIG.export.csvNewline;

function row(overrides = {}) {
  return {
    name: 'Al-Shifa Dental Clinic', categories: ['Dentist'], score: 82,
    reasons: ['No website', 'dentist, no online booking'],
    rating: 4.3, reviewCount: 87, phone: '+92 57 261 2201',
    website: null, domain: null, websiteTech: 'none',
    mobileFriendly: null, hasBooking: null, hasChatbot: null,
    email: null, socials: [], ownerReplies: null, lastReviewDays: 60,
    address: 'Pleader Lane, Attock', lat: 33.7621, lng: 72.3489,
    provenance: 'google-payload', cid: '0xa:0xb',
    ...overrides,
  };
}

test('emits a header row from the column list', () => {
  const lines = toCsv([row()]).split(NL);
  assert.equal(lines[0], EXPORT_COLUMNS.map((c) => c.header).join(','));
});

test('emits one line per lead plus the header', () => {
  assert.equal(toCsv([row(), row()]).trimEnd().split(NL).length, 3);
});

test('quotes fields containing the delimiter', () => {
  const csv = toCsv([row({ address: 'Pleader Lane, Attock, Punjab' })]);
  assert.ok(csv.includes('"Pleader Lane, Attock, Punjab"'));
});

test('escapes embedded double quotes by doubling them', () => {
  const csv = toCsv([row({ name: 'The "Best" Dentist' })]);
  assert.ok(csv.includes('"The ""Best"" Dentist"'));
});

test('quotes fields containing newlines so a row cannot split', () => {
  const csv = toCsv([row({ address: 'Line one\nLine two' })]);
  assert.equal(csv.trimEnd().split(NL).length, 2, 'an embedded newline must not create a new row');
});

test('joins array fields with a semicolon rather than a comma', () => {
  const csv = toCsv([row({ categories: ['Dentist', 'Dental clinic'] })]);
  assert.ok(csv.includes('Dentist; Dental clinic'));
});

test('renders the reasons array as the why column', () => {
  const csv = toCsv([row()]);
  assert.ok(csv.includes('No website; dentist, no online booking')
    || csv.includes('"No website; dentist, no online booking"'));
});

test('renders null as an empty field, never as the string null', () => {
  const csv = toCsv([row({ website: null, email: null })]);
  assert.ok(!/\bnull\b/.test(csv), 'the literal text null must never appear');
});

test('renders booleans as yes and no, not true and false', () => {
  const csv = toCsv([row({ mobileFriendly: false, hasBooking: true })]);
  assert.ok(csv.includes('no'));
  assert.ok(csv.includes('yes'));
});

test('renders unknown enrichment as unknown, distinct from no', () => {
  const csv = toCsv([row({ mobileFriendly: null })]);
  const cells = csv.split(NL)[1];
  assert.ok(cells.includes('unknown'));
});

test('an empty lead list still emits the header', () => {
  assert.equal(toCsv([]), EXPORT_COLUMNS.map((c) => c.header).join(',') + NL);
});

test('accepts a custom column subset', () => {
  const csv = toCsv([row()], [{ key: 'name', header: 'Business' }]);
  assert.equal(csv.split(NL)[0], 'Business');
  assert.equal(csv.split(NL)[1], 'Al-Shifa Dental Clinic');
});

test('score sorts first in the default column order, because that is what the operator reads', () => {
  assert.equal(EXPORT_COLUMNS[0].key, 'score');
});
