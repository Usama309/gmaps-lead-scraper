# Phase 3: Review Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Populate the last two null fields, `ownerReplies` and `lastReviewDays`, which unlock two of the operator's 21 filters and the dormancy score modifier.

**Architecture:** A second pass that reads the rendered Maps place panel, because this data exists nowhere else. The worker drives one dedicated tab through each lead, injects a reader, throttles, and stores the result. Operator decision on 2026-07-31: it runs over EVERY harvested lead automatically, not a shortlist.

**Tech Stack:** Chrome MV3, `chrome.scripting`, vanilla ES modules, no build step, Node's built-in test runner.

## What makes this phase different, and dangerous

Phases 1 and 2 made background fetches with `credentials: 'omit'`, so no Google account was ever attached. **This phase cannot do that.** The reviews only exist in the rendered page, so the pass runs in a real tab, in a real session, carrying the operator's real Google account. There is no allowlist trick available here.

Three consequences, all binding:

1. **It is attributable.** Every safety control in this phase exists because the activity cannot be made anonymous.
2. **It is slow.** Measured live on 2026-07-31: about 7 seconds of interaction per lead plus 5 to 8 seconds of page load, so 12 to 15 seconds each. 83 leads is roughly 18 minutes; 500 leads is nearly 2 hours.
3. **A run WILL be interrupted.** Something that takes two hours will hit a closed laptop, an evicted worker, or a Google interstitial. Resume is not a nicety here, it is the difference between a usable feature and one nobody finishes.

## Recon, measured 2026-07-31 against live Maps

Every selector in the spec still resolves. Verified on Chaudhry Dental Clinic, Attock:

| Selector | Result |
|---|---|
| `div.jftiEf` | 3 rows before sorting, 10 after |
| `span.rsqaWe` | present, text reads `"a year ago"` |
| `.CDe7pd` (owner reply) | 0 on this business, needs a business that has replies to confirm |
| `[data-item-id]` | 5 |
| `.CpccDe` (sponsored) | 0 |

**The finding that shapes the whole phase: reviews default to "Most relevant", not newest.** The sort menu offers exactly `["Most relevant", "Newest", "Highest rating", "Lowest rating"]`. Without clicking Newest, the first row is not the latest review and `lastReviewDays` is simply wrong. That click is mandatory, not an optimisation.

---

## Task 1: Parse a relative date

**Files:** Create `src/sources/review-dates.js`, `tests/review-dates.test.js`

**Produces:** `parseRelativeDate(text, now) -> { days, precise }`

Google gives relative text only: `"a year ago"`, `"3 days ago"`, `"2 weeks ago"`, `"6 months ago"`, `"just now"`. Convert to a day count.

`precise` is `false` once the unit is months or years, because the spec accepts that precision beyond about four weeks is approximate and the CSV must not imply otherwise.

Cases the tests must cover, each mutation-checked:
- `"a day ago"` and `"1 day ago"` both mean 1. Google uses the article form for singular.
- `"just now"`, `"a few seconds ago"`, `"a moment ago"` mean 0.
- `"a year ago"` is 365, not null, and `precise: false`.
- Unparseable text returns `null` days, NOT 0. A zero would read as a review posted today, which is the exact opposite of the truth and would make a dormant business look active.
- The operator's shortest filter is 3 days, so day and week granularity must be exact.

---

## Task 2: The page reader

**Files:** Create `src/sources/google-dom.js`, `tests/google-dom.test.js`

**Produces:**
- `readReviewPanel(doc, now) -> { ownerReplies, lastReviewDays, reviewsSeen, precise }` — PURE, takes a document-like object so it is testable in bare Node against fixture HTML.
- `REVIEW_SELECTORS` — every selector in one frozen object, since these are the most volatile values in the project.

**The reader must refuse to guess.** If it finds zero review rows, it returns `ownerReplies: null` and `lastReviewDays: null`, never `false` and `0`. Same three-state rule as the rest of the codebase: `null` is "we did not see", `false` is "we looked and there were none". A business whose reviews failed to render must not be recorded as a business whose owner never replies.

