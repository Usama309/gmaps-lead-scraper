import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGeocodeUrl, parseGeocode, geocodePlace, MAX_PLACE_OPTIONS, parseMapsUrl, parseGeocodeOptions, searchPlaces } from '../src/ui/sidepanel/geocode.js';

// A Photon hit, in the GeoJSON shape the geocoder actually receives. Coordinates are
// [longitude, latitude], deliberately reversed from how the form reads them.
const kcFeature = {
  geometry: { type: 'Point', coordinates: [-94.5786, 39.0997] },
  properties: { name: 'Kansas City', state: 'Missouri', country: 'United States' },
};

test('buildGeocodeUrl encodes the query and asks for several candidates', () => {
  const url = new URL(buildGeocodeUrl('Kansas City, US'));
  assert.equal(url.origin + url.pathname, 'https://photon.komoot.io/api/');
  assert.equal(url.searchParams.get('q'), 'Kansas City, US');
  assert.equal(url.searchParams.get('limit'), String(MAX_PLACE_OPTIONS));
});

test('buildGeocodeUrl rejects an empty query rather than searching for nothing', () => {
  assert.throws(() => buildGeocodeUrl('   '), /type a place/);
});

test('parseGeocode reads lat/lng/label from the first feature', () => {
  const out = parseGeocode({ features: [kcFeature] });
  assert.deepEqual(out, { lat: 39.0997, lng: -94.5786, label: 'Kansas City, Missouri, United States' });
});

test('parseGeocode returns null on an empty or malformed body', () => {
  assert.equal(parseGeocode({ features: [] }), null);
  assert.equal(parseGeocode(null), null);
  assert.equal(parseGeocode({ features: [{ geometry: {} }] }), null);
});

test('parseGeocode treats an unparseable coordinate as no hit', () => {
  // A NaN written into the form would fail the harvest later with a worse message.
  assert.equal(parseGeocode({ features: [{ geometry: { coordinates: ['west', 39.1] } }] }), null);
});

test('geocodePlace returns the parsed hit on success', async () => {
  const fakeFetch = async (url) => {
    assert.match(url, /q=Kansas\+City/);
    return { ok: true, json: async () => ({ features: [kcFeature] }) };
  };
  const out = await geocodePlace('Kansas City', fakeFetch);
  assert.deepEqual(out, { lat: 39.0997, lng: -94.5786, label: 'Kansas City, Missouri, United States' });
});

test('geocodePlace surfaces an HTTP error as an operator message', async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(() => geocodePlace('anywhere', fakeFetch), /HTTP 429/);
});

test('geocodePlace reports a no-match rather than returning nothing', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ features: [] }) });
  await assert.rejects(() => geocodePlace('asdfghjkl', fakeFetch), /no place matched/);
});

test('geocodePlace turns a network rejection into a readable message', async () => {
  const fakeFetch = async () => { throw new Error('offline'); };
  await assert.rejects(() => geocodePlace('Kansas City', fakeFetch), /could not reach the place lookup/);
});

// ---- Pasting a Google Maps link ----

test('a pasted Maps search link yields its centre and its keyword', () => {
  // The operator's own example. This path involves no lookup at all: the coordinates
  // are in the link, so there is no geocoder and no ambiguity about which place.
  const url = 'https://www.google.com/maps/search/dental+clinic/@39.0904394,-94.9058341,10z/data=!4m2!2m1!6e1?entry=ttu&g_ep=EgoyMDI2MDcyOS4wIKXMDSoASAFQAw%3D%3D';
  assert.deepEqual(parseMapsUrl(url), {
    lat: 39.0904394, lng: -94.9058341, zoom: 10,
    keyword: 'dental clinic', label: 'dental clinic',
  });
});

