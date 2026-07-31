import { newestReviewDays } from './review-dates.js';

/**
 * Read owner-reply presence and review recency out of a rendered Maps place panel.
 *
 * THIS IS THE ONLY FILE PERMITTED TO CONTAIN A DOM SELECTOR.
 *
 * These are the most volatile values in the project by a wide margin. The payload
 * indices in payload-map.js are at least stable enough that Google reshuffles them
 * rarely; these are obfuscated CSS class names that change whenever the Maps front
 * end ships. Verified live on 2026-07-31 against Chaudhry Dental Clinic, Attock:
 * `div.jftiEf` gave 3 rows before sorting and 10 after, and `span.rsqaWe` read
 * "a year ago".
 *
 * ## The document interface this needs
 *
 * `readReviewPanel` is pure and takes a document-LIKE object, so it can be tested in
 * bare Node with plain objects and so the tab driver in Phase 3 Task 3 knows exactly
 * what it must satisfy. The whole interface is:
 *
 *   doc.querySelectorAll(selector) -> array-like of nodes
 *   doc.querySelector(selector)    -> node or null
 *   node.querySelector(selector)   -> node or null
 *   node.querySelectorAll(selector)-> array-like of nodes
 *   node.textContent               -> string
 *   node.getAttribute(name)        -> string or null
 *
 * Nothing else: no events, no layout. `getAttribute` is here because the live check
 * on 2026-07-31 found the review count lives ONLY in an aria-label. An earlier
 * version read textContent alone, so statedReviewCount returned null on every real
 * page, which made the drift canary below permanently inert. A canary that cannot
 * fire is worse than none, because it is mistaken for protection.
 */

export const REVIEW_SELECTORS = Object.freeze({
  /** One review. */
  row: 'div.jftiEf',
  /** The relative date inside a row. */
  date: 'span.rsqaWe',
  /** An owner's reply inside a row. */
  ownerReply: '.CDe7pd',
  /** An advert dressed as a result. Two forms, both seen in the wild. */
  sponsored: '.CpccDe',
  sponsoredHeading: 'h1.kpih0e[aria-label="Sponsored"]',
  /**
   * The sort control. Present only when there ARE reviews to sort, which makes it a
   * far better "this page has reviews" signal than any count.
   *
   * Counting was tried first and abandoned: the figure lives in star-rating labels
   * like "4.8 stars 25 Reviews", the whole search results list stays in the DOM
   * beside the open place, and the panel is also full of "mentioned in 3 reviews"
   * topic chips. Every count on the page might belong to a different business, and a
   * canary reading another business's number is worse than no canary.
   */
  sortControl: 'button[aria-label="Sort reviews"]',
  /** Star-rating label, the one place a count is reliably formatted. Not load-bearing. */
  ratingLabel: 'span[aria-label*="Reviews"]',
});

function all(node, selector) {
  if (!node || typeof node.querySelectorAll !== 'function') return [];
  return Array.from(node.querySelectorAll(selector) ?? []);
}

function isSponsored(row) {
  if (!row || typeof row.querySelector !== 'function') return false;
  return Boolean(row.querySelector(REVIEW_SELECTORS.sponsored))
    || Boolean(row.querySelector(REVIEW_SELECTORS.sponsoredHeading));
}

/**
 * How many reviews the star label states.
 *
 * NOT load-bearing, and deliberately so. Counting was tried as the drift signal and
 * abandoned after checking the live page: the figure lives in labels shaped
 * "4.8 stars 25 Reviews", the entire search results list stays in the DOM beside the
 * open place, and the panel also carries "mentioned in 3 reviews" topic chips. Every
 * count on the page might belong to a different business. An unanchored read returned
 * 4 on a business with 25 reviews.
 */
export function statedReviewCount(doc) {
  for (const node of all(doc, REVIEW_SELECTORS.ratingLabel)) {
    const label = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null;
    const match = /([\d,]+)\s+Reviews?\b/i.exec(label ?? '');
    if (match) return Number(match[1].replace(/,/g, ''));
  }
  return null;
}

/**
 * Does this page have reviews at all?
 *
 * The sort control is the signal, because it exists only when there is something to
 * sort. Unlike a count it cannot belong to a different business, which is exactly the
 * problem that ruled counting out.
 */
export function hasReviewsUi(doc) {
  return all(doc, REVIEW_SELECTORS.sortControl).length > 0;
}

/**
 * Fail loudly when the selectors stop matching.
 *
 * The payload has a canary for exactly this reason, and the failure mode here is
 * worse: if `div.jftiEf` stops matching, every business returns "no reviews seen" and
 * the operator gets a column of nulls that looks exactly like sparse data rather than
 * like a broken tool. Throws rather than returning, because the caller must stop the
 * pass instead of grinding through 500 leads collecting nothing.
 */
export function assertSelectorsAlive(doc) {
  if (hasReviewsUi(doc) && all(doc, REVIEW_SELECTORS.row).length === 0) {
    throw new Error(
      `the panel offers ${REVIEW_SELECTORS.sortControl} but ${REVIEW_SELECTORS.row} matched no `
      + 'reviews. The Maps markup has changed and the review pass would silently report nulls '
      + 'for every business. Re-derive the selectors in src/sources/google-dom.js.'
    );
  }
}

/**
 * Read the panel.
 *
 * Returns nulls, not falses, when nothing was seen. `null` means "we did not look or
 * could not see", `false` means "we looked and there were none", and the difference
 * is binding across this codebase. A page whose reviews failed to render must not be
 * recorded as a business whose owner never replies, because that is a fact nobody
 * established and the operator would filter on it.
 *
 * The caller MUST have sorted by newest first. Maps defaults to "Most relevant", so
 * without that click the first row is not the latest review and `lastReviewDays` is
 * simply wrong. That is not this function's job to enforce, because it cannot see the
 * sort state, which is precisely why it is called out here.
 */
export function readReviewPanel(doc) {
  const rows = all(doc, REVIEW_SELECTORS.row).filter((row) => !isSponsored(row));

  if (rows.length === 0) {
    return {
      // No rows AND no sort control means a business with no reviews, which is a real
      // observation: nobody has replied because nobody has reviewed. No rows WITH a
      // sort control means the page has reviews we failed to read, which is not an
      // observation about the business at all.
      ownerReplies: hasReviewsUi(doc) ? null : false,
      lastReviewDays: null,
      precise: false,
      reviewsSeen: 0,
    };
  }

  const dates = rows.map((row) => {
    const node = row.querySelector(REVIEW_SELECTORS.date);
    return node ? node.textContent : null;
  });

  const newest = newestReviewDays(dates);

  return {
    ownerReplies: rows.some((row) => Boolean(row.querySelector(REVIEW_SELECTORS.ownerReply))),
    lastReviewDays: newest.days,
    precise: newest.precise,
    reviewsSeen: rows.length,
  };
}
