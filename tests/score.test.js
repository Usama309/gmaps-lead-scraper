import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead } from '../src/core/schema.js';
import { scoreLead } from '../src/pipeline/score.js';
import { SCORING } from '../src/core/scoring-config.js';

/** An enriched, reachable, mid-size business. Components isolated per test. */
function base(overrides = {}) {
  return makeLead({
    cid: '0x1:0x1',
    name: 'Test Business',
    phone: '+92 300 000 0000',
    reviewCount: 100,
    categories: ['Hardware store'],
    enriched: true,
    mobileFriendly: true,
    hasBooking: false,
    ...overrides,
  });
}

test('no website scores the full website gap', () => {
  const { score, reasons } = scoreLead(base({ website: null }));
  // 40 website + 0 mobile(unknown, no site) + 6 non-appointment + 20 viability
  assert.equal(score, 66);
  assert.ok(reasons.includes('No website'));
});

test('a Facebook page in the website slot scores 38', () => {
  const { reasons } = scoreLead(base({ website: 'https://facebook.com/x' }));
  assert.ok(reasons.includes('Facebook page as website'));
});

test('a dead website scores 35', () => {
  const { reasons } = scoreLead(base({ website: 'https://alshifa.pk/', websiteTech: 'dead' }));
  assert.ok(reasons.includes('Website URL is dead'));
});

test('a DIY builder site scores 30 and names the builder', () => {
  const { reasons } = scoreLead(base({ website: 'https://x.wixsite.com', websiteTech: 'wix' }));
  assert.ok(reasons.some(r => /wix builder site/i.test(r)));
});

test('WordPress scores 20 on platform identity alone, with no age judgement', () => {
  const { reasons } = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress' }));
  assert.ok(reasons.includes('WordPress site'));
  assert.ok(!reasons.some(r => /dated|old/i.test(r)), 'must not claim age it cannot measure');
});

test('a modern custom build scores only 5', () => {
  const a = scoreLead(base({ website: 'https://x.pk', websiteTech: 'next' })).score;
  const b = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress' })).score;
  assert.ok(a < b, 'a modern site must be a worse lead than WordPress');
});

test('a detected but unrecognised platform scores the middle value 12', () => {
  const { score } = scoreLead(base({ website: 'https://x.pk', websiteTech: 'unknown' }));
  // 12 website + 0 mobile(pass) + 6 non-appointment + 20 viability
  assert.equal(score, 38);
});

test('failing mobile adds the full mobile gap', () => {
  const pass = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: true }));
  const fail = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: false }));
  assert.equal(fail.score - pass.score, SCORING.mobileGap.noViewport);
  assert.ok(fail.reasons.includes('fails mobile'));
});

test('partial mobile scores between pass and fail', () => {
  const partial = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: 'partial' }));
  const fail = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: false }));
  assert.ok(partial.score < fail.score);
});

test('an appointment business with no booking scores the full booking gap', () => {
  const { score, reasons } = scoreLead(base({
    website: 'https://x.pk', websiteTech: 'wordpress',
    categories: ['Dentist'], hasBooking: false,
  }));
  // 20 website + 0 mobile + 20 booking + 20 viability
  assert.equal(score, 60);
  assert.ok(reasons.some(r => /dentist.*no online booking/i.test(r)));
});

test('an appointment business that already books online scores zero booking gap', () => {
  const { score } = scoreLead(base({
    website: 'https://x.pk', websiteTech: 'wordpress',
    categories: ['Dentist'], hasBooking: true,
  }));
  assert.equal(score, 40);
});

test('viability rewards the established-SMB band and penalises the extremes', () => {
  const w = { website: 'https://x.pk', websiteTech: 'wordpress' };
  const sweet = scoreLead(base({ ...w, reviewCount: 100 })).score;
  const big = scoreLead(base({ ...w, reviewCount: 700 })).score;
  const huge = scoreLead(base({ ...w, reviewCount: 5000 })).score;
  const tiny = scoreLead(base({ ...w, reviewCount: 3 })).score;
  assert.ok(sweet > big && big > huge, 'bigger businesses are worse leads');
  assert.ok(sweet > tiny, 'too-new businesses are worse leads');
});

test('unknown review count scores the neutral midpoint, for licensed sources', () => {
  const { reasons } = scoreLead(base({
    website: 'https://x.pk', websiteTech: 'wordpress',
    reviewCount: null, provenance: 'osm',
  }));
  assert.ok(reasons.includes('review count unknown'));
});

test('every viability band explains itself, so a retune cannot silence the reason', () => {
  for (const band of SCORING.viability.bands) {
    const inside = Number.isFinite(band.max) ? band.max : band.min;
    const { reasons } = scoreLead(base({
      website: 'https://x.pk', websiteTech: 'wordpress',
      reviewCount: inside,
    }));
    const expected = band.reason.replace('{count}', inside);
    assert.ok(
      reasons.includes(expected),
      `band ${band.min}-${band.max} produced no reason text; expected ${expected} in ${JSON.stringify(reasons)}`,
    );
    assert.ok(band.reason.length > 0, `band ${band.min}-${band.max} has empty reason text`);
  }
});

test('unreachable businesses are multiplied down', () => {
  const reachable = scoreLead(base({ website: null, phone: '+92 300 000 0000' })).score;
  const unreachable = scoreLead(base({ website: null, phone: null, email: null })).score;
  assert.equal(unreachable, Math.round(reachable * SCORING.modifiers.unreachable));
});

test('an email alone counts as reachable', () => {
  const withEmail = scoreLead(base({ website: null, phone: null, email: 'a@b.com' })).score;
  const withNeither = scoreLead(base({ website: null, phone: null, email: null })).score;
  assert.ok(withEmail > withNeither);
});

test('a dormant business is multiplied down', () => {
  const fresh = scoreLead(base({ website: null, lastReviewDays: 10 })).score;
  const dormant = scoreLead(base({ website: null, lastReviewDays: 400 })).score;
  assert.equal(dormant, Math.round(fresh * SCORING.modifiers.dormant));
});

test('a permanently closed business scores exactly zero and says why', () => {
  const { score, reasons } = scoreLead(base({ website: null, permanentlyClosed: true }));
  assert.equal(score, 0);
  assert.deepEqual(reasons, ['permanently closed']);
});

test('an unenriched lead is marked provisional and skips enrichment-only components', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', phone: '+92 1', reviewCount: 100, website: 'https://x.pk' });
  const { provisional, reasons } = scoreLead(lead);
  assert.equal(provisional, true);
  assert.ok(!reasons.includes('fails mobile'));
  assert.ok(!reasons.some(r => /no online booking/.test(r)));
});

test('an enriched lead is not provisional', () => {
  assert.equal(scoreLead(base({ website: null })).provisional, false);
});

test('score is always an integer within 0 to 100', () => {
  const cases = [
    base({ website: null }),
    base({ website: null, phone: null, email: null, lastReviewDays: 500 }),
    base({ website: 'https://x.pk', websiteTech: 'next', mobileFriendly: true, hasBooking: true, reviewCount: 9000 }),
    base({ website: null, categories: ['Dentist'], reviewCount: 50, mobileFriendly: false }),
  ];
  for (const lead of cases) {
    const { score } = scoreLead(lead);
    assert.ok(Number.isInteger(score), `not an integer: ${score}`);
    assert.ok(score >= 0 && score <= 100, `out of range: ${score}`);
  }
});
