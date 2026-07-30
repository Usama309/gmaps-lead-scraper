import { makeLead } from '../core/schema.js';

/**
 * Positional indices into Google Maps' embedded search payload.
 *
 * THIS IS THE ONLY FILE PERMITTED TO CONTAIN A PAYLOAD INDEX.
 *
 * Verified against live Google Maps on 2026-07-29. The payload is plain JSON,
 * so parsing is not the risk. Index drift is. When Google reshuffles the array,
 * every field silently becomes undefined, which would look like "no businesses
 * have phone numbers" rather than like a bug. The canary below exists to turn
 * that silent corruption into a loud abort.
 *
 * On drift: re-derive the indices from a live payload, bump PAYLOAD_MAP_VERSION,
 * and update tests/fixtures/payload-record.json to match.
 */
export const PAYLOAD_MAP_VERSION = '2026-07-29';

export const PAYLOAD_MAP = Object.freeze({
  /** Container holding the array of result records. */
  records: Object.freeze([64]),
  /** Each entry in that container wraps its record at this index. */
  recordWrapper: 1,

  record: Object.freeze({
    name: Object.freeze([11]),
    rating: Object.freeze([4, 7]),
    reviewCount: Object.freeze([4, 8]),
    categories: Object.freeze([13]),
    phone: Object.freeze([178, 0, 0]),
    website: Object.freeze([7, 0]),
    lat: Object.freeze([9, 2]),
    lng: Object.freeze([9, 3]),
    placeId: Object.freeze([78]),
    cid: Object.freeze([10]),
    address: Object.freeze([18]),
    hours: Object.freeze([203]),
  }),
});

function at(source, path) {
  let cursor = source;
  for (const index of path) {
    if (cursor === null || cursor === undefined) return null;
    cursor = cursor[index];
  }
  return cursor === undefined ? null : cursor;
}

/** Turn one raw positional record into a canonical Lead. */
export function extractRecord(raw) {
  const m = PAYLOAD_MAP.record;
  const categories = at(raw, m.categories);

  return makeLead({
    provenance: 'google-payload',
    cid: at(raw, m.cid),
    placeId: at(raw, m.placeId),
    name: at(raw, m.name),
    categories: Array.isArray(categories) ? categories : [],
    rating: at(raw, m.rating),
    reviewCount: at(raw, m.reviewCount),
    phone: at(raw, m.phone),
    website: at(raw, m.website),
    lat: at(raw, m.lat),
    lng: at(raw, m.lng),
    address: at(raw, m.address),
  });
}

/** Read every record out of a parsed payload. Holes and malformed entries are skipped. */
export function extractRecords(parsed) {
  const container = at(parsed, PAYLOAD_MAP.records);
  if (!Array.isArray(container)) return [];

  const leads = [];
  for (const entry of container) {
    const raw = at(entry, [PAYLOAD_MAP.recordWrapper]);
    if (!raw) continue;
    try {
      const lead = extractRecord(raw);
      if (lead.name) leads.push(lead);
    } catch {
      // A record we cannot even derive a key for is unusable. Skipping one bad
      // record is correct; the canary catches the case where they are ALL bad.
    }
  }
  return leads;
}

/**
 * Assert that a payload still matches the pinned index map.
 *
 * Called once before a run begins, against the first real page. Returns problems
 * rather than throwing so the caller can present them to the operator.
 */
export function runCanary(parsed) {
  const problems = [];
  const container = at(parsed, PAYLOAD_MAP.records);

  if (!Array.isArray(container) || container.length === 0) {
    problems.push(`no records found at index path [${PAYLOAD_MAP.records}]`);
    return { ok: false, problems };
  }

  const leads = [];
  for (const entry of container) {
    const raw = at(entry, [PAYLOAD_MAP.recordWrapper]);
    if (raw) leads.push(raw);
  }

  if (leads.length === 0) {
    problems.push(`no records found at wrapper index ${PAYLOAD_MAP.recordWrapper}`);
    return { ok: false, problems };
  }

  const named = leads.filter((r) => typeof at(r, PAYLOAD_MAP.record.name) === 'string');
  if (named.length === 0) {
    problems.push(`name index [${PAYLOAD_MAP.record.name}] yielded no strings across ${leads.length} records`);
  }

  const ratings = leads
    .map((r) => at(r, PAYLOAD_MAP.record.rating))
    .filter((v) => v !== null);
  if (ratings.length > 0 && !ratings.every((v) => typeof v === 'number')) {
    problems.push(`rating index [${PAYLOAD_MAP.record.rating}] returned a non-numeric value`);
  }

  return { ok: problems.length === 0, problems };
}
