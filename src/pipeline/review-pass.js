import { CONFIG } from '../core/config.js';
import { nextDelayMs } from './guard.js';

/**
 * Walk a set of leads through the rendered Maps place panel, reading owner replies
 * and review recency.
 *
 * ## Why this file is careful in a way the other pipelines are not
 *
 * Every other stage in this product fetches with `credentials: 'omit'`, so no Google
 * account is attached and there is nothing to trace back to the operator. This stage
 * cannot: the reviews only exist once a page has rendered, and a page renders in a
 * real session. It is the one attributable thing the product does.
 *
 * That single fact drives the rest of the design. It stops dead on the first sign of
 * a block rather than pushing through, it paces on the same throttle as the
 * harvester rather than inventing a faster one, and it is resumable because a
 * 500-lead pass takes nearly two hours and something WILL interrupt it.
 *
 * ## The driver contract
 *
 * The browser half is injected, so every test here runs in bare Node with no browser
 * and no DOM. A driver provides:
 *
 *   open(url)   -> { ok: true } | { blocked: true, reason }
 *   click(step) -> boolean, where step is 'reviewsTab' | 'sortMenu' | 'sortNewest'
 *   read()      -> { ownerReplies, lastReviewDays, precise, reviewsSeen }
 *                  and THROWS if the selectors have drifted
 *
 * `click` takes a step name rather than a selector because the selectors belong to
 * google-dom.js, which is the only file allowed to hold one. This file orchestrates;
 * it does not know what a review looks like.
 */

/** Reasons that stop the WHOLE pass rather than just the current lead. */
export const HALTING_REASONS = Object.freeze(['blocked', 'selector_drift', 'aborted']);

const TERMINAL = Object.freeze(['completed', 'completed_with_errors', ...HALTING_REASONS]);

export function assertPassReason(reason) {
  if (!TERMINAL.includes(reason)) {
    throw new Error(`unknown review pass reason: ${JSON.stringify(reason)}`);
  }
  return reason;
}

/**
 * Has this lead been read recently enough to skip?
 *
 * Skipping is keyed on when we last READ it, not on whether the fields are set. A
 * business with no reviews legitimately has null recency forever, and keying on the
 * value would re-read it on every pass for the rest of its life.
 */
export function isFresh(lead, now) {
  if (!lead?.reviewsReadAt) return false;
  const readAt = new Date(lead.reviewsReadAt).getTime();
  if (!Number.isFinite(readAt)) return false;

  const ageDays = (now - readAt) / 86400000;
  // A future timestamp means the clock moved and the record cannot be trusted, so it
  // is re-read rather than believed. Same rule as the domain cache in db.js.
  return ageDays >= 0 && ageDays <= CONFIG.reviewPass.recheckAfterDays;
}

/** The place URL for a lead. Requires a placeId; a CID alone will not open a panel. */
export function placeUrl(lead) {
  if (!lead?.placeId) return null;
  return CONFIG.reviewPass.placeUrlPrefix + encodeURIComponent(lead.placeId);
}

/** Estimated minutes, so the operator can be told the cost before a run starts. */
export function estimateMinutes(leadCount) {
  return Math.ceil((leadCount * CONFIG.reviewPass.secondsPerLead) / 60);
}

/**
 * Read one lead.
 *
 * The sort click is MANDATORY, not an optimisation. Maps defaults its review list to
 * "Most relevant", so without it the first row is not the latest review and
 * `lastReviewDays` is simply a wrong number rather than a missing one. Measured live
 * on 2026-07-31: the menu offers exactly Most relevant, Newest, Highest rating,
 * Lowest rating.
 *
 * If the sort cannot be applied we return no recency at all rather than the
 * most-relevant row's date. A missing value is honest; a confidently wrong one is
 * what the operator would filter on.
 */
