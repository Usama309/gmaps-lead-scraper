import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead } from '../src/core/schema.js';
import { filterLeads, DEFAULT_FILTER_STATE } from '../src/pipeline/filter.js';

let n = 0;
function lead(overrides = {}) {
  n += 1;
  return makeLead({
    cid: `0x${n}:0x${n}`,
    name: `Business ${n}`,
    phone: '+92 300 000 0000',
    rating: 4.5,
    reviewCount: 100,
    categories: ['Hardware store'],
    enriched: true,
    mobileFriendly: true,
    hasBooking: false,
    website: 'https://example.pk',
    websiteTech: 'wordpress',
    ...overrides,
  });
}

function run(leads, patch = {}) {
  return filterLeads(leads, { ...DEFAULT_FILTER_STATE, ...patch });
}

test('default state passes everything and attaches a score', () => {
  const out = run([lead(), lead()]);
  assert.equal(out.length, 2);
  assert.ok(Number.isInteger(out[0].score));
  assert.ok(Array.isArray(out[0].reasons));
});

test('results are sorted by score descending by default', () => {
  const out = run([lead({ websiteTech: 'next' }), lead({ website: null })]);
  assert.ok(out[0].score > out[1].score);
});

test('minScore filters', () => {
  const out = run([lead({ website: null }), lead({ websiteTech: 'next' })], { minScore: 50 });
  assert.equal(out.length, 1);
});

test('minRating and maxReviews filter', () => {
  assert.equal(run([lead({ rating: 3.9 }), lead({ rating: 4.8 })], { minRating: 4.5 }).length, 1);
  assert.equal(run([lead({ reviewCount: 50 }), lead({ reviewCount: 900 })], { maxReviews: 500 }).length, 1);
  assert.equal(run([lead({ reviewCount: 5 }), lead({ reviewCount: 50 })], { minReviews: 10 }).length, 1);
});

test('website tri-state filters on real websites, not the raw field', () => {
  const facebook = lead({ website: 'https://facebook.com/x' });
  const real = lead({ website: 'https://real.pk', websiteTech: 'wordpress' });
  const none = lead({ website: null });
  assert.equal(run([facebook, real, none], { website: 'no' }).length, 2,
    'a Facebook page counts as having no real website');
  assert.equal(run([facebook, real, none], { website: 'yes' }).length, 1);
});

test('hasPhone filters', () => {
  assert.equal(run([lead({ phone: null }), lead()], { hasPhone: 'yes' }).length, 1);
});

test('tech multi-select filters, empty means any', () => {
  const leads = [lead({ websiteTech: 'wix' }), lead({ websiteTech: 'wordpress' }), lead({ website: null })];
  assert.equal(run(leads, { tech: [] }).length, 3);
  assert.equal(run(leads, { tech: ['wix'] }).length, 1);
  assert.equal(run(leads, { tech: ['wix', 'wordpress'] }).length, 2);
  assert.equal(run(leads, { tech: ['none'] }).length, 1);
});

test('mobile, booking, chatbot and email tri-states filter', () => {
  assert.equal(run([lead({ mobileFriendly: false }), lead()], { mobileFriendly: 'no' }).length, 1);
  assert.equal(run([lead({ hasBooking: true }), lead()], { hasBooking: 'no' }).length, 1);
  assert.equal(run([lead({ hasChatbot: true }), lead({ hasChatbot: false })], { hasChatbot: 'no' }).length, 1);
  assert.equal(run([lead({ email: 'a@b.com' }), lead()], { hasEmail: 'yes' }).length, 1);
});

test('a "no X" filter never returns a lead whose X was never inspected', () => {
  // An unenriched null means "we have not looked". Treating it as confirmed
  // absent would put un-inspected businesses into a list the operator trusts.
  const FIELD_FOR = {
    hasEmail: 'email', hasSocials: 'socials', hasBooking: 'hasBooking',
    hasChatbot: 'hasChatbot', ownerReplies: 'ownerReplies',
  };
  for (const [filterKey, field] of Object.entries(FIELD_FOR)) {
    const unlooked = lead({ enriched: false, [field]: null });
    const looked = lead({ enriched: true, [field]: null });
    const out = run([unlooked, looked], { [filterKey]: 'no' }).map((l) => l.name);
    assert.deepEqual(out, [looked.name],
      `${filterKey} leaked an un-inspected lead into a 'no' filter`);
  }
});

