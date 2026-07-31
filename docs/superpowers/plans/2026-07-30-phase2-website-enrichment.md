# Phase 2: Website Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a provisional score into a real one by fetching each surviving lead's website and reading six signals off it: email, platform, mobile friendliness, chatbot, online booking, and social links.

**Architecture:** A new pure module `src/core/fingerprints.js` holds every signature. A new module `src/pipeline/enrich.js` fetches a domain, scans the HTML as text, and returns a patch for the Lead. `src/store/db.js` gains a domain cache so a domain is fetched at most once per TTL across runs. The worker exposes an `ENRICH` message that the dashboard triggers on the CURRENTLY FILTERED set, which is what makes enrichment cheap: the expensive stage runs on survivors, not on everything harvested.

**Tech Stack:** Chrome MV3, vanilla ES modules, no build step, zero runtime dependencies, Node's built-in test runner.

## Global Constraints

- All tunables live in `src/core/config.js`. All score weights live in `src/core/scoring-config.js`. All signatures live in `src/core/fingerprints.js`. No magic value anywhere else.
- Pure modules must not import browser APIs. `fingerprints.js` and the scanning half of `enrich.js` must be testable in bare Node.
- Every Google request uses `credentials: 'omit'`. Enrichment fetches third-party sites, and those too must send no credentials: we are not logged in to a prospect's website and must never appear to be.
- The anonymous-cookie declarativeNetRequest rule is scoped to `www.google.com/search` carrying our marker. Enrichment fetches must NOT match it. Any change to that rule's `urlFilter` must keep enrichment out.
- Never write an em dash in user-facing copy.
- **Three-state null semantics are binding.** `null` means never inspected, `false` means inspected and absent. Enrichment sets `enriched: true` and must then write `false` rather than leaving `null`, or a "no chatbot" filter silently includes sites nobody looked at.

## Why the worker scans HTML as text rather than parsing it

Verified in the live worker on 2026-07-30: `DOMParser` is `undefined`, `document` is `undefined`, and `chrome.offscreen` is unavailable without declaring the permission. The alternative was an offscreen document purely to get a DOM.

Rejected, because the signals do not need one. Every fingerprint here is a substring of the raw markup: a script `src`, a `<meta name="generator">`, a `mailto:` href, a `viewport` meta, a booking widget's domain. That is what tech-detection tools match on. An offscreen document would add a permission, a document lifecycle, and a message hop, and would still be matching the same strings.

---

## Task 1: Fingerprint tables