test('a place link works too, and a negative longitude survives', () => {
  // The place NAME becomes the label, not the keyword: nobody searched for "Lahore",
  // they are standing in it.
  assert.deepEqual(parseMapsUrl('https://www.google.com/maps/place/Lahore/@31.5204,74.3587,12z'), {
    lat: 31.5204, lng: 74.3587, zoom: 12, keyword: null, label: 'Lahore',
  });
  // The western hemisphere is where a dropped minus sign would move a search by
  // thousands of kilometres while still looking like a valid coordinate.
  assert.equal(parseMapsUrl('https://www.google.com/maps/@39.09,-94.90,10z').lng, -94.9);
});

test('a regional Google domain is still Google', () => {
  assert.ok(parseMapsUrl('https://www.google.co.uk/maps/@51.5074,-0.1278,12z'));
  assert.ok(parseMapsUrl('https://maps.google.com/maps/@51.5074,-0.1278,12z'));
});

test('ANYTHING THAT IS NOT A MAPS LINK RETURNS NULL, so the caller can fall back', () => {
  // The caller uses null to decide "this is a place name, look it up". Throwing here
  // would make typing a city name an error instead of a search.
  for (const text of ['Kansas City', '', '   ', null, undefined, 'not a url',
                      'https://example.com/maps/@1,2,3z', 'https://www.google.com/search?q=x']) {
    assert.equal(parseMapsUrl(text), null, JSON.stringify(text));
  }
});

test('a link with impossible coordinates is refused, not written into the form', () => {
  // A latitude of 400 would be accepted by a bare parse and then fail much later,
  // with a message about tiling that says nothing about the link that caused it.
  assert.equal(parseMapsUrl('https://www.google.com/maps/@400,-94.9,10z'), null);
  assert.equal(parseMapsUrl('https://www.google.com/maps/@39.09,-400,10z'), null);
});

test('a Maps link without a centre is not a location', () => {
  assert.equal(parseMapsUrl('https://www.google.com/maps/search/dental+clinic/'), null);
});

// ---- Offering every candidate ----

test('EVERY candidate is offered, because Kansas City is two different cities', () => {
  // Picking one for the operator means silently harvesting the wrong market, in the
  // wrong state. Measured live: Photon returns both, plus the airport and the
  // art institute, which is exactly why the kind is shown alongside.
  const body = { features: [
    { geometry: { coordinates: [-94.5781, 39.1001] }, properties: { name: 'Kansas City', state: 'Missouri', country: 'United States', osm_value: 'city' } },
    { geometry: { coordinates: [-94.6265, 39.1135] }, properties: { name: 'Kansas City', state: 'Kansas', country: 'United States', osm_value: 'city' } },
    { geometry: { coordinates: [-94.7208, 39.3022] }, properties: { name: 'Kansas City International Airport', state: 'MO', country: 'United States', osm_value: 'aerodrome' } },
  ] };
  const options = parseGeocodeOptions(body);
  assert.equal(options.length, 3);
  assert.equal(options[0].label, 'Kansas City, Missouri, United States');
  assert.equal(options[1].label, 'Kansas City, Kansas, United States');
  assert.notEqual(options[0].lat, options[1].lat, 'the two must be distinguishable by more than name');
  assert.equal(options[2].kind, 'aerodrome', 'the kind is what tells an airport from a city at a glance');
});

test('longitude and latitude are not swapped on the way out', () => {
  // Photon returns [lng, lat], the reverse of how the form reads them. A swap here
  // puts a Pakistani search in the Indian Ocean and both numbers still look valid.
  const options = parseGeocodeOptions({ features: [
    { geometry: { coordinates: [74.3587, 31.5204] }, properties: { name: 'Lahore', country: 'Pakistan' } },
  ] });
  assert.equal(options[0].lat, 31.5204);
  assert.equal(options[0].lng, 74.3587);
});

test('a candidate with unusable coordinates is dropped, not offered', () => {
  const options = parseGeocodeOptions({ features: [
    { geometry: { coordinates: ['x', 'y'] }, properties: { name: 'Broken' } },
    { geometry: { coordinates: [74.3587, 31.5204] }, properties: { name: 'Lahore', country: 'Pakistan' } },
  ] });
  assert.deepEqual(options.map((o) => o.label), ['Lahore, Pakistan']);
});

