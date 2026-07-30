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
  const website = partial.website ? String(partial.website).trim() : null;
  const domain = normalizeDomain(website);
  const isSocial = domain !== null && SOCIAL_HOSTS.includes(domain);

  let websiteTech = partial.websiteTech ?? null;
  if (!website || domain === null) websiteTech = 'none';
  else if (isSocial) websiteTech = 'facebook';

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
    hasRealWebsite: Boolean(website) && domain !== null && !isSocial,
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