**Files:**
- Create: `src/core/fingerprints.js`
- Test: `tests/fingerprints.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `FINGERPRINTS` (frozen), `detectTech(html) -> string`, `detectChatbot(html) -> boolean`, `detectBooking(html) -> boolean`, `detectSocials(html) -> string[]`, `detectMobileFriendly(html) -> true | false | 'partial'`.

Every detector takes the raw HTML string and returns a value. No fetching, no DOM, no imports beyond `config.js` if a tunable is needed.

`detectTech` must return one of the exact keys `SCORING.techBand` already maps: `wordpress`, `wix`, `weebly`, `godaddy`, `squarespace`, `next`, `react`, `webflow`, `shopify`, `unknown`. It must never invent a key, because an unmapped key falls through scoring silently.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run and confirm they fail**

Run: `node --test tests/fingerprints.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/core/fingerprints.js`**

Structure it as data plus one generic matcher, so adding a vendor is a one-line change:

```js
export const FINGERPRINTS = Object.freeze({
  tech: Object.freeze({
    wordpress: ['/wp-content/', '/wp-includes/', 'name="generator" content="WordPress'],
    wix: ['static.parastorage.com', 'wix.com/website-builder'],
    squarespace: ['squarespace.com', 'static1.squarespace.com'],
    godaddy: ['godaddysites.com', 'img1.wsimg.com'],
    weebly: ['weebly.com', 'editmysite.com'],
    shopify: ['cdn.shopify.com', 'shopify.com/s/files'],
    webflow: ['assets.website-files.com', 'webflow.io'],
    next: ['/_next/static/', '__NEXT_DATA__'],
    react: ['react-dom', 'data-reactroot'],
  }),
  chatbot: Object.freeze(['widget.intercom.io', 'js.driftt.com', 'embed.tawk.to',
    'client.crisp.chat', 'code.tidio.co', 'js.hs-scripts.com', 'cdn.livechatinc.com']),
  booking: Object.freeze(['assets.calendly.com', 'acuityscheduling.com', 'squareup.com/appointments',
    'setmore.com', 'simplybook.me', 'booksy.com', 'fresha.com', 'opentable.com', 'resy.com']),
  socials: Object.freeze({
    facebook: 'facebook.com/', instagram: 'instagram.com/', linkedin: 'linkedin.com/',
    x: 'twitter.com/', tiktok: 'tiktok.com/', youtube: 'youtube.com/',
  }),
  // Paths that mean "share this page", not "our profile".
  socialNoise: Object.freeze(['/sharer', '/share?', '/intent/', 'plugins/like']),
});
```

Order matters in `detectTech`: check the specific builders before the generic frameworks, because a Wix site also ships React. Return the FIRST match in a deliberate order, and write that order down in a comment.

- [ ] **Step 4: Run the tests, confirm they pass**

- [ ] **Step 5: Commit**

```bash
git add src/core/fingerprints.js tests/fingerprints.test.js
git commit -m "feat: website fingerprint tables and detectors"
```

---

## Task 2: The domain cache

**Files:**
- Modify: `src/store/db.js`, `src/core/config.js` (only if a tunable is missing)
- Test: `tests/db.test.js`

**Interfaces:**
- Produces: `getCachedDomain(domain) -> record | null`, `putCachedDomain(domain, record) -> void`.

A record holds the enrichment patch plus `fetchedAt`. `getCachedDomain` returns `null` past `CONFIG.enrich.domainCacheTtlDays`, so a stale entry is a miss rather than a wrong answer.

Two businesses commonly share a domain (a chain, or a shared agency landing page). The cache is keyed by DOMAIN, not by lead, which is the whole point: it is what stops a 200-lead run making 200 fetches to the same host.

- [ ] **Step 1: Write the failing tests**

```js
test('a cached domain inside the TTL is returned', async () => { /* put then get */ });
test('a cached domain past the TTL is a miss, not a stale hit', async () => {
  // Write with a fetchedAt older than CONFIG.enrich.domainCacheTtlDays and assert null.
});
test('the cache is keyed by domain, so two leads sharing a host cost one fetch', async () => {});
```

- [ ] **Step 2: Run, confirm failure. Step 3: Implement. Step 4: Run, confirm pass. Step 5: Commit.**

Keep `db.js` the only module that touches IndexedDB. Add an object store in the existing upgrade path and bump `CONFIG.db.version`.

---

## Task 3: Fetch one site

**Files:**
- Create: `src/pipeline/enrich.js`
- Test: `tests/enrich.test.js`

**Interfaces:**
- Consumes: `fingerprints.js`, `config.js`.
- Produces: `scanHtml(html) -> patch` (PURE, no network), `enrichOne({ lead, fetchPage, now }) -> patch`, `enrichLeads({ leads, ... }) -> { patches, stats }`.

Split deliberately. `scanHtml` is pure and carries all the logic, so it is exhaustively testable in bare Node. `enrichOne` owns only fetching, timeouts and failure classification, and takes `fetchPage` injected so no test ever hits the network.

**The failure taxonomy is the important part of this task.** From the spec: a dead domain is a 35-point scoring signal, not an error. Classify:

| Outcome | `websiteTech` | `enriched` |
|---|---|---|
| 200 with HTML | detected value | `true` |
| DNS failure, connection refused, timeout | `dead` | `true` |
| 4xx or 5xx | `dead` | `true` |
| Fetch threw for any other reason | unchanged (`null`) | `false` |

The last row matters: an unexplained failure must NOT be recorded as a dead domain, or a transient network fault permanently marks a live business as a 35-point lead.

- [ ] **Step 1: Write the failing tests**

```js
test('a dead domain is a scoring signal, not an error', async () => {
  const patch = await enrichOne({ lead: { website: 'https://gone.example' },
    fetchPage: async () => { throw Object.assign(new Error('failed'), { name: 'TypeError' }); } });
  assert.equal(patch.websiteTech, 'dead');
  assert.equal(patch.enriched, true);
});

test('a timeout is a dead domain, and does not hang the run', async () => {});

test('an unexplained failure leaves the lead unenriched rather than marking it dead', async () => {
  // Marking it dead would score a live business as a 35-point lead forever.
});

test('every enrichment field is written, so "no chatbot" never includes an uninspected site', () => {
  const patch = scanHtml('<html></html>');
  for (const field of ['hasChatbot', 'hasBooking', 'mobileFriendly']) {
    assert.notEqual(patch[field], null, `${field} must be false, not null, once inspected`);
  }
  assert.equal(patch.enriched, true);
});

