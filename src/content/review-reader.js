/**
 * Read the review panel out of a Maps place page.
 *
 * Injected by `chrome.scripting.executeScript({ files: [...] })`, whose result is the
 * value of this file's LAST EXPRESSION. That is the whole reason this file is shaped
 * as one bare IIFE with no exports and no imports.
 *
 * NO IMPORTS, for the same platform reason as main-world.js: a script injected this
 * way is a classic script, and this project has no build step, so an import statement
 * is a SyntaxError at injection time and nothing runs.
 *
 * The selectors are therefore duplicated from src/sources/google-dom.js, and
 * tests/google-dom.test.js asserts the two copies never drift apart. That is the same
 * arrangement main-world.js has for its message constant, and the same test guards it.
 *
 * This file DECIDES NOTHING. It returns what it saw and lets the worker interpret it,
 * because the interpretation carries the three-state null rules that the rest of the
 * codebase depends on, and those belong somewhere testable in bare Node.
 */
(() => {
  'use strict';

  // Must equal REVIEW_SELECTORS in src/sources/google-dom.js.
  const SELECTORS = {
    row: 'div.jftiEf',
    date: 'span.rsqaWe',
    ownerReply: '.CDe7pd',
    sponsored: '.CpccDe',
    sponsoredHeading: 'h1.kpih0e[aria-label="Sponsored"]',
    sortControl: 'button[aria-label="Sort reviews"]',
    ratingLabel: 'span[aria-label*="Reviews"]',
  };

  // A Google interstitial, which must stop the whole pass rather than one lead.
  const blocked = location.pathname.startsWith('/sorry')
    || document.title.toLowerCase().includes('unusual traffic');

  const rows = Array.from(document.querySelectorAll(SELECTORS.row))
    .filter((row) => !row.querySelector(SELECTORS.sponsored)
      && !row.querySelector(SELECTORS.sponsoredHeading))
    .map((row) => {
      const date = row.querySelector(SELECTORS.date);
      return {
        date: date ? date.textContent : null,
        hasReply: Boolean(row.querySelector(SELECTORS.ownerReply)),
      };
    });

  return {
    blocked,
    hasReviewsUi: document.querySelectorAll(SELECTORS.sortControl).length > 0,
    rows,
  };
})();