test('searchPlaces reports no match rather than returning an empty list', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ features: [] }) });
  await assert.rejects(() => searchPlaces('nowhere at all', fake), /no place matched/i);
});

test('searchPlaces returns the candidates on success', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ features: [
    { geometry: { coordinates: [-94.5781, 39.1001] }, properties: { name: 'Kansas City', state: 'Missouri' } },
  ] }) });
  const out = await searchPlaces('Kansas City', fake);
  assert.equal(out.length, 1);
  assert.equal(out[0].lat, 39.1001);
});

test('the panel no longer exposes raw coordinate inputs', () => {
  // Removed at the operator's request, and the reasoning is worth keeping: the whole
  // job of this panel is to FIND coordinates, so a pair of text boxes asking for them
  // by hand, in the right order, was the one path that could put a search in the
  // wrong hemisphere while looking perfectly filled in.
  const html = readFileSync(new URL('../src/ui/sidepanel/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="lat"/, 'the latitude input must be gone');
  assert.doesNotMatch(html, /id="lng"/, 'the longitude input must be gone');
  assert.match(html, /id="place"/, 'and the place box is what replaces it');
});

test('the panel still sends coordinates to the worker, from the resolved place', () => {
  // The fields went, the values did not. planLegs cannot tile without them, and a
  // panel that quietly sent undefined would fail deep in the pipeline with a message
  // about tiling rather than about a missing location.
  const js = readFileSync(new URL('../src/ui/sidepanel/sidepanel.js', import.meta.url), 'utf8');
  assert.match(js, /lat:\s*searchArea\.lat/);
  assert.match(js, /lng:\s*searchArea\.lng/);
});

test('the held location is not called `location`, which would shadow the global', () => {
  // A module-scoped `const location` shadows window.location for the whole file and
  // breaks anything that later reaches for it, in a way that reads as correct.
  const js = readFileSync(new URL('../src/ui/sidepanel/sidepanel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /^\s*(const|let|var)\s+location\s*=/m);
});

test('A /maps/place/ LINK CARRIES A PLACE NAME, NOT A SEARCH KEYWORD', () => {
  // The operator pasted a /place/ link and the panel told them the keyword in it was
  // "Kansas City, MO, USA", which is the name of the city rather than anything they
  // had searched for. Only a /search/ URL carries a search term.
  const place = parseMapsUrl('https://www.google.com/maps/place/Kansas+City,+MO,+USA/@39.0903034,-94.9051455,10z/data=!3m1!4b1');
  assert.equal(place.keyword, null, 'a place name is not a keyword');
  assert.equal(place.label, 'Kansas City, MO, USA', 'but it is a perfectly good label');

  const search = parseMapsUrl('https://www.google.com/maps/search/dental+clinic/@39.0904394,-94.9058341,10z');
  assert.equal(search.keyword, 'dental clinic', 'a search URL does carry a keyword');
  assert.equal(search.label, 'dental clinic');
});

test('OPEN MAPS SEARCHES COORDINATES, never the raw text in the box', () => {
  // The bug the operator hit: the button built "<keyword> in <whatever is typed>",
  // so pasting a link produced the search
  //   dentist in https://www.google.com/maps/place/Kansas+City,+MO,+USA/@39.09...
  // Google matched nothing, so the capture came from a FAILED search, which is the one
  // thing this button exists to prevent.
  const js = readFileSync(new URL('../src/ui/sidepanel/sidepanel.js', import.meta.url), 'utf8');
  const handler = js.slice(js.indexOf("getElementById('capOpen')"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.doesNotMatch(body, /placeInput\.value/, 'the raw box text must never reach the Maps URL');
  assert.match(body, /searchArea\.lat/, 'it must use the resolved coordinates');
  assert.match(body, /searchArea\.lng/);
  assert.match(body, /@\$\{searchArea\.lat\},\$\{searchArea\.lng\}/, 'centred, as an @lat,lng URL');
});
