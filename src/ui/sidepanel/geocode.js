/**
 * Turn a place name the operator types ("Kansas City, US") into the latitude and
 * longitude the harvest form needs.
 *
 * The whole point of this module is that the operator should never have to look up
 * coordinates by hand. It uses Photon (photon.komoot.io), a free, keyless, OSM-based
 * geocoder built for exactly this: browser autocomplete. It is used here rather than
 * OpenStreetMap's own Nominatim because Nominatim rejects a browser `fetch` with
 * HTTP 403 unless it carries an app User-Agent, and a page cannot set that header.
 * Photon is CORS-enabled and answers a plain fetch, verified live on 2026-07-31.
 *
 * The network call is kept behind an injectable `fetchImpl` so the pure URL-building
 * and response-parsing can be tested without touching the network. `credentials:
 * 'omit'` is carried through for the same reason the rest of the extension does it,
 * so no account of the operator's is ever attached to a request.
 */

const ENDPOINT = 'https://photon.komoot.io/api/';

/** How many candidates to offer. Enough to disambiguate, few enough to scan. */
export const MAX_PLACE_OPTIONS = 6;

/**
 * Pull the location straight out of a pasted Google Maps URL.
 *
 * This is the most reliable path in this module by a wide margin, because there is no
 * lookup involved at all: a Maps URL carries the map centre in its own path as
 * `@lat,lng,zoom`. No network, no geocoder, no ambiguity about which Kansas City was
 * meant. If the operator can see the place on their screen, the link is the answer.
 *
 * Handles the two shapes Maps produces:
 *   /maps/search/dental+clinic/@39.0904394,-94.9058341,10z/data=...
 *   /maps/place/Some+Place/@31.5204,74.3587,12z/...
 *
 * The keyword is returned too when the URL carries one, since a link copied from a
 * search the operator already ran tells us what they were looking for.
 *
 * Returns null rather than throwing for anything that is not a Maps URL, because the
 * caller uses that to decide whether the box holds a link or a place name.
 */
export function parseMapsUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.[a-z.]+$/i.test(url.hostname)) return null;
  if (!url.pathname.includes('/maps')) return null;

  // The centre lives in the path, not the query string: @lat,lng,zoomz
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(url.pathname);
  if (!at) return null;

  const lat = Number(at[1]);
  const lng = Number(at[2]);
  // Range-checked rather than merely parsed. A malformed link that yielded a
  // latitude of 400 would be written into the form and fail much later, with a
  // message about tiling that says nothing about the link that caused it.
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;

  const zoom = at[3] === undefined ? null : Number(at[3]);

  // /maps/search/<keyword>/@... or /maps/place/<name>/@...
  const kw = /\/maps\/(?:search|place)\/([^/@]+)/.exec(url.pathname);
  let keyword = null;
  if (kw) {
    try {
      keyword = decodeURIComponent(kw[1].replace(/\+/g, ' ')).trim() || null;
    } catch {
      keyword = kw[1].replace(/\+/g, ' ').trim() || null;
    }
  }

  return { lat, lng, zoom, keyword };
}

/** Build the lookup URL. Separated out so a test can assert it without a network call. */
export function buildGeocodeUrl(query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new Error('type a place to look up');
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', String(MAX_PLACE_OPTIONS));
  return url.toString();
}

/**
 * Pull the first usable hit out of a Photon GeoJSON response.
 *
 * Photon returns `features[].geometry.coordinates` as [longitude, latitude] (GeoJSON
 * order, the reverse of how the form reads), so the two are unpacked by position and
 * named explicitly here rather than anywhere a swap could go unnoticed.
 *
 * Returns null rather than throwing on an empty or malformed result, so the caller
 * decides how to speak to the operator. A hit whose coordinates do not parse to
 * finite numbers is treated as no hit: a NaN written into the form would make the
 * harvest fail later with a far more confusing message than "no match".
 */
export function parseGeocode(body) {
  const hit = body?.features?.[0];
  const coords = hit?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const p = hit.properties ?? {};
  const label = [p.name, p.state, p.country].filter(Boolean).join(', ');
  return { lat, lng, label };
}

/**
 * Look up a place and return { lat, lng, label }.
 *
 * Throws a message fit to show the operator on every failure path: an empty query, a
 * non-OK HTTP status, a body that is not the GeoJSON Photon documents, or a query
 * that simply matched nothing.
 */
export async function geocodePlace(query, fetchImpl = fetch) {
  const url = buildGeocodeUrl(query);
  let response;
  try {
    response = await fetchImpl(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new Error(`could not reach the place lookup: ${error?.message ?? error}`);
  }
  if (!response.ok) throw new Error(`place lookup returned HTTP ${response.status}`);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('place lookup returned something that was not JSON');
  }

  const parsed = parseGeocode(data);
  if (!parsed) throw new Error(`no place matched "${String(query).trim()}"`);
  return parsed;
}

/**
 * Every usable candidate, not just the first.
 *
 * "Kansas City" is two different cities in two different states, and picking one for
 * the operator means silently harvesting the wrong market. Photon returns both, so
 * the answer is to show them rather than to guess.
 *
 * Coordinates arrive as [longitude, latitude], GeoJSON order and the reverse of how
 * the form reads them, so they are unpacked by position and named immediately. A
 * candidate whose coordinates do not parse to finite numbers is dropped rather than
 * offered: a NaN written into the form fails much later with a message that says
 * nothing about where it came from.
 */
export function parseGeocodeOptions(body) {
  const features = Array.isArray(body?.features) ? body.features : [];
  const options = [];

  for (const hit of features) {
    const coords = hit?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const p = hit.properties ?? {};
    const label = [p.name, p.state, p.country].filter(Boolean).join(', ');
    if (!label) continue;
    // What KIND of place, so "Kansas City" the city is distinguishable from
    // "Kansas City International Airport" at a glance.
    options.push({ lat, lng, label, kind: p.osm_value ?? null });
  }

  return options;
}

/** Look up a place and return every candidate worth offering. */
export async function searchPlaces(query, fetchImpl = fetch) {
  const url = buildGeocodeUrl(query);
  let response;
  try {
    response = await fetchImpl(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new Error(`could not reach the place lookup: ${error?.message ?? error}`);
  }
  if (!response.ok) throw new Error(`place lookup returned HTTP ${response.status}`);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('place lookup returned something that was not JSON');
  }

  const options = parseGeocodeOptions(data);
  if (options.length === 0) throw new Error(`no place matched "${String(query).trim()}"`);
  return options;
}
