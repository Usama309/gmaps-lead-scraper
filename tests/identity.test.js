import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, normalizePhone, normalizeDomain, leadKey } from '../src/core/identity.js';

test('normalizeName folds case, punctuation and spacing', () => {
  assert.equal(normalizeName('  Al-Shifa  Dental   Clinic!  '), 'al shifa dental clinic');
  assert.equal(normalizeName('Dr. Ayesha Skin Clinic'), 'dr ayesha skin clinic');
});

test('normalizePhone keeps digits only and drops a leading zero after country code', () => {
  assert.equal(normalizePhone('+92 57 261 4408'), '92572614408');
  assert.equal(normalizePhone('(0300) 512-7739'), '03005127739');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('normalizeDomain strips scheme, www and path', () => {
  assert.equal(normalizeDomain('https://www.MalikDental.com/contact?x=1'), 'malikdental.com');
  assert.equal(normalizeDomain('attockphoto.wixsite.com/home'), 'attockphoto.wixsite.com');
  assert.equal(normalizeDomain('not a url'), null);
  assert.equal(normalizeDomain(null), null);
});

test('leadKey prefers the Google CID', () => {
  assert.equal(leadKey({ cid: '0x38df9a:0x1234', name: 'X' }), 'cid:0x38df9a:0x1234');
});

test('leadKey falls back to name plus phone when there is no CID', () => {
  assert.equal(
    leadKey({ cid: null, name: 'Hazro Auto Works', phone: '+92 57 231 9012' }),
    'np:hazro auto works|92572319012'
  );
});

test('leadKey falls back to name plus rounded coordinates when there is no phone', () => {
  assert.equal(
    leadKey({ cid: null, name: 'Sharif Tailors', phone: null, lat: 33.76098243, lng: 72.3428741 }),
    'nl:sharif tailors|33.7610|72.3429'
  );
});

test('leadKey throws rather than returning a colliding key when nothing identifies the lead', () => {
  assert.throws(() => leadKey({ cid: null, name: '', phone: null, lat: null, lng: null }),
    /cannot derive/i);
});
