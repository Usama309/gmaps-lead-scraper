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
  // A rating/reviewCount swap is checked on the SAMPLE, not per record, and the
  // history here is worth keeping because both earlier attempts were wrong.
  //
  // The first was a per-record ordering rule, `reviewCount >= rating`. Ratings are
  // capped at 5, so that can only ever be violated when reviewCount is 4 or less,
  // which means it fired exclusively on very small businesses. Live in Attock, 8 of
  // 19 real dentists had a 5.0 rating and one to four reviews, and it aborted the
  // whole run. Those businesses are the target market, not drift.
  //
  // Removing it outright was also wrong. The argument was that a swap puts a
  // fractional rating into the reviewCount slot, where Number.isInteger rejects it.
  // That fails on exactly the market this tool is for: a listing with one review has
  // a whole-number rating by arithmetic, so in a thin market every rating can be a
  // whole number and the swap sails through both validators. A review reproduced it
  // on a 20-record page and the canary reported no problems at all.
  //
  // What survives is the aggregate shape. A swapped column puts ratings into
  // reviewCount, so EVERY count would be at or below the rating ceiling of 5. Any
  // real page mixes in at least one established business with more than a handful of
  // reviews; live in Attock the counts ran to 209. When a whole sample looks like it
  // could be either, we cannot tell, and saying so is the honest stop.
  swapCeiling: 5,
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
      // No coverage floor on purpose. Live coverage was 67% and a thin market could
      // be lower, so a percentage here would cry wolf. But total loss must still
      // abort: this field carries 40 of the 100 score points and the flagship
      // filter, so a drift here makes EVERY business look like a perfect lead.
      field: 'website', minAnyValid: true,
      valid: (v) => typeof v === 'string' && /^https?:\/\//i.test(v),
      why: 'website drives the largest score component and the no-website filter',
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
  // Kept separate from problems on purpose. A problem means the payload is wrong and
  // the run must stop; a warning means one thing could not be confirmed from this
  // page. Collapsing the two made an unreadable page abort a sixty-leg job.
  const warnings = [];
  const container = at(parsed, PAYLOAD_MAP.records);

  if (!Array.isArray(container) || container.length === 0) {
    problems.push(`no records found at index path [${PAYLOAD_MAP.records}]`);
    return { ok: false, problems, warnings, sampled: 0 };
  }

  const records = [];
  for (const entry of container) {
    const raw = at(entry, [PAYLOAD_MAP.recordWrapper]);
    if (raw) records.push(raw);
  }

  if (records.length === 0) {
    problems.push(`no records found at wrapper index ${PAYLOAD_MAP.recordWrapper}`);
    return { ok: false, problems, warnings, sampled: 0 };
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

    // A coverage shortfall is a WARNING, not a halt, and the reasoning is the file's
    // own: "real drift is uniform across records". Uniform drift takes coverage to
    // zero, and `minAnyValid` above already halts on that. A figure strictly between
    // zero and the floor is therefore telling us about the DATA, not the indices.
    //
    // Measured live in Attock on 2026-07-31, same code and same day: phone coverage
    // was 98% for dentists, 65% for beauty salons and 60% for gyms. The 80% floor was
    // calibrated on dentists, so it aborted the entire beauty salon and gym runs on
    // perfectly good data. That is the same mistake as the old reviewCount ordering
    // rule: a threshold true of one vertical applied to every vertical, turning a
    // thin category into a hard stop.
    if (judgeCoverage) {
      const coverage = present.length / records.length;
      if (coverage < rule.minCoverage) {
        warnings.push(
          `${rule.field} at index path [${path}] covered only `
          + `${Math.round(coverage * 100)}% of ${records.length} records, `
          + `below the ${Math.round(rule.minCoverage * 100)}% floor (${rule.why}). `
          + 'Harvesting continues: total loss of a field is caught separately, so a '
          + 'partial figure means this category carries the field less often, not that '
          + 'the indices moved'
        );
      }
    }
  }

  const paired = records
    .map((r) => ({
      rating: at(r, PAYLOAD_MAP.record.rating),
      reviewCount: at(r, PAYLOAD_MAP.record.reviewCount),
    }))
    .filter((v) => typeof v.rating === 'number' && typeof v.reviewCount === 'number');

  // Sample-level ambiguity notice. A WARNING, never a problem, and the distinction
  // is the whole point.
  //
  // An earlier version of this raised a problem, which meant `canary_failed`, which
  // is a HALTING reason. That killed the entire job on the first page of any leg
  // whose sample happened to be all new listings. A six-record outer tile of a rural
  // run does exactly that, and rural thin markets are what this product sells into,
  // so one unlucky tile aborted a sixty-leg run.
  //
  // Ambiguity is not evidence of drift. It is the absence of evidence either way:
  // ratings cap at 5, so when every count is also at or below 5 and every rating is a
  // whole number, the two columns are literally interchangeable and NO rule can read
  // them apart. Halting on that punishes the operator for a thin market.
  //
  // Real drift still halts, through the per-field validators, and they are strictly
  // better at it: a swap puts a count above 5 into the rating slot (range check) or a
  // fractional rating into the count slot (integer check). Both are problems. Only
  // the genuinely unreadable case lands here, and it is reported rather than acted on.
  // Gated at the SMALL-page threshold, not the coverage one. Using the coverage gate
  // of 5 reintroduced exactly the blind spot this file closed for total field loss: a
  // four-record page could be fully transposed and say nothing at all. A warning on a
  // small sample costs the operator a line of text and nothing else.
  if (paired.length >= CANARY_RULES.minRecordsToRequireAnyValid
    && paired.every((v) => v.reviewCount <= CANARY_RULES.swapCeiling)
    && paired.every((v) => Number.isInteger(v.rating))) {
    warnings.push(
      `all ${paired.length} records on this page have a whole-number rating and no more than `
      + `${CANARY_RULES.swapCeiling} reviews, so rating at [${PAYLOAD_MAP.record.rating}] and `
      + `reviewCount at [${PAYLOAD_MAP.record.reviewCount}] cannot be told apart on this page `
      + 'alone. Harvesting continues, because a market of brand new listings looks exactly like '
      + 'this and is the far likelier explanation'
    );
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
    warnings,
    sampled: records.length,
    coverageJudged: judgeCoverage,
    proximityJudged,
  };
}
