import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelativeDate, newestReviewDays } from '../src/sources/review-dates.js';

test('Google writes the singular as an article, and that is the live form', () => {
  // Measured on live Maps 2026-07-31: the text read "a year ago", not "1 year ago".
  // A parser accepting only the numeral form would pass every hand-written test and
  // return null on every real review.
  assert.deepEqual(parseRelativeDate('a year ago'), { days: 365, precise: false });
  assert.deepEqual(parseRelativeDate('a day ago'), { days: 1, precise: true });
  assert.deepEqual(parseRelativeDate('an hour ago'), { days: 0, precise: true });
});

test('the numeral form parses too', () => {
  assert.equal(parseRelativeDate('3 days ago').days, 3);
  assert.equal(parseRelativeDate('2 weeks ago').days, 14);
  assert.equal(parseRelativeDate('6 months ago').days, 180);
});

test('day and week granularity is exact, because the shortest filter is 3 days', () => {
  // The operator asked for a "last 3 days" and a "last week" option specifically, so
  // these two units are the ones that must not be approximated.
  assert.equal(parseRelativeDate('3 days ago').days, 3);
  assert.equal(parseRelativeDate('1 week ago').days, 7);
  assert.equal(parseRelativeDate('a week ago').days, 7);
  assert.equal(parseRelativeDate('3 days ago').precise, true);
  assert.equal(parseRelativeDate('a week ago').precise, true);
});

test('months and years are marked imprecise, so the export cannot overstate them', () => {
  // "6 months ago" is somewhere between about 152 and 195 days. Reporting a bare
  // number without the caveat invites the operator to filter on a precision that
  // does not exist.
  assert.equal(parseRelativeDate('6 months ago').precise, false);
  assert.equal(parseRelativeDate('2 years ago').precise, false);
  assert.equal(parseRelativeDate('3 weeks ago').precise, true);
});

test('"just now" and its variants mean zero days, not unparseable', () => {
  for (const text of ['just now', 'a moment ago', 'a few seconds ago', 'Now']) {
    assert.deepEqual(parseRelativeDate(text), { days: 0, precise: true }, text);
  }
});

test('an edited review still parses', () => {
  // Google prefixes these with "Edited". Dropping them would silently lose the
  // most engaged reviews, which are the ones most likely to have been edited.
  assert.equal(parseRelativeDate('Edited 2 days ago').days, 2);
});

test('UNPARSEABLE TEXT IS NULL, NEVER ZERO', () => {
  // The single most important case here. Zero means "reviewed today", which is the
  // exact opposite of what an unreadable date tells us. A zero would make a dormant
  // business look active and let it escape the dormancy modifier that exists to
  // catch exactly that business.
  for (const text of ['', '   ', 'yesterday', 'last summer', 'a year', '5 fortnights ago', null, undefined, 42]) {
    const result = parseRelativeDate(text);
    assert.equal(result.days, null, `${JSON.stringify(text)} must be null, got ${result.days}`);
    assert.notEqual(result.days, 0, `${JSON.stringify(text)} must not read as reviewed today`);
  }
});

test('the newest of several dates wins', () => {
  assert.equal(newestReviewDays(['a year ago', '3 days ago', '2 months ago']).days, 3);
});

test('one unreadable row cannot drag the age down to zero', () => {
  // If an unparseable entry were treated as recent, a single rendering oddity would
  // make a business that has not been reviewed in a year look like it was reviewed
  // today, which is the most damaging direction this can fail in.
  assert.equal(newestReviewDays(['a year ago', 'sometime last spring']).days, 365);
});

test('dates that ALL fail to parse yield null, not the best of nothing', () => {
  assert.deepEqual(newestReviewDays(['whenever', 'ages ago']), { days: null, precise: false });
  assert.deepEqual(newestReviewDays([]), { days: null, precise: false });
  assert.deepEqual(newestReviewDays(undefined), { days: null, precise: false });
});

test('the precision flag follows the winning date, not the others', () => {
  // A precise 3-day reading must not be marked imprecise just because an older
  // "a year ago" was also on the page.
  assert.deepEqual(newestReviewDays(['a year ago', '3 days ago']), { days: 3, precise: true });
  assert.deepEqual(newestReviewDays(['2 years ago', '6 months ago']), { days: 180, precise: false });
});
