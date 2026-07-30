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

/**
 * Read every record out of a parsed payload.
 *
 * Returns counts alongside the leads, because three very different situations
 * would otherwise collapse into one empty array: no container at all, a container
 * that is legitimately empty (the normal end of a leg), and a container full of
 * records that ALL failed extraction. The harvester treats an empty record list
 * as end-of-list, so without rawCount an index drift that broke every record
 * would look exactly like a completed search.
 */
export function extractPage(parsed) {
  const container = at(parsed, PAYLOAD_MAP.records);
  if (!Array.isArray(container)) return { leads: [], rawCount: 0, skipped: 0 };

  const leads = [];
  let rawCount = 0;
  let skipped = 0;

  for (const entry of container) {
    const raw = at(entry, [PAYLOAD_MAP.recordWrapper]);
    if (!raw) continue;
    rawCount += 1;
    try {
      const lead = extractRecord(raw);
      if (lead.name) leads.push(lead);
      else skipped += 1;
    } catch {
      // A record we cannot derive a key for is unusable. Skipping one is correct.
      // The caller compares rawCount against leads.length to catch the case where
      // they are ALL unusable, which is drift rather than bad luck.
      skipped += 1;
    }
  }

  return { leads, rawCount, skipped };
}

/** Convenience wrapper for callers that only need the leads. */
export function extractRecords(parsed) {
  return extractPage(parsed).leads;
}

/** A Google CID looks like 0x<hex>:0x<hex>. Used to validate, and to detect shifts. */
const CID_PATTERN = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;

function countDigits(value) {
  return (String(value).match(/\d/g) ?? []).length;
}

/**
 * What a healthy payload looks like, field by field.
 *
 * Coverage floors are set well below the live measurement (98% phone, 98% rating,
 * 67% website on 2026-07-29) so a genuinely thin market does not trip them, while
 * a total field loss does.
 *
 * `required: true` means every record must carry a valid value at any sample size,
 * because these two fields ARE the record's identity. Everything else is judged on
 * coverage, and only once the sample is large enough for a fraction to mean anything.
 */
export const CANARY_RULES = Object.freeze({
  minRecordsToJudgeCoverage: 5,
  fields: Object.freeze([
    Object.freeze({
      field: 'name', required: true, minCoverage: 0.95,
      // Rejecting CID-shaped strings is what catches a constant-offset shift:
      // move every index by one and `name` lands on the CID hex, which is still
      // a string and would sail past a bare typeof check.
      valid: (v) => typeof v === 'string' && v.trim().length > 0 && !CID_PATTERN.test(v),
      why: 'name must be a non-empty string that is not a CID',
    }),
    Object.freeze({
      field: 'cid', required: true, minCoverage: 0.90,
      valid: (v) => typeof v === 'string' && CID_PATTERN.test(v),
      why: 'cid is the primary dedupe key; drift landing it on shared text merges distinct businesses',
    }),
    Object.freeze({
      field: 'phone', required: false, minCoverage: 0.50,
      valid: (v) => typeof v === 'string' && countDigits(v) >= 7,
      why: 'phone is the field the operator actually calls; measured at 98% live',
    }),
    Object.freeze({
      field: 'rating', required: false, minCoverage: 0.50,
      valid: (v) => typeof v === 'number' && v >= 0 && v <= 5,
      why: 'rating must be a number within 0 to 5',
    }),
    Object.freeze({
      field: 'reviewCount', required: false, minCoverage: 0.50,
      valid: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
      why: 'review count drives the viability score',
    }),
    Object.freeze({
      field: 'lat', required: false, minCoverage: 0.90,
      valid: (v) => typeof v === 'number' && v >= -90 && v <= 90,
      why: 'coordinates feed the fallback dedupe key',
    }),
    Object.freeze({
      field: 'lng', required: false, minCoverage: 0.90,
      valid: (v) => typeof v === 'number' && v >= -180 && v <= 180,
      why: 'coordinates feed the fallback dedupe key',
    }),
  ]),
});

/**
 * Assert that a payload still matches the pinned index map.
 *
 * Called once before a run begins, against the first real page. Returns problems
 * rather than throwing so the caller can show them to the operator.
 *
 * Checks three separate things, because presence alone is not enough:
 *   1. Records exist at the mapped container and wrapper indices.
 *   2. FORMAT: any value that IS present must look like the field it claims to be.
 *      This is what catches a shift onto a populated but wrong field, which a
 *      presence check waves straight through.
 *   3. COVERAGE: enough records carry each field, judged only once the sample is
 *      big enough that a fraction means something.
 */
export function runCanary(parsed) {
  const problems = [];
  const container = at(parsed, PAYLOAD_MAP.records);

  if (!Array.isArray(container) || container.length === 0) {
    problems.push(`no records found at index path [${PAYLOAD_MAP.records}]`);
    return { ok: false, problems, sampled: 0 };
  }

  const records = [];
  for (const entry of container) {
    const raw = at(entry, [PAYLOAD_MAP.recordWrapper]);
    if (raw) records.push(raw);
  }

  if (records.length === 0) {
    problems.push(`no records found at wrapper index ${PAYLOAD_MAP.recordWrapper}`);
    return { ok: false, problems, sampled: 0 };
  }

  const judgeCoverage = records.length >= CANARY_RULES.minRecordsToJudgeCoverage;

  for (const rule of CANARY_RULES.fields) {
    const path = PAYLOAD_MAP.record[rule.field];
    const values = records.map((r) => at(r, path));

    const present = values.filter((v) => v !== null && v !== undefined);
    const malformed = present.filter((v) => !rule.valid(v));

    if (malformed.length > 0) {
      problems.push(
        `${rule.field} at index path [${path}] returned ${malformed.length} of `
        + `${present.length} values in the wrong shape (${rule.why}). `
        + `First offender: ${JSON.stringify(malformed[0]).slice(0, 60)}`
      );
      continue;
    }

    if (rule.required && present.length < records.length) {
      problems.push(
        `${rule.field} at index path [${path}] is missing on `
        + `${records.length - present.length} of ${records.length} records (${rule.why})`
      );
      continue;
    }

    if (judgeCoverage) {
      const coverage = present.length / records.length;
      if (coverage < rule.minCoverage) {
        problems.push(
          `${rule.field} at index path [${path}] covered only `
          + `${Math.round(coverage * 100)}% of ${records.length} records, `
          + `below the ${Math.round(rule.minCoverage * 100)}% floor (${rule.why})`
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    sampled: records.length,
    coverageJudged: judgeCoverage,
  };
}
