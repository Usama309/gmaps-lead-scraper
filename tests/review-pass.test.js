import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReviewPass, isFresh, placeUrl, estimateMinutes, HALTING_REASONS,
} from '../src/pipeline/review-pass.js';
import { CONFIG } from '../src/core/config.js';

const NOW = Date.UTC(2026, 6, 31);
const now = () => NOW;

function lead(n, extra = {}) {
  return { key: `k${n}`, name: `Business ${n}`, placeId: `ChIJPlace${n}`, ...extra };
}

/**
 * A driver that records the exact sequence of steps asked of it.
 *
 * The sequence is the point of most of these tests: the sort click is mandatory, and
 * a driver that silently skipped it would still return a plausible date.
 */
function fakeDriver({ panel = null, blockAt = null, failStep = null, throwOnRead = false } = {}) {
  const steps = [];
  let opens = 0;
  return {
    steps,
    get opens() { return opens; },
    open: async (url) => {
      steps.push(`open:${url}`);
      opens += 1;
      if (blockAt !== null && opens >= blockAt) return { blocked: true, reason: 'HTTP 429' };
      return { ok: true };
    },
    click: async (step) => {
      steps.push(`click:${step}`);
      return step !== failStep;
    },
    read: async () => {
      steps.push('read');
      if (throwOnRead) throw new Error('div.jftiEf matched no reviews');
      return panel ?? { ownerReplies: false, lastReviewDays: 12, precise: true, reviewsSeen: 8 };
    },
  };
}

const run = (leads, driver, extra = {}) =>
  runReviewPass({ leads, driver, now, delay: async () => {}, ...extra });

test('a lead is read through tab, sort menu, newest, then read, in that order', async () => {
  // The sort click is MANDATORY. Maps defaults to "Most relevant", so without it the
  // first row is not the latest review and lastReviewDays is a confidently wrong
  // number rather than a missing one.
  const driver = fakeDriver();
  await run([lead(1)], driver);
  assert.deepEqual(driver.steps, [
    `open:${placeUrl(lead(1))}`,
    'click:reviewsTab',
    'click:sortMenu',
    'click:sortNewest',
    'read',
  ]);
});

test('IF SORTING FAILS, NO DATE IS RECORDED AT ALL', async () => {
  // The tempting alternative is to read the most-relevant row anyway and store its
  // date. That is worse than storing nothing: the operator filters on recency, and a
  // wrong number is indistinguishable from a right one.
  const driver = fakeDriver({ failStep: 'sortNewest' });
  const result = await run([lead(1)], driver);
  assert.equal(result.patches.length, 0, 'nothing may be stored from an unsorted list');
  assert.ok(result.problems.some((p) => /sort/i.test(p)));
  assert.ok(!driver.steps.includes('read'), 'and it must not even read');
});

test('a successful read produces a patch carrying when it was read', async () => {
  const driver = fakeDriver({ panel: { ownerReplies: true, lastReviewDays: 3, precise: true, reviewsSeen: 10 } });
  const { patches } = await run([lead(1)], driver);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].ownerReplies, true);
  assert.equal(patches[0].lastReviewDays, 3);
  assert.equal(patches[0].lastReviewPrecise, true);
  assert.equal(patches[0].reviewsReadAt, new Date(NOW).toISOString());
});

test('A BLOCK STOPS THE WHOLE PASS, it does not skip one lead', async () => {
  // This is the attributable stage, so pushing through a block costs more here than
  // anywhere else in the product.
  const driver = fakeDriver({ blockAt: 2 });
  const result = await run([lead(1), lead(2), lead(3)], driver);
  assert.equal(result.stopReason, 'blocked');
  assert.ok(HALTING_REASONS.includes(result.stopReason));
  assert.equal(driver.opens, 2, 'it must not open the third lead');
  assert.equal(result.patches.length, 1, 'and it keeps what it already read');
});

test('SELECTOR DRIFT STOPS THE WHOLE PASS TOO', async () => {
  // Drift means every remaining lead would return nulls that read as sparse data.
  // Grinding through 500 of those is the failure this prevents.
  const driver = fakeDriver({ throwOnRead: true });
  const result = await run([lead(1), lead(2)], driver);
  assert.equal(result.stopReason, 'selector_drift');
  assert.equal(driver.opens, 1);
  assert.ok(result.problems.some((p) => /drift/i.test(p)));
});

test('a failed lead does not advance the resume point', async () => {
  // Mirrors runHarvest exactly. Advancing past a failure means a resume skips it
  // permanently, which in the harvester silently lost a slice of the market and here
  // would silently lose a business the operator is about to call.
  const driver = fakeDriver({ failStep: 'reviewsTab' });
  const result = await run([lead(1), lead(2), lead(3)], driver);
  assert.equal(result.completedLeads, 0, 'the first failure is the resume point');
  assert.equal(result.stopReason, 'completed_with_errors');
});

test('a clean pass advances the resume point to the end', async () => {
  const result = await run([lead(1), lead(2)], fakeDriver());
  assert.equal(result.completedLeads, 2);
  assert.equal(result.stopReason, 'completed');
});

