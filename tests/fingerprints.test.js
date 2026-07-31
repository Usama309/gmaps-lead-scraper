import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTech, detectChatbot, detectBooking, detectSocials, detectMobileFriendly, FINGERPRINTS } from '../src/core/fingerprints.js';
import { SCORING } from '../src/core/scoring-config.js';

test('every tech key the detector can return is one scoring knows how to band', () => {
  // An unmapped key does not throw, it scores as undefined and the lead silently
  // loses the largest score component.
  for (const key of Object.keys(FINGERPRINTS.tech)) {
    assert.ok(key in SCORING.techBand, `${key} has no scoring band`);
  }
});

test('WordPress is detected from its asset path', () => {
  assert.equal(detectTech('<link href="/wp-content/themes/x/style.css">'), 'wordpress');
});

test('Wix is detected from its static host', () => {
  assert.equal(detectTech('<script src="https://static.parastorage.com/x.js">'), 'wix');
});

test('an unrecognised site is unknown, never none', () => {
  // `none` means there is no website at all, which is a 40-point signal. A site we
  // fetched and could not identify is a 12-point signal. Conflating them would make
  // every bespoke site look like a business with no web presence.
  assert.equal(detectTech('<html><body>hello</body></html>'), 'unknown');
});

test('site-builder tech wins over the generic framework it also ships', () => {
  // A Wix site ships React under the hood. Checking 'react' before 'wix' would
  // misidentify every Wix site as a bespoke React build.
  assert.equal(
    detectTech('<script src="https://static.parastorage.com/x.js"></script><div data-reactroot></div>'),
    'wix'
  );
});

test('a booking widget is detected by vendor, not by the word booking', () => {
  assert.equal(detectBooking('<script src="https://assets.calendly.com/x.js">'), true);
  assert.equal(detectBooking('<p>Call us to book an appointment</p>'), false);
});

test('a chatbot is detected by vendor script', () => {
  assert.equal(detectChatbot('<script src="https://widget.intercom.io/x.js">'), true);
  assert.equal(detectChatbot('<html></html>'), false);
});

test('socials are returned deduplicated and normalised', () => {
  const html = '<a href="https://facebook.com/x">f</a><a href="https://www.facebook.com/x">f2</a><a href="https://instagram.com/y">i</a>';
  assert.deepEqual(detectSocials(html).sort(), ['facebook', 'instagram']);
});

test('a share button is not a social profile', () => {
  // Almost every site links facebook.com/sharer. Counting it would report that
  // every business has a Facebook presence.
  assert.deepEqual(detectSocials('<a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>'), []);
});

test('mobile friendliness is three-valued', () => {
  assert.equal(detectMobileFriendly('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
  assert.equal(detectMobileFriendly('<html><body></body></html>'), false);
  assert.equal(detectMobileFriendly('<meta name="viewport" content="width=1024">'), 'partial');
});