test('enrichment fetches send no credentials', () => {
  // Read the source and assert the fetch call carries credentials: 'omit'. We are
  // not logged in to a prospect's site and must never appear to be.
});
```

- [ ] **Steps 2 to 5: fail, implement, pass, commit.**

Use `AbortSignal.timeout(CONFIG.enrich.fetchTimeoutMs)` (verified available in the worker). Cap response reading so a huge page cannot exhaust the worker.

---

## Task 4: Email, and the two extra pages

**Files:**
- Modify: `src/pipeline/enrich.js`
- Test: `tests/enrich.test.js`

Email is the one signal that may need more than the homepage. Follow at most `CONFIG.enrich.maxExtraPages` (2) same-origin candidates, `/contact` then `/about`, and ONLY when the homepage yielded no address.

- [ ] **Step 1: Write the failing tests**

```js
test('an email on the homepage costs no extra fetch', async () => {});
test('a missing email follows contact then about, and stops at two', async () => {
  // Assert the fetch count, not just the result. The cap is the point.
});
test('an off-origin contact link is not followed', async () => {
  // Following arbitrary links off a prospect's site is not something this tool does.
});
test('a mailto with a query string yields the address only', () => {
  assert.equal(scanHtml('<a href="mailto:a@b.pk?subject=Hi">m</a>').email, 'a@b.pk');
});
test('an obviously non-contact address is ignored', () => {
  // sentry, wixpress, example.com and image filenames that look like addresses.
});
```

- [ ] **Steps 2 to 5: fail, implement, pass, commit.**

---

## Task 5: Run enrichment over the filtered set

**Files:**
- Modify: `background.js`, `src/core/messages.js`
- Test: `tests/enrich.test.js`

**Interfaces:**
- Produces: `MSG.ENRICH`, `MSG.ENRICH_PROGRESS`.

The handler takes the same filter state the dashboard is showing, resolves it to leads, and enriches only those. That is the spec's ordering, and the reason the expensive stage stays cheap.

Requirements, each of which has bitten this project before in Phase 1:

- One enrichment run at a time, with the slot claimed SYNCHRONOUSLY before the first `await`, exactly as `startRun` does.
- Throttled between fetches, reusing `nextDelayMs()`. These are other people's servers.
- Abortable, and an abort must persist what has already been enriched.
- Progress broadcast as it goes, not only at the end. A long run's single awaited response is lost if the panel closes.
- Writes go through the same serialised `pendingWrites` chain, and are awaited before reporting done.

- [ ] **Step 1: Write the failing tests. Steps 2 to 5: fail, implement, pass, commit.**

---

## Task 6: Show it in the dashboard

**Files:**
- Modify: `src/ui/dashboard/index.html`, `src/ui/dashboard/dashboard.js`
- Test: `tests/filter.test.js` (the markup guard)

An "Enrich N websites" button on the filter rail, plus a real progress line and a real count.

**The markup guard in `tests/filter.test.js` forbids hardcoded figures in runtime slots, and it will fail if you ship a placeholder.** That is deliberate. A mockup enrichment bar reading "12 of 18 domains resolved, 68%" shipped in Phase 1 and described a phase that did not exist. Every number must come from `dashboard.js` at runtime, and the markup placeholder must be `0`.

After enrichment, rows must stop saying "score provisional". Assert that.

- [ ] **Steps 1 to 5.**

---

## Task 7: Prove the score actually changed

**Files:**
- Test: `tests/score.test.js`, `tests/enrich.test.js`

The point of Phase 2 is that a provisional score becomes real. Verify end to end, in-process:

- [ ] **Step 1: Write the tests**

```js
test('enriching a lead removes provisional and moves the score', () => {
  // A WordPress site with no booking widget must score differently once enriched
  // than it did as a floor, and provisional must become false.
});

test('a lead whose enrichment failed unexplained stays provisional', () => {});

test('the mobile and booking components only contribute once enriched', () => {
  // They are worth 20 points each. If they contributed while null, every
  // unenriched lead would carry 40 points it had not earned.
});
```

- [ ] **Steps 2 to 5.**

---

## Task 8: Live verification

Phase 1's lesson, and it cost four defects: unit tests against an injected `fetch` cannot see how the real world behaves. Do not mark Phase 2 done without this.

- [ ] **Step 1:** Load the extension, harvest 2 km of `dentist` in Attock, filter to leads that have a website.
- [ ] **Step 2:** Enrich. Record: how many domains resolved, how many were dead, how many timed out, and the wall-clock time.
- [ ] **Step 3:** Check the detected platform against three sites by opening them and looking. A detector that reports `unknown` for an obvious WordPress site is a fingerprint bug, not a miss.
- [ ] **Step 4:** Confirm the cache works: re-run enrichment and confirm zero fetches.
- [ ] **Step 5:** Export and confirm `Score provisional` now reads `no`, and that `Mobile friendly` and `Online booking` carry real values rather than `unknown`.
- [ ] **Step 6:** Record the real numbers in `.claude/PROJECT_SCOPE.md`.

---

## Self-review notes

- **Spec coverage.** All six Tier 3 filters have a task: email (4), tech (1), mobile (1), chatbot (1), booking (1), socials (1). The domain cache, throttling and the enrichment trigger each have one. `ownerReplies` and `lastReviewDays` are Phase 3, not here, and stay `null`.
- **Type consistency.** `detectTech` returns keys that `SCORING.techBand` maps, asserted by a test rather than by hope. `mobileFriendly` is `true | false | 'partial'`, matching what `filter.js` already handles.
- **The three-state rule is the trap in this phase.** Every task that writes an enrichment field must write `false` rather than leave `null`, and Task 3 has an explicit test for it. A `null` after enrichment means "never inspected" and would silently pull uninspected businesses into the operator's "no chatbot" list.
