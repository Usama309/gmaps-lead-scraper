import { REVIEW_SELECTORS, interpretPanel, assertRawSelectorsAlive } from '../sources/google-dom.js';

/**
 * The browser half of the review pass.
 *
 * Kept apart from review-pass.js so the orchestration, which holds every safety rule
 * worth testing, runs in bare Node with no browser. This file is the part that cannot
 * be unit tested, so it is deliberately thin: navigate, click, inject, hand back.
 *
 * Everything it needs is injected rather than imported, so a test can still drive it
 * with fakes and assert the sequence.
 */

const READER_FILE = 'src/content/review-reader.js';

/**
 * Steps, as semantic names rather than selectors.
 *
 * review-pass.js asks for 'sortNewest'; it does not know what a sort menu looks like.
 * Selectors belong to google-dom.js and to the injected reader, and nowhere else.
 *
 * These are matched by accessible name rather than by class, deliberately. The review
 * ROWS have to be matched by their obfuscated classes because they carry no accessible
 * name, but controls do carry one, and an aria-label survives a styling change that
 * would break a class. Measured live on 2026-07-31: the sort menu offers exactly
 * Most relevant, Newest, Highest rating, Lowest rating.
 */
export const STEPS = Object.freeze({
  reviewsTab: { role: 'tab', pattern: '^Reviews for ' },
  sortMenu: { selector: REVIEW_SELECTORS.sortControl },
  sortNewest: { role: 'menuitemradio', pattern: '^Newest$' },
});

/** Runs IN THE PAGE. Self-contained, because executeScript serialises it. */
function clickInPage(step) {
  const matches = (el, pattern) => {
    const name = el.getAttribute('aria-label') || el.textContent || '';
    return new RegExp(pattern).test(name.trim());
  };

  if (step.selector) {
    const el = document.querySelector(step.selector);
    if (!el) return false;
    el.click();
    return true;
  }

  const candidates = Array.from(document.querySelectorAll(`[role="${step.role}"]`));
  const target = candidates.find((el) => matches(el, step.pattern));
  if (!target) return false;
  target.click();
  return true;
}

/**
 * Build a driver over one reusable tab.
 *
 * The tab is created ONCE and reused for every lead. Opening a tab per lead would
 * leave the operator's browser full of them and cost a create and a destroy on top of
 * the load that is already the slowest part of this stage.
 */
export function createTabDriver({ tabs, scripting, waitMs = 4000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let tabId = null;

  const ensureTab = async () => {
    if (tabId !== null) return tabId;
    // active: false so a two-hour pass does not steal focus every 13 seconds.
    const tab = await tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id;
    return tabId;
  };

  return {
    async open(url) {
      const id = await ensureTab();
      await tabs.update(id, { url });
      // A fixed wait rather than a load event: Maps renders its panel well after
      // load fires, so the event would report ready while the page is still empty.
      await sleep(waitMs);

      const [probe] = await scripting.executeScript({ target: { tabId: id }, files: [READER_FILE] });
      if (probe?.result?.blocked) return { blocked: true, reason: 'Google served an interstitial' };
      return { ok: true };
    },

    async click(name) {
      const step = STEPS[name];
      if (!step) throw new Error(`unknown review pass step: ${name}`);
      const [out] = await scripting.executeScript({
        target: { tabId }, func: clickInPage, args: [step],
      });
      if (out?.result) await sleep(1200);
      return Boolean(out?.result);
    },

    async read() {
      const [out] = await scripting.executeScript({ target: { tabId }, files: [READER_FILE] });
      const raw = out?.result;
      // Throws on drift, which review-pass.js turns into a halt. Every remaining lead
      // would otherwise report nulls that read as sparse data.
      assertRawSelectorsAlive(raw);
      return interpretPanel(raw);
    },

    async close() {
      if (tabId === null) return;
      const id = tabId;
      tabId = null;
      await tabs.remove(id).catch(() => {});
    },
  };
}
