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

test('CRITICAL: a re-harvest without the URL does not flip hasRealWebsite to false', () => {
  // hasRealWebsite is DERIVED from website, so copying it across let a derived
  // false overwrite a known true. The stored URL survived while the flag did not,
  // and the lead then matched a "no website" filter while showing its own live URL.
  const stored = makeLead({ cid: '0xa:0xb', name: 'Clinic', website: 'https://clinic.pk' });
  assert.equal(stored.hasRealWebsite, true);

  const bare = makeLead({ cid: '0xa:0xb', name: 'Clinic' });
  const merged = mergeLead(stored, bare);

  assert.equal(merged.website, 'https://clinic.pk', 'the URL survives');
  assert.equal(merged.hasRealWebsite, true, 'and so must the flag derived from it');
  assert.equal(merged.domain, 'clinic.pk');
});

test('CRITICAL: a later harvest that finds a website clears a stale no-website verdict', () => {
  // websiteTech was only refreshed under incoming.enriched, which is never true in
  // Phase 1. A lead could carry a live URL and a 40 point "No website" score in the
  // same exported row.
  const stored = makeLead({ cid: '0xa:0xb', name: 'Spa' });
  assert.equal(stored.websiteTech, 'none');

  const found = makeLead({ cid: '0xa:0xb', name: 'Spa', website: 'https://spa.pk' });
  const merged = mergeLead(stored, found);

  assert.equal(merged.websiteTech, null, 'unknown platform, not a stale "none"');
  assert.equal(merged.hasRealWebsite, true);
});

test('CRITICAL: a re-harvest with no website does not erase a known platform', () => {
  // makeLead derives websiteTech from the website URL, so a record without one
  // reports 'none' by construction rather than by observation. Treating that as
  // fresh enrichment overwrote a platform already identified, which is precisely
  // the silent erasure this function exists to prevent.
  const stored = makeLead({
    cid: '0xa:0xb', name: 'Al-Shifa', website: 'https://alshifa.pk',
    enriched: true, websiteTech: 'wordpress', mobileFriendly: false,
  });
  const reharvest = makeLead({ cid: '0xa:0xb', name: 'Al-Shifa', enriched: true });

  const merged = mergeLead(stored, reharvest);
  assert.equal(merged.websiteTech, 'wordpress', 'a leg with no website must not clear the platform');
  assert.equal(merged.mobileFriendly, false, 'other enrichment must survive too');
});

test('a re-harvest that DID inspect a site updates the platform', () => {
  const stored = makeLead({
    cid: '0xa:0xb', name: 'X', website: 'https://x.pk', enriched: true, websiteTech: 'wordpress',
  });
  const rebuilt = makeLead({
    cid: '0xa:0xb', name: 'X', website: 'https://x.webflow.io', enriched: true, websiteTech: 'webflow',
  });
  assert.equal(mergeLead(stored, rebuilt).websiteTech, 'webflow');
});

test('a non-array socials value cannot spread into single characters', () => {
  const stored = makeLead({ cid: '0xa:0xb', name: 'X', enriched: true, socials: ['facebook'] });
  const odd = makeLead({ cid: '0xa:0xb', name: 'X', enriched: true });
  odd.socials = 'instagram';
  assert.deepEqual(mergeLead(stored, odd).socials, ['facebook']);
});

test('merging is pure and mutates neither argument', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'X', rating: 5 });
  const a = JSON.stringify(existing); const b = JSON.stringify(incoming);
  mergeLead(existing, incoming);
  assert.equal(JSON.stringify(existing), a);
  assert.equal(JSON.stringify(incoming), b);
});