test('a "no" filter does match a lead enrichment checked and found empty', () => {
  const cases = [
    ['hasEmail', { email: null }],
    ['hasSocials', { socials: [] }],
    ['hasBooking', { hasBooking: false }],
    ['hasChatbot', { hasChatbot: false }],
    ['ownerReplies', { ownerReplies: false }],
  ];
  for (const [key, absent] of cases) {
    const looked = lead({ ...absent, enriched: true });
    assert.equal(run([looked], { [key]: 'no' }).length, 1,
      `${key}:'no' must include an enriched lead confirmed to lack it`);
  }
});

test('mobileFriendly "no" treats a partial site as failing mobile', () => {
  const leads = [
    lead({ mobileFriendly: false, enriched: true }),
    lead({ mobileFriendly: 'partial', enriched: true }),
    lead({ mobileFriendly: true, enriched: true }),
    lead({ mobileFriendly: null, enriched: false }),
  ];
  const no = run(leads, { mobileFriendly: 'no' }).map((l) => l.mobileFriendly);
  assert.equal(no.length, 2, 'a partially responsive site is still a redesign lead');
  assert.ok(no.includes(false));
  assert.ok(no.includes('partial'));
  assert.ok(!no.includes(true));
  assert.ok(!no.includes(null), 'an uninspected site is not a confirmed mobile failure');
});

test('mobileFriendly "yes" matches only a properly responsive site', () => {
  const leads = [
    lead({ mobileFriendly: false, enriched: true }),
    lead({ mobileFriendly: 'partial', enriched: true }),
    lead({ mobileFriendly: true, enriched: true }),
    lead({ mobileFriendly: null, enriched: false }),
  ];
  const yes = run(leads, { mobileFriendly: 'yes' }).map((l) => l.mobileFriendly);
  assert.deepEqual(yes, [true]);
});

test('ownerReplies tri-state filters', () => {
  assert.equal(run([lead({ ownerReplies: true }), lead({ ownerReplies: false })], { ownerReplies: 'yes' }).length, 1);
});

test('lastReviewWithinDays filters and excludes unknown recency', () => {
  const leads = [lead({ lastReviewDays: 3 }), lead({ lastReviewDays: 40 }), lead({ lastReviewDays: null })];
  assert.equal(run(leads, { lastReviewWithinDays: 7 }).length, 1);
  assert.equal(run(leads, { lastReviewWithinDays: 0 }).length, 3, '0 means any time');
});

test('categories filter matches case-insensitively on any category', () => {
  const leads = [lead({ categories: ['Dentist'] }), lead({ categories: ['Bakery'] })];
  assert.equal(run(leads, { categories: ['dentist'] }).length, 1);
  assert.equal(run(leads, { categories: [] }).length, 2);
});

test('socials filter requires at least one link', () => {
  const leads = [lead({ socials: ['facebook'] }), lead({ socials: [] })];
  assert.equal(run(leads, { hasSocials: 'yes' }).length, 1);
});

test('skipExported removes leads whose key is in the exported set', () => {
  const a = lead(); const b = lead();
  const out = run([a, b], { skipExported: true, exportedKeys: new Set([a.key]) });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, b.key);
});

test('skipExported is ignored when the toggle is off', () => {
  const a = lead(); const b = lead();
  assert.equal(run([a, b], { skipExported: false, exportedKeys: new Set([a.key]) }).length, 2);
});

test('permanently closed businesses are always excluded', () => {
  assert.equal(run([lead({ permanentlyClosed: true }), lead()]).length, 1);
});

test('filterLeads does not mutate its input', () => {
  const input = [lead()];
  const snapshot = JSON.stringify(input);
  filterLeads(input, DEFAULT_FILTER_STATE);
  assert.equal(JSON.stringify(input), snapshot);
});

test('every filter key in DEFAULT_FILTER_STATE is documented in the spec set', () => {
  const expected = [
    'keywords', 'location', 'lat', 'lng', 'zoom', 'radiusKm', 'categories',
    'minRating', 'openNow',
    'minReviews', 'maxReviews', 'hasPhone', 'website', 'ownerReplies', 'lastReviewWithinDays',
    'hasEmail', 'tech', 'mobileFriendly', 'hasChatbot', 'hasBooking', 'hasSocials',
    'minScore', 'skipExported', 'exportedKeys', 'sortBy', 'sortDir',
  ];
  assert.deepEqual(Object.keys(DEFAULT_FILTER_STATE).sort(), expected.sort());
});
