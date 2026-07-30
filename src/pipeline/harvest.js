import { CONFIG } from '../core/config.js';
import { planTiles } from './tiling.js';
import { setPbCentre } from '../sources/google-payload.js';
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
    throw new Error(
      `leg ${leg.id} returned leads as ${Array.isArray(result.leads) ? 'array' : typeof result.leads}, expected an array`
    );
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
export async function runHarvest({
  legs,
  pb,
  source,
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

  const finish = (stopReason) => ({
    leads: [...byKey.values()],
    stopReason: assertStopReason(stopReason),
    completedLegs,
    problems,
  });

  for (let i = startAt; i < legs.length; i += 1) {
    if (signal?.aborted) return finish('aborted');

    const leg = legs[i];
    const legPb = setPbCentre(pb, { lat: leg.lat, lng: leg.lng, zoom: leg.zoom });

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

    // Only the newly seen leads. Legs overlap by design, so passing the raw list
    // would make a streaming consumer write the same business several times.
    if (fresh.length > 0) onLeads(fresh);

    onProgress({
      legIndex: i,
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

    completedLegs = i + 1;

    if (signal?.aborted) return finish('aborted');
    if (i + 1 < legs.length) await delay(nextDelayMs());
  }

  return finish('completed');
}