**Sponsored cards are excluded** before anything is counted: an article carrying `.CpccDe`, or a child `h1.kpih0e[aria-label="Sponsored"]`, is an advert.

**Selector drift needs its own canary,** for the same reason the payload has one. If `div.jftiEf` stops matching, every business silently reports "no reviews seen" and the operator gets a column of nulls that looks like sparse data. Export `assertSelectorsAlive(doc)` which throws when a page that clearly has reviews, judged by the review-count text, yields zero rows.

---

## Task 3: Drive the tab

**Files:** Create `src/pipeline/review-pass.js`, `tests/review-pass.test.js`. Modify `manifest.json` (add `scripting`).

**Produces:** `runReviewPass({ leads, driver, delay, signal, onProgress, startAt })`

`driver` is injected, so every test runs in bare Node with no browser: it exposes `open(url)`, `click(selector)`, `read()`, and `close()`.

Per lead: open `https://www.google.com/maps/place/?q=place_id:<placeId>`, click the Reviews tab, open the sort menu, click Newest, read, throttle, next.

**Binding safety requirements. Each exists because of something measured in this project.**

- **Block detection first.** Before reading, check for a `/sorry/` interstitial or a missing panel. On a block: STOP the whole pass immediately, exactly as `HALTING_REASONS` does in harvest.js. Never push through. This pass is attributable, so pushing through is worse here than anywhere else in the product.
- **Throttle between leads**, reusing `nextDelayMs()` from guard.js. Do not invent a second pacing scheme.
- **Resume.** Return `completedLeads` and accept `startAt`, mirroring `runHarvest`'s contract exactly, including the rule that a FAILED lead does not advance the counter so a resume retries it rather than skipping it. Read that code before writing this.
- **Abortable, keeping everything already read.**
- **One pass at a time**, slot claimed synchronously before the first await.
- **Skip leads already read recently.** A lead whose `lastReviewDays` was set within `CONFIG.reviewPass.recheckAfterDays` is not worth 13 seconds again.

---

## Task 4: Wire it, and warn honestly

**Files:** Modify `background.js`, `src/core/messages.js`, `src/ui/dashboard/*`

`REVIEW_PASS`, `REVIEW_PASS_PROGRESS`, `ABORT_REVIEW_PASS`.

The operator chose to run this over every harvested lead automatically. **It must still say what it is about to cost, before it starts**, because 500 leads is nearly two hours: state the lead count and the estimated minutes, from `CONFIG.reviewPass.secondsPerLead` measured at 13.

Progress must show which lead is being read and how many remain. A two-hour bar with no detail is indistinguishable from a hang.

The markup test in `tests/filter.test.js` forbids hardcoded numbers in runtime slots. Add any new slot id to its `EXPECTED` list with a `0` placeholder.

---

## Task 5: Live verification

Not optional. Phase 1 skipped its live step and it cost four defects; Phase 2's live step immediately found two more, including one that made two whole verticals return zero.

- [ ] Run the pass over a harvested set in Comet on the Usama profile.
- [ ] Record: leads read, owner replies found, dormant businesses found, wall clock, and whether any block was hit.
- [ ] Confirm on a business that DOES have owner replies that `.CDe7pd` resolves. The recon business had none, so that selector is the one still unverified.
- [ ] Confirm a business with no reviews reports `null`, not `0` days and `false` replies.
- [ ] Kill the pass midway, restart it, and confirm it resumes rather than starting over.
- [ ] Record the real numbers in `.claude/PROJECT_SCOPE.md`.

## Global Constraints

- All tunables in `src/core/config.js`; add a `reviewPass` block. All selectors in `REVIEW_SELECTORS`. No magic value anywhere else.
- Pure modules must not import browser APIs. `review-dates.js` and `readReviewPanel` are pure.
- Three-state nulls are binding: `null` is "not looked", `false` is "looked and absent".
- Never write an em dash.
- Every test must be mutation-checked: break the code in the way the test exists to catch, confirm the test fails, restore. Three review rounds on Phase 1 found tests that passed against the defect they were written for.