async function readOneLead(lead, driver) {
  const url = placeUrl(lead);
  if (!url) return { status: 'skipped', reason: 'no placeId, so no panel to open' };

  const opened = await driver.open(url);
  if (opened?.blocked) return { status: 'blocked', reason: opened.reason ?? 'blocked' };

  if (!await driver.click('reviewsTab')) {
    return { status: 'failed', reason: 'the reviews tab did not open' };
  }

  const sorted = await driver.click('sortMenu') && await driver.click('sortNewest');
  if (!sorted) {
    return { status: 'failed', reason: 'could not sort by newest, so any date read would be the most relevant review rather than the latest' };
  }

  // Drift throws, and must not be caught here: it means every remaining lead would
  // report nulls, so the caller has to stop rather than grind through the queue.
  const panel = await driver.read();
  return { status: 'read', panel };
}

/**
 * Run the pass.
 *
 * Mirrors `runHarvest`'s resume contract deliberately, including the rule that a
 * FAILED lead does not advance the counter. Advancing past a failure means a resume
 * skips it permanently, which in the harvester silently lost a slice of the market
 * and here would silently lose a business the operator is about to call.
 */
export async function runReviewPass({
  leads,
  driver,
  now = () => Date.now(),
  signal = null,
  startAt = 0,
  onProgress = () => {},
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!driver || typeof driver.open !== 'function') {
    throw new Error('runReviewPass requires a driver with open, click and read');
  }
  if (!Number.isInteger(startAt) || startAt < 0 || startAt > leads.length) {
    throw new Error(
      `runReviewPass requires startAt within 0..${leads.length}, got ${JSON.stringify(startAt)}. `
      + 'An out-of-range resume would read nothing and report success.'
    );
  }

  const patches = [];
  const problems = [];
  let completedLeads = startAt;
  let firstFailed = null;
  let skipped = 0;

  const finish = (reason) => ({
    patches,
    stopReason: assertPassReason(reason),
    completedLeads,
    skipped,
    problems,
  });

  for (let i = startAt; i < leads.length; i += 1) {
    if (signal?.aborted) return finish('aborted');

    const lead = leads[i];

    // Freshness is checked BEFORE the counter moves, and a skip still counts as
    // done: there is nothing to retry on a resume.
    if (isFresh(lead, now())) {
      skipped += 1;
      completedLeads = firstFailed ?? (i + 1);
      onProgress({ index: i, total: leads.length, lead, status: 'fresh', completedLeads });
      continue;
    }

    let outcome;
    try {
      outcome = await readOneLead(lead, driver);
    } catch (error) {
      // The reader throws only on selector drift, which is not survivable: every
      // remaining lead would return nulls that read as sparse data.
      problems.push(`selectors have drifted while reading ${lead.name ?? lead.key}: ${error?.message ?? String(error)}`);
      return finish('selector_drift');
    }

    if (outcome.status === 'blocked') {
      // Never push through a block. This is the attributable stage, so pushing
      // through costs more here than anywhere else in the product.
      problems.push(`blocked while reading ${lead.name ?? lead.key}: ${outcome.reason}`);
      return finish('blocked');
    }

    if (outcome.status === 'read') {
      patches.push({
        key: lead.key,
        ownerReplies: outcome.panel.ownerReplies,
        lastReviewDays: outcome.panel.lastReviewDays,
        lastReviewPrecise: outcome.panel.precise,
        reviewsReadAt: new Date(now()).toISOString(),
      });
    } else {
      problems.push(`${lead.name ?? lead.key}: ${outcome.reason}`);
      if (outcome.status === 'failed' && firstFailed === null) firstFailed = i;
    }

    completedLeads = firstFailed ?? (i + 1);
    onProgress({ index: i, total: leads.length, lead, status: outcome.status, completedLeads });

    if (signal?.aborted) return finish('aborted');
    if (i + 1 < leads.length) await delay(nextDelayMs());
  }

  return finish(problems.length > 0 ? 'completed_with_errors' : 'completed');
}
