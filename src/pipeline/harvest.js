import { CONFIG } from '../core/config.js';
import { planTiles, haversineKm } from './tiling.js';
import { setPbCentre, setPbQuery } from '../sources/google-payload.js';
import { assertSource, assertStopReason } from '../sources/source.js';
import { nextDelayMs } from './guard.js';

/**
 * Reasons that stop the WHOLE job rather than just the current leg.
 *
 * All three mean the next leg's data would be untrustworthy: we are being
 * throttled, the payload shape has drifted, or the operator asked us to stop.
 * Continuing would produce a partial list that reads as complete.
 */
const HALTING_REASONS = Object.freeze(['blocked', 'canary_failed', 'aborted']);

/**
 * Validate what a source handed back, INSIDE the caller's try/catch.
 *
 * A malformed return is as damaging as a throw and was not covered by one: the
 * try wrapped only the call, so reading `.leads` off undefined escaped it and
 * destroyed every lead collected so far. A leads value that is a string is worse
 * still, because it iterates character by character into the dedupe map and
 * reports success.
 */
function assertLegResult(result, leg) {
  if (!result || typeof result !== 'object') {
    throw new Error(
      `leg ${leg.id} returned ${result === null ? 'null' : typeof result} instead of a result object`
    );
  }
  if (!Array.isArray(result.leads)) {
    throw new Error(`leg ${leg.id} returned leads as ${typeof result.leads}, expected an array`);
  }
  if (result.notices !== undefined && !Array.isArray(result.notices)) {
    throw new Error(`leg ${leg.id} returned notices as ${typeof result.notices}, expected an array`);
  }
  assertStopReason(result.stopReason);
}

/**
 * Expand a job into a flat queue of legs.
 *
 * A leg is one query at one map centre. Legs exist because a single Google query
 * caps at 247 results, so covering a real market means multiplying keywords by
 * geographic tiles and merging on the dedupe key.
 */
export function planLegs({ keywords, categories = [], lat, lng, zoom = 14, radiusKm }) {
  // Deduplicated, because a repeated keyword produces legs with identical ids and
  // the resume contract addresses legs by index against a list assumed unique.
  const cleanKeywords = [...new Set(
    (keywords ?? []).map((k) => String(k).trim()).filter(Boolean)
  )];
  if (cleanKeywords.length === 0) {
    throw new Error('planLegs requires at least one keyword');
  }

  const categorySuffix = categories.length ? ` ${categories.join(' ')}` : '';
  const plan = planTiles({ lat, lng, radiusKm });

  const legs = [];
  for (const keyword of cleanKeywords) {
    for (const [tileIndex, tile] of plan.tiles.entries()) {
      legs.push({
        id: `${keyword}@${tile.lat.toFixed(5)},${tile.lng.toFixed(5)}`,
        query: `${keyword}${categorySuffix}`,
        keyword,
        tileIndex,
        lat: tile.lat,
        lng: tile.lng,
        zoom,
      });
    }
  }

  const capped = legs.slice(0, CONFIG.harvest.maxLegsPerRun);

  // Coverage is returned rather than swallowed. Two separate caps can shrink what
  // actually gets searched, and a short list that looks complete is worse than a
  // short list labelled as short.
  return {
    legs: capped,
    // The area the operator actually asked for. Carried separately from the legs
    // because Google treats the viewport in a pb as a hint, not a boundary: asked
    // for 2 km live and it returned a median of 62 km, with results as far away as
    // Peshawar. The radius has to be enforced on the way out, since it cannot be
    // enforced on the way in.
    area: { lat, lng, radiusKm },
    coverage: {
      tilesPlanned: plan.candidateCount,
      tilesUsed: plan.tiles.length,
      tilesTruncated: plan.truncated,
      requestedRadiusKm: plan.requestedRadiusKm,
      effectiveRadiusKm: plan.effectiveRadiusKm,
      legsPlanned: legs.length,
      legsUsed: capped.length,
      legsTruncated: capped.length < legs.length,
    },
  };
}

/**
 * Run the leg queue, deduplicating as leads arrive.
 *
 * A block or a canary failure halts the entire job rather than moving to the next
 * leg: both mean the data we would collect next is untrustworthy, and continuing
 * would produce a partial list the operator might mistake for a complete one.
 */
/**
 * Is this lead inside the area the operator asked for?
 *
 * A lead with no coordinates is kept. We cannot show it is outside, and silently
 * discarding a real business because Google omitted its position would be a worse
 * error than admitting one. The count is reported either way.
 */
function insideArea(lead, area) {
  if (!area || !Number.isFinite(area.radiusKm)) return true;
  if (!Number.isFinite(lead.lat) || !Number.isFinite(lead.lng)) return true;
  return haversineKm({ lat: area.lat, lng: area.lng }, { lat: lead.lat, lng: lead.lng }) <= area.radiusKm;
}

