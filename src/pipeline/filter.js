import { scoreLead } from './score.js';

/**
 * The canonical shape of every filter. This object IS the filter contract:
 * the UI binds to these keys and the pipeline reads only these keys.
 *
 * Tri-states use the strings 'any' | 'yes' | 'no' rather than booleans, because
 * "any" and "no" are genuinely different questions and a boolean cannot hold three states.
 */
export const DEFAULT_FILTER_STATE = Object.freeze({
  // Tier 1, harvest-time. Present here so one object describes the whole job.
  keywords: [],
  location: '',
  lat: null,
  lng: null,
  zoom: null,
  radiusKm: 15,
  categories: [],
  minRating: 0,
  openNow: 'any',

  // Tier 2, Maps data.
  minReviews: 0,
  maxReviews: Infinity,
  hasPhone: 'any',
  website: 'any',
  ownerReplies: 'any',
  lastReviewWithinDays: 0,

  // Tier 3, website intel.
  hasEmail: 'any',
  tech: [],
  mobileFriendly: 'any',
  hasChatbot: 'any',
  hasBooking: 'any',
  hasSocials: 'any',

  // Tier 4, scoring and output.
  minScore: 0,
  skipExported: true,
  exportedKeys: null,
  sortBy: 'score',
  sortDir: -1,
});

function triState(setting, value) {
  if (setting === 'any') return true;
  if (setting === 'yes') return value === true;
  if (setting === 'no') return value === false;
  return true;
}

const SORTERS = {
  score: (l) => l.score,
  rating: (l) => l.rating ?? -1,
  reviews: (l) => l.reviewCount ?? -1,
  lastReview: (l) => (l.lastReviewDays === null ? Infinity : l.lastReviewDays),
  name: (l) => l.name.toLowerCase(),
};

/**
 * Pure. Scores every lead, keeps those matching the filter state, sorts the result.
 * Never touches the network and never mutates its input.
 */
export function filterLeads(leads, state) {
  const f = { ...DEFAULT_FILTER_STATE, ...state };

  const scored = leads.map((lead) => ({ ...lead, ...scoreLead(lead) }));

  const kept = scored.filter((l) => {
    if (l.permanentlyClosed) return false;
    if (l.score < f.minScore) return false;

    if (l.rating !== null && l.rating < f.minRating) return false;
    if (l.reviewCount !== null) {
      if (l.reviewCount < f.minReviews) return false;
      if (l.reviewCount > f.maxReviews) return false;
    }

    if (!triState(f.hasPhone, Boolean(l.phone))) return false;
    if (!triState(f.website, l.hasRealWebsite)) return false;
    if (!triState(f.hasEmail, Boolean(l.email))) return false;
    if (!triState(f.hasSocials, l.socials.length > 0)) return false;
    if (!triState(f.ownerReplies, l.ownerReplies)) return false;
    if (!triState(f.hasBooking, l.hasBooking)) return false;
    if (!triState(f.hasChatbot, l.hasChatbot)) return false;

    // mobileFriendly is tri-valued in the data ('partial'), so it cannot use triState.
    if (f.mobileFriendly === 'yes' && l.mobileFriendly !== true) return false;
    if (f.mobileFriendly === 'no' && l.mobileFriendly !== false) return false;

    if (f.tech.length && !f.tech.includes(l.websiteTech)) return false;

    if (f.lastReviewWithinDays > 0) {
      if (l.lastReviewDays === null) return false;
      if (l.lastReviewDays > f.lastReviewWithinDays) return false;
    }

    if (f.categories.length) {
      const wanted = f.categories.map((c) => c.toLowerCase());
      const own = l.categories.map((c) => c.toLowerCase());
      if (!own.some((c) => wanted.includes(c))) return false;
    }

    if (f.skipExported && f.exportedKeys && f.exportedKeys.has(l.key)) return false;

    return true;
  });

  const keyOf = SORTERS[f.sortBy] ?? SORTERS.score;
  return kept.sort((a, b) => {
    const av = keyOf(a); const bv = keyOf(b);
    if (av < bv) return -f.sortDir;
    if (av > bv) return f.sortDir;
    return 0;
  });
}