test('resuming starts where it stopped, not from the beginning', async () => {
  const driver = fakeDriver();
  await runReviewPass({ leads: [lead(1), lead(2), lead(3)], driver, now, delay: async () => {}, startAt: 2 });
  assert.equal(driver.opens, 1, 'only the remaining lead is opened');
  assert.ok(driver.steps[0].includes('ChIJPlace3'));
});

test('an out-of-range resume throws instead of silently reading nothing', async () => {
  await assert.rejects(
    () => runReviewPass({ leads: [lead(1)], driver: fakeDriver(), now, startAt: 5 }),
    /startAt/i,
  );
});

test('abort keeps everything already read', async () => {
  const controller = new AbortController();
  const driver = fakeDriver();
  const leads = [lead(1), lead(2), lead(3)];
  const result = await runReviewPass({
    leads, driver, now, signal: controller.signal,
    delay: async () => { controller.abort(); },
  });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.patches.length, 1, 'the completed read survives the abort');
});

test('a lead read recently is skipped, and the skip is counted', async () => {
  const fresh = lead(1, { reviewsReadAt: new Date(NOW - 5 * 86400000).toISOString() });
  const driver = fakeDriver();
  const result = await run([fresh, lead(2)], driver);
  assert.equal(driver.opens, 1, 'the fresh lead costs no page load');
  assert.equal(result.skipped, 1);
  assert.equal(result.completedLeads, 2, 'a skip still counts as done, there is nothing to retry');
});

test('freshness is keyed on WHEN WE READ, not on whether a value came back', async () => {
  // A business with no reviews legitimately has null recency forever. Keying on the
  // value would re-read it every pass for the rest of its life, at 13 seconds a time.
  const readButEmpty = lead(1, { reviewsReadAt: new Date(NOW - 86400000).toISOString(), lastReviewDays: null });
  assert.equal(isFresh(readButEmpty, NOW), true);
});

test('a stale or impossible read timestamp means re-read, never trust', async () => {
  const stale = lead(1, { reviewsReadAt: new Date(NOW - (CONFIG.reviewPass.recheckAfterDays + 1) * 86400000).toISOString() });
  const future = lead(2, { reviewsReadAt: new Date(NOW + 86400000).toISOString() });
  const corrupt = lead(3, { reviewsReadAt: 'not a date' });
  assert.equal(isFresh(stale, NOW), false);
  assert.equal(isFresh(future, NOW), false, 'a future stamp means the clock moved');
  assert.equal(isFresh(corrupt, NOW), false);
  assert.equal(isFresh(lead(4), NOW), false);
});

test('a lead with no placeId is skipped rather than opening a broken URL', async () => {
  const driver = fakeDriver();
  const result = await run([lead(1, { placeId: null })], driver);
  assert.equal(driver.opens, 0);
  assert.ok(result.problems.some((p) => /placeId/i.test(p)));
});

test('the pass is throttled between leads, on the harvester\'s own timer', async () => {
  // Not a second pacing scheme. This stage is the most detectable thing the product
  // does, so it must not be the least patient.
  const delays = [];
  await runReviewPass({
    leads: [lead(1), lead(2), lead(3)], driver: fakeDriver(), now,
    delay: async (ms) => { delays.push(ms); },
  });
  assert.equal(delays.length, 2, 'between leads, not after the last one');
  for (const ms of delays) {
    assert.ok(ms >= CONFIG.harvest.delayMs.min && ms <= CONFIG.harvest.delayMs.max, `delay ${ms} is off the configured throttle`);
  }
});

test('the cost estimate comes from the measured per-lead figure', () => {
  // 500 leads is nearly two hours, and the operator is told before it starts.
  assert.equal(estimateMinutes(0), 0);
  assert.equal(estimateMinutes(30), Math.ceil((30 * CONFIG.reviewPass.secondsPerLead) / 60));
  assert.ok(estimateMinutes(500) >= 100, 'a 500-lead pass must be reported as the hours it is');
});

test('placeUrl needs a placeId, since a CID alone opens no panel', () => {
  assert.equal(placeUrl({ placeId: null, cid: '0xa:0xb' }), null);
  assert.ok(placeUrl({ placeId: 'ChIJx' }).startsWith(CONFIG.reviewPass.placeUrlPrefix));
});

test('the estimate the UI shows is the same one the worker sends', () => {
  // Two places tell the operator what a pass will cost. If they disagree, one of them
  // is lying, and the button is the one they read first.
  for (const n of [1, 30, 83, 500]) {
    assert.equal(estimateMinutes(n), Math.ceil((n * CONFIG.reviewPass.secondsPerLead) / 60));
  }
});

test('a resume point of zero is only reported for a genuinely complete pass', async () => {
  // The dashboard stores completedLeads as the next startAt and resets to 0 only on
  // 'completed'. A halt that reported completedLeads equal to the total would make
  // the next press silently do nothing.
  const driver = fakeDriver({ blockAt: 2 });
  const result = await run([lead(1), lead(2), lead(3)], driver);
  assert.equal(result.stopReason, 'blocked');
  assert.ok(result.completedLeads < 3, 'a blocked pass must leave work to resume');
  assert.ok(result.completedLeads >= 1, 'and must not throw away what it finished');
});
