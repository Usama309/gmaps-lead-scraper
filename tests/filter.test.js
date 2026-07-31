import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeLead } from '../src/core/schema.js';
import { filterLeads, DEFAULT_FILTER_STATE, countHiddenByExportSkip } from '../src/pipeline/filter.js';

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

test('BLOCKER: the default filter survives the message boundary', () => {
  // DEFAULT_FILTER_STATE crosses chrome.runtime.sendMessage, which serialises as
  // JSON. Infinity has no JSON form and arrived as null, after which
  // `reviewCount > null` compares against zero, so the default filter kept ONLY
  // businesses with no reviews at all. Every in-process test passed, because
  // Infinity works fine until it is serialised.
  const leads = [lead({ reviewCount: 120 }), lead({ reviewCount: 4 }), lead({ reviewCount: 0 })];

  const inProcess = filterLeads(leads, DEFAULT_FILTER_STATE);
  const overTheWire = filterLeads(leads, JSON.parse(JSON.stringify(DEFAULT_FILTER_STATE)));

  assert.equal(inProcess.length, 3, 'the default filter caps nothing');
  assert.equal(overTheWire.length, 3,
    `serialising the default state dropped ${inProcess.length - overTheWire.length} leads`);
});

test('every default filter value survives JSON, since the UI sends this over a port', () => {
  // Guards the whole object rather than the one field that bit us. Any future
  // non-serialisable default fails here instead of silently in production.
  const round = JSON.parse(JSON.stringify(DEFAULT_FILTER_STATE));
  for (const [key, value] of Object.entries(DEFAULT_FILTER_STATE)) {
    if (key === 'exportedKeys') continue; // a Set, replaced by the worker
    assert.deepEqual(round[key], value, `${key} does not survive serialisation`);
  }
});

test('an explicit max of zero means zero, not no limit', () => {
  const leads = [lead({ reviewCount: 5 }), lead({ reviewCount: 0 })];
  assert.equal(run(leads, { maxReviews: 0 }).length, 1);
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

test('the dashboard UI carries no hardcoded counts left over from the mockup', () => {
  // "1,284 businesses already exported" was baked into the markup and never
  // replaced, so the Skip duplicates control stated a specific false fact on every
  // load, including the very first one when nothing had been exported at all.
  // The first version matched only comma-thousands, so it certified a class it could
  // not see: "1284" without the comma passed, and so did the other mockup figures
  // sitting nearby, a duplicates count of 6, a harvested count of 18, a permanent
  // "Harvest leg 2 of 3" in the header and a whole Phase 2 enrichment bar reading
  // "12 of 18 domains resolved" at 68%.
  //
  // Scoped to the slots that display RUNTIME data. Option labels like "15 km" and
  // "Last 3 months" are real copy, and the score slider's readout legitimately
  // mirrors its own initial value, so a blanket "no digits" rule would be noise.
  const html = readFileSync(new URL('../src/ui/dashboard/index.html', import.meta.url), 'utf8');
  // Named explicitly, and every one must be FOUND. The previous version matched only
  // <dd|em|span> while listing `e-count` in its own pattern, and `e-count` is a <b>.
  // A `length >= 5` assertion then masked the miss: seven slots matched, e-count was
  // never among them, and setting it to 18 kept the suite green.
  const EXPECTED = [
    's-harv', 's-pass', 's-hot', 's-med', 's-nosite', 's-dupe', 'f-dupe-hint', 'e-count', 'enrich-count', 'review-count',
    // Phase 2: the enrichment control. enrich-count is the candidate figure the
    // button states before a click; enrich-done/enrich-total are the progress
    // line ENRICH_PROGRESS drives while a run is in flight. All three must ship
    // at 0, the same reason as every slot above them.
    'enrich-count', 'enrich-done', 'enrich-total',
  ];
  const lying = [];
  for (const id of EXPECTED) {
    // Match the WHOLE element, not just its first text node. The previous version
    // stopped at the first `<`, so a number sitting after a nested tag was invisible:
    // `<dd id="s-nosite"><small>of pass </small>12</dd>` passed cleanly, and
    // `#s-nosite` really does contain a nested <small> in this file.
    const open = new RegExp(`<([a-z]+)[^>]*\\bid="${id}"[^>]*>`);
    const m = html.match(open);
    assert.ok(m, `runtime slot ${id} was not found at all, so this test cannot see it`);
    const from = m.index + m[0].length;
    const to = html.indexOf(`</${m[1]}>`, from);
    assert.notEqual(to, -1, `runtime slot ${id} is not closed`);
    const inner = html.slice(from, to).replace(/<[^>]*>/g, ' ');
    const digits = inner.match(/\d+/g) ?? [];
    if (digits.some((n) => Number(n) !== 0)) lying.push({ id, text: inner.trim() });
  }
  assert.deepEqual(lying, [], `runtime slots ship hardcoded values: ${JSON.stringify(lying)}`);

  // And nothing anywhere may hardcode a comma-thousands figure.
  const body = html.slice(html.indexOf('<body'));
  const withCommas = body.match(/>[^<>]*\b\d{1,3},\d{3}\b[^<>]*</g) ?? [];
  assert.deepEqual(withCommas, [], `mockup numbers still in the markup: ${withCommas.join(' | ')}`);

  // The enrichment progress bar described a Phase 2 that does not exist.
  assert.ok(!body.includes('domains resolved'), 'the mockup enrichment bar is still present');
  assert.ok(!body.includes('Harvest leg'), 'the mockup run-state counter is still present');
});

test('the duplicates count reports what the toggle alone hides', () => {
  // The naive version counted every stored lead that had been exported, including
  // ones already removed by score or rating, so "Duplicates hidden" and "Passing
  // filters" could not be reconciled: turning the toggle off raised the second by
  // far less than the first claimed.
  const exportedLowScore = lead({ website: 'https://modern.pk', websiteTech: 'next' }); // scores low
  const exportedHighScore = lead({ website: null });                                    // scores high
  const fresh = lead({ website: null });
  const leads = [exportedLowScore, exportedHighScore, fresh];

  const state = {
    ...DEFAULT_FILTER_STATE,
    minScore: 50,
    skipExported: true,
    exportedKeys: new Set([exportedLowScore.key, exportedHighScore.key]),
  };

  const shown = filterLeads(leads, state).length;
  const hidden = countHiddenByExportSkip(leads, state);
  const shownWithToggleOff = filterLeads(leads, { ...state, skipExported: false }).length;

  assert.equal(hidden, shownWithToggleOff - shown,
    'the figure must equal how many more rows appear when the toggle is released');
  assert.equal(hidden, 1, 'only the high-scoring exported lead was hidden by this toggle');
});

test('the duplicates count is zero when the toggle is off or nothing was exported', () => {
  const leads = [lead(), lead()];
  assert.equal(countHiddenByExportSkip(leads, { ...DEFAULT_FILTER_STATE, skipExported: false }), 0);
  assert.equal(countHiddenByExportSkip(leads, { ...DEFAULT_FILTER_STATE, exportedKeys: null }), 0);
});
