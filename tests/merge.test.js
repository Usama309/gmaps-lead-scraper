import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead, mergeLead } from '../src/core/schema.js';

const existing = makeLead({
  cid: '0xa:0xb', name: 'Al-Shifa Dental', phone: '+92 57 261 2201',
  rating: 4.3, reviewCount: 87, website: 'https://alshifa.pk',
  enriched: true, websiteTech: 'wordpress', mobileFriendly: false,
  hasBooking: false, email: 'info@alshifa.pk', socials: ['facebook'],
});

test('merging keeps enrichment that the incoming record lacks', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'Al-Shifa Dental', rating: 4.4, reviewCount: 91 });
  const merged = mergeLead(existing, incoming);
  assert.equal(merged.enriched, true, 'enrichment must survive a re-harvest');
  assert.equal(merged.websiteTech, 'wordpress');
  assert.equal(merged.mobileFriendly, false);
  assert.equal(merged.email, 'info@alshifa.pk');
});

test('merging takes fresher Maps data from the incoming record', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'Al-Shifa Dental', rating: 4.4, reviewCount: 91 });
  const merged = mergeLead(existing, incoming);
  assert.equal(merged.rating, 4.4, 'a newer rating wins');
  assert.equal(merged.reviewCount, 91);
});

test('merging does not let an incoming null erase a known value', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'Al-Shifa Dental', phone: null, rating: null });
  const merged = mergeLead(existing, incoming);
  assert.equal(merged.phone, '+92 57 261 2201', 'a missing incoming field must not wipe the stored one');
  assert.equal(merged.rating, 4.3);
});

test('merging prefers incoming enrichment when it is newer', () => {
  const stale = makeLead({ cid: '0xa:0xb', name: 'X', enriched: false });
  const fresh = makeLead({
    cid: '0xa:0xb', name: 'X', website: 'https://x.wixsite.com',
    enriched: true, websiteTech: 'wix', mobileFriendly: true,
  });
  const merged = mergeLead(stale, fresh);
  assert.equal(merged.websiteTech, 'wix');
  assert.equal(merged.mobileFriendly, true);
  assert.equal(merged.enriched, true);
});

test('merging keeps the existing key and refuses a key mismatch', () => {
  const other = makeLead({ cid: '0xZZ:0xZZ', name: 'Different Business' });
  assert.throws(() => mergeLead(existing, other), /key/i);
});

test('merging unions the socials list without duplicates', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'X', enriched: true, socials: ['facebook', 'instagram'] });
  const merged = mergeLead(existing, incoming);
  assert.deepEqual([...merged.socials].sort(), ['facebook', 'instagram']);
});

test('merging is pure and mutates neither argument', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'X', rating: 5 });
  const a = JSON.stringify(existing); const b = JSON.stringify(incoming);
  mergeLead(existing, incoming);
  assert.equal(JSON.stringify(existing), a);
  assert.equal(JSON.stringify(incoming), b);
});
