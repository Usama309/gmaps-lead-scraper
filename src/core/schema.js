import { normalizeDomain, leadKey } from './identity.js';

/** Hosts that appear in the Maps website slot but are not a real business site. */
const SOCIAL_HOSTS = [
  'facebook.com', 'm.facebook.com', 'instagram.com', 'linkedin.com',
  'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'linktr.ee',
];

export const LEAD_FIELDS = [
  'key', 'cid', 'placeId', 'provenance',
  'name', 'categories', 'address', 'lat', 'lng',
  'rating', 'reviewCount', 'phone',
  'website', 'domain', 'hasRealWebsite', 'permanentlyClosed',
  // Enrichment. null means unknown, which is not the same as false.
  'enriched', 'websiteTech', 'mobileFriendly', 'hasBooking', 'hasChatbot',
  'email', 'socials', 'ownerReplies', 'lastReviewDays',
];

/**
 * Everything that follows from the website URL alone.
 *
 * Extracted so makeLead and mergeLead cannot disagree about it. They did: makeLead
 * derived these while mergeLead copied them, which is how a derived false came to
 * overwrite a known true.
 */
export function deriveWebsite(rawWebsite) {
  const website = rawWebsite ? String(rawWebsite).trim() : null;
  const domain = normalizeDomain(website);
  const isSocial = domain !== null && SOCIAL_HOSTS.includes(domain);

  return {
    website,
    domain,
    hasRealWebsite: Boolean(website) && domain !== null && !isSocial,
    websiteTech: !website || domain === null ? 'none' : (isSocial ? 'facebook' : null),
  };
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value) {
  const n = numOrNull(value);
  return n === null ? null : Math.round(n);
}

/**
 * Normalise a raw record from any source into the canonical Lead shape.
 * Enrichment fields default to null rather than false: "we have not looked"
 * must never be scored as "it is absent".
 */
export function makeLead(partial = {}) {
  const derived = deriveWebsite(partial.website);
  const { website, domain } = derived;
  // An explicit platform from enrichment wins, unless the URL itself settles it.
  const websiteTech = derived.websiteTech ?? (partial.websiteTech ?? null);

  const lead = {
    cid: partial.cid ?? null,
    placeId: partial.placeId ?? null,
    provenance: partial.provenance ?? 'google-payload',

    name: partial.name ? String(partial.name).trim() : '',
    categories: Array.isArray(partial.categories) ? partial.categories.filter(Boolean) : [],
    address: partial.address ? String(partial.address).trim() : null,
    lat: numOrNull(partial.lat),
    lng: numOrNull(partial.lng),

    rating: numOrNull(partial.rating),
    reviewCount: intOrNull(partial.reviewCount),
    phone: partial.phone ? String(partial.phone).trim() : null,

    website,
    domain,
    hasRealWebsite: derived.hasRealWebsite,
    permanentlyClosed: partial.permanentlyClosed === true,

    enriched: partial.enriched === true,
    websiteTech,
    mobileFriendly: partial.mobileFriendly ?? null,
    hasBooking: partial.hasBooking ?? null,
    hasChatbot: partial.hasChatbot ?? null,
    email: partial.email ?? null,
    socials: Array.isArray(partial.socials) ? partial.socials : [],
    ownerReplies: partial.ownerReplies ?? null,
    lastReviewDays: partial.lastReviewDays ?? null,
  };

  lead.key = leadKey(lead);
  return lead;
}

/**
 * Fields that come from Maps and should take the freshest value available.
 *
 * `domain`, `hasRealWebsite` and `websiteTech` are deliberately absent. All three
 * are DERIVED from `website`, so copying them straight across lets a derived
 * `false` overwrite a known `true`: a re-harvest whose record happened to omit the
 * URL flipped hasRealWebsite to false while the stored website survived, and the
 * lead then matched a "no website" filter while displaying its own live URL. They
 * are recomputed from the merged website instead, below.
 */
const MAPS_FIELDS = [
  'name', 'categories', 'address', 'lat', 'lng',
  'rating', 'reviewCount', 'phone', 'website',
  'permanentlyClosed', 'placeId',
];

/**
 * Fields that come from enrichment and must survive a re-harvest.
 *
 * websiteTech is deliberately NOT here. It is DERIVED from the website URL rather
 * than observed independently, so makeLead reports 'none' for any record without
 * one. Treating that as fresh enrichment let a leg carrying no website overwrite a
 * platform we had already identified, which is exactly the silent erasure this
 * function exists to prevent. It is merged separately, below, and only when the
 * incoming record actually looked at a site.
 */
const ENRICHMENT_FIELDS = [
  'mobileFriendly', 'hasBooking', 'hasChatbot',
  'email', 'ownerReplies', 'lastReviewDays',
];

function isEmpty(value) {
  return value === null || value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    value === '';
}

/**
 * Combine a stored lead with a freshly harvested one.
 *
 * Two rules carry the weight here. Fresher Maps data wins, because ratings and
 * review counts move. But an absent incoming field must never erase a known
 * stored one: a re-harvest that happens to omit a phone number would otherwise
 * silently destroy enrichment work already paid for in network time.
 */
export function mergeLead(existing, incoming) {
  if (existing.key !== incoming.key) {
    throw new Error(`refusing to merge leads with different keys: ${existing.key} vs ${incoming.key}`);
  }

  const merged = { ...existing };

  for (const field of MAPS_FIELDS) {
    if (!isEmpty(incoming[field])) merged[field] = incoming[field];
  }

  // Recompute everything derived from the website, from the MERGED website.
  const websiteChanged = merged.website !== existing.website;
  const derived = deriveWebsite(merged.website);
  merged.domain = derived.domain;
  merged.hasRealWebsite = derived.hasRealWebsite;

  // Keep a platform we identified earlier only while it still describes the same
  // real site. If the website changed or went away, the old platform is stale, and
  // an unenriched lead would otherwise carry a live URL beside a "No website"
  // verdict worth 40 score points.
  if (websiteChanged || !derived.hasRealWebsite) {
    merged.websiteTech = derived.websiteTech;
  }

  // Enrichment only flows in from a record that was actually enriched.
  if (incoming.enriched) {
    merged.enriched = true;
    for (const field of ENRICHMENT_FIELDS) {
      if (!isEmpty(incoming[field])) merged[field] = incoming[field];
    }

    // Only accept a platform reading from a record that actually had a site to
    // read. See the note on ENRICHMENT_FIELDS above.
    if (incoming.hasRealWebsite && !isEmpty(incoming.websiteTech)) {
      merged.websiteTech = incoming.websiteTech;
    }

    const incomingSocials = Array.isArray(incoming.socials) ? incoming.socials : [];
    merged.socials = [...new Set([...(existing.socials ?? []), ...incomingSocials])];
  }

  return merged;
}
