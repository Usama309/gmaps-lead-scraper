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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A phone number contains only dialling characters. Deliberately strict: a loose
 * "has seven digits" test also accepts a Google place ID like ChIJ1234567, which
 * let phone and placeId swap places with both values still looking valid.
 */
function looksLikePhone(value) {
  return typeof value === 'string'
    && /^[+(]?[\d][\d\s\-().]*$/.test(value.trim())
    && countDigits(value) >= 7;
}

/**
 * A Google place ID starts with a letter and is long. Requiring the leading
 * letter is what stops a phone number passing as a place ID, closing the other
 * direction of the same swap.
 */
function looksLikePlaceId(value) {
  return typeof value === 'string' && /^[A-Za-z]/.test(value) && value.trim().length >= 8;
}

/**
 * What a healthy payload looks like, field by field.
 *
 * Coverage floors sit close to the live measurement (98% phone, 98% rating,
 * 67% website on 2026-07-29) rather than far below it. An earlier version used a
 * 50% floor for phone, which meant a drift halving real coverage raised no alarm
 * on the field the operator actually dials.
 *
 * Four rule-level mechanisms, because each catches a different failure:
 *   required        every record must carry a valid value, at any sample size
 *   minAnyValid     at least one record must, once the sample is 2 or more. This
 *                   catches a TOTAL field loss on a page too small for a
 *                   percentage to mean anything, which was a real blind spot: a
 *                   4-record page could lose phone, rating, reviewCount, lat and
 *                   lng entirely and still report healthy.
 *   minCoverage     a fraction, judged only once the sample is large enough
 *   minUniqueRatio  the values must be mostly distinct. A repeated identifier is
 *                   drift onto a shared field rather than sparse data, and for cid
 *                   it would collapse every business into a single exported row.
 *
 * A fifth mechanism, the pairwise collision sweep, lives in runCanary rather than
 * on a rule because it compares every mapped scalar field against every other one.
 * An earlier version enumerated the pairs to compare, so a shift landing name on
 * the phone or the website evaded it. Sweeping all pairs closes the whole class.
 */
export const CANARY_RULES = Object.freeze({
  minRecordsToJudgeCoverage: 5,
  minRecordsToRequireAnyValid: 2,
  // Real drift is uniform across records, but a stricter threshold costs nothing
  // and catches a partial swap that a bare majority rule would tolerate.
  minRecordsNearQuery: 0.9,
  // Two mapped fields holding the same value on more than a quarter of records
  // means the indices collided. Genuine data essentially never does this.
  maxFieldCollisionRatio: 0.25,
  // A record's coordinates should sit near the point we queried. A lat/lng swap
  // passes both range checks whenever |longitude| is under 90, which covers most
  // of the inhabited world, so range validation alone cannot catch it.
  maxDistanceFromQueryKm: 250,
  fields: Object.freeze([
    Object.freeze({
      field: 'name', required: true, minCoverage: 0.95,
      valid: (v) => isNonEmptyString(v) && !CID_PATTERN.test(v),
      why: 'name must be a non-empty string and not a CID',
    }),
    Object.freeze({
      field: 'cid', required: true, minCoverage: 0.90, minUniqueRatio: 0.95,
      valid: (v) => typeof v === 'string' && CID_PATTERN.test(v),
      why: 'cid is the primary dedupe key, so it must be well formed AND distinct per record; a repeated cid collapses every business into one exported row',
    }),
    Object.freeze({
      field: 'phone', minAnyValid: true, minCoverage: 0.80,
      valid: looksLikePhone,
      why: 'phone is the field the operator actually dials; measured at 98% live',
    }),
    Object.freeze({
      field: 'rating', minAnyValid: true, minCoverage: 0.80,
      valid: (v) => typeof v === 'number' && v >= 0 && v <= 5,
      why: 'rating must be a number within 0 to 5',
    }),
    Object.freeze({
      field: 'reviewCount', minAnyValid: true, minCoverage: 0.80,
      valid: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
      why: 'review count drives the viability score',
    }),
    Object.freeze({
      field: 'lat', minAnyValid: true, minCoverage: 0.90,
      valid: (v) => typeof v === 'number' && v >= -90 && v <= 90,
      why: 'coordinates feed the fallback dedupe key',
    }),
    Object.freeze({
      field: 'lng', minAnyValid: true, minCoverage: 0.90,
      valid: (v) => typeof v === 'number' && v >= -180 && v <= 180,
      why: 'coordinates feed the fallback dedupe key',
    }),
    Object.freeze({
      field: 'categories', minAnyValid: true, minCoverage: 0.80,
      valid: (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString),
      why: 'categories drive appointment detection in scoring and the category filter',
    }),
    Object.freeze({
      field: 'placeId', minAnyValid: true, minCoverage: 0.80, minUniqueRatio: 0.95,
      valid: looksLikePlaceId,
      why: 'placeId is the stable Google identifier carried into the export',
    }),
    Object.freeze({
      field: 'address', minAnyValid: true, minCoverage: 0.80,
      valid: isNonEmptyString,
      why: 'address is exported and read aloud when qualifying a lead',
    }),
  ]),
});

const EARTH_RADIUS_KM = 6371;

function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Assert that a payload still matches the pinned index map.
 *
 * Called once before a run begins, against the first real page. Returns problems
 * rather than throwing so the caller can show them to the operator.
 *
 * `expect.lat` and `expect.lng` are the coordinates we queried. Supplying them
 * enables the proximity check, which is the only thing that catches a lat/lng
 * swap. Omitting them skips that check and says so in the result.
 */
export function runCanary(parsed, expect = {}) {
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
  const judgeAnyValid = records.length >= CANARY_RULES.minRecordsToRequireAnyValid;

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

    // Total loss is unambiguous at any sample size above one, so it does not wait
    // for the coverage threshold. This is the small-page blind spot.
    if (rule.minAnyValid && judgeAnyValid && present.length === 0) {
      problems.push(
        `${rule.field} at index path [${path}] is absent on ALL ${records.length} `
        + `records, which is total field loss rather than sparse data (${rule.why})`
      );
      continue;
    }

    if (rule.minUniqueRatio && present.length > 1) {
      const distinct = new Set(present).size;
      const ratio = distinct / present.length;
      if (ratio < rule.minUniqueRatio) {
        problems.push(
          `${rule.field} at index path [${path}] holds only ${distinct} distinct `
          + `values across ${present.length} records. A repeated identifier is not `
          + `sparse data, it is drift onto a shared field (${rule.why})`
        );
      }
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

  // Relational invariants. Two numeric fields can swap places while both remain
  // individually valid, which no per-field validator and no equality sweep can
  // see. A real business has far more reviews than its rating is high, so the
  // ordering between them is a cheap, reliable tell.
  const paired = records
    .map((r) => ({
      rating: at(r, PAYLOAD_MAP.record.rating),
      reviewCount: at(r, PAYLOAD_MAP.record.reviewCount),
    }))
    .filter((v) => typeof v.rating === 'number' && typeof v.reviewCount === 'number');

  if (paired.length > 0) {
    const ordered = paired.filter((v) => v.reviewCount >= v.rating);
    if (ordered.length < paired.length * 0.9) {
      problems.push(
        `reviewCount is smaller than rating on ${paired.length - ordered.length} of `
        + `${paired.length} records. Real businesses have more reviews than their `
        + `rating is high, so those two indices have most likely swapped`
      );
    }
  }

  // Cross-field collision sweep. Enumerating "name must differ from address" only
  // guards the pairs someone thought of; a shift landing name on the phone, the
  // website or the joined categories evaded it. Comparing every mapped scalar pair
  // closes the whole class instead of one instance of it.
  const scalarFields = CANARY_RULES.fields
    .map((rule) => rule.field)
    .filter((field) => {
      const sample = records.map((r) => at(r, PAYLOAD_MAP.record[field])).find((v) => v !== null);
      return typeof sample === 'string' || typeof sample === 'number';
    });

  for (let i = 0; i < scalarFields.length; i += 1) {
    for (let j = i + 1; j < scalarFields.length; j += 1) {
      const a = scalarFields[i];
      const b = scalarFields[j];
      const collisions = records.filter((r) => {
        const av = at(r, PAYLOAD_MAP.record[a]);
        const bv = at(r, PAYLOAD_MAP.record[b]);
        return av !== null && bv !== null && av === bv;
      });
      if (collisions.length > records.length * CANARY_RULES.maxFieldCollisionRatio) {
        problems.push(
          `${a} at [${PAYLOAD_MAP.record[a]}] and ${b} at [${PAYLOAD_MAP.record[b]}] `
          + `hold identical values on ${collisions.length} of ${records.length} `
          + `records, which means those indices have collided or shifted`
        );
      }
    }
  }

  // Proximity. Catches a lat/lng swap, which no range check can: a longitude of
  // 72 is a perfectly valid latitude.
  let proximityJudged = false;
  if (Number.isFinite(expect.lat) && Number.isFinite(expect.lng)) {
    const centre = { lat: expect.lat, lng: expect.lng };
    const coords = records
      .map((r) => ({ lat: at(r, PAYLOAD_MAP.record.lat), lng: at(r, PAYLOAD_MAP.record.lng) }))
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));

    if (coords.length > 0) {
      proximityJudged = true;
      const near = coords.filter((c) => distanceKm(centre, c) <= CANARY_RULES.maxDistanceFromQueryKm);
      if (near.length < coords.length * CANARY_RULES.minRecordsNearQuery) {
        const swapped = coords.filter(
          (c) => distanceKm(centre, { lat: c.lng, lng: c.lat }) <= CANARY_RULES.maxDistanceFromQueryKm
        );
        problems.push(
          `only ${near.length} of ${coords.length} records sit within `
          + `${CANARY_RULES.maxDistanceFromQueryKm} km of the queried point `
          + `(${expect.lat}, ${expect.lng}).`
          + (swapped.length > near.length
            ? ' They DO fit when latitude and longitude are exchanged, so those two indices have swapped.'
            : ' The coordinate indices have drifted.')
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    sampled: records.length,
    coverageJudged: judgeCoverage,
    proximityJudged,
  };
}
