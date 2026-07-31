import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readReviewPanel, assertSelectorsAlive, statedReviewCount, hasReviewsUi, REVIEW_SELECTORS,
} from '../src/sources/google-dom.js';

/**
 * The smallest thing satisfying the document interface google-dom.js documents.
 *
 * Deliberately not a DOM library. The reader was designed against four methods and a
 * textContent, so the fake is four methods and a textContent, and anything the reader
 * starts relying on beyond that will fail here rather than only in a browser.
 */
function node({ matches = {}, text = '', attrs = {} } = {}) {
  return {
    textContent: text,
    getAttribute: (name) => attrs[name] ?? null,
    querySelector: (sel) => (matches[sel] ? matches[sel][0] ?? null : null),
    querySelectorAll: (sel) => matches[sel] ?? [],
  };
}

function review({ date = 'a year ago', reply = false, sponsored = false } = {}) {
  const matches = { [REVIEW_SELECTORS.date]: [node({ text: date })] };
  if (reply) matches[REVIEW_SELECTORS.ownerReply] = [node({ text: 'Response from the owner' })];
  if (sponsored) matches[REVIEW_SELECTORS.sponsored] = [node()];
  return node({ matches });
}

/**
 * `countLabel` puts the figure in aria-label, which is where the LIVE page keeps it.
 * `countText` puts it in textContent. Both are supported and both are tested, because
 * an earlier version read only text and its drift canary was inert on every real page.
 */
/**
 * `hasSort` models the sort control, which is how the reader tells "this business has
 * no reviews" from "this page has reviews we failed to read". `ratingLabel` models
 * the star label the count is parsed from.
 *
 * Counting was tried first and abandoned. The live page keeps the figure in labels
 * like "4.8 stars 25 Reviews", the entire search results list stays in the DOM beside
 * the open place, and the panel carries "mentioned in 3 reviews" chips as well. Every
 * count on the page might belong to a different business.
 */
function panel({ rows = [], hasSort = false, ratingLabel = null } = {}) {
  const matches = { [REVIEW_SELECTORS.row]: rows };
  if (hasSort) matches[REVIEW_SELECTORS.sortControl] = [node({ attrs: { 'aria-label': 'Sort reviews' } })];
  if (ratingLabel !== null) {
    matches[REVIEW_SELECTORS.ratingLabel] = [node({ attrs: { 'aria-label': ratingLabel } })];
  }
  return node({ matches });
}

test('reads the newest date and whether the owner replies', () => {
  const doc = panel({
    rows: [review({ date: '3 days ago' }), review({ date: 'a year ago', reply: true })],
    hasSort: true,
  });
  const out = readReviewPanel(doc);
  assert.equal(out.lastReviewDays, 3);
  assert.equal(out.ownerReplies, true);
  assert.equal(out.reviewsSeen, 2);
  assert.equal(out.precise, true);
});

test('an owner who has replied to NO review reads false, not null', () => {
  // We looked at real rows and found no reply. That is an observation and the
  // operator's "no owner replies" filter depends on it being one.
  const out = readReviewPanel(panel({ rows: [review(), review()], hasSort: true }));
  assert.equal(out.ownerReplies, false);
});

test('A PAGE WITH REVIEWS WE FAILED TO READ REPORTS NULL, NOT FALSE AND ZERO', () => {
  // The case that matters most. The sort control proves this business HAS reviews, so
  // zero rows means we failed to read them. Returning false and 0 would record it as a
  // business whose owner never replies and which was reviewed today: two confident
  // facts nobody established, both of which the operator can filter on.
  const out = readReviewPanel(panel({ rows: [], hasSort: true }));
  assert.equal(out.ownerReplies, null, 'must not claim the owner never replies');
  assert.equal(out.lastReviewDays, null, 'must not claim a review today');
  assert.equal(out.reviewsSeen, 0);
});

test('a business with no reviews is a real observation, not a failure', () => {
  // No rows AND no sort control: there is nothing to sort because there is nothing
  // there. Nobody has replied because nobody has reviewed, and that is knowable.
  const out = readReviewPanel(panel({ rows: [], hasSort: false }));
  assert.equal(out.ownerReplies, false, 'zero reviews means zero replies');
  assert.equal(out.lastReviewDays, null, 'but there is still no review date to report');
});

test('a sponsored card is not a review', () => {
  // An advert carrying a recent date would make a dormant business look active,
  // which is the direction that costs the operator a wasted call.
  const doc = panel({
    rows: [review({ date: 'just now', sponsored: true }), review({ date: 'a year ago' })],
    hasSort: true,
  });
  const out = readReviewPanel(doc);
  assert.equal(out.reviewsSeen, 1, 'the advert must not be counted');
  assert.equal(out.lastReviewDays, 365, 'nor may it supply the newest date');
});

test('a row whose date is missing does not become a review from today', () => {
  const dateless = node({ matches: {} });
  const out = readReviewPanel(panel({ rows: [dateless, review({ date: '5 days ago' })], hasSort: true }));
  assert.equal(out.lastReviewDays, 5);
});

test('the count is parsed from the live star-label shape', () => {
  // Measured 2026-07-31: labels read "4.8 stars 25 Reviews". Not load-bearing for the
  // canary any more, but still the only reliably formatted count on the page.
  assert.equal(statedReviewCount(panel({ ratingLabel: '4.8 stars 25 Reviews' })), 25);
  assert.equal(statedReviewCount(panel({ ratingLabel: '4.9 stars 1,284 Reviews' })), 1284);
  assert.equal(statedReviewCount(panel({})), null);
});

test('THE CANARY KEYS ON THE SORT CONTROL, not on any count', () => {
  // Counting was tried against the live page and abandoned. The figure lives in star
  // labels, the whole results list stays in the DOM beside the open place, and topic
  // chips are phrased "mentioned in 3 reviews", so every number is ambiguous. The
  // sort control exists only when there is something to sort and cannot belong to a
  // different business.
  assert.equal(hasReviewsUi(panel({ hasSort: true })), true);
  assert.equal(hasReviewsUi(panel({ ratingLabel: '4.8 stars 25 Reviews' })), false,
    'a count alone must not be read as proof that reviews rendered');
});



test('SELECTOR DRIFT THROWS, rather than reporting nulls for every business', () => {
  // The failure this exists to prevent: div.jftiEf stops matching, every business
  // returns "no reviews seen", and the operator reads a column of nulls as sparse
  // data rather than as a broken tool. The payload has a canary for the same reason.
  const broken = panel({ rows: [], hasSort: true });
  assert.throws(() => assertSelectorsAlive(broken), /markup has changed|matched no reviews/i);
});

test('a genuinely reviewless business does not trip the drift alarm', () => {
  assert.doesNotThrow(() => assertSelectorsAlive(panel({ rows: [], hasSort: false })));
  assert.doesNotThrow(() => assertSelectorsAlive(panel({ rows: [review()], hasSort: true })));
});

test('every selector lives in one frozen object', () => {
  // These are the most volatile values in the project. One place to re-derive them
  // when Maps ships, and a test that fails if someone inlines a class name elsewhere.
  assert.ok(Object.isFrozen(REVIEW_SELECTORS));
  for (const [name, value] of Object.entries(REVIEW_SELECTORS)) {
    assert.equal(typeof value, 'string', `${name} must be a selector string`);
    assert.ok(value.length > 0, `${name} must not be empty`);
  }
});
