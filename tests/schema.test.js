import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead, LEAD_FIELDS } from '../src/core/schema.js';

test('makeLead fills every declared field', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X' });
  for (const field of LEAD_FIELDS) {
    assert.ok(field in lead, `missing field: ${field}`);
  }
});

test('makeLead normalises name, phone and domain', () => {
  const lead = makeLead({
    name: '  Glow Beauty Salon & Spa ',
    phone: '+92 57 261 4408',
    website: 'https://www.GlowAttock.com/home',
  });
  assert.equal(lead.name, 'Glow Beauty Salon & Spa');
  assert.equal(lead.phone, '+92 57 261 4408');
  assert.equal(lead.domain, 'glowattock.com');
});

test('makeLead coerces numerics and rejects nonsense', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', rating: '4.6', reviewCount: '212', lat: '33.76', lng: 'abc' });
  assert.equal(lead.rating, 4.6);
  assert.equal(lead.reviewCount, 212);
  assert.equal(lead.lat, 33.76);
  assert.equal(lead.lng, null);
});

test('makeLead defaults enrichment fields to unknown, never to false', () => {
  // Uses a lead that HAS a website, so the platform is genuinely unknown. A lead
  // with no website is a different case: 'none' there is knowledge, not absence.
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: 'https://x.pk' });
  assert.equal(lead.enriched, false);
  assert.equal(lead.websiteTech, null, 'a site we have not inspected has an unknown platform');
  assert.equal(lead.mobileFriendly, null);
  assert.equal(lead.hasBooking, null);
  assert.equal(lead.lastReviewDays, null);
});

test('makeLead classifies a Facebook page in the website slot as not a real website', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: 'https://facebook.com/glowattock' });
  assert.equal(lead.websiteTech, 'facebook');
  assert.equal(lead.hasRealWebsite, false);
});

test('makeLead treats a normal website as a real website with unknown platform', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: 'https://malikdental.com' });
  assert.equal(lead.hasRealWebsite, true);
  assert.equal(lead.websiteTech, null);
});

test('makeLead marks no website at all', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: null });
  assert.equal(lead.hasRealWebsite, false);
  assert.equal(lead.websiteTech, 'none');
});

test('makeLead always sets a dedupe key', () => {
  assert.equal(makeLead({ cid: '0xabc:0xdef', name: 'X' }).key, 'cid:0xabc:0xdef');
});

test('categories is always an array with falsy entries removed', () => {
  assert.deepEqual(makeLead({ cid: '0x1:0x1', name: 'X', categories: ['Dentist', null, ''] }).categories, ['Dentist']);
  assert.deepEqual(makeLead({ cid: '0x1:0x1', name: 'X' }).categories, []);
});