export async function runHarvest({
  legs,
  pb,
  source,
  // The requested search area. Google honours a pb viewport as a hint only, so
  // without this a 2 km request returns businesses from the next province. Omitting
  // it disables the check rather than defaulting to something arbitrary.
  area = null,
  onProgress = () => {},
  onLeads = () => {},
  signal = null,
  startAt = 0,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  assertSource(source);

  if (!Number.isInteger(startAt) || startAt < 0 || startAt > legs.length) {
    throw new Error(
      `runHarvest requires startAt to be an integer within 0..${legs.length}, `
      + `got ${JSON.stringify(startAt)}. A silent out-of-range resume would harvest `
      + 'nothing and report success.'
    );
  }

  const byKey = new Map();
  const problems = [];
  let completedLegs = startAt;
  // Things a leg could not confirm, as distinct from things that went wrong. A Set
  // because the same observation repeats on every leg of a thin run, and sixty
  // identical paragraphs is how a warning becomes invisible.
  const notices = new Set();

  // Counted by BUSINESS, not by record. Legs overlap by design, so the same
  // out-of-area business is returned by many of them; counting records made the
  // figure roughly leg count times the truth, and made it incomparable with the
  // deduped kept count it sits beside.
  const outsideKeys = new Set();

  // Index of the first leg that failed without halting the run. Resume restarts
  // from there rather than past it, so a transient network fault costs a repeat
  // rather than a hole in coverage. Dedupe makes the repeat free.
  let firstFailedLeg = null;

  const finish = (stopReason) => ({
    leads: [...byKey.values()],
    stopReason: assertStopReason(stopReason),
    completedLegs,
    problems,
    notices: [...notices],
    outsideArea: outsideKeys.size,
  });

  for (let i = startAt; i < legs.length; i += 1) {
    if (signal?.aborted) return finish('aborted');

    const leg = legs[i];
    // BOTH the centre and the query. The pb carries the search term the operator
    // originally typed into Maps, and Google reads it, so moving only the coordinates
    // harvests somewhere between where you asked and wherever you last searched.
    const legPb = setPbQuery(
      setPbCentre(pb, { lat: leg.lat, lng: leg.lng, zoom: leg.zoom }),
      leg.query,
    );

    // The try covers the call AND the shape check, because a malformed return
    // damages exactly as much as a throw: it would discard every lead from every
    // leg already completed, each of which cost real network time and throttle delay.
    let result;
    try {
      result = await source.harvestLeg({
        query: leg.query,
        pb: legPb,
        lat: leg.lat,
        lng: leg.lng,
        signal,
      });
      assertLegResult(result, leg);
    } catch (error) {
      problems.push(`leg ${leg.id} failed: ${error?.message ?? String(error)}`);
      return finish('leg_threw');
    }

    const fresh = [];
    for (const lead of result.leads) {
      // Filtered before the dedupe map, so an out-of-area business never occupies a
      // key and can never be counted as unique.
      if (!insideArea(lead, area)) {
        outsideKeys.add(lead.key);
        continue;
      }
      if (!byKey.has(lead.key)) {
        byKey.set(lead.key, lead);
        fresh.push(lead);
      }
    }

    // Every leg's problems are carried out, not just the halting ones. A leg that
    // hit a network fault still ran, still cost time, and still returned fewer
    // leads than it should have; swallowing that makes a degraded run look clean.
    if (result.problems?.length) {
      problems.push(...result.problems.map((p) => `leg ${leg.id}: ${p}`));
    }

    // Deliberately NOT pushed into `problems`. A notice must not change the run's
    // stop reason, and must not be joined into the PAUSED line where the halt
    // reason has to stay readable.
    for (const notice of result.notices ?? []) notices.add(notice);

    // Only the newly seen leads. Legs overlap by design, so passing the raw list
    // would make a streaming consumer write the same business several times.
    if (fresh.length > 0) onLeads(fresh);

    // Updated BEFORE progress is reported, because the worker persists the number
    // from that payload as the resume point. Reporting the pre-update value made
    // every run's first progress message claim zero legs done.
    if (result.stopReason !== 'end_of_list' && result.stopReason !== 'cap_reached') {
      if (firstFailedLeg === null) firstFailedLeg = i;
    }
    completedLegs = firstFailedLeg ?? (i + 1);

    onProgress({
      legIndex: i,
      completedLegs,
      totalLegs: legs.length,
      leg,
      legLeads: result.leads.length,
      freshLeads: fresh.length,
      uniqueLeads: byKey.size,
      stopReason: result.stopReason,
    });

    // Checked BEFORE completedLegs advances, so a halted leg is retried on resume
    // rather than skipped. Advancing first meant a blocked leg was recorded as
    // done and permanently lost from the job.
    if (HALTING_REASONS.includes(result.stopReason)) {
      return finish(result.stopReason);
    }

    if (signal?.aborted) return finish('aborted');
    if (i + 1 < legs.length) await delay(nextDelayMs());
  }

  // Keyed on problems ONLY. A notice is an observation, not a failure, and folding
  // one in here reported a flawless rural harvest as incomplete.
  return finish(problems.length > 0 ? 'completed_with_errors' : 'completed');
}
