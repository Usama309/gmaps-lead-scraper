import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, EXPORT_COLUMNS } from '../src/export/csv.js';
import { CONFIG } from '../src/core/config.js';

const NL = CONFIG.export.csvNewline;

/**
 * Minimal RFC4180 reader, used so assertions read real cells and real rows.
 *
 * Splitting on the delimiter or on the newline is wrong exactly BECAUSE the
 * escaping works. A quoted field may legally contain either, so a naive split
 * shifts columns or invents rows and the assertion then compares the wrong
 * thing. Three tests here failed that way before this helper existed, each time
 * looking like a bug in the exporter rather than in the test.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === CONFIG.export.csvDelimiter) { row.push(cell); cell = ''; continue; }
    if (text.startsWith(NL, i)) {
      row.push(cell); cell = '';
      rows.push(row); row = [];
      i += NL.length - 1;
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** Read one named column out of a single-lead CSV. */
function cellOf(csv, header) {
  const rows = parseCsv(csv);
  const index = rows[0].indexOf(header);
  assert.ok(index >= 0, `no column named ${header}`);
  return rows[1][index];
}

function row(overrides = {}) {
  return {
    name: 'Al-Shifa Dental Clinic', categories: ['Dentist'], score: 82, provisional: true,
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

test('every escaped field round-trips back to its exact input', () => {
  // The only real proof for an escaper. A cell that survives quoting but comes
  // back altered would shift the operator's columns without any visible error.
  const nasty = [
    ['comma', 'Pleader Lane, Attock, Punjab'],
    ['double quote', 'The "Best" Dentist'],
    ['only a quote', '"'],
    ['leading quote', '"quoted start'],
    ['embedded LF', `line one${String.fromCharCode(10)}line two`],
    ['embedded CRLF', `line one${String.fromCharCode(13, 10)}line two`],
    ['all at once', `a, b "c"${String.fromCharCode(10)}d`],
  ];
  for (const [label, value] of nasty) {
    const csv = toCsv([row({ address: value })]);
    const rows = parseCsv(csv);
    assert.equal(rows.length, 2, `${label} produced ${rows.length} logical rows`);
    assert.equal(rows[1].length, rows[0].length, `${label} shifted the columns`);
    assert.equal(cellOf(csv, 'Address'), value, `${label} did not round-trip`);
  }
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

test('emits the provisional flag as its own column, since every Phase 1 score is a floor', () => {
  assert.equal(cellOf(toCsv([row({ provisional: true })]), 'Score provisional'), 'yes');
  assert.equal(cellOf(toCsv([row({ provisional: false })]), 'Score provisional'), 'no');
});

test('email and socials render as unknown when never inspected, not as a blank cell', () => {
  // Both rejoined the enrichment set: their null means "we did not look", the same
  // as any other unenriched field, and rendering them blank made that read as a
  // confirmed absence instead.
  const csv = toCsv([row({ email: null })]);
  assert.equal(cellOf(csv, 'Email'), 'unknown');
});

test('an empty socials list renders blank, since an empty array is a confirmed absence', () => {
  const csv = toCsv([row({ socials: [] })]);
  assert.equal(cellOf(csv, 'Social links'), '');
});

test('email and socials are validated like every other enrichment field', () => {
  assert.throws(() => toCsv([row({ email: 123 })]), /which is not/,
    'a non-string email should have been rejected');
  assert.throws(() => toCsv([row({ socials: 'facebook' })]), /which is not/,
    'a non-array socials value should have been rejected');
});

test('an empty lead list still emits the header', () => {
  assert.equal(toCsv([]), EXPORT_COLUMNS.map((c) => c.header).join(',') + NL);
});

test('accepts a custom column subset', () => {
  const csv = toCsv([row()], [{ key: 'name', header: 'Business' }]);
  assert.equal(csv.split(NL)[0], 'Business');
  assert.equal(csv.split(NL)[1], 'Al-Shifa Dental Clinic');
});

test('IMPORTANT: a business name that is a spreadsheet formula is neutralised', () => {
  // Anyone can register a Google Maps listing, and this file is opened directly
  // in Excel or Sheets, so a name beginning with = + - or @ would execute.
  for (const name of ['=1+1', '+1+1', '-1+1', '@SUM(A1:A2)', '=HYPERLINK("http://x","click")']) {
    const cell = cellOf(toCsv([row({ name })]), 'Business');
    assert.ok(cell.startsWith("'"),
      `${name} rendered as ${JSON.stringify(cell)}, which a spreadsheet would execute`);
    assert.equal(cell.slice(1), name, 'the name itself must survive intact');
  }
});

test('a negative number is left numeric, since coordinates are legitimately negative', () => {
  // The mitigation must not turn real latitude and longitude into text.
  const csv = toCsv([row({ lat: -33.8688, lng: -70.6693 })]);
  assert.equal(cellOf(csv, 'Latitude'), '-33.8688', 'latitude must stay numeric');
  assert.equal(cellOf(csv, 'Longitude'), '-70.6693', 'longitude must stay numeric');
});

test('IMPORTANT: an enrichment field holding an unexpected value throws rather than lying', () => {
  // A field holding the string 'yes' renders identically to a genuine true, and
  // one holding 'unknown' renders identically to a genuine null. Nothing
  // downstream could tell an unverified field from a verified one.
  for (const [key, bad] of [
    ['hasBooking', 'yes'], ['hasChatbot', 'unknown'], ['ownerReplies', 'no'],
    ['hasBooking', 1], ['mobileFriendly', 'mostly'],
  ]) {
    assert.throws(() => toCsv([row({ [key]: bad })]), /which is not/,
      `${key} = ${JSON.stringify(bad)} should have been rejected`);
  }
});

test('mobileFriendly partial survives, since a site can be partly responsive', () => {
  assert.equal(cellOf(toCsv([row({ mobileFriendly: 'partial' })]), 'Mobile friendly'), 'partial');
});

test('score sorts first in the default column order, because that is what the operator reads', () => {
  assert.equal(EXPORT_COLUMNS[0].key, 'score');
});
