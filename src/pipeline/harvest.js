import { CONFIG } from '../core/config.js';
import { planTiles } from './tiling.js';
import { setPbCentre } from '../sources/google-payload.js';
import { nextDelayMs } from './guard.js';

/**
 * Expand a job into a flat queue of legs.
 *
 * A leg is one query at one map centre. Legs exist because a single Google query
 * caps at 247 results, so covering a real market means multiplying keywords by
 * geographic tiles and merging on the dedupe key.
 */
export function planLegs({ keywords, categories = [], lat, lng, zoom = 14, radiusKm }) {
  const cleanKeywords = (keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
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
  const byKey = new Map();
  const problems = [];
  let completedLegs = startAt;

  for (let i = startAt; i < legs.length; i += 1) {
    if (signal?.aborted) {
      return { leads: [...byKey.values()], stopReason: 'aborted', completedLegs, problems };
    }

    const leg = legs[i];
    const legPb = setPbCentre(pb, { lat: leg.lat, lng: leg.lng, zoom: leg.zoom });

    // Same rule as inside harvestLeg: a throw here would discard every lead from
    // every leg already completed. One flaky request must not cost the whole run.
    let result;
    try {
      result = await source.harvestLeg({
        query: leg.query,
        pb: legPb,
        lat: leg.lat,
        lng: leg.lng,
        signal,
      });
    } catch (error) {
      problems.push(`leg ${leg.id} threw: ${error?.message ?? String(error)}`);
      return {
        leads: [...byKey.values()],
        stopReason: 'leg_threw',
        completedLegs,
        problems,
      };
    }

    let fresh = 0;
    for (const lead of result.leads) {
      if (!byKey.has(lead.key)) {
        byKey.set(lead.key, lead);
        fresh += 1;
      }
    }

    completedLegs = i + 1;
    if (fresh > 0) onLeads(result.leads);

    onProgress({
      legIndex: i,
      totalLegs: legs.length,
      leg,
      legLeads: result.leads.length,
      freshLeads: fresh,
      uniqueLeads: byKey.size,
      stopReason: result.stopReason,
    });

    if (result.stopReason === 'blocked' || result.stopReason === 'canary_failed') {
      problems.push(...result.problems);
      return { leads: [...byKey.values()], stopReason: result.stopReason, completedLegs, problems };
    }

    if (signal?.aborted) {
      return { leads: [...byKey.values()], stopReason: 'aborted', completedLegs, problems };
    }

    if (i + 1 < legs.length) await delay(nextDelayMs());
  }

  return { leads: [...byKey.values()], stopReason: 'completed', completedLegs, problems };
}
