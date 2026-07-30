# MapProspector Phase 1: Harvest to CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Chrome MV3 extension that harvests Google Maps business listings for a keyword and location, deduplicates them, scores each as a sales opportunity with stated reasons, filters them locally, and exports the qualified set as CSV.

**Architecture:** Extraction reads Google's own embedded JSON payload rather than scraping the DOM. A leg queue multiplies keywords by radius tiles to get past the hard 247-results-per-query cap. Everything after harvest is a pure function over IndexedDB, so re-filtering never costs a network request.

**Tech Stack:** Chrome MV3, vanilla JavaScript ES modules, no build step, zero runtime dependencies. Tests run on Node's built-in `node:test` and `node:assert`.

## Global Constraints

- **Chrome MV3 only.** Service worker declared with `"type": "module"`.
- **Every Google request uses `credentials: 'omit'`.** No Google account may ever be attached to a request. This is a binding risk control, not a preference.
- **Zero runtime dependencies.** No bundler, no transpiler, no npm packages shipped in the extension. Dev dependencies used only by the test harness are permitted, because nothing in `devDependencies` reaches the browser. Exactly one is used: `fake-indexeddb`.
- **Pure modules must not import browser APIs.** `score.js`, `filter.js`, `tiling.js`, `identity.js`, `schema.js`, `guard.js`, `payload-map.js`, `csv.js` must be importable in bare Node, because that is how they are tested.
- **All tunables live in `src/core/config.js`.** All scoring weights live in `src/core/scoring-config.js`. No magic number may appear anywhere else.
- **Hard cap of 247 results per query.** Page size 20. Offsets step by 20.
- **Never retry through a block.** On a block signal, pause and notify. No backoff-and-continue.
- **No em dashes in any user-facing string, comment, or commit message.**
- **Node 24+** for the test runner.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Declares ESM, wires the `test` script. No dependencies. |
| `manifest.json` | MV3 manifest with a pinned `key` for a stable extension ID. |
| `background.js` | Service worker. Message router between UI and pipeline. |
| `src/core/config.js` | Every tunable: timings, caps, page size, TTLs. |
| `src/core/identity.js` | Normalisers and dedupe key derivation. No imports. |
| `src/core/schema.js` | The Lead record shape and normalisation. |
| `src/core/scoring-config.js` | Score weights, modifiers, appointment categories. |
| `src/pipeline/score.js` | Pure. `(lead) -> {score, reasons, provisional}`. |
| `src/pipeline/filter.js` | Pure. `(leads, filterState) -> leads`. |
| `src/pipeline/tiling.js` | Pure. Radius to a grid of sub-centres. |
| `src/pipeline/guard.js` | Pure. Block versus end-of-list classification, throttle delays. |
| `src/sources/payload-map.js` | Pinned positional indices, version, canary self-test. |
| `src/sources/source.js` | The interface every harvester implements. |
| `src/sources/google-payload.js` | Primary harvester. Touches network. |
| `src/pipeline/harvest.js` | Leg queue, dedupe pool, resume state. |
| `src/store/db.js` | The only module that touches IndexedDB. |
| `src/export/csv.js` | Pure. Lead array to CSV text. |
| `src/ui/dashboard/` | Filter rail, results table, export button. |
| `tests/` | One test file per pure module. |

---

### Task 1: Project scaffold, governance files, and manifest

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `.claude/PROJECT_SCOPE.md`, `.claude/TASKLIST.md`, `.claude/CHANGELOG.md`, `.claude/DECISIONS.md`, `.claude/KNOWN_ISSUES.md`
- Create: `CLAUDE.md`
- Create: `tests/manifest.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a loadable unpacked extension and a working `npm test` command.

- [ ] **Step 1: Write the failing test**

Create `tests/manifest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('manifest targets MV3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('service worker is an ES module', () => {
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('manifest pins a key so the extension ID is stable', () => {
  assert.ok(typeof manifest.key === 'string' && manifest.key.length > 100,
    'a pinned key is required or the OAuth client breaks on every reload');
});

test('host permissions cover Google Maps and arbitrary business sites', () => {
  assert.ok(manifest.host_permissions.includes('https://www.google.com/*'));
  assert.ok(manifest.host_permissions.includes('http://*/*'));
  assert.ok(manifest.host_permissions.includes('https://*/*'));
});

test('declares the storage and sidePanel permissions the pipeline needs', () => {
  for (const p of ['storage', 'unlimitedStorage', 'sidePanel']) {
    assert.ok(manifest.permissions.includes(p), `missing permission: ${p}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, because `package.json` and `manifest.json` do not exist yet.

- [ ] **Step 3: Generate the pinned extension key**

The extension ID must not change between reloads, or the Sheets OAuth client in Phase 4 silently breaks. Generate a keypair and derive the manifest `key`:

```bash
cd ~/Sites/gmaps-lead-scraper
mkdir -p .keys
openssl genrsa -out .keys/extension.pem 2048 2>/dev/null
openssl rsa -in .keys/extension.pem -pubout -outform DER 2>/dev/null | base64 | tr -d '\n' > .keys/manifest-key.txt
echo "extension ID:"
openssl rsa -in .keys/extension.pem -pubout -outform DER 2>/dev/null \
  | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p'
echo ""
printf '.keys/\n' >> .gitignore
```

Record the printed extension ID in `.claude/DECISIONS.md`. The private key stays out of git.

- [ ] **Step 4: Write `package.json` and install the one dev dependency**

Run `npm install` after writing the file. It pulls a single package, used only by
`tests/db.test.js` to provide an in-memory IndexedDB. Nothing in `devDependencies`
ships in the extension.

```json
{
  "name": "mapprospector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Chrome extension that harvests and scores Google Maps business leads",
  "scripts": {
    "test": "node --test"
  },
  "devDependencies": {
    "fake-indexeddb": "^6.0.0"
  }
}
```

- [ ] **Step 5: Write `manifest.json`**

Paste the contents of `.keys/manifest-key.txt` as the `key` value.

```json
{
  "manifest_version": 3,
  "name": "MapProspector",
  "version": "0.1.0",
  "description": "Harvest, score and export local business leads.",
  "key": "PASTE_CONTENTS_OF_.keys/manifest-key.txt_HERE",
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_title": "MapProspector"
  },
  "side_panel": {
    "default_path": "src/ui/sidepanel/index.html"
  },
  "permissions": [
    "storage",
    "unlimitedStorage",
    "sidePanel",
    "tabs"
  ],
  "host_permissions": [
    "https://www.google.com/*",
    "http://*/*",
    "https://*/*"
  ]
}
```

- [ ] **Step 6: Create the five governance files**

Required by the operator's project standards. Populate from the approved spec, not blank templates.

`.claude/PROJECT_SCOPE.md`:

```markdown
# Project Scope: MapProspector

## What this is
A Chrome MV3 extension that harvests Google Maps business listings, scores each as a
web-design or online-booking sales opportunity, and exports the qualified set.

Design spec: `docs/superpowers/specs/2026-07-29-gmaps-lead-scraper-design.md`

## Current State
Phase 1 in progress. Nothing shipped yet.

## In Progress
Phase 1, harvest to CSV. See `docs/superpowers/plans/2026-07-29-phase1-harvest-to-csv.md`.

## Next Priorities
1. Phase 1: harvest to CSV
2. Phase 2: website enrichment and full scoring
3. Phase 3: review intelligence via the detail-panel pass
4. Phase 4: export suite including Sheets OAuth
5. Phase 5: OpenStreetMap and Foursquare adapters
6. Phase 6: UI to the approved design

## Architecture Decisions
See `.claude/DECISIONS.md`.

## Known Issues
See `.claude/KNOWN_ISSUES.md`.
```

`.claude/DECISIONS.md`:

```markdown
# Architecture Decision Records

## ADR-001: Extract from the embedded JSON payload, not the DOM
**Date:** 2026-07-29
**Decision:** Read business records from `window.APP_INITIALIZATION_STATE` and the
`/search?tbm=map&pb=` paging endpoint rather than scraping the results feed.
**Why:** Measured live. The payload returned 238 records for one query with 98% phone
coverage. In the same browser session the DOM infinite-scroll loader stalled at 10 cards
on two separate dense queries. The payload route needs no login, no detail-panel clicks
and no class names.
**Consequence:** Positional index drift is the standing risk. Mitigated by a pinned
versioned index map plus a canary that aborts the run loudly.

## ADR-002: Terms of service exposure is accepted, with logged-out requests as control
**Date:** 2026-07-29
**Decision:** Proceed with Google as primary source. All requests use `credentials: 'omit'`.
**Why:** Every route to Maps data conflicts with Google's terms, including the paid Places
API, which additionally costs $20 to $35 per 1,000 for the fields that matter and forbids
storing them. The operator reviewed this and chose to proceed.
**Consequence:** Logged-out requests mean no Google account is attached, so there is no
account to suspend. Licensed sources stay first-class so the tool survives if the Google
route is abandoned.

## ADR-003: Zero runtime dependencies, no build step
**Date:** 2026-07-29
**Decision:** Vanilla ES modules. Tests on `node:test`.
**Why:** Solo operator, constrained budget, and a debuggable extension matters more than
type safety here. A build step is friction with no proportional payoff at this size.
**Consequence:** Pure modules must avoid browser APIs so they remain testable in Node.

## ADR-004: Pinned extension key in the manifest
**Date:** 2026-07-29
**Decision:** Ship a `key` field so the extension ID is stable.
**Why:** Without it the ID changes on every unpacked reload and the Phase 4 Sheets OAuth
client breaks silently. That is the usual failure mode for this feature.
**Extension ID:** RECORD_THE_ID_PRINTED_IN_STEP_3_HERE
```

`.claude/KNOWN_ISSUES.md`:

```markdown
# Known Issues

## Open
- Google review dates are relative text only, so last-review precision beyond roughly
  four weeks is approximate. Documented in the spec, not fixable.
- Mobile-friendliness is a heuristic from a single HTML fetch, not a PageSpeed verdict.
  Labelled as such in the UI.
- The sub-940px dashboard layout has never been rendered and verified. The CSS exists.

## Resolved
None yet.
```

`.claude/CHANGELOG.md`:

```markdown
# Changelog

## [Unreleased]
### Added
- [2026-07-29 04:00 PM] Design spec and Phase 1 implementation plan
```

`.claude/TASKLIST.md`:

```markdown
# Task List

## Phase 1: Harvest to CSV
- [ ] Task 1: Project scaffold, governance files, manifest
- [ ] Task 2: config.js, the tunables single source of truth
- [ ] Task 3: identity.js and schema.js
- [ ] Task 4: scoring-config.js and score.js
- [ ] Task 5: filter.js
- [ ] Task 6: tiling.js
- [ ] Task 7: payload-map.js and the canary
- [ ] Task 8: guard.js, block versus end-of-list
- [ ] Task 9: source.js and google-payload.js
- [ ] Task 10: harvest.js, the leg queue
- [ ] Task 11: csv.js
- [ ] Task 12: mergeLead and db.js
- [ ] Task 13: content script pb capture and background router
- [ ] Task 14: dashboard wiring and live end-to-end run

## Summary
0 of 14 complete.
```

`CLAUDE.md` in the project root:

```markdown
# MapProspector

Import user-level rules from `~/.claude/CLAUDE.md`.

## Stack
Chrome MV3 extension. Vanilla ES modules, no build step, zero runtime dependencies.
Tests: `npm test` (Node's built-in test runner).

## Project-specific rules
- All tunables belong in `src/core/config.js`. All score weights belong in
  `src/core/scoring-config.js`. Never inline a magic number elsewhere.
- Pure modules must not import browser APIs. They are tested in bare Node.
- Every Google request uses `credentials: 'omit'`. This is a binding risk control.
- Never write an em dash in user-facing copy.

## Key documents
- Spec: `docs/superpowers/specs/2026-07-29-gmaps-lead-scraper-design.md`
- Current plan: `docs/superpowers/plans/2026-07-29-phase1-harvest-to-csv.md`
- State: `.claude/PROJECT_SCOPE.md`
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: 5 passing tests, 0 failing.

- [ ] **Step 8: Verify the extension actually loads in Chrome**

Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select the project root. Expected: the extension appears with no errors, and its ID matches the one recorded in ADR-004. A manifest that passes tests but will not load is not done.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: scaffold MV3 extension with pinned key and governance files"
```

---

### Task 2: config.js, the tunables single source of truth

**Files:**
- Create: `src/core/config.js`
- Create: `tests/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONFIG` object. Every later task imports tunables from here and defines none of its own.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/core/config.js';

test('harvest caps match the measured Google limits', () => {
  assert.equal(CONFIG.harvest.pageSize, 20);
  assert.equal(CONFIG.harvest.perQueryCap, 247);
});

test('throttle delay is a sane randomised range', () => {
  assert.ok(CONFIG.harvest.delayMs.min >= 800, 'too aggressive');
  assert.ok(CONFIG.harvest.delayMs.max > CONFIG.harvest.delayMs.min);
});

test('harvest is serial by default', () => {
  assert.equal(CONFIG.harvest.maxParallel, 1);
});

test('the tiling threshold is absolute so the single-tile path can actually fire', () => {
  assert.ok(CONFIG.tiling.minRadiusForTilingKm > 0);
});

test('tile spacing is an absolute distance, not a fraction of the radius', () => {
  assert.ok(CONFIG.tiling.spacingKm > 0);
  assert.equal(CONFIG.tiling.spacingFactor, undefined,
    'a proportional spacing factor cancels the radius out and pins the grid size');
});

test('guard knows the valid payload prefix', () => {
  assert.equal(CONFIG.guard.validPrefix, ")]}'");
});

test('config is frozen so nothing can mutate a tunable at runtime', () => {
  assert.throws(() => { CONFIG.harvest.pageSize = 99; });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL, cannot find module `../src/core/config.js`.

- [ ] **Step 3: Write the implementation**

Create `src/core/config.js`:

```js
/**
 * Every tunable in the project. Nothing else may define a magic number.
 * Deep-frozen so a runtime mutation fails loudly instead of silently
 * changing behaviour halfway through a run.
 */
function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const CONFIG = deepFreeze({
  harvest: {
    // Measured against live Google Maps on 2026-07-29.
    pageSize: 20,
    perQueryCap: 247,
    // Randomised inter-request delay. Recon could not trigger a block at a far
    // higher rate, but the downside of being wrong is asymmetric.
    delayMs: { min: 1200, max: 2800 },
    maxParallel: 1,
    maxLegsPerRun: 60,
  },

  tiling: {
    // Absolute distance between tile centres. This must NOT be a fraction of the
    // requested radius: ceil(radius / (radius * factor)) cancels the radius out,
    // pinning the grid to a constant size and making query density fall as
    // 1/radius^2. A query's real catch-area depends on business density around
    // the query point, not on how wide the operator drew the circle, so the
    // spacing that matters is absolute.
    // 6 km chosen against the UI's own 15 km default radius: it yields 21 tiles,
    // comfortably under maxTiles, so the common case never truncates. Tighter
    // spacing (3 km) tripled the query count for heavily overlapping coverage and
    // truncated the default search down to about 8 km.
    spacingKm: 6,
    // Hard ceiling on queries per run. Reaching it means the requested radius was
    // larger than maxTiles can cover, which is reported to the operator rather
    // than silently truncating coverage.
    maxTiles: 25,
    // Below this radius one query already covers the area, so skip tiling.
    minRadiusForTilingKm: 5,
  },

  guard: {
    validPrefix: ")]}'",
    blockedStatuses: [302, 429, 403, 503],
    latencyEwmaAlpha: 0.3,
    // Pause if smoothed latency exceeds this multiple of the first observed latency.
    latencyBreachMultiple: 4,
  },

  enrich: {
    domainCacheTtlDays: 30,
    maxExtraPages: 2,
    fetchTimeoutMs: 12000,
  },

  export: {
    csvDelimiter: ',',
    csvNewline: '\r\n',
  },

  db: {
    name: 'mapprospector',
    version: 1,
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.js tests/config.test.js
git commit -m "feat: add config as the single source of truth for tunables"
```

---

### Task 3: identity.js and schema.js

**Files:**
- Create: `src/core/identity.js`
- Create: `src/core/schema.js`
- Create: `tests/identity.test.js`
- Create: `tests/schema.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeName(s) -> string`
  - `normalizePhone(s) -> string|null`
  - `normalizeDomain(url) -> string|null`
  - `leadKey(lead) -> string` (the dedupe identity)
  - `makeLead(partial) -> Lead`
  - `LEAD_FIELDS -> string[]`

- [ ] **Step 1: Write the failing test for identity**

Create `tests/identity.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, normalizePhone, normalizeDomain, leadKey } from '../src/core/identity.js';

test('normalizeName folds case, punctuation and spacing', () => {
  assert.equal(normalizeName('  Al-Shifa  Dental   Clinic!  '), 'al shifa dental clinic');
  assert.equal(normalizeName('Dr. Ayesha Skin Clinic'), 'dr ayesha skin clinic');
});

test('normalizePhone keeps digits only and drops a leading zero after country code', () => {
  assert.equal(normalizePhone('+92 57 261 4408'), '92572614408');
  assert.equal(normalizePhone('(0300) 512-7739'), '03005127739');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
});

test('normalizeDomain strips scheme, www and path', () => {
  assert.equal(normalizeDomain('https://www.MalikDental.com/contact?x=1'), 'malikdental.com');
  assert.equal(normalizeDomain('attockphoto.wixsite.com/home'), 'attockphoto.wixsite.com');
  assert.equal(normalizeDomain('not a url'), null);
  assert.equal(normalizeDomain(null), null);
});

test('leadKey prefers the Google CID', () => {
  assert.equal(leadKey({ cid: '0x38df9a:0x1234', name: 'X' }), 'cid:0x38df9a:0x1234');
});

test('leadKey falls back to name plus phone when there is no CID', () => {
  assert.equal(
    leadKey({ cid: null, name: 'Hazro Auto Works', phone: '+92 57 231 9012' }),
    'np:hazro auto works|92572319012'
  );
});

test('leadKey falls back to name plus rounded coordinates when there is no phone', () => {
  assert.equal(
    leadKey({ cid: null, name: 'Sharif Tailors', phone: null, lat: 33.76098243, lng: 72.3428741 }),
    'nl:sharif tailors|33.7610|72.3429'
  );
});

test('leadKey throws rather than returning a colliding key when nothing identifies the lead', () => {
  assert.throws(() => leadKey({ cid: null, name: '', phone: null, lat: null, lng: null }),
    /cannot derive/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/identity.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write identity.js**

Create `src/core/identity.js`:

```js
/**
 * Normalisers and dedupe identity. Deliberately dependency-free: this is the
 * leaf of the import graph and every other core module may import it.
 */

export function normalizeName(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D+/g, '');
  return digits.length ? digits : null;
}

export function normalizeDomain(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  // A hostname with no dot is not a real domain, it is stray text.
  if (!host.includes('.')) return null;
  return host.replace(/^www\./, '');
}

/**
 * Stable identity for deduplication, in descending order of trust.
 * Throws rather than inventing a key, because a colliding key silently merges
 * two different businesses and that corruption is unrecoverable.
 */
export function leadKey(lead) {
  if (lead.cid) return `cid:${lead.cid}`;

  const name = normalizeName(lead.name);
  const phone = normalizePhone(lead.phone);
  if (name && phone) return `np:${name}|${phone}`;

  if (name && Number.isFinite(lead.lat) && Number.isFinite(lead.lng)) {
    return `nl:${name}|${lead.lat.toFixed(4)}|${lead.lng.toFixed(4)}`;
  }

  throw new Error('cannot derive a dedupe key: lead has no cid, no name+phone, no name+coords');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/identity.test.js`
Expected: 7 passing.

- [ ] **Step 5: Write the failing test for schema**

Create `tests/schema.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead, LEAD_FIELDS } from '../src/core/schema.js';

test('makeLead fills every declared field', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X' });
  for (const field of LEAD_FIELDS) {
    assert.ok(field in lead, `missing field: ${field}`);
  }
});

test('makeLead normalises name, phone and domain', () => {
  const lead = makeLead({
    name: '  Glow Beauty Salon & Spa ',
    phone: '+92 57 261 4408',
    website: 'https://www.GlowAttock.com/home',
  });
  assert.equal(lead.name, 'Glow Beauty Salon & Spa');
  assert.equal(lead.phone, '+92 57 261 4408');
  assert.equal(lead.domain, 'glowattock.com');
});

test('makeLead coerces numerics and rejects nonsense', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', rating: '4.6', reviewCount: '212', lat: '33.76', lng: 'abc' });
  assert.equal(lead.rating, 4.6);
  assert.equal(lead.reviewCount, 212);
  assert.equal(lead.lat, 33.76);
  assert.equal(lead.lng, null);
});

test('makeLead defaults enrichment fields to unknown, never to false', () => {
  // Uses a lead that HAS a website, so the platform is genuinely unknown. A lead
  // with no website is a different case: 'none' there is knowledge, not absence.
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: 'https://x.pk' });
  assert.equal(lead.enriched, false);
  assert.equal(lead.websiteTech, null, 'a site we have not inspected has an unknown platform');
  assert.equal(lead.mobileFriendly, null);
  assert.equal(lead.hasBooking, null);
  assert.equal(lead.lastReviewDays, null);
});

test('makeLead classifies a Facebook page in the website slot as not a real website', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: 'https://facebook.com/glowattock' });
  assert.equal(lead.websiteTech, 'facebook');
  assert.equal(lead.hasRealWebsite, false);
});

test('makeLead treats a normal website as a real website with unknown platform', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: 'https://malikdental.com' });
  assert.equal(lead.hasRealWebsite, true);
  assert.equal(lead.websiteTech, null);
});

test('makeLead marks no website at all', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', website: null });
  assert.equal(lead.hasRealWebsite, false);
  assert.equal(lead.websiteTech, 'none');
});

test('makeLead always sets a dedupe key', () => {
  assert.equal(makeLead({ cid: '0xabc:0xdef', name: 'X' }).key, 'cid:0xabc:0xdef');
});

test('categories is always an array with falsy entries removed', () => {
  assert.deepEqual(makeLead({ cid: '0x1:0x1', name: 'X', categories: ['Dentist', null, ''] }).categories, ['Dentist']);
  assert.deepEqual(makeLead({ cid: '0x1:0x1', name: 'X' }).categories, []);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test tests/schema.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 7: Write schema.js**

Create `src/core/schema.js`:

```js
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
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test tests/schema.test.js tests/identity.test.js`
Expected: 16 passing total.

- [ ] **Step 9: Commit**

```bash
git add src/core/identity.js src/core/schema.js tests/identity.test.js tests/schema.test.js
git commit -m "feat: add lead schema and dedupe identity derivation"
```

---

### Task 4: scoring-config.js and score.js

**Files:**
- Create: `src/core/scoring-config.js`
- Create: `src/pipeline/score.js`
- Create: `tests/score.test.js`

**Interfaces:**
- Consumes: `makeLead` from `src/core/schema.js`.
- Produces: `scoreLead(lead) -> { score: number, reasons: string[], provisional: boolean }`, and the `SCORING` config object.

- [ ] **Step 1: Write the failing test**

Create `tests/score.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead } from '../src/core/schema.js';
import { scoreLead } from '../src/pipeline/score.js';
import { SCORING } from '../src/core/scoring-config.js';

/** An enriched, reachable, mid-size business. Components isolated per test. */
function base(overrides = {}) {
  return makeLead({
    cid: '0x1:0x1',
    name: 'Test Business',
    phone: '+92 300 000 0000',
    reviewCount: 100,
    categories: ['Hardware store'],
    enriched: true,
    mobileFriendly: true,
    hasBooking: false,
    ...overrides,
  });
}

test('no website scores the full website gap', () => {
  const { score, reasons } = scoreLead(base({ website: null }));
  // 40 website + 0 mobile(unknown, no site) + 6 non-appointment + 20 viability
  assert.equal(score, 66);
  assert.ok(reasons.includes('No website'));
});

test('a Facebook page in the website slot scores 38', () => {
  const { reasons } = scoreLead(base({ website: 'https://facebook.com/x' }));
  assert.ok(reasons.includes('Facebook page as website'));
});

test('a dead website scores 35', () => {
  const { reasons } = scoreLead(base({ website: 'https://alshifa.pk/', websiteTech: 'dead' }));
  assert.ok(reasons.includes('Website URL is dead'));
});

test('a DIY builder site scores 30 and names the builder', () => {
  const { reasons } = scoreLead(base({ website: 'https://x.wixsite.com', websiteTech: 'wix' }));
  assert.ok(reasons.some(r => /wix builder site/i.test(r)));
});

test('WordPress scores 20 on platform identity alone, with no age judgement', () => {
  const { reasons } = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress' }));
  assert.ok(reasons.includes('WordPress site'));
  assert.ok(!reasons.some(r => /dated|old/i.test(r)), 'must not claim age it cannot measure');
});

test('a modern custom build scores only 5', () => {
  const a = scoreLead(base({ website: 'https://x.pk', websiteTech: 'next' })).score;
  const b = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress' })).score;
  assert.ok(a < b, 'a modern site must be a worse lead than WordPress');
});

test('a detected but unrecognised platform scores the middle value 12', () => {
  const { score } = scoreLead(base({ website: 'https://x.pk', websiteTech: 'unknown' }));
  // 12 website + 0 mobile(pass) + 6 non-appointment + 20 viability
  assert.equal(score, 38);
});

test('failing mobile adds the full mobile gap', () => {
  const pass = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: true }));
  const fail = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: false }));
  assert.equal(fail.score - pass.score, SCORING.mobileGap.noViewport);
  assert.ok(fail.reasons.includes('fails mobile'));
});

test('partial mobile scores between pass and fail', () => {
  const partial = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: 'partial' }));
  const fail = scoreLead(base({ website: 'https://x.pk', websiteTech: 'wordpress', mobileFriendly: false }));
  assert.ok(partial.score < fail.score);
});

test('an appointment business with no booking scores the full booking gap', () => {
  const { score, reasons } = scoreLead(base({
    website: 'https://x.pk', websiteTech: 'wordpress',
    categories: ['Dentist'], hasBooking: false,
  }));
  // 20 website + 0 mobile + 20 booking + 20 viability
  assert.equal(score, 60);
  assert.ok(reasons.some(r => /dentist.*no online booking/i.test(r)));
});

test('an appointment business that already books online scores zero booking gap', () => {
  const { score } = scoreLead(base({
    website: 'https://x.pk', websiteTech: 'wordpress',
    categories: ['Dentist'], hasBooking: true,
  }));
  assert.equal(score, 40);
});

test('viability rewards the established-SMB band and penalises the extremes', () => {
  const w = { website: 'https://x.pk', websiteTech: 'wordpress' };
  const sweet = scoreLead(base({ ...w, reviewCount: 100 })).score;
  const big = scoreLead(base({ ...w, reviewCount: 700 })).score;
  const huge = scoreLead(base({ ...w, reviewCount: 5000 })).score;
  const tiny = scoreLead(base({ ...w, reviewCount: 3 })).score;
  assert.ok(sweet > big && big > huge, 'bigger businesses are worse leads');
  assert.ok(sweet > tiny, 'too-new businesses are worse leads');
});

test('unknown review count scores the neutral midpoint, for licensed sources', () => {
  const { reasons } = scoreLead(base({
    website: 'https://x.pk', websiteTech: 'wordpress',
    reviewCount: null, provenance: 'osm',
  }));
  assert.ok(reasons.includes(SCORING.viability.unknownReason));
});

test('every viability band produces a reason, so none can be added without text', () => {
  for (const band of SCORING.viability.bands) {
    const count = Number.isFinite(band.max) ? band.max : band.min;
    const { reasons } = scoreLead(base({
      website: 'https://x.pk', websiteTech: 'wordpress', reviewCount: count,
    }));
    const expected = band.reason.replace('{count}', count);
    assert.ok(reasons.includes(expected),
      `band ${band.min}..${band.max} produced no reason; got ${JSON.stringify(reasons)}`);
  }
});

test('unreachable businesses are multiplied down', () => {
  const reachable = scoreLead(base({ website: null, phone: '+92 300 000 0000' })).score;
  const unreachable = scoreLead(base({ website: null, phone: null, email: null })).score;
  assert.equal(unreachable, Math.round(reachable * SCORING.modifiers.unreachable));
});

test('an email alone counts as reachable', () => {
  const withEmail = scoreLead(base({ website: null, phone: null, email: 'a@b.com' })).score;
  const withNeither = scoreLead(base({ website: null, phone: null, email: null })).score;
  assert.ok(withEmail > withNeither);
});

test('a dormant business is multiplied down', () => {
  const fresh = scoreLead(base({ website: null, lastReviewDays: 10 })).score;
  const dormant = scoreLead(base({ website: null, lastReviewDays: 400 })).score;
  assert.equal(dormant, Math.round(fresh * SCORING.modifiers.dormant));
});

test('a permanently closed business scores exactly zero and says why', () => {
  const { score, reasons } = scoreLead(base({ website: null, permanentlyClosed: true }));
  assert.equal(score, 0);
  assert.deepEqual(reasons, ['permanently closed']);
});

test('an unenriched lead is marked provisional and skips enrichment-only components', () => {
  const lead = makeLead({ cid: '0x1:0x1', name: 'X', phone: '+92 1', reviewCount: 100, website: 'https://x.pk' });
  const { provisional, reasons } = scoreLead(lead);
  assert.equal(provisional, true);
  assert.ok(!reasons.includes('fails mobile'));
  assert.ok(!reasons.some(r => /no online booking/.test(r)));
});

test('an enriched lead is not provisional', () => {
  assert.equal(scoreLead(base({ website: null })).provisional, false);
});

test('score is always an integer within 0 to 100', () => {
  const cases = [
    base({ website: null }),
    base({ website: null, phone: null, email: null, lastReviewDays: 500 }),
    base({ website: 'https://x.pk', websiteTech: 'next', mobileFriendly: true, hasBooking: true, reviewCount: 9000 }),
    base({ website: null, categories: ['Dentist'], reviewCount: 50, mobileFriendly: false }),
  ];
  for (const lead of cases) {
    const { score } = scoreLead(lead);
    assert.ok(Number.isInteger(score), `not an integer: ${score}`);
    assert.ok(score >= 0 && score <= 100, `out of range: ${score}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/score.test.js`
Expected: FAIL, cannot find module `scoring-config.js`.

- [ ] **Step 3: Write scoring-config.js**

Create `src/core/scoring-config.js`:

```js
/**
 * Every scoring weight. Tune here and nowhere else.
 *
 * The operator sells website design and online booking systems, so a good lead
 * is a real, reachable, solvent business with a weak or absent web presence.
 *
 * Components are independent by design: each answers a different question and no
 * signal may feed two of them. Scoring both "Wix" and "old Wix" would count one
 * weakness twice, so platform age is deliberately not scored at all.
 */
export const SCORING = Object.freeze({
  websiteGap: Object.freeze({
    none: 40,
    facebook: 38,
    dead: 35,
    builder: 30,
    wordpress: 20,
    unknown: 12,
    modern: 5,
  }),

  /** websiteTech value to its scoring band. */
  techBand: Object.freeze({
    none: 'none',
    facebook: 'facebook',
    dead: 'dead',
    wix: 'builder',
    weebly: 'builder',
    godaddy: 'builder',
    squarespace: 'builder',
    wordpress: 'wordpress',
    next: 'modern',
    react: 'modern',
    webflow: 'modern',
    shopify: 'modern',
    unknown: 'unknown',
  }),

  mobileGap: Object.freeze({
    noViewport: 20,
    fixedWidth: 12,
    responsive: 0,
  }),

  bookingGap: Object.freeze({
    appointmentMissing: 20,
    appointmentPresent: 0,
    nonAppointment: 6,
  }),

  viability: Object.freeze({
    // Each band carries the text that explains it. Keeping the wording beside the
    // numbers it describes is what stops the explanation desynchronising from the
    // score when these are retuned. {count} is substituted at render time.
    bands: Object.freeze([
      Object.freeze({ min: 10, max: 300, points: 20, reason: '{count} reviews' }),
      Object.freeze({ min: 301, max: 1000, points: 12, reason: '{count} reviews, established' }),
      Object.freeze({ min: 1001, max: Infinity, points: 4, reason: '{count} reviews, likely has an agency' }),
      Object.freeze({ min: 0, max: 9, points: 8, reason: 'only {count} reviews' }),
    ]),
    unknown: 12,
    unknownReason: 'review count unknown',
  }),

  modifiers: Object.freeze({
    unreachable: 0.6,
    dormant: 0.7,
    dormantAfterDays: 365,
  }),

  /** Categories where an online booking gap is a real sales opening. */
  appointmentCategories: Object.freeze([
    'dentist', 'orthodontist', 'dermatologist', 'medical clinic', 'clinic',
    'physiotherapist', 'chiropractor', 'veterinarian', 'eye care centre',
    'beauty salon', 'hair salon', 'nail salon', 'barber shop', 'spa',
    'massage therapist', 'tattoo shop', 'gym', 'fitness centre', 'yoga studio',
    'photographer', 'auto repair shop', 'driving school', 'tutoring service',
    'dance school', 'pet groomer', 'nutritionist', 'therapist',
  ]),
});
```

- [ ] **Step 4: Write score.js**

Create `src/pipeline/score.js`:

```js
import { SCORING } from '../core/scoring-config.js';

function isAppointmentCategory(categories) {
  return categories.some((c) => {
    const norm = String(c).toLowerCase().trim();
    return SCORING.appointmentCategories.some((a) => norm.includes(a) || a.includes(norm));
  });
}

function websiteGap(lead, reasons) {
  const tech = lead.websiteTech ?? 'unknown';
  const band = SCORING.techBand[tech] ?? 'unknown';
  const points = SCORING.websiteGap[band];

  const label = {
    none: 'No website',
    facebook: 'Facebook page as website',
    dead: 'Website URL is dead',
    builder: `${tech} builder site`,
    wordpress: 'WordPress site',
    unknown: 'website platform unrecognised',
    modern: 'modern custom build',
  }[band];

  if (label) reasons.push(label);
  return points;
}

function mobileGap(lead, reasons) {
  // A business with no website has no mobile problem to sell against; the
  // absence is already fully priced by websiteGap.
  if (!lead.hasRealWebsite) return 0;

  if (lead.mobileFriendly === false) {
    reasons.push('fails mobile');
    return SCORING.mobileGap.noViewport;
  }
  if (lead.mobileFriendly === 'partial') {
    reasons.push('partly mobile friendly');
    return SCORING.mobileGap.fixedWidth;
  }
  return SCORING.mobileGap.responsive;
}

function bookingGap(lead, reasons) {
  const appointment = isAppointmentCategory(lead.categories);
  const primary = (lead.categories[0] ?? 'business').toLowerCase();

  if (!appointment) return SCORING.bookingGap.nonAppointment;

  if (lead.hasBooking === true) return SCORING.bookingGap.appointmentPresent;

  reasons.push(`${primary}, no online booking`);
  return SCORING.bookingGap.appointmentMissing;
}

function viability(lead, reasons) {
  const count = lead.reviewCount;
  if (count === null) {
    reasons.push(SCORING.viability.unknownReason);
    return SCORING.viability.unknown;
  }
  for (const band of SCORING.viability.bands) {
    if (count >= band.min && count <= band.max) {
      reasons.push(band.reason.replace('{count}', count));
      return band.points;
    }
  }
  reasons.push(SCORING.viability.unknownReason);
  return SCORING.viability.unknown;
}

/**
 * Score a lead as a sales opportunity.
 *
 * Returns `provisional: true` when the lead has not been enriched yet, because
 * the mobile and booking components cannot be answered without fetching the
 * business's website. A provisional score is a floor, not an estimate.
 */
export function scoreLead(lead) {
  if (lead.permanentlyClosed) {
    return { score: 0, reasons: ['permanently closed'], provisional: false };
  }

  const reasons = [];
  let score = websiteGap(lead, reasons) + viability(lead, reasons);

  if (lead.enriched) {
    score += mobileGap(lead, reasons) + bookingGap(lead, reasons);
  }

  if (!lead.phone && !lead.email) {
    score *= SCORING.modifiers.unreachable;
    reasons.push('no phone or email, unreachable');
  }

  if (lead.lastReviewDays !== null && lead.lastReviewDays > SCORING.modifiers.dormantAfterDays) {
    score *= SCORING.modifiers.dormant;
    reasons.push('no review in over a year');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    provisional: !lead.enriched,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/score.test.js`
Expected: 20 passing. If the three arithmetic assertions (66, 38, 60, 40) disagree, the weights in `scoring-config.js` are the source of truth and the test expectations should be recomputed, not the weights adjusted to fit.

- [ ] **Step 6: Commit**

```bash
git add src/core/scoring-config.js src/pipeline/score.js tests/score.test.js
git commit -m "feat: add explainable lead scoring with isolated weight config"
```

---

### Task 5: filter.js

**Files:**
- Create: `src/pipeline/filter.js`
- Create: `tests/filter.test.js`

**Interfaces:**
- Consumes: `scoreLead` from `src/pipeline/score.js`.
- Produces:
  - `DEFAULT_FILTER_STATE` object, the canonical shape of all 21 filters
  - `filterLeads(leads, filterState) -> Lead[]` where each returned lead carries `score`, `reasons`, `provisional`

- [ ] **Step 1: Write the failing test**

Create `tests/filter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead } from '../src/core/schema.js';
import { filterLeads, DEFAULT_FILTER_STATE } from '../src/pipeline/filter.js';

let n = 0;
function lead(overrides = {}) {
  n += 1;
  return makeLead({
    cid: `0x${n}:0x${n}`,
    name: `Business ${n}`,
    phone: '+92 300 000 0000',
    rating: 4.5,
    reviewCount: 100,
    categories: ['Hardware store'],
    enriched: true,
    mobileFriendly: true,
    hasBooking: false,
    website: 'https://example.pk',
    websiteTech: 'wordpress',
    ...overrides,
  });
}

function run(leads, patch = {}) {
  return filterLeads(leads, { ...DEFAULT_FILTER_STATE, ...patch });
}

test('default state passes everything and attaches a score', () => {
  const out = run([lead(), lead()]);
  assert.equal(out.length, 2);
  assert.ok(Number.isInteger(out[0].score));
  assert.ok(Array.isArray(out[0].reasons));
});

test('results are sorted by score descending by default', () => {
  const out = run([lead({ websiteTech: 'next' }), lead({ website: null })]);
  assert.ok(out[0].score > out[1].score);
});

test('minScore filters', () => {
  const out = run([lead({ website: null }), lead({ websiteTech: 'next' })], { minScore: 50 });
  assert.equal(out.length, 1);
});

test('minRating and maxReviews filter', () => {
  assert.equal(run([lead({ rating: 3.9 }), lead({ rating: 4.8 })], { minRating: 4.5 }).length, 1);
  assert.equal(run([lead({ reviewCount: 50 }), lead({ reviewCount: 900 })], { maxReviews: 500 }).length, 1);
  assert.equal(run([lead({ reviewCount: 5 }), lead({ reviewCount: 50 })], { minReviews: 10 }).length, 1);
});

test('website tri-state filters on real websites, not the raw field', () => {
  const facebook = lead({ website: 'https://facebook.com/x' });
  const real = lead({ website: 'https://real.pk', websiteTech: 'wordpress' });
  const none = lead({ website: null });
  assert.equal(run([facebook, real, none], { website: 'no' }).length, 2,
    'a Facebook page counts as having no real website');
  assert.equal(run([facebook, real, none], { website: 'yes' }).length, 1);
});

test('hasPhone filters', () => {
  assert.equal(run([lead({ phone: null }), lead()], { hasPhone: 'yes' }).length, 1);
});

test('tech multi-select filters, empty means any', () => {
  const leads = [lead({ websiteTech: 'wix' }), lead({ websiteTech: 'wordpress' }), lead({ website: null })];
  assert.equal(run(leads, { tech: [] }).length, 3);
  assert.equal(run(leads, { tech: ['wix'] }).length, 1);
  assert.equal(run(leads, { tech: ['wix', 'wordpress'] }).length, 2);
  assert.equal(run(leads, { tech: ['none'] }).length, 1);
});

test('mobile, booking, chatbot and email tri-states filter', () => {
  assert.equal(run([lead({ mobileFriendly: false }), lead()], { mobileFriendly: 'no' }).length, 1);
  assert.equal(run([lead({ hasBooking: true }), lead()], { hasBooking: 'no' }).length, 1);
  assert.equal(run([lead({ hasChatbot: true }), lead({ hasChatbot: false })], { hasChatbot: 'no' }).length, 1);
  assert.equal(run([lead({ email: 'a@b.com' }), lead()], { hasEmail: 'yes' }).length, 1);
});

test('a "no X" filter never returns a lead whose X was never inspected', () => {
  // An unenriched null means "we have not looked". Treating it as confirmed
  // absent would put un-inspected businesses into a list the operator trusts.
  const FIELD_FOR = {
    hasEmail: 'email', hasSocials: 'socials', hasBooking: 'hasBooking',
    hasChatbot: 'hasChatbot', ownerReplies: 'ownerReplies',
  };
  for (const [filterKey, field] of Object.entries(FIELD_FOR)) {
    const unlooked = lead({ enriched: false, [field]: null });
    const looked = lead({ enriched: true, [field]: null });
    const out = run([unlooked, looked], { [filterKey]: 'no' }).map((l) => l.name);
    assert.deepEqual(out, [looked.name],
      `${filterKey} leaked an un-inspected lead into a 'no' filter`);
  }
});

test('mobileFriendly no returns both outright failures and partial sites', () => {
  const fails = lead({ mobileFriendly: false });
  const partial = lead({ mobileFriendly: 'partial' });
  const passes = lead({ mobileFriendly: true });
  const unknown = lead({ mobileFriendly: null });
  const names = run([fails, partial, passes, unknown], { mobileFriendly: 'no' })
    .map((l) => l.name).sort();
  assert.deepEqual(names, [fails.name, partial.name].sort());
  assert.deepEqual(run([fails, partial, passes, unknown], { mobileFriendly: 'yes' })
    .map((l) => l.name), [passes.name]);
});

test('ownerReplies tri-state filters', () => {
  assert.equal(run([lead({ ownerReplies: true }), lead({ ownerReplies: false })], { ownerReplies: 'yes' }).length, 1);
});

test('lastReviewWithinDays filters and excludes unknown recency', () => {
  const leads = [lead({ lastReviewDays: 3 }), lead({ lastReviewDays: 40 }), lead({ lastReviewDays: null })];
  assert.equal(run(leads, { lastReviewWithinDays: 7 }).length, 1);
  assert.equal(run(leads, { lastReviewWithinDays: 0 }).length, 3, '0 means any time');
});

test('categories filter matches case-insensitively on any category', () => {
  const leads = [lead({ categories: ['Dentist'] }), lead({ categories: ['Bakery'] })];
  assert.equal(run(leads, { categories: ['dentist'] }).length, 1);
  assert.equal(run(leads, { categories: [] }).length, 2);
});

test('socials filter requires at least one link', () => {
  const leads = [lead({ socials: ['facebook'] }), lead({ socials: [] })];
  assert.equal(run(leads, { hasSocials: 'yes' }).length, 1);
});

test('skipExported removes leads whose key is in the exported set', () => {
  const a = lead(); const b = lead();
  const out = run([a, b], { skipExported: true, exportedKeys: new Set([a.key]) });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, b.key);
});

test('skipExported is ignored when the toggle is off', () => {
  const a = lead(); const b = lead();
  assert.equal(run([a, b], { skipExported: false, exportedKeys: new Set([a.key]) }).length, 2);
});

test('permanently closed businesses are always excluded', () => {
  assert.equal(run([lead({ permanentlyClosed: true }), lead()]).length, 1);
});

test('filterLeads does not mutate its input', () => {
  const input = [lead()];
  const snapshot = JSON.stringify(input);
  filterLeads(input, DEFAULT_FILTER_STATE);
  assert.equal(JSON.stringify(input), snapshot);
});

test('every filter key in DEFAULT_FILTER_STATE is documented in the spec set', () => {
  const expected = [
    'keywords', 'location', 'lat', 'lng', 'zoom', 'radiusKm', 'categories',
    'minRating', 'openNow',
    'minReviews', 'maxReviews', 'hasPhone', 'website', 'ownerReplies', 'lastReviewWithinDays',
    'hasEmail', 'tech', 'mobileFriendly', 'hasChatbot', 'hasBooking', 'hasSocials',
    'minScore', 'skipExported', 'exportedKeys', 'sortBy', 'sortDir',
  ];
  assert.deepEqual(Object.keys(DEFAULT_FILTER_STATE).sort(), expected.sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/filter.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write filter.js**

Create `src/pipeline/filter.js`:

```js
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

/**
 * Fold a nullable enrichment value into a tri-value.
 *
 * A null on an UNENRICHED lead means "we have not looked", and that must never
 * satisfy a "no X" filter: it would put un-inspected businesses into a list the
 * operator believes is verified. The same null on an ENRICHED lead does mean
 * confirmed absent, because enrichment ran and found nothing.
 */
function presence(lead, value) {
  const hasValue = Array.isArray(value) ? value.length > 0 : Boolean(value);
  if (hasValue) return true;
  return lead.enriched ? false : null;
}

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
    // All five enrichment fields go through presence() so "not looked" and
    // "looked and absent" stay distinguishable regardless of whether the field
    // is value-typed (email, socials) or boolean (booking, chatbot, replies).
    if (!triState(f.hasEmail, presence(l, l.email))) return false;
    if (!triState(f.hasSocials, presence(l, l.socials))) return false;
    if (!triState(f.ownerReplies, presence(l, l.ownerReplies))) return false;
    if (!triState(f.hasBooking, presence(l, l.hasBooking))) return false;
    if (!triState(f.hasChatbot, presence(l, l.hasChatbot))) return false;

    // mobileFriendly is tri-valued in the data ('partial'), so it cannot use triState.
    // A partially responsive site counts as a fails-mobile LEAD: the owner sells
    // mobile-friendly redesigns, so anything short of properly responsive is a
    // pitch. The scoring layer still prices partial below a full failure, which is
    // the right place for that distinction.
    if (f.mobileFriendly === 'yes' && l.mobileFriendly !== true) return false;
    if (f.mobileFriendly === 'no'
      && l.mobileFriendly !== false && l.mobileFriendly !== 'partial') return false;

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/filter.test.js`
Expected: 17 passing.

- [ ] **Step 5: Run the whole suite to check nothing regressed**

Run: `npm test`
Expected: all passing across config, identity, schema, score, filter, manifest.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/filter.js tests/filter.test.js
git commit -m "feat: add pure filter pipeline covering all 21 filters"
```

---

### Task 6: tiling.js

**Files:**
- Create: `src/pipeline/tiling.js`
- Create: `tests/tiling.test.js`

**Interfaces:**
- Consumes: `CONFIG` from `src/core/config.js`.
- Produces: `planTiles({ lat, lng, radiusKm }) -> { tiles, truncated, candidateCount, requestedRadiusKm, effectiveRadiusKm }`, `tileRadius(args) -> [{ lat, lng }]` (thin wrapper), `haversineKm(a, b) -> number`

**Why this task exists:** a single Google query is hard-capped at 247 results. The only way to harvest more from one area is to run the same keyword at several sub-centres and merge on the dedupe key.

- [ ] **Step 1: Write the failing test**

Create `tests/tiling.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, tileRadius, haversineKm } from '../src/pipeline/tiling.js';
import { CONFIG } from '../src/core/config.js';

const ATTOCK = { lat: 33.7609824, lng: 72.342874 };

test('haversineKm returns zero for identical points', () => {
  assert.equal(haversineKm(ATTOCK, ATTOCK), 0);
});

test('haversineKm matches a known distance within one percent', () => {
  // Attock to Islamabad measures about 66 km great-circle.
  const islamabad = { lat: 33.6844, lng: 73.0479 };
  const d = haversineKm(ATTOCK, islamabad);
  assert.ok(d > 63 && d < 68, `unexpected distance: ${d}`);
});

test('a small radius produces a single tile at the centre', () => {
  const tiles = tileRadius({ ...ATTOCK, radiusKm: 2 });
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].lat, ATTOCK.lat);
  assert.equal(tiles[0].lng, ATTOCK.lng);
});

test('the tiling threshold is an absolute distance, not a fraction of the radius', () => {
  assert.equal(tileRadius({ ...ATTOCK, radiusKm: CONFIG.tiling.minRadiusForTilingKm }).length, 1);
  assert.ok(tileRadius({ ...ATTOCK, radiusKm: CONFIG.tiling.minRadiusForTilingKm + 25 }).length > 1);
});

test('a large radius produces multiple tiles', () => {
  const tiles = tileRadius({ ...ATTOCK, radiusKm: 30 });
  assert.ok(tiles.length > 1, 'a 30 km radius must be tiled');
});

test('the centre is always included as a tile', () => {
  const tiles = tileRadius({ ...ATTOCK, radiusKm: 50 });
  assert.ok(tiles.some((t) => t.lat === ATTOCK.lat && t.lng === ATTOCK.lng));
});

test('every tile lies inside the requested radius', () => {
  const radiusKm = 30;
  for (const tile of tileRadius({ ...ATTOCK, radiusKm })) {
    const d = haversineKm(ATTOCK, tile);
    assert.ok(d <= radiusKm + 0.001, `tile ${d} km out exceeds radius ${radiusKm}`);
  }
});

test('tiles overlap enough to cover the gaps between them', () => {
  const radiusKm = 30;
  const tiles = tileRadius({ ...ATTOCK, radiusKm });
  const spacing = CONFIG.tiling.spacingKm;
  // Nearest-neighbour distance must not exceed the spacing, or coverage has holes.
  for (const a of tiles) {
    const nearest = Math.min(...tiles.filter((b) => b !== a).map((b) => haversineKm(a, b)));
    assert.ok(nearest <= spacing * 1.5, `tile isolated by ${nearest} km`);
  }
});

test('tile count grows with radius, so coverage density does not collapse', () => {
  // Guards the bug this module shipped with once: spacing as a fraction of the
  // radius cancels the radius out, pinning the grid to 9 tiles at every scale.
  const small = planTiles({ ...ATTOCK, radiusKm: 8 }).candidateCount;
  const medium = planTiles({ ...ATTOCK, radiusKm: 20 }).candidateCount;
  const large = planTiles({ ...ATTOCK, radiusKm: 40 }).candidateCount;
  assert.ok(medium > small, `medium ${medium} must exceed small ${small}`);
  assert.ok(large > medium, `large ${large} must exceed medium ${medium}`);
});

test('the tile cap actually engages and is reported, never silent', () => {
  const plan = planTiles({ ...ATTOCK, radiusKm: 500 });
  assert.equal(plan.tiles.length, CONFIG.tiling.maxTiles, 'the cap must bind');
  assert.ok(plan.candidateCount > CONFIG.tiling.maxTiles, 'the cap must have something to cut');
  assert.equal(plan.truncated, true, 'truncation must be reported');
  assert.ok(plan.effectiveRadiusKm < plan.requestedRadiusKm,
    'a truncated plan covers less than was asked for and must say so');
});

test('an untruncated plan reports its full radius as effective', () => {
  const plan = planTiles({ ...ATTOCK, radiusKm: 8 });
  assert.equal(plan.truncated, false);
  assert.equal(plan.effectiveRadiusKm, plan.requestedRadiusKm);
});

test('tiling throws on invalid coordinates rather than emitting nonsense', () => {
  assert.throws(() => tileRadius({ lat: null, lng: 72, radiusKm: 10 }), /coordinates/i);
  assert.throws(() => tileRadius({ lat: 33, lng: 72, radiusKm: 0 }), /radius/i);
  assert.throws(() => tileRadius({ lat: 33, lng: 72, radiusKm: -5 }), /radius/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tiling.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

Create `src/pipeline/tiling.js`:

```js
import { CONFIG } from '../core/config.js';

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 110.574;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Plan the sub-centres for a circular search area.
 *
 * A single Google query is hard-capped at 247 results, so covering a real market
 * means firing the same keyword at several centres and merging on the dedupe key.
 * Tiles overlap deliberately: Google ranks by relevance to the query point, so a
 * business sitting between two centres would otherwise fall through the gap.
 *
 * Spacing is ABSOLUTE. An earlier version spaced tiles at a fraction of the
 * requested radius, which cancels the radius out of ceil(radius / spacing) and
 * pins the grid to a constant 9 tiles at every scale, so a 30 km search fired
 * exactly as many queries as a 6 km one and coverage density fell as 1/radius^2.
 *
 * Returns coverage metadata alongside the tiles, because hitting maxTiles shrinks
 * the area actually searched and the operator has to be told rather than handed a
 * short list that looks complete.
 */
export function planTiles({ lat, lng, radiusKm }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('planTiles requires finite coordinates');
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error('planTiles requires a positive radius');
  }

  const centre = { lat, lng };

  if (radiusKm <= CONFIG.tiling.minRadiusForTilingKm) {
    return {
      tiles: [centre],
      truncated: false,
      candidateCount: 1,
      requestedRadiusKm: radiusKm,
      effectiveRadiusKm: radiusKm,
    };
  }

  const spacingKm = CONFIG.tiling.spacingKm;
  const stepsPerSide = Math.ceil(radiusKm / spacingKm);
  const latStep = spacingKm / KM_PER_DEGREE_LAT;
  const lngStep = spacingKm / (KM_PER_DEGREE_LAT * Math.cos(toRad(lat)));

  const candidates = [];
  for (let i = -stepsPerSide; i <= stepsPerSide; i += 1) {
    for (let j = -stepsPerSide; j <= stepsPerSide; j += 1) {
      const tile = { lat: lat + i * latStep, lng: lng + j * lngStep };
      if (haversineKm(centre, tile) <= radiusKm) candidates.push(tile);
    }
  }

  // Nearest first, so truncation keeps the centre of the requested area rather
  // than an arbitrary slice of its edge.
  candidates.sort((a, b) => haversineKm(centre, a) - haversineKm(centre, b));

  const truncated = candidates.length > CONFIG.tiling.maxTiles;
  const tiles = candidates.slice(0, CONFIG.tiling.maxTiles);
  const effectiveRadiusKm = truncated
    ? haversineKm(centre, tiles[tiles.length - 1])
    : radiusKm;

  return {
    tiles,
    truncated,
    candidateCount: candidates.length,
    requestedRadiusKm: radiusKm,
    effectiveRadiusKm,
  };
}

/** Convenience wrapper for callers that do not need the coverage metadata. */
export function tileRadius(args) {
  return planTiles(args).tiles;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/tiling.test.js`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/tiling.js tests/tiling.test.js
git commit -m "feat: add radius tiling to get past the 247 per query cap"
```

---

### Task 7: payload-map.js and the canary

**Files:**
- Create: `src/sources/payload-map.js`
- Create: `tests/fixtures/payload-record.json`
- Create: `tests/payload-map.test.js`

**Interfaces:**
- Consumes: `makeLead` from `src/core/schema.js`.
- Produces:
  - `PAYLOAD_MAP` object, `PAYLOAD_MAP_VERSION` string
  - `extractRecord(rawRecord) -> Lead`
  - `extractPage(parsedPayload) -> { leads, rawCount, skipped }`
  - `extractRecords(parsedPayload) -> Lead[]` (thin wrapper over extractPage)
  - `CANARY_RULES` object
  - `runCanary(parsedPayload) -> { ok, problems, sampled, coverageJudged }`

**Why this task exists:** the payload is plain JSON addressed by positional index. Index drift is the standing risk in this whole project. This module is the only place an index may appear, and the canary makes drift fail loudly instead of silently emitting nulls.

- [ ] **Step 1: Create the fixture**

Create `tests/fixtures/payload-record.json`. It holds eight records, deliberately more than
`CANARY_RULES.minRecordsToJudgeCoverage`, so the coverage floors are actually exercisable. Two
records intentionally lack a website, mirroring the 67% website coverage measured live. Build it
with a script so the indices are unambiguous:

```bash
mkdir -p tests/fixtures
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
const BUSINESSES = [
  ['Al-Shifa Dental Clinic', 4.3, 87, '+92 57 261 2201', 'https://alshifadental.com.pk/', 33.7621, 72.3489],
  ['Attock Smile Studio', 4.7, 34, '+92 57 264 8890', 'https://attocksmile.wixsite.com/home', 33.7655, 72.3512],
  ['Malik Dental and Braces', 4.4, 145, '+92 57 270 3355', 'https://malikdental.com/', 33.7702, 72.3601],
  ['Hazro Auto Works', 4.1, 156, '+92 57 231 9012', null, 33.7588, 72.3402],
  ['Glow Beauty Salon and Spa', 4.6, 212, '+92 57 261 4408', 'https://facebook.com/glowattock', 33.7614, 72.3455],
  ['Kamra Physiotherapy Center', 4.8, 41, '+92 57 253 7719', 'https://kamraphysio.com/', 33.7699, 72.3388],
  ['Royal Barber Lounge', 4.5, 96, '+92 333 447 1160', null, 33.7643, 72.3521],
  ['Attock Eye Hospital', 4.6, 340, '+92 57 266 4400', 'https://attockeye.com.pk/', 33.7671, 72.3474],
];
const records = BUSINESSES.map(([name, rating, reviews, phone, website, lat, lng], i) => {
  const r = [];
  r[11] = name;
  r[4] = (() => { const a = []; a[7] = rating; a[8] = reviews; return a; })();
  r[13] = ['Dentist', 'Dental clinic'];
  r[178] = [[phone]];
  if (website) r[7] = [website, new URL(website).hostname];
  r[9] = (() => { const a = []; a[2] = lat; a[3] = lng; return a; })();
  r[78] = 'ChIJTestPlaceId' + i;
  r[10] = '0x38df9a1b2c3d4e5' + i + ':0x1234567890abcde' + i;
  r[18] = 'Pleader Lane, Attock, Punjab';
  r[203] = null;
  return [null, r];
});
const payload = []; payload[64] = records;
writeFileSync('tests/fixtures/payload-record.json', JSON.stringify(payload));
console.log('fixture written with', records.length, 'records');
"
```

- [ ] **Step 2: Write the failing test**

Create `tests/payload-map.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAYLOAD_MAP, PAYLOAD_MAP_VERSION, CANARY_RULES,
  extractRecord, extractPage, extractRecords, runCanary,
} from '../src/sources/payload-map.js';

const GOOD = JSON.parse(readFileSync(new URL('./fixtures/payload-record.json', import.meta.url), 'utf8'));
const firstRaw = GOOD[64][0][1];

/** Mutate every record's value at a mapped field path. */
function drift(field, value) {
  const copy = structuredClone(GOOD);
  const path = PAYLOAD_MAP.record[field];
  for (const entry of copy[64]) {
    let cursor = entry[PAYLOAD_MAP.recordWrapper];
    for (const index of path.slice(0, -1)) cursor = cursor[index];
    cursor[path[path.length - 1]] = value;
  }
  return copy;
}

test('the map declares a version so drift is traceable', () => {
  assert.match(PAYLOAD_MAP_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test('every mapped path is an array of indices', () => {
  for (const [field, path] of Object.entries(PAYLOAD_MAP.record)) {
    assert.ok(Array.isArray(path), `${field} path must be an array`);
    assert.ok(path.every((i) => Number.isInteger(i)), `${field} path must be all integers`);
  }
});

test('extractRecord pulls every field from the fixture', () => {
  const lead = extractRecord(firstRaw);
  assert.equal(lead.name, 'Al-Shifa Dental Clinic');
  assert.equal(lead.rating, 4.3);
  assert.equal(lead.reviewCount, 87);
  assert.deepEqual(lead.categories, ['Dentist', 'Dental clinic']);
  assert.equal(lead.phone, '+92 57 261 2201');
  assert.equal(lead.website, 'https://alshifadental.com.pk/');
  assert.equal(lead.domain, 'alshifadental.com.pk');
  assert.equal(lead.lat, 33.7621);
  assert.equal(lead.lng, 72.3489);
  assert.equal(lead.placeId, 'ChIJTestPlaceId0');
  assert.match(lead.cid, /^0x[0-9a-f]+:0x[0-9a-f]+$/);
  assert.equal(lead.address, 'Pleader Lane, Attock, Punjab');
  assert.equal(lead.provenance, 'google-payload');
});

test('extractRecord survives missing optional fields without inventing data', () => {
  const sparse = []; sparse[11] = 'Nameless Shop'; sparse[10] = '0x1:0x2';
  const lead = extractRecord(sparse);
  assert.equal(lead.name, 'Nameless Shop');
  assert.equal(lead.rating, null, 'a missing rating must be null, never 0');
  assert.equal(lead.reviewCount, null);
  assert.equal(lead.phone, null);
  assert.equal(lead.websiteTech, 'none');
});

test('extractPage reads all records and reports the raw count', () => {
  const page = extractPage(GOOD);
  assert.equal(page.leads.length, 8);
  assert.equal(page.rawCount, 8);
  assert.equal(page.skipped, 0);
});

test('extractPage distinguishes an empty container from records that all failed', () => {
  const empty = []; empty[64] = [];
  assert.deepEqual(extractPage(empty), { leads: [], rawCount: 0, skipped: 0 });

  // Eight records present, none with a derivable identity. This must NOT look
  // the same as an empty page, because the harvester reads an empty page as the
  // normal end of a leg and would report a completed search.
  const allBad = []; allBad[64] = Array.from({ length: 8 }, () => {
    const r = []; r[11] = 'Has A Name But No Identity';
    const entry = []; entry[PAYLOAD_MAP.recordWrapper] = r; return entry;
  });
  const page = extractPage(allBad);
  assert.equal(page.leads.length, 0);
  assert.equal(page.rawCount, 8, 'raw count must survive so total extraction failure is detectable');
  assert.equal(page.skipped, 8);
});

test('extractRecords stays available as a thin wrapper', () => {
  assert.equal(extractRecords(GOOD).length, 8);
  assert.deepEqual(extractRecords([]), []);
  assert.deepEqual(extractRecords(null), []);
});

test('canary passes on a good payload and judges coverage', () => {
  const result = runCanary(GOOD);
  assert.equal(result.ok, true, `unexpected problems: ${result.problems.join('; ')}`);
  assert.equal(result.sampled, 8);
  assert.equal(result.coverageJudged, true);
});

test('canary FAILS when the record container is missing entirely', () => {
  const { ok, problems } = runCanary({});
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /no records/i.test(p)));
});

test('canary FAILS when the name index has drifted to null', () => {
  const { ok, problems } = runCanary(drift('name', null));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /name/i.test(p)));
});

test('canary FAILS on a constant-offset shift that lands name on the CID', () => {
  // The subtle case: name is still a string, so a bare typeof check waves it
  // through. Only a format check catches it.
  const { ok, problems } = runCanary(drift('name', '0x38df9a1b2c3d4e5f:0x1234567890abcdef'));
  assert.equal(ok, false, 'a CID-shaped name means the indices shifted');
  assert.ok(problems.some((p) => /name/i.test(p)));
});

test('canary FAILS when the cid index lands on shared text, which would merge businesses', () => {
  const { ok, problems } = runCanary(drift('cid', 'Pleader Lane, Attock, Punjab'));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /cid/i.test(p)));
});

test('canary FAILS when the phone index is lost, the field the operator actually calls', () => {
  const { ok, problems } = runCanary(drift('phone', null));
  assert.equal(ok, false, 'total phone loss must not pass');
  assert.ok(problems.some((p) => /phone/i.test(p)));
});

test('canary FAILS when ratings stop being numeric', () => {
  const { ok, problems } = runCanary(drift('rating', 'four point three'));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /rating/i.test(p)));
});

test('canary FAILS when ratings go all-null, closing the empty-set escape hatch', () => {
  // An earlier version only validated non-null ratings, so a drift that nulled
  // every rating left nothing to check and reported healthy.
  const { ok, problems } = runCanary(drift('rating', null));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /rating/i.test(p)));
});

test('canary FAILS when coordinates drift out of valid range', () => {
  assert.equal(runCanary(drift('lat', 999)).ok, false);
  assert.equal(runCanary(drift('lng', 'seventy two')).ok, false);
});

test('canary FAILS when review counts stop being integers', () => {
  assert.equal(runCanary(drift('reviewCount', 'eighty seven')).ok, false);
});

test('a small sample skips coverage floors but still enforces identity fields', () => {
  const oneRecord = []; oneRecord[64] = [GOOD[64][0]];
  const healthy = runCanary(oneRecord);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.coverageJudged, false, 'one record is too few to judge a percentage');

  // Identity fields are still absolute, at any sample size.
  const broken = structuredClone(oneRecord);
  broken[64][0][PAYLOAD_MAP.recordWrapper][11] = null;
  assert.equal(runCanary(broken).ok, false, 'a missing name must fail even on one record');
});

test('CANARY_RULES marks name and cid as required, since they are the record identity', () => {
  const required = CANARY_RULES.fields.filter((f) => f.required).map((f) => f.field);
  assert.deepEqual(required.sort(), ['cid', 'name']);
  for (const rule of CANARY_RULES.fields) {
    assert.equal(typeof rule.valid, 'function', `${rule.field} needs a validator`);
    assert.ok(rule.why, `${rule.field} needs an explanation for the operator`);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/payload-map.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write the implementation**

Create `src/sources/payload-map.js`:

```js
import { makeLead } from '../core/schema.js';

/**
 * Positional indices into Google Maps' embedded search payload.
 *
 * THIS IS THE ONLY FILE PERMITTED TO CONTAIN A PAYLOAD INDEX.
 *
 * Verified against live Google Maps on 2026-07-29. The payload is plain JSON,
 * so parsing is not the risk. Index drift is. When Google reshuffles the array,
 * every field silently becomes undefined, which would look like "no businesses
 * have phone numbers" rather than like a bug. The canary below exists to turn
 * that silent corruption into a loud abort.
 *
 * On drift: re-derive the indices from a live payload, bump PAYLOAD_MAP_VERSION,
 * and update tests/fixtures/payload-record.json to match.
 */
export const PAYLOAD_MAP_VERSION = '2026-07-29';

export const PAYLOAD_MAP = Object.freeze({
  /** Container holding the array of result records. */
  records: Object.freeze([64]),
  /** Each entry in that container wraps its record at this index. */
  recordWrapper: 1,

  record: Object.freeze({
    name: Object.freeze([11]),
    rating: Object.freeze([4, 7]),
    reviewCount: Object.freeze([4, 8]),
    categories: Object.freeze([13]),
    phone: Object.freeze([178, 0, 0]),
    website: Object.freeze([7, 0]),
    lat: Object.freeze([9, 2]),
    lng: Object.freeze([9, 3]),
    placeId: Object.freeze([78]),
    cid: Object.freeze([10]),
    address: Object.freeze([18]),
    hours: Object.freeze([203]),
  }),
});

function at(source, path) {
  let cursor = source;
  for (const index of path) {
    if (cursor === null || cursor === undefined) return null;
    cursor = cursor[index];
  }
  return cursor === undefined ? null : cursor;
}

/** Turn one raw positional record into a canonical Lead. */
export function extractRecord(raw) {
  const m = PAYLOAD_MAP.record;
  const categories = at(raw, m.categories);

  return makeLead({
    provenance: 'google-payload',
    cid: at(raw, m.cid),
    placeId: at(raw, m.placeId),
    name: at(raw, m.name),
    categories: Array.isArray(categories) ? categories : [],
    rating: at(raw, m.rating),
    reviewCount: at(raw, m.reviewCount),
    phone: at(raw, m.phone),
    website: at(raw, m.website),
    lat: at(raw, m.lat),
    lng: at(raw, m.lng),
    address: at(raw, m.address),
  });
}

/**
 * Read every record out of a parsed payload.
 *
 * Returns counts alongside the leads, because three very different situations
 * would otherwise collapse into one empty array: no container at all, a container
 * that is legitimately empty (the normal end of a leg), and a container full of
 * records that ALL failed extraction. The harvester treats an empty record list
 * as end-of-list, so without rawCount an index drift that broke every record
 * would look exactly like a completed search.
 */
export function extractPage(parsed) {
  const container = at(parsed, PAYLOAD_MAP.records);
  if (!Array.isArray(container)) return { leads: [], rawCount: 0, skipped: 0 };

  const leads = [];
  let rawCount = 0;
  let skipped = 0;

  for (const entry of container) {
    const raw = at(entry, [PAYLOAD_MAP.recordWrapper]);
    if (!raw) continue;
    rawCount += 1;
    try {
      const lead = extractRecord(raw);
      if (lead.name) leads.push(lead);
      else skipped += 1;
    } catch {
      // A record we cannot derive a key for is unusable. Skipping one is correct.
      // The caller compares rawCount against leads.length to catch the case where
      // they are ALL unusable, which is drift rather than bad luck.
      skipped += 1;
    }
  }

  return { leads, rawCount, skipped };
}

/** Convenience wrapper for callers that only need the leads. */
export function extractRecords(parsed) {
  return extractPage(parsed).leads;
}

/** A Google CID looks like 0x<hex>:0x<hex>. Used to validate, and to detect shifts. */
const CID_PATTERN = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;

function countDigits(value) {
  return (String(value).match(/\d/g) ?? []).length;
}

/**
 * What a healthy payload looks like, field by field.
 *
 * Coverage floors are set well below the live measurement (98% phone, 98% rating,
 * 67% website on 2026-07-29) so a genuinely thin market does not trip them, while
 * a total field loss does.
 *
 * `required: true` means every record must carry a valid value at any sample size,
 * because these two fields ARE the record's identity. Everything else is judged on
 * coverage, and only once the sample is large enough for a fraction to mean anything.
 */
export const CANARY_RULES = Object.freeze({
  minRecordsToJudgeCoverage: 5,
  fields: Object.freeze([
    Object.freeze({
      field: 'name', required: true, minCoverage: 0.95,
      // Rejecting CID-shaped strings is what catches a constant-offset shift:
      // move every index by one and `name` lands on the CID hex, which is still
      // a string and would sail past a bare typeof check.
      valid: (v) => typeof v === 'string' && v.trim().length > 0 && !CID_PATTERN.test(v),
      why: 'name must be a non-empty string that is not a CID',
    }),
    Object.freeze({
      field: 'cid', required: true, minCoverage: 0.90,
      valid: (v) => typeof v === 'string' && CID_PATTERN.test(v),
      why: 'cid is the primary dedupe key; drift landing it on shared text merges distinct businesses',
    }),
    Object.freeze({
      field: 'phone', required: false, minCoverage: 0.50,
      valid: (v) => typeof v === 'string' && countDigits(v) >= 7,
      why: 'phone is the field the operator actually calls; measured at 98% live',
    }),
    Object.freeze({
      field: 'rating', required: false, minCoverage: 0.50,
      valid: (v) => typeof v === 'number' && v >= 0 && v <= 5,
      why: 'rating must be a number within 0 to 5',
    }),
    Object.freeze({
      field: 'reviewCount', required: false, minCoverage: 0.50,
      valid: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
      why: 'review count drives the viability score',
    }),
    Object.freeze({
      field: 'lat', required: false, minCoverage: 0.90,
      valid: (v) => typeof v === 'number' && v >= -90 && v <= 90,
      why: 'coordinates feed the fallback dedupe key',
    }),
    Object.freeze({
      field: 'lng', required: false, minCoverage: 0.90,
      valid: (v) => typeof v === 'number' && v >= -180 && v <= 180,
      why: 'coordinates feed the fallback dedupe key',
    }),
  ]),
});

/**
 * Assert that a payload still matches the pinned index map.
 *
 * Called once before a run begins, against the first real page. Returns problems
 * rather than throwing so the caller can show them to the operator.
 *
 * Checks three separate things, because presence alone is not enough:
 *   1. Records exist at the mapped container and wrapper indices.
 *   2. FORMAT: any value that IS present must look like the field it claims to be.
 *      This is what catches a shift onto a populated but wrong field, which a
 *      presence check waves straight through.
 *   3. COVERAGE: enough records carry each field, judged only once the sample is
 *      big enough that a fraction means something.
 */
export function runCanary(parsed) {
  const problems = [];
  const container = at(parsed, PAYLOAD_MAP.records);

  if (!Array.isArray(container) || container.length === 0) {
    problems.push(`no records found at index path [${PAYLOAD_MAP.records}]`);
    return { ok: false, problems, sampled: 0 };
  }

  const records = [];
  for (const entry of container) {
    const raw = at(entry, [PAYLOAD_MAP.recordWrapper]);
    if (raw) records.push(raw);
  }

  if (records.length === 0) {
    problems.push(`no records found at wrapper index ${PAYLOAD_MAP.recordWrapper}`);
    return { ok: false, problems, sampled: 0 };
  }

  const judgeCoverage = records.length >= CANARY_RULES.minRecordsToJudgeCoverage;

  for (const rule of CANARY_RULES.fields) {
    const path = PAYLOAD_MAP.record[rule.field];
    const values = records.map((r) => at(r, path));

    const present = values.filter((v) => v !== null && v !== undefined);
    const malformed = present.filter((v) => !rule.valid(v));

    if (malformed.length > 0) {
      problems.push(
        `${rule.field} at index path [${path}] returned ${malformed.length} of `
        + `${present.length} values in the wrong shape (${rule.why}). `
        + `First offender: ${JSON.stringify(malformed[0]).slice(0, 60)}`
      );
      continue;
    }

    if (rule.required && present.length < records.length) {
      problems.push(
        `${rule.field} at index path [${path}] is missing on `
        + `${records.length - present.length} of ${records.length} records (${rule.why})`
      );
      continue;
    }

    if (judgeCoverage) {
      const coverage = present.length / records.length;
      if (coverage < rule.minCoverage) {
        problems.push(
          `${rule.field} at index path [${path}] covered only `
          + `${Math.round(coverage * 100)}% of ${records.length} records, `
          + `below the ${Math.round(rule.minCoverage * 100)}% floor (${rule.why})`
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    sampled: records.length,
    coverageJudged: judgeCoverage,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/payload-map.test.js`
Expected: 10 passing. Note that two of these tests assert the canary *fails*, which is the point: a canary that cannot fail is decoration.

- [ ] **Step 6: Commit**

```bash
git add src/sources/payload-map.js tests/payload-map.test.js tests/fixtures/payload-record.json
git commit -m "feat: pin payload indices in one module with a drift canary"
```

---

### Task 8: guard.js, block versus end-of-list

**Files:**
- Create: `src/pipeline/guard.js`
- Create: `tests/guard.test.js`

**Interfaces:**
- Consumes: `CONFIG` from `src/core/config.js`.
- Produces:
  - `classifyTransport({ status, body }) -> { state: 'ok' | 'blocked', reason: string|null }`
  - `classifyPage({ transport, recordCount, rawCount }) -> { state: 'ok' | 'blocked' | 'end_of_list' | 'extraction_failed', reason: string|null }`
  - `nextDelayMs(random = Math.random) -> number`
  - `createLatencyWatch() -> { observe(ms) -> boolean }`

**Why this task exists:** the spec calls out one specific trap. End-of-list and a soft block look superficially similar. Confusing them either truncates every run silently or hammers through a real block. They are classified here, in one place, as distinct states.

- [ ] **Step 1: Write the failing test**

Create `tests/guard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransport, classifyPage, nextDelayMs, createLatencyWatch } from '../src/pipeline/guard.js';
import { CONFIG } from '../src/core/config.js';

const VALID = CONFIG.guard.validPrefix + '\n[[1,2,3]]';

test('a 200 with the valid prefix is ok', () => {
  assert.equal(classifyTransport({ status: 200, body: VALID }).state, 'ok');
});

test('a missing prefix means a sorry interstitial, not an empty result', () => {
  const t = classifyTransport({ status: 200, body: '<!DOCTYPE html><html>sorry' });
  assert.equal(t.state, 'blocked');
  assert.match(t.reason, /prefix/i);
});

test('every blocked status is treated as blocked', () => {
  for (const status of CONFIG.guard.blockedStatuses) {
    assert.equal(classifyTransport({ status, body: VALID }).state, 'blocked', `status ${status}`);
  }
});

test('any non-200 status is blocked, including ones not enumerated', () => {
  assert.equal(classifyTransport({ status: 418, body: VALID }).state, 'blocked');
});

test('an empty body is blocked', () => {
  assert.equal(classifyTransport({ status: 200, body: '' }).state, 'blocked');
});

test('THE TRAP: a valid response with zero records is end_of_list, never blocked', () => {
  const transport = classifyTransport({ status: 200, body: VALID });
  const page = classifyPage({ transport, recordCount: 0 });
  assert.equal(page.state, 'end_of_list');
  assert.match(page.reason, /end of/i);
});

test('a valid response with records is ok', () => {
  const transport = classifyTransport({ status: 200, body: VALID });
  assert.equal(classifyPage({ transport, recordCount: 20, rawCount: 20 }).state, 'ok');
});

test('THE OTHER TRAP: records that arrived but all failed extraction is drift, not end of list', () => {
  const transport = classifyTransport({ status: 200, body: VALID });
  const page = classifyPage({ transport, recordCount: 0, rawCount: 20 });
  assert.equal(page.state, 'extraction_failed');
  assert.match(page.reason, /drift/i);
});

test('a blocked transport stays blocked regardless of record count', () => {
  const transport = classifyTransport({ status: 429, body: '' });
  assert.equal(classifyPage({ transport, recordCount: 0 }).state, 'blocked');
  assert.equal(classifyPage({ transport, recordCount: 20 }).state, 'blocked');
});

test('nextDelayMs stays inside the configured range', () => {
  assert.equal(nextDelayMs(() => 0), CONFIG.harvest.delayMs.min);
  assert.equal(nextDelayMs(() => 0.999999), Math.round(CONFIG.harvest.delayMs.max));
  for (let i = 0; i < 200; i += 1) {
    const d = nextDelayMs();
    assert.ok(d >= CONFIG.harvest.delayMs.min && d <= CONFIG.harvest.delayMs.max, `out of range: ${d}`);
  }
});

test('nextDelayMs is actually randomised, not a constant', () => {
  const values = new Set(Array.from({ length: 50 }, () => nextDelayMs()));
  assert.ok(values.size > 5, 'delay is not varying');
});

test('latency watch tolerates normal drift', () => {
  const watch = createLatencyWatch();
  assert.equal(watch.observe(900), false);
  assert.equal(watch.observe(1100), false);
  assert.equal(watch.observe(1300), false);
});

test('latency watch breaches when responses slow down dramatically', () => {
  const watch = createLatencyWatch();
  watch.observe(900);
  let breached = false;
  for (let i = 0; i < 12 && !breached; i += 1) breached = watch.observe(20000);
  assert.equal(breached, true, 'a sustained 20x slowdown must breach');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/guard.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

Create `src/pipeline/guard.js`:

```js
import { CONFIG } from '../core/config.js';

/**
 * Transport-level classification: did we get a real payload response at all?
 *
 * Google serves a `/sorry/` HTML interstitial when it wants you to stop. That
 * arrives as HTTP 200 with an HTML body, so status alone is not enough: the
 * `)]}'` prefix is the actual signal.
 */
export function classifyTransport({ status, body }) {
  if (status !== 200) {
    return { state: 'blocked', reason: `HTTP ${status}` };
  }
  if (!body) {
    return { state: 'blocked', reason: 'empty response body' };
  }
  if (!body.startsWith(CONFIG.guard.validPrefix)) {
    return { state: 'blocked', reason: 'response is missing the payload prefix, likely a challenge page' };
  }
  return { state: 'ok', reason: null };
}

/**
 * Page-level classification.
 *
 * This is the trap the spec calls out. A finished leg looks like a clean HTTP 200
 * carrying the valid prefix and zero records, roughly 784 bytes. That is SUCCESS.
 * Treating it as a block would pause every single run at its natural end.
 * Treating a real block as end-of-list would silently truncate results and the
 * operator would never know the list was incomplete.
 */
export function classifyPage({ transport, recordCount, rawCount = 0 }) {
  if (transport.state === 'blocked') {
    return { state: 'blocked', reason: transport.reason };
  }
  // Records arrived but none survived extraction. That is index drift, not the
  // end of the results. Without this branch it would be indistinguishable from a
  // finished leg and the operator would read a truncated list as complete.
  if (recordCount === 0 && rawCount > 0) {
    return {
      state: 'extraction_failed',
      reason: `${rawCount} records arrived but none could be extracted, which means the payload indices have drifted`,
    };
  }
  if (recordCount === 0) {
    return { state: 'end_of_list', reason: 'reached the end of results for this leg' };
  }
  return { state: 'ok', reason: null };
}

/** Randomised inter-request delay. Jitter matters more than the absolute value. */
export function nextDelayMs(random = Math.random) {
  const { min, max } = CONFIG.harvest.delayMs;
  return Math.round(min + random() * (max - min));
}

/**
 * Watches response latency with an exponentially weighted moving average.
 *
 * Recon observed latency drifting from 980 ms to 2.2 s under burst pressure
 * without ever producing a 429. Sustained slowdown is therefore the earliest
 * available warning that we are pushing too hard, well before a hard block.
 */
export function createLatencyWatch() {
  const { latencyEwmaAlpha, latencyBreachMultiple } = CONFIG.guard;
  let ewma = null;
  let baseline = null;

  return {
    /** Returns true when smoothed latency has breached the threshold. */
    observe(ms) {
      if (baseline === null) {
        baseline = ms;
        ewma = ms;
        return false;
      }
      ewma = latencyEwmaAlpha * ms + (1 - latencyEwmaAlpha) * ewma;
      return ewma > baseline * latencyBreachMultiple;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/guard.test.js`
Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/guard.js tests/guard.test.js
git commit -m "feat: classify blocks separately from end of list, with latency watch"
```

---
### Task 9: source.js and google-payload.js

**Files:**
- Create: `src/sources/source.js`
- Create: `src/sources/google-payload.js`
- Create: `tests/google-payload.test.js`

**Interfaces:**
- Consumes: `CONFIG`, `extractRecords`, `runCanary`, `classifyTransport`, `classifyPage`, `nextDelayMs`.
- Produces:
  - `assertSource(obj) -> void` (throws on a non-conforming source)
  - `setPbOffset(pb, offset) -> string`
  - `setPbCentre(pb, { lat, lng, zoom }) -> string`
  - `googlePayloadSource` implementing `{ id, harvestLeg({ query, pb, onPage, signal }) -> { leads, stopReason } }`

**Design note on the `pb` parameter.** The paging endpoint requires a long opaque `pb` blob. Hand-synthesising it is fragile and unnecessary: the Maps page builds a valid one itself on every search. A content script captures that blob once per search, and paging then reuses it with the offset field substituted. `setPbOffset` is the pure, testable core of that substitution.

- [ ] **Step 1: Write the failing test**

Create `tests/google-payload.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSource } from '../src/sources/source.js';
import { setPbOffset, setPbCentre, googlePayloadSource } from '../src/sources/google-payload.js';

const PB = '!4m12!1m3!1d5000!2d72.342874!3d33.7609824!2m3!1f0!2f0!3f0!7i20!8i0!10b1';

test('setPbOffset replaces an existing offset field', () => {
  assert.match(setPbOffset(PB, 40), /!8i40!/);
  assert.doesNotMatch(setPbOffset(PB, 40), /!8i0!/);
});

test('setPbOffset appends the offset when the field is absent', () => {
  assert.match(setPbOffset('!7i20', 60), /!8i60/);
});

test('setPbOffset leaves the page size untouched', () => {
  assert.match(setPbOffset(PB, 100), /!7i20/);
});

test('setPbOffset rejects a negative or non-integer offset', () => {
  assert.throws(() => setPbOffset(PB, -1), /offset/i);
  assert.throws(() => setPbOffset(PB, 1.5), /offset/i);
});

test('setPbCentre substitutes latitude, longitude and zoom', () => {
  const out = setPbCentre(PB, { lat: 31.5204, lng: 74.3587, zoom: 12 });
  assert.match(out, /!2d74\.3587/);
  assert.match(out, /!3d31\.5204/);
});

test('setPbCentre rejects invalid coordinates', () => {
  assert.throws(() => setPbCentre(PB, { lat: null, lng: 74, zoom: 12 }), /coordinates/i);
});

test('googlePayloadSource conforms to the source interface', () => {
  assertSource(googlePayloadSource);
});

test('assertSource rejects an object missing harvestLeg', () => {
  assert.throws(() => assertSource({ id: 'x' }), /harvestLeg/);
});

test('assertSource rejects an object missing an id', () => {
  assert.throws(() => assertSource({ harvestLeg: () => {} }), /id/);
});

test('harvestLeg pages until end_of_list and returns accumulated leads', async () => {
  // Two full pages then an empty one. `fetchPage` is injected so this test
  // never touches the network.
  const pages = [
    { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) },
    { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) },
    { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(0)) },
  ];
  let call = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    fetchPage: async () => pages[call++],
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'end_of_list');
  assert.equal(result.leads.length, 40);
  assert.equal(call, 3);
});

test('harvestLeg stops immediately on a block and reports it', async () => {
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    fetchPage: async () => ({ status: 429, body: '' }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'blocked');
  assert.equal(result.leads.length, 0);
});

test('harvestLeg never retries through a block', async () => {
  let calls = 0;
  await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    fetchPage: async () => { calls += 1; return { status: 429, body: '' }; },
    delay: async () => {},
  });
  assert.equal(calls, 1, 'a block must stop the leg on the first occurrence');
});

test('harvestLeg respects the per query cap', async () => {
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    fetchPage: async () => ({ status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'cap_reached');
  assert.ok(result.leads.length <= 260, `runaway: ${result.leads.length}`);
});

test('harvestLeg treats total extraction failure as drift, not a finished leg', async () => {
  // Twenty records arrive, none has a derivable identity. Reading that as
  // end_of_list would report a completed search over a truncated list.
  const allBad = []; allBad[64] = Array.from({ length: 20 }, () => {
    const r = []; r[11] = 'Named But Unidentifiable';
    return [null, r];
  });
  let call = 0;
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist', pb: PB,
    fetchPage: async () => {
      call += 1;
      return call === 1
        ? { status: 200, body: ")]}'\n" + JSON.stringify(payloadWith(20)) }
        : { status: 200, body: ")]}'\n" + JSON.stringify(allBad) };
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'canary_failed');
  assert.ok(result.problems.some((p) => /drift/i.test(p)));
});

test('harvestLeg aborts when the canary fails on the first page', async () => {
  const drifted = []; drifted[64] = [[null, []]];
  const result = await googlePayloadSource.harvestLeg({
    query: 'dentist',
    pb: PB,
    fetchPage: async () => ({ status: 200, body: ")]}'\n" + JSON.stringify(drifted) }),
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'canary_failed');
  assert.ok(result.problems.length > 0);
});

/**
 * Build a payload carrying `count` records healthy enough to pass the canary.
 *
 * Phone and coordinates are required here, not decoration: the canary enforces
 * coverage floors on both, so a fixture missing them would be rejected as drift.
 * That is the canary doing its job, so the fixture has to look like real data.
 */
function payloadWith(count) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const r = [];
    r[11] = `Business ${i}`;
    r[10] = `0xaaa${i.toString(16)}:0xbbb${i.toString(16)}`;
    r[4] = (() => { const a = []; a[7] = 4.2; a[8] = 50; return a; })();
    r[178] = [[`+92 57 261 ${(1000 + i).toString().padStart(4, '0')}`]];
    r[9] = (() => { const a = []; a[2] = 33.76 + i * 0.001; a[3] = 72.34 + i * 0.001; return a; })();
    records.push([null, r]);
  }
  const p = []; p[64] = records;
  return p;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/google-payload.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write source.js**

Create `src/sources/source.js`:

```js
/**
 * The contract every harvester implements, so the pipeline never cares whether a
 * record came from Google, OpenStreetMap or Foursquare.
 *
 *   id          string, stamped onto each lead as `provenance`
 *   harvestLeg  async ({ query, ...sourceSpecific }) -> { leads, stopReason, problems }
 *
 * stopReason is one of: 'end_of_list' | 'cap_reached' | 'blocked' | 'canary_failed' | 'aborted'
 */
export const STOP_REASONS = Object.freeze([
  'end_of_list', 'cap_reached', 'blocked', 'canary_failed', 'aborted',
]);

export function assertSource(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('source must be an object');
  }
  if (typeof candidate.id !== 'string' || !candidate.id) {
    throw new Error('source must expose a non-empty string id');
  }
  if (typeof candidate.harvestLeg !== 'function') {
    throw new Error('source must expose an async harvestLeg function');
  }
}
```

- [ ] **Step 4: Write google-payload.js**

Create `src/sources/google-payload.js`:

```js
import { CONFIG } from '../core/config.js';
import { extractPage, runCanary } from './payload-map.js';
import { classifyTransport, classifyPage, nextDelayMs } from '../pipeline/guard.js';

const SEARCH_ENDPOINT = 'https://www.google.com/search';

/**
 * Substitute the result offset into a captured pb blob.
 *
 * The pb blob is opaque and long. We do not synthesise it: the Maps page builds a
 * valid one for its own request and a content script captures it. Only the offset
 * field `!8i<N>` needs changing to page through results.
 */
export function setPbOffset(pb, offset) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`setPbOffset requires a non-negative integer offset, got ${offset}`);
  }
  if (/!8i\d+/.test(pb)) return pb.replace(/!8i\d+/, `!8i${offset}`);
  return `${pb}!8i${offset}`;
}

/** Substitute the map centre and zoom into a captured pb blob. */
export function setPbCentre(pb, { lat, lng, zoom }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('setPbCentre requires finite coordinates');
  }
  let out = pb;
  out = /!2d-?[\d.]+/.test(out) ? out.replace(/!2d-?[\d.]+/, `!2d${lng}`) : `${out}!2d${lng}`;
  out = /!3d-?[\d.]+/.test(out) ? out.replace(/!3d-?[\d.]+/, `!3d${lat}`) : `${out}!3d${lat}`;
  if (Number.isFinite(zoom) && /!1d[\d.]+/.test(out)) {
    // pb encodes an extent rather than a zoom level; larger value means wider view.
    out = out.replace(/!1d[\d.]+/, `!1d${Math.round(2 ** (21 - zoom) * 0.6)}`);
  }
  return out;
}

/**
 * Default page fetcher. Kept separate so tests inject a fake and never hit the network.
 *
 * `credentials: 'omit'` is a binding requirement, not a default: it guarantees no
 * Google account is attached to any request, so there is no account to suspend.
 */
async function defaultFetchPage({ query, pb, signal }) {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('tbm', 'map');
  url.searchParams.set('authuser', '0');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('q', query);
  url.searchParams.set('pb', pb);

  const started = Date.now();
  const response = await fetch(url, { credentials: 'omit', signal });
  const body = await response.text();
  return { status: response.status, body, latencyMs: Date.now() - started };
}

function parseBody(body) {
  const newline = body.indexOf('\n');
  const json = newline === -1 ? body.slice(CONFIG.guard.validPrefix.length) : body.slice(newline + 1);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const googlePayloadSource = {
  id: 'google-payload',

  /**
   * Harvest one leg: a single query at a single map centre, paged to exhaustion
   * or to the 247 cap, whichever comes first.
   */
  async harvestLeg({
    query,
    pb,
    onPage = () => {},
    signal = null,
    fetchPage = defaultFetchPage,
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    const leads = [];
    let offset = 0;
    let canaryChecked = false;

    while (offset < CONFIG.harvest.perQueryCap) {
      if (signal?.aborted) return { leads, stopReason: 'aborted', problems: [] };

      const page = await fetchPage({ query, pb: setPbOffset(pb, offset), signal });
      const transport = classifyTransport(page);

      if (transport.state === 'blocked') {
        // Never retry through a block. Stop and let the operator decide.
        return { leads, stopReason: 'blocked', problems: [transport.reason] };
      }

      const parsed = parseBody(page.body);
      if (parsed === null) {
        return { leads, stopReason: 'blocked', problems: ['payload did not parse as JSON'] };
      }

      // Validate the index map against the very first real page, before trusting
      // 247 records' worth of extraction.
      if (!canaryChecked) {
        canaryChecked = true;
        const canary = runCanary(parsed);
        if (!canary.ok) {
          return { leads, stopReason: 'canary_failed', problems: canary.problems };
        }
      }

      const extracted = extractPage(parsed);
      const pageLeads = extracted.leads;
      const verdict = classifyPage({
        transport, recordCount: pageLeads.length, rawCount: extracted.rawCount,
      });

      if (verdict.state === 'end_of_list') {
        return { leads, stopReason: 'end_of_list', problems: [] };
      }

      if (verdict.state === 'extraction_failed') {
        return { leads, stopReason: 'canary_failed', problems: [verdict.reason] };
      }

      leads.push(...pageLeads);
      onPage({ offset, count: pageLeads.length, total: leads.length, latencyMs: page.latencyMs });

      offset += CONFIG.harvest.pageSize;
      if (offset < CONFIG.harvest.perQueryCap) await delay(nextDelayMs());
    }

    return { leads, stopReason: 'cap_reached', problems: [] };
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/google-payload.test.js`
Expected: 14 passing.

- [ ] **Step 6: Commit**

```bash
git add src/sources/source.js src/sources/google-payload.js tests/google-payload.test.js
git commit -m "feat: add payload harvester with cap, block and canary handling"
```

---

### Task 10: harvest.js, the leg queue

**Files:**
- Create: `src/pipeline/harvest.js`
- Create: `tests/harvest.test.js`

**Interfaces:**
- Consumes: `tileRadius`, `googlePayloadSource`, `CONFIG`.
- Produces:
  - `planLegs({ keywords, categories, lat, lng, zoom, radiusKm }) -> Leg[]` where `Leg` is `{ id, query, lat, lng, zoom }`
  - `runHarvest({ legs, pb, source, onProgress, onLeads, signal, startAt }) -> { leads, stopReason, completedLegs, problems }`

- [ ] **Step 1: Write the failing test**

Create `tests/harvest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLegs, runHarvest } from '../src/pipeline/harvest.js';
import { makeLead } from '../src/core/schema.js';

const CENTRE = { lat: 33.7609824, lng: 72.342874, zoom: 14.98 };

test('planLegs multiplies keywords by tiles', () => {
  const { legs } = planLegs({ keywords: ['dentist', 'orthodontist'], ...CENTRE, radiusKm: 2 });
  assert.equal(legs.length, 2, 'one tile at 2 km, so one leg per keyword');
  assert.deepEqual(legs.map((l) => l.query), ['dentist', 'orthodontist']);
});

test('planLegs produces more legs for a larger radius', () => {
  const small = planLegs({ keywords: ['dentist'], ...CENTRE, radiusKm: 2 }).legs;
  const large = planLegs({ keywords: ['dentist'], ...CENTRE, radiusKm: 30 }).legs;
  assert.ok(large.length > small.length);
});

test('planLegs appends categories to the query text', () => {
  const { legs } = planLegs({ keywords: ['clinic'], categories: ['Dentist'], ...CENTRE, radiusKm: 2 });
  assert.match(legs[0].query, /clinic/);
  assert.match(legs[0].query, /Dentist/);
});

test('planLegs gives every leg a stable unique id', () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 30 });
  const ids = legs.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'leg ids must be unique');
  const again = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 30 }).legs;
  assert.deepEqual(again.map((l) => l.id), ids, 'leg ids must be stable across calls');
});

test('planLegs rejects an empty keyword list', () => {
  assert.throws(() => planLegs({ keywords: [], ...CENTRE, radiusKm: 5 }), /keyword/i);
});

test('planLegs caps total legs so a job cannot run away', () => {
  const { legs, coverage } = planLegs({
    keywords: ['a', 'b', 'c', 'd', 'e', 'f'], ...CENTRE, radiusKm: 500,
  });
  assert.ok(legs.length <= 60, `${legs.length} legs exceeds the cap`);
  assert.equal(coverage.tilesTruncated, true, 'a truncated tile plan must say so');
  assert.equal(coverage.legsTruncated, true, 'a truncated leg queue must say so');
});

/** A fake source that returns a fixed set of leads per leg. */
function fakeSource(perLeg, stopReason = 'end_of_list') {
  return {
    id: 'fake',
    async harvestLeg({ query }) {
      return {
        leads: perLeg.map((n) => makeLead({ cid: `0x${n}:0x${n}`, name: `B${n}`, phone: '+92 1' })),
        stopReason,
        problems: [],
      };
    },
  };
}

test('runHarvest merges legs and deduplicates across them', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 2 });
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    source: fakeSource([1, 2, 3]),
    delay: async () => {},
  });
  assert.equal(result.leads.length, 3, 'the same three businesses across two legs dedupe to three');
  assert.equal(result.completedLegs, 2);
  assert.equal(result.stopReason, 'completed');
});

test('runHarvest stops the whole job when a leg reports a block', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b', 'c'], ...CENTRE, radiusKm: 2 });
  let called = 0;
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    source: {
      id: 'fake',
      async harvestLeg() {
        called += 1;
        return { leads: [], stopReason: 'blocked', problems: ['HTTP 429'] };
      },
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'blocked');
  assert.equal(called, 1, 'a block must halt the queue, not continue to the next leg');
  assert.deepEqual(result.problems, ['HTTP 429']);
});

test('runHarvest stops the whole job when the canary fails', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 2 });
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    source: {
      id: 'fake',
      async harvestLeg() {
        return { leads: [], stopReason: 'canary_failed', problems: ['name index drifted'] };
      },
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'canary_failed');
});

test('runHarvest reports progress per leg', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b'], ...CENTRE, radiusKm: 2 });
  const seen = [];
  await runHarvest({
    legs, pb: '!7i20!8i0',
    source: fakeSource([1, 2]),
    onProgress: (p) => seen.push(p),
    delay: async () => {},
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].legIndex, 1);
  assert.equal(seen[1].totalLegs, 2);
  assert.equal(seen[1].uniqueLeads, 2);
});

test('runHarvest resumes from startAt, skipping completed legs', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b', 'c'], ...CENTRE, radiusKm: 2 });
  const queried = [];
  await runHarvest({
    legs, pb: '!7i20!8i0', startAt: 2,
    source: {
      id: 'fake',
      async harvestLeg({ query }) {
        queried.push(query);
        return { leads: [], stopReason: 'end_of_list', problems: [] };
      },
    },
    delay: async () => {},
  });
  assert.deepEqual(queried, ['c'], 'only the third leg should run');
});

test('runHarvest honours an abort signal between legs', async () => {
  const { legs } = planLegs({ keywords: ['a', 'b', 'c'], ...CENTRE, radiusKm: 2 });
  const controller = new AbortController();
  let called = 0;
  const result = await runHarvest({
    legs, pb: '!7i20!8i0',
    signal: controller.signal,
    source: {
      id: 'fake',
      async harvestLeg() { called += 1; controller.abort(); return { leads: [], stopReason: 'end_of_list', problems: [] }; },
    },
    delay: async () => {},
  });
  assert.equal(result.stopReason, 'aborted');
  assert.equal(called, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/harvest.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

Create `src/pipeline/harvest.js`:

```js
import { CONFIG } from '../core/config.js';
import { planTiles } from './tiling.js';
import { setPbCentre } from '../sources/google-payload.js';
import { nextDelayMs } from './guard.js';

/**
 * Expand a job into a flat queue of legs.
 *
 * A leg is one query at one map centre. Legs exist because a single Google query
 * caps at 247 results, so covering a real market means multiplying keywords by
 * geographic tiles and merging on the dedupe key.
 */
export function planLegs({ keywords, categories = [], lat, lng, zoom = 14, radiusKm }) {
  const cleanKeywords = (keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (cleanKeywords.length === 0) {
    throw new Error('planLegs requires at least one keyword');
  }

  const categorySuffix = categories.length ? ` ${categories.join(' ')}` : '';
  const plan = planTiles({ lat, lng, radiusKm });

  const legs = [];
  for (const keyword of cleanKeywords) {
    for (const [tileIndex, tile] of plan.tiles.entries()) {
      legs.push({
        id: `${keyword}@${tile.lat.toFixed(5)},${tile.lng.toFixed(5)}`,
        query: `${keyword}${categorySuffix}`,
        keyword,
        tileIndex,
        lat: tile.lat,
        lng: tile.lng,
        zoom,
      });
    }
  }

  const capped = legs.slice(0, CONFIG.harvest.maxLegsPerRun);

  // Coverage is returned rather than swallowed. Two separate caps can shrink what
  // actually gets searched, and a short list that looks complete is worse than a
  // short list labelled as short.
  return {
    legs: capped,
    coverage: {
      tilesPlanned: plan.candidateCount,
      tilesUsed: plan.tiles.length,
      tilesTruncated: plan.truncated,
      requestedRadiusKm: plan.requestedRadiusKm,
      effectiveRadiusKm: plan.effectiveRadiusKm,
      legsPlanned: legs.length,
      legsUsed: capped.length,
      legsTruncated: capped.length < legs.length,
    },
  };
}

/**
 * Run the leg queue, deduplicating as leads arrive.
 *
 * A block or a canary failure halts the entire job rather than moving to the next
 * leg: both mean the data we would collect next is untrustworthy, and continuing
 * would produce a partial list the operator might mistake for a complete one.
 */
export async function runHarvest({
  legs,
  pb,
  source,
  onProgress = () => {},
  onLeads = () => {},
  signal = null,
  startAt = 0,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const byKey = new Map();
  const problems = [];
  let completedLegs = startAt;

  for (let i = startAt; i < legs.length; i += 1) {
    if (signal?.aborted) {
      return { leads: [...byKey.values()], stopReason: 'aborted', completedLegs, problems };
    }

    const leg = legs[i];
    const legPb = setPbCentre(pb, { lat: leg.lat, lng: leg.lng, zoom: leg.zoom });

    const result = await source.harvestLeg({
      query: leg.query,
      pb: legPb,
      lat: leg.lat,
      lng: leg.lng,
      signal,
    });

    let fresh = 0;
    for (const lead of result.leads) {
      if (!byKey.has(lead.key)) {
        byKey.set(lead.key, lead);
        fresh += 1;
      }
    }

    completedLegs = i + 1;
    if (fresh > 0) onLeads(result.leads);

    onProgress({
      legIndex: i,
      totalLegs: legs.length,
      leg,
      legLeads: result.leads.length,
      freshLeads: fresh,
      uniqueLeads: byKey.size,
      stopReason: result.stopReason,
    });

    if (result.stopReason === 'blocked' || result.stopReason === 'canary_failed') {
      problems.push(...result.problems);
      return { leads: [...byKey.values()], stopReason: result.stopReason, completedLegs, problems };
    }

    if (signal?.aborted) {
      return { leads: [...byKey.values()], stopReason: 'aborted', completedLegs, problems };
    }

    if (i + 1 < legs.length) await delay(nextDelayMs());
  }

  return { leads: [...byKey.values()], stopReason: 'completed', completedLegs, problems };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/harvest.test.js`
Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/harvest.js tests/harvest.test.js
git commit -m "feat: add leg queue with cross-leg dedupe and resume support"
```

---

### Task 11: csv.js

**Files:**
- Create: `src/export/csv.js`
- Create: `tests/csv.test.js`

**Interfaces:**
- Consumes: `CONFIG`.
- Produces: `EXPORT_COLUMNS` array, `toCsv(leads, columns = EXPORT_COLUMNS) -> string`

- [ ] **Step 1: Write the failing test**

Create `tests/csv.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, EXPORT_COLUMNS } from '../src/export/csv.js';
import { CONFIG } from '../src/core/config.js';

const NL = CONFIG.export.csvNewline;

function row(overrides = {}) {
  return {
    name: 'Al-Shifa Dental Clinic', categories: ['Dentist'], score: 82,
    reasons: ['No website', 'dentist, no online booking'],
    rating: 4.3, reviewCount: 87, phone: '+92 57 261 2201',
    website: null, domain: null, websiteTech: 'none',
    mobileFriendly: null, hasBooking: null, hasChatbot: null,
    email: null, socials: [], ownerReplies: null, lastReviewDays: 60,
    address: 'Pleader Lane, Attock', lat: 33.7621, lng: 72.3489,
    provenance: 'google-payload', cid: '0xa:0xb',
    ...overrides,
  };
}

test('emits a header row from the column list', () => {
  const lines = toCsv([row()]).split(NL);
  assert.equal(lines[0], EXPORT_COLUMNS.map((c) => c.header).join(','));
});

test('emits one line per lead plus the header', () => {
  assert.equal(toCsv([row(), row()]).trimEnd().split(NL).length, 3);
});

test('quotes fields containing the delimiter', () => {
  const csv = toCsv([row({ address: 'Pleader Lane, Attock, Punjab' })]);
  assert.ok(csv.includes('"Pleader Lane, Attock, Punjab"'));
});

test('escapes embedded double quotes by doubling them', () => {
  const csv = toCsv([row({ name: 'The "Best" Dentist' })]);
  assert.ok(csv.includes('"The ""Best"" Dentist"'));
});

test('quotes fields containing newlines so a row cannot split', () => {
  const csv = toCsv([row({ address: 'Line one\nLine two' })]);
  assert.equal(csv.trimEnd().split(NL).length, 2, 'an embedded newline must not create a new row');
});

test('joins array fields with a semicolon rather than a comma', () => {
  const csv = toCsv([row({ categories: ['Dentist', 'Dental clinic'] })]);
  assert.ok(csv.includes('Dentist; Dental clinic'));
});

test('renders the reasons array as the why column', () => {
  const csv = toCsv([row()]);
  assert.ok(csv.includes('No website; dentist, no online booking')
    || csv.includes('"No website; dentist, no online booking"'));
});

test('renders null as an empty field, never as the string null', () => {
  const csv = toCsv([row({ website: null, email: null })]);
  assert.ok(!/\bnull\b/.test(csv), 'the literal text null must never appear');
});

test('renders booleans as yes and no, not true and false', () => {
  const csv = toCsv([row({ mobileFriendly: false, hasBooking: true })]);
  assert.ok(csv.includes('no'));
  assert.ok(csv.includes('yes'));
});

test('renders unknown enrichment as unknown, distinct from no', () => {
  const csv = toCsv([row({ mobileFriendly: null })]);
  const cells = csv.split(NL)[1];
  assert.ok(cells.includes('unknown'));
});

test('an empty lead list still emits the header', () => {
  assert.equal(toCsv([]), EXPORT_COLUMNS.map((c) => c.header).join(',') + NL);
});

test('accepts a custom column subset', () => {
  const csv = toCsv([row()], [{ key: 'name', header: 'Business' }]);
  assert.equal(csv.split(NL)[0], 'Business');
  assert.equal(csv.split(NL)[1], 'Al-Shifa Dental Clinic');
});

test('score sorts first in the default column order, because that is what the operator reads', () => {
  assert.equal(EXPORT_COLUMNS[0].key, 'score');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/csv.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the implementation**

Create `src/export/csv.js`:

```js
import { CONFIG } from '../core/config.js';

/**
 * Default export column order. Score first, then identity, then the reasons that
 * justify the score, then the raw signals. This is the order the operator reads
 * on a call, so it is the order the file uses.
 */
export const EXPORT_COLUMNS = Object.freeze([
  { key: 'score', header: 'Score' },
  { key: 'name', header: 'Business' },
  { key: 'categories', header: 'Category' },
  { key: 'reasons', header: 'Why it scored' },
  { key: 'phone', header: 'Phone' },
  { key: 'email', header: 'Email' },
  { key: 'website', header: 'Website' },
  { key: 'websiteTech', header: 'Platform' },
  { key: 'mobileFriendly', header: 'Mobile friendly' },
  { key: 'hasBooking', header: 'Online booking' },
  { key: 'hasChatbot', header: 'Chatbot' },
  { key: 'socials', header: 'Social links' },
  { key: 'rating', header: 'Rating' },
  { key: 'reviewCount', header: 'Reviews' },
  { key: 'ownerReplies', header: 'Owner replies' },
  { key: 'lastReviewDays', header: 'Days since last review' },
  { key: 'address', header: 'Address' },
  { key: 'lat', header: 'Latitude' },
  { key: 'lng', header: 'Longitude' },
  { key: 'provenance', header: 'Source' },
  { key: 'cid', header: 'Google CID' },
]);

/**
 * Render one value as a CSV cell.
 *
 * null means "we did not look", which is genuinely different from false. Emitting
 * "unknown" rather than blank or "no" keeps that distinction visible in the export,
 * so the operator never reads an un-enriched row as a confirmed absence.
 */
function renderCell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return String(value);
}

function renderEnrichmentCell(value) {
  if (value === null || value === undefined) return 'unknown';
  return renderCell(value);
}

/** Enrichment fields where null must read as "unknown" rather than blank. */
const ENRICHMENT_KEYS = new Set(['mobileFriendly', 'hasBooking', 'hasChatbot', 'ownerReplies']);

function quote(cell) {
  const d = CONFIG.export.csvDelimiter;
  if (cell.includes(d) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function toCsv(leads, columns = EXPORT_COLUMNS) {
  const d = CONFIG.export.csvDelimiter;
  const nl = CONFIG.export.csvNewline;

  const header = columns.map((c) => quote(c.header)).join(d);

  const body = leads.map((lead) =>
    columns
      .map((c) => {
        const raw = lead[c.key];
        const rendered = ENRICHMENT_KEYS.has(c.key) ? renderEnrichmentCell(raw) : renderCell(raw);
        return quote(rendered);
      })
      .join(d)
  );

  return [header, ...body].join(nl) + nl;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/csv.test.js`
Expected: 13 passing.

- [ ] **Step 5: Commit**

```bash
git add src/export/csv.js tests/csv.test.js
git commit -m "feat: add CSV export preserving the unknown versus absent distinction"
```

---
### Task 12: mergeLead and db.js

**Files:**
- Modify: `src/core/schema.js` (add `mergeLead`)
- Create: `src/store/db.js`
- Create: `tests/merge.test.js`
- Create: `tests/db.test.js`

**Interfaces:**
- Consumes: `CONFIG`.
- Produces:
  - `mergeLead(existing, incoming) -> Lead` (pure, tested in Node)
  - `openDb()`, `putLeads(leads)`, `getAllLeads()`, `clearLeads()`
  - `getExportedKeys() -> Set<string>`, `markExported(keys)`
  - `saveRun(run)`, `loadRun(id)`, `listRuns()`
  - `getDomainCache(domain)`, `putDomainCache(domain, data)`

**Testing note.** IndexedDB does not exist in bare Node, so `tests/db.test.js` loads `fake-indexeddb/auto` to supply an in-memory implementation. This is a dev dependency only and ships nothing. `db.js` holds cross-run dedupe and the domain cache TTL, both of which fail silently when wrong, so leaving it untested was not acceptable. The pure merge logic is additionally unit tested on its own in `schema.js`.

- [ ] **Step 1: Write the failing test for mergeLead**

Create `tests/merge.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead, mergeLead } from '../src/core/schema.js';

const existing = makeLead({
  cid: '0xa:0xb', name: 'Al-Shifa Dental', phone: '+92 57 261 2201',
  rating: 4.3, reviewCount: 87, website: 'https://alshifa.pk',
  enriched: true, websiteTech: 'wordpress', mobileFriendly: false,
  hasBooking: false, email: 'info@alshifa.pk', socials: ['facebook'],
});

test('merging keeps enrichment that the incoming record lacks', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'Al-Shifa Dental', rating: 4.4, reviewCount: 91 });
  const merged = mergeLead(existing, incoming);
  assert.equal(merged.enriched, true, 'enrichment must survive a re-harvest');
  assert.equal(merged.websiteTech, 'wordpress');
  assert.equal(merged.mobileFriendly, false);
  assert.equal(merged.email, 'info@alshifa.pk');
});

test('merging takes fresher Maps data from the incoming record', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'Al-Shifa Dental', rating: 4.4, reviewCount: 91 });
  const merged = mergeLead(existing, incoming);
  assert.equal(merged.rating, 4.4, 'a newer rating wins');
  assert.equal(merged.reviewCount, 91);
});

test('merging does not let an incoming null erase a known value', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'Al-Shifa Dental', phone: null, rating: null });
  const merged = mergeLead(existing, incoming);
  assert.equal(merged.phone, '+92 57 261 2201', 'a missing incoming field must not wipe the stored one');
  assert.equal(merged.rating, 4.3);
});

test('merging prefers incoming enrichment when it is newer', () => {
  const stale = makeLead({ cid: '0xa:0xb', name: 'X', enriched: false });
  const fresh = makeLead({
    cid: '0xa:0xb', name: 'X', website: 'https://x.wixsite.com',
    enriched: true, websiteTech: 'wix', mobileFriendly: true,
  });
  const merged = mergeLead(stale, fresh);
  assert.equal(merged.websiteTech, 'wix');
  assert.equal(merged.mobileFriendly, true);
  assert.equal(merged.enriched, true);
});

test('merging keeps the existing key and refuses a key mismatch', () => {
  const other = makeLead({ cid: '0xZZ:0xZZ', name: 'Different Business' });
  assert.throws(() => mergeLead(existing, other), /key/i);
});

test('merging unions the socials list without duplicates', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'X', enriched: true, socials: ['facebook', 'instagram'] });
  const merged = mergeLead(existing, incoming);
  assert.deepEqual([...merged.socials].sort(), ['facebook', 'instagram']);
});

test('merging is pure and mutates neither argument', () => {
  const incoming = makeLead({ cid: '0xa:0xb', name: 'X', rating: 5 });
  const a = JSON.stringify(existing); const b = JSON.stringify(incoming);
  mergeLead(existing, incoming);
  assert.equal(JSON.stringify(existing), a);
  assert.equal(JSON.stringify(incoming), b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/merge.test.js`
Expected: FAIL, `mergeLead` is not exported.

- [ ] **Step 3: Add mergeLead to schema.js**

Append to `src/core/schema.js`:

```js
/** Fields that come from Maps and should take the freshest value available. */
const MAPS_FIELDS = [
  'name', 'categories', 'address', 'lat', 'lng',
  'rating', 'reviewCount', 'phone', 'website', 'domain',
  'hasRealWebsite', 'permanentlyClosed', 'placeId',
];

/** Fields that come from enrichment and must survive a re-harvest. */
const ENRICHMENT_FIELDS = [
  'websiteTech', 'mobileFriendly', 'hasBooking', 'hasChatbot',
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

  // Enrichment only flows in from a record that was actually enriched.
  if (incoming.enriched) {
    merged.enriched = true;
    for (const field of ENRICHMENT_FIELDS) {
      if (!isEmpty(incoming[field])) merged[field] = incoming[field];
    }
    merged.socials = [...new Set([...(existing.socials ?? []), ...(incoming.socials ?? [])])];
  }

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/merge.test.js`
Expected: 7 passing.

- [ ] **Step 5: Write db.js**

Create `src/store/db.js`:

```js
import { CONFIG } from '../core/config.js';
import { mergeLead } from '../core/schema.js';

const STORES = Object.freeze({
  leads: 'leads',
  exported: 'exported',
  domainCache: 'domainCache',
  runs: 'runs',
});

let dbPromise = null;

/**
 * Open the database, creating stores on first use.
 *
 * Deliberately the only module in the project that touches IndexedDB. Everything
 * upstream deals in plain arrays of leads, which is what makes the pipeline
 * testable in bare Node.
 */
export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG.db.name, CONFIG.db.version);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.leads)) {
        db.createObjectStore(STORES.leads, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.exported)) {
        db.createObjectStore(STORES.exported, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.domainCache)) {
        db.createObjectStore(STORES.domainCache, { keyPath: 'domain' });
      }
      if (!db.objectStoreNames.contains(STORES.runs)) {
        db.createObjectStore(STORES.runs, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Upsert leads, merging with anything already stored under the same key. */
export async function putLeads(leads) {
  const db = await openDb();
  const store = tx(db, STORES.leads, 'readwrite');
  let inserted = 0;
  let merged = 0;

  for (const lead of leads) {
    const existing = await wrap(store.get(lead.key));
    if (existing) {
      await wrap(store.put(mergeLead(existing, lead)));
      merged += 1;
    } else {
      await wrap(store.put(lead));
      inserted += 1;
    }
  }

  return { inserted, merged };
}

export async function getAllLeads() {
  const db = await openDb();
  return wrap(tx(db, STORES.leads, 'readonly').getAll());
}

export async function clearLeads() {
  const db = await openDb();
  return wrap(tx(db, STORES.leads, 'readwrite').clear());
}

export async function getExportedKeys() {
  const db = await openDb();
  const rows = await wrap(tx(db, STORES.exported, 'readonly').getAll());
  return new Set(rows.map((r) => r.key));
}

export async function markExported(keys, runId = null) {
  const db = await openDb();
  const store = tx(db, STORES.exported, 'readwrite');
  const at = new Date().toISOString();
  for (const key of keys) await wrap(store.put({ key, runId, exportedAt: at }));
  return keys.length;
}

export async function getDomainCache(domain) {
  const db = await openDb();
  const row = await wrap(tx(db, STORES.domainCache, 'readonly').get(domain));
  if (!row) return null;

  const ageDays = (Date.now() - new Date(row.cachedAt).getTime()) / 86400000;
  if (ageDays > CONFIG.enrich.domainCacheTtlDays) return null;
  return row.data;
}

export async function putDomainCache(domain, data) {
  const db = await openDb();
  return wrap(tx(db, STORES.domainCache, 'readwrite').put({
    domain, data, cachedAt: new Date().toISOString(),
  }));
}

export async function saveRun(run) {
  const db = await openDb();
  return wrap(tx(db, STORES.runs, 'readwrite').put(run));
}

export async function loadRun(id) {
  const db = await openDb();
  return wrap(tx(db, STORES.runs, 'readonly').get(id));
}

export async function listRuns() {
  const db = await openDb();
  return wrap(tx(db, STORES.runs, 'readonly').getAll());
}
```

- [ ] **Step 6: Write the db tests**

Create `tests/db.test.js`:

```js
import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead } from '../src/core/schema.js';
import {
  putLeads, getAllLeads, clearLeads,
  getExportedKeys, markExported,
  putDomainCache, getDomainCache,
  saveRun, loadRun, listRuns,
} from '../src/store/db.js';

let n = 0;
function lead(overrides = {}) {
  n += 1;
  return makeLead({ cid: `0xaa${n}:0xbb${n}`, name: `Business ${n}`, phone: '+92 300 000 0000', ...overrides });
}

beforeEach(async () => { await clearLeads(); });

test('putLeads inserts new leads and reports the count', async () => {
  const result = await putLeads([lead(), lead()]);
  assert.equal(result.inserted, 2);
  assert.equal(result.merged, 0);
  assert.equal((await getAllLeads()).length, 2);
});

test('putLeads merges on re-put instead of duplicating', async () => {
  const a = lead({ rating: 4.3, reviewCount: 87 });
  await putLeads([a]);

  const enriched = makeLead({
    cid: a.cid, name: a.name, website: 'https://x.wixsite.com',
    enriched: true, websiteTech: 'wix', mobileFriendly: false,
  });
  const result = await putLeads([enriched]);

  assert.equal(result.inserted, 0);
  assert.equal(result.merged, 1, 'the same business must not create a second row');

  const stored = await getAllLeads();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].websiteTech, 'wix', 'enrichment must land');
  assert.equal(stored[0].rating, 4.3, 'an incoming null must not erase the stored rating');
});

test('markExported and getExportedKeys round trip, powering cross-run dedupe', async () => {
  const a = lead(); const b = lead();
  await putLeads([a, b]);
  await markExported([a.key], 'run-1');

  const exported = await getExportedKeys();
  assert.ok(exported instanceof Set);
  assert.ok(exported.has(a.key));
  assert.ok(!exported.has(b.key));
});

test('exported keys survive a leads wipe, because they track history not state', async () => {
  const a = lead();
  await putLeads([a]);
  await markExported([a.key]);
  await clearLeads();
  assert.ok((await getExportedKeys()).has(a.key));
});

test('domain cache returns stored data on a hit', async () => {
  await putDomainCache('alshifa.pk', { tech: 'wordpress', mobileFriendly: false });
  assert.deepEqual(await getDomainCache('alshifa.pk'), { tech: 'wordpress', mobileFriendly: false });
});

test('domain cache returns null on a miss', async () => {
  assert.equal(await getDomainCache('never-fetched.pk'), null);
});

test('domain cache expires an entry past its TTL', async () => {
  // Write a deliberately stale record straight through putDomainCache, then age it
  // by rewriting cachedAt. Uses the real TTL from config rather than a literal.
  const { CONFIG } = await import('../src/core/config.js');
  await putDomainCache('stale.pk', { tech: 'wix' });

  const db = await (await import('../src/store/db.js')).openDb();
  const store = db.transaction('domainCache', 'readwrite').objectStore('domainCache');
  const ancient = new Date(Date.now() - (CONFIG.enrich.domainCacheTtlDays + 1) * 86400000);
  await new Promise((resolve, reject) => {
    const req = store.put({ domain: 'stale.pk', data: { tech: 'wix' }, cachedAt: ancient.toISOString() });
    req.onsuccess = resolve; req.onerror = () => reject(req.error);
  });

  assert.equal(await getDomainCache('stale.pk'), null, 'a stale entry must read as a miss');
});

test('runs round trip so a blocked job can resume', async () => {
  await saveRun({ id: 'run-7', config: { keywords: ['dentist'] }, completedLegs: 3 });
  const loaded = await loadRun('run-7');
  assert.equal(loaded.completedLegs, 3);
  assert.deepEqual(loaded.config.keywords, ['dentist']);
  assert.ok((await listRuns()).some((r) => r.id === 'run-7'));
});

test('saveRun overwrites the same id rather than appending', async () => {
  await saveRun({ id: 'run-8', completedLegs: 1 });
  await saveRun({ id: 'run-8', completedLegs: 5 });
  assert.equal((await loadRun('run-8')).completedLegs, 5);
  assert.equal((await listRuns()).filter((r) => r.id === 'run-8').length, 1);
});
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: everything passing, including the 9 new db tests.

- [ ] **Step 8: Commit**

```bash
git add src/core/schema.js src/store/db.js tests/merge.test.js tests/db.test.js
git commit -m "feat: add lead merge rules and the IndexedDB store"
```

---

### Task 13: content script pb capture and the background router

**Files:**
- Create: `src/content/capture.js`
- Modify: `manifest.json` (register the content script)
- Create: `background.js`
- Create: `tests/messages.test.js`
- Create: `src/core/messages.js`

**Interfaces:**
- Consumes: everything built so far.
- Produces:
  - `MSG` constant map, `makeRequest(type, payload)`, `makeResponse(ok, data, error)`
  - A content script that captures the live `pb` blob and posts it to the worker
  - A service worker that routes `MSG.START_RUN`, `MSG.ABORT_RUN`, `MSG.GET_LEADS`, `MSG.EXPORT`

**Why the content script exists.** The `pb` blob is opaque and must be a valid one Google itself produced. Rather than synthesise it, the content script observes the Maps page making its own `/search?tbm=map` request and captures the parameter. This is the single most fragile external dependency in the project, so it fails loudly with a named error rather than silently harvesting nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/messages.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, makeRequest, makeResponse, isResponse } from '../src/core/messages.js';

test('every message type is a unique namespaced string', () => {
  const values = Object.values(MSG);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.match(v, /^mapprospector\//);
});

test('the message set covers the phase 1 surface', () => {
  for (const key of ['CAPTURE_PB', 'START_RUN', 'ABORT_RUN', 'GET_LEADS', 'EXPORT', 'RUN_PROGRESS']) {
    assert.ok(key in MSG, `missing message type: ${key}`);
  }
});

test('makeRequest stamps the type and carries the payload', () => {
  const r = makeRequest(MSG.START_RUN, { keywords: ['dentist'] });
  assert.equal(r.type, MSG.START_RUN);
  assert.deepEqual(r.payload.keywords, ['dentist']);
});

test('makeRequest rejects an unknown type rather than sending a silent no-op', () => {
  assert.throws(() => makeRequest('not-a-real-type', {}), /unknown message type/i);
});

test('makeResponse carries success data', () => {
  const r = makeResponse(true, { leads: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.leads, []);
  assert.equal(r.error, null);
});

test('makeResponse carries an error string on failure', () => {
  const r = makeResponse(false, null, 'pb capture timed out');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pb capture timed out');
});

test('makeResponse refuses a failure with no error message', () => {
  assert.throws(() => makeResponse(false, null, null), /error message/i);
});

test('isResponse distinguishes a response from a request', () => {
  assert.equal(isResponse(makeResponse(true, {})), true);
  assert.equal(isResponse(makeRequest(MSG.GET_LEADS, {})), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/messages.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write messages.js**

Create `src/core/messages.js`:

```js
/**
 * The message vocabulary between the content script, the service worker and the UI.
 * Namespaced so a stray message from another extension can never be mistaken for ours.
 */
export const MSG = Object.freeze({
  CAPTURE_PB: 'mapprospector/capture-pb',
  START_RUN: 'mapprospector/start-run',
  ABORT_RUN: 'mapprospector/abort-run',
  GET_LEADS: 'mapprospector/get-leads',
  EXPORT: 'mapprospector/export',
  RUN_PROGRESS: 'mapprospector/run-progress',
  RUN_BLOCKED: 'mapprospector/run-blocked',
});

const KNOWN = new Set(Object.values(MSG));

export function makeRequest(type, payload = {}) {
  if (!KNOWN.has(type)) throw new Error(`unknown message type: ${type}`);
  return { type, payload };
}

export function makeResponse(ok, data = null, error = null) {
  if (!ok && !error) {
    throw new Error('a failed response requires an error message');
  }
  return { ok, data, error: error ?? null };
}

export function isResponse(message) {
  return Boolean(message) && typeof message === 'object' && 'ok' in message;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/messages.test.js`
Expected: 8 passing.

- [ ] **Step 5: Write the content script**

Create `src/content/capture.js`:

```js
import { MSG } from '../core/messages.js';

/**
 * Capture a valid `pb` blob from the Maps page's own search request.
 *
 * The blob is opaque and Google-generated. Synthesising one by hand is fragile,
 * so instead we patch `window.fetch` and `XMLHttpRequest.open` to observe the
 * page issuing its own `/search?tbm=map` call and lift the parameter off it.
 *
 * If Maps ever stops making that request, capture fails loudly. That is
 * deliberate: a silent failure here would look like "this city has no businesses".
 */
const SEARCH_PATH = '/search';
const PATCH_FLAG = '__mapProspectorPatched';

let capturedPb = null;

/**
 * Observe a URL without ever being able to break the host page.
 *
 * Everything here runs inside Google Maps' own JavaScript context, on every
 * fetch the page makes. A throw escaping this function would break Maps for the
 * user, so the whole body is guarded and failures are swallowed deliberately.
 */
function remember(urlString) {
  try {
    const url = new URL(urlString, location.origin);
    if (!url.pathname.startsWith(SEARCH_PATH)) return;
    if (url.searchParams.get('tbm') !== 'map') return;

    const pb = url.searchParams.get('pb');
    if (!pb || pb.length <= 50) return;
    if (pb === capturedPb) return; // already have this one

    capturedPb = pb;
    chrome.runtime
      .sendMessage({ type: MSG.CAPTURE_PB, payload: { pb, href: location.href } })
      .catch(() => {
        // The worker may be asleep. We keep the blob locally and answer the
        // direct request below, so a dropped message costs nothing.
      });
  } catch {
    // A URL we cannot parse, or a revoked extension context. Never rethrow:
    // this runs on Google's own fetch path.
  }
}

/**
 * Patch the page's network primitives, once.
 *
 * Guarded against double injection: Chrome can run a document_start content
 * script more than once on a soft navigation, and patching a patch would build
 * an ever-deeper call chain on every Maps request.
 */
function installObservers() {
  if (window[PATCH_FLAG]) return;

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function observedFetch(input, init) {
      const target = typeof input === 'string' ? input : input?.url;
      if (target) remember(target);
      return nativeFetch.call(this, input, init);
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  if (typeof nativeOpen === 'function') {
    XMLHttpRequest.prototype.open = function observedOpen(method, url, ...rest) {
      if (url) remember(url);
      return nativeOpen.call(this, method, url, ...rest);
    };
  }

  Object.defineProperty(window, PATCH_FLAG, {
    value: { nativeFetch, nativeOpen },
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

/** Restore the page's own functions. Exposed for teardown and for debugging. */
function removeObservers() {
  const saved = window[PATCH_FLAG];
  if (!saved) return;
  if (saved.nativeFetch) window.fetch = saved.nativeFetch;
  if (saved.nativeOpen) XMLHttpRequest.prototype.open = saved.nativeOpen;
  delete window[PATCH_FLAG];
}

// Restore the page's own functions if it navigates away or the tab is discarded.
window.addEventListener('pagehide', removeObservers, { once: true });

installObservers();

// Answer direct requests from the worker for whatever we have captured so far.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== MSG.CAPTURE_PB) return false;
  respond({
    ok: Boolean(capturedPb),
    data: { pb: capturedPb },
    error: capturedPb ? null : 'no search parameters captured yet',
  });
  return true;
});
```

- [ ] **Step 6: Register the content script in manifest.json**

Add to `manifest.json`:

```json
  "content_scripts": [
    {
      "matches": ["https://www.google.com/maps/*"],
      "js": ["src/content/capture.js"],
      "run_at": "document_start",
      "world": "MAIN"
    }
  ],
```

`"world": "MAIN"` is required. The patch must run in the page's own JavaScript context, because an isolated world has its own `window.fetch` and would observe nothing.

- [ ] **Step 7: Write background.js**

Create `background.js`:

```js
import { MSG, makeResponse } from './src/core/messages.js';
import { planLegs, runHarvest } from './src/pipeline/harvest.js';
import { googlePayloadSource } from './src/sources/google-payload.js';
import { filterLeads } from './src/pipeline/filter.js';
import { toCsv } from './src/export/csv.js';
import { putLeads, getAllLeads, getExportedKeys, markExported, saveRun } from './src/store/db.js';

/** Live run state. One run at a time by design: concurrent runs would race the dedupe pool. */
let activeRun = null;
let latestPb = null;

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // No listener open. Progress messages are advisory, so dropping one is fine.
  });
}

async function startRun(config) {
  if (activeRun) throw new Error('a run is already in progress');
  if (!latestPb) {
    throw new Error('no search parameters captured yet. Open Google Maps and run one search first.');
  }

  const { legs, coverage } = planLegs(config);
  const controller = new AbortController();
  const runId = `run-${Date.now()}`;

  activeRun = { runId, controller, legs };
  await saveRun({ id: runId, config, legs, completedLegs: 0, startedAt: new Date().toISOString() });

  try {
    const result = await runHarvest({
      legs,
      pb: latestPb,
      source: googlePayloadSource,
      signal: controller.signal,
      onLeads: (leads) => { putLeads(leads).catch((e) => console.error('putLeads failed', e)); },
      onProgress: (p) => {
        broadcast(MSG.RUN_PROGRESS, p);
        saveRun({ id: runId, config, legs, completedLegs: p.legIndex + 1 }).catch(() => {});
      },
    });

    await putLeads(result.leads);
    await saveRun({
      id: runId, config, legs,
      completedLegs: result.completedLegs,
      stopReason: result.stopReason,
      problems: result.problems,
      finishedAt: new Date().toISOString(),
    });

    if (result.stopReason === 'blocked' || result.stopReason === 'canary_failed') {
      broadcast(MSG.RUN_BLOCKED, { stopReason: result.stopReason, problems: result.problems });
    }

    return {
      stopReason: result.stopReason,
      total: result.leads.length,
      completedLegs: result.completedLegs,
      problems: result.problems,
      coverage,
    };
  } finally {
    activeRun = null;
  }
}

async function getLeads(filterState) {
  const [leads, exportedKeys] = await Promise.all([getAllLeads(), getExportedKeys()]);
  return { leads: filterLeads(leads, { ...filterState, exportedKeys }), totalStored: leads.length };
}

async function exportLeads(filterState) {
  const { leads } = await getLeads(filterState);
  const csv = toCsv(leads);
  await markExported(leads.map((l) => l.key));
  return { csv, count: leads.length, filename: `mapprospector-${Date.now()}.csv` };
}

const HANDLERS = {
  [MSG.CAPTURE_PB]: async (payload) => { latestPb = payload.pb; return { captured: true }; },
  [MSG.START_RUN]: (payload) => startRun(payload),
  [MSG.ABORT_RUN]: async () => {
    if (!activeRun) return { aborted: false };
    activeRun.controller.abort();
    return { aborted: true };
  },
  [MSG.GET_LEADS]: (payload) => getLeads(payload ?? {}),
  [MSG.EXPORT]: (payload) => exportLeads(payload ?? {}),
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  Promise.resolve(handler(message.payload))
    .then((data) => respond(makeResponse(true, data)))
    .catch((error) => respond(makeResponse(false, null, error?.message ?? String(error))));

  return true; // keep the channel open for the async response
});
```

- [ ] **Step 8: Reload the extension and verify pb capture works live**

1. Reload the extension at `chrome://extensions`.
2. Open `https://www.google.com/maps/search/dentist+in+Attock/`.
3. Open the service worker console from the extension card.
4. Run in that console: `chrome.runtime.sendMessage({type:'mapprospector/capture-pb'})` and confirm a pb string was stored.

Expected: the worker holds a `pb` blob over 50 characters. If not, capture is broken and no later task can work, so stop and fix it here.

- [ ] **Step 9: Commit**

```bash
git add src/core/messages.js src/content/capture.js background.js manifest.json tests/messages.test.js
git commit -m "feat: capture live search parameters and route worker messages"
```

---

### Task 14: dashboard wiring and live end-to-end run

**Files:**
- Create: `src/ui/dashboard/index.html` (from the approved mockup)
- Create: `src/ui/dashboard/dashboard.js`
- Create: `src/ui/sidepanel/index.html`
- Create: `src/ui/sidepanel/sidepanel.js`
- Modify: `manifest.json` (register the dashboard page)

**Interfaces:**
- Consumes: `MSG`, `makeRequest`, `DEFAULT_FILTER_STATE`.
- Produces: a working end-to-end tool.

- [ ] **Step 1: Copy the approved mockup as the dashboard shell**

```bash
mkdir -p src/ui/dashboard src/ui/sidepanel
cp docs/superpowers/specs/assets/dashboard-mockup.html src/ui/dashboard/index.html
```

Then in `src/ui/dashboard/index.html`, make three changes:

1. Wrap the content in a real document: add `<!DOCTYPE html><html><head><meta charset="utf-8">` before the `<title>`, close `</head><body>` before the `.mp` div, and `</body></html>` at the end. The mockup was authored for an environment that supplied the skeleton.
2. Delete the `LEADS` array and the `render()` bootstrap call from the inline script. Real data replaces them.
3. Add `<script type="module" src="dashboard.js"></script>` immediately before `</body>`.

- [ ] **Step 2: Write dashboard.js**

Create `src/ui/dashboard/dashboard.js`:

```js
import { MSG, makeRequest } from '../../core/messages.js';
import { DEFAULT_FILTER_STATE } from '../../pipeline/filter.js';

const state = { ...DEFAULT_FILTER_STATE, exportedKeys: null };
let currentLeads = [];

const $ = (sel) => document.querySelector(sel);

async function send(type, payload) {
  const response = await chrome.runtime.sendMessage(makeRequest(type, payload));
  if (!response?.ok) throw new Error(response?.error ?? 'no response from the extension worker');
  return response.data;
}

function stripeColor(score) {
  if (score >= 80) return 'var(--opportunity)';
  if (score >= 60) return 'var(--accent)';
  return 'var(--sorted)';
}

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderRows(leads) {
  const tbody = $('#mp-rows');

  if (leads.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="11" style="padding:26px;text-align:center;color:var(--ink-3)">' +
      'No businesses match. Loosen a filter, or run a harvest from the side panel.</td></tr>';
    return;
  }

  tbody.innerHTML = leads.map((d) => {
    const why = d.reasons.map((r) => `<b>${esc(r)}</b>`).join('');
    const colour = stripeColor(d.score);
    const cell = (v, fallback) =>
      v === null || v === undefined ? `<span class="mp-none">${fallback}</span>` : esc(v);

    return `<tr class="${d.score < 60 ? 'dim' : ''}">
      <td><div class="mp-scorecell">
        <span class="mp-stripe" style="background:${colour}"></span>
        <span class="mp-scoreno" style="color:${colour}">${d.score}</span>
        <span class="mp-meter"><i style="width:${d.score}%;background:${colour}"></i></span>
      </div></td>
      <td><div class="mp-name">${esc(d.name)}</div>
        <div class="mp-cat">${esc(d.categories.join(', '))}${d.provisional ? ' (score provisional)' : ''}</div>
        <div class="mp-why">${why}</div></td>
      <td class="num mp-num">${d.rating === null ? '' : d.rating.toFixed(1)}</td>
      <td class="num mp-num">${d.reviewCount ?? ''}</td>
      <td class="mp-sub mp-nowrap">${cell(d.phone, 'none')}</td>
      <td class="mp-sub">${cell(d.website, 'no website')}</td>
      <td class="mp-sub">${d.websiteTech === 'none' ? '<span class="mp-none">no site</span>' : esc(d.websiteTech ?? 'unknown')}</td>
      <td class="mp-sub">${d.mobileFriendly === null ? '<span style="color:var(--ink-3)">n/a</span>'
        : d.mobileFriendly ? '<span class="mp-has">passes</span>' : '<span class="mp-none">fails</span>'}</td>
      <td class="mp-sub">${d.hasBooking === null ? '<span style="color:var(--ink-3)">n/a</span>'
        : d.hasBooking ? '<span class="mp-has">live</span>' : '<span class="mp-none">missing</span>'}</td>
      <td class="mp-sub">${cell(d.email, 'none')}</td>
      <td class="mp-sub">${d.lastReviewDays === null ? '' : `${d.lastReviewDays} d`}</td>
    </tr>`;
  }).join('');
}

function renderStats(leads, totalStored) {
  const scores = leads.map((l) => l.score).sort((a, b) => a - b);
  const median = scores.length
    ? (scores.length % 2
      ? scores[(scores.length - 1) / 2]
      : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2))
    : 0;

  $('#s-harv').textContent = totalStored;
  $('#s-pass').textContent = leads.length;
  $('#s-hot').textContent = leads.filter((l) => l.score >= 80).length;
  $('#s-med').textContent = median;
  $('#s-nosite').innerHTML = `${leads.filter((l) => !l.hasRealWebsite).length}<small> of pass</small>`;
  $('#e-count').textContent = leads.length;
}

async function refresh() {
  try {
    const { leads, totalStored } = await send(MSG.GET_LEADS, state);
    currentLeads = leads;
    renderRows(leads);
    renderStats(leads, totalStored);
  } catch (error) {
    $('#e-toast').textContent = error.message;
    $('#e-toast').classList.add('on');
  }
}

// Bind the rail controls to filter state. Each writes one key and refreshes.
function bind() {
  document.querySelectorAll('.mp-seg').forEach((group) => {
    group.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        button.setAttribute('aria-pressed', 'true');
        const map = { web: 'website', phone: 'hasPhone', mob: 'mobileFriendly', book: 'hasBooking', mail: 'hasEmail' };
        for (const [attr, key] of Object.entries(map)) {
          if (button.dataset[attr]) state[key] = button.dataset[attr];
        }
        refresh();
      });
    });
  });

  document.querySelectorAll('.mp-chip[data-tech]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', on ? 'false' : 'true');
      const tech = chip.dataset.tech.toLowerCase();
      state.tech = on ? state.tech.filter((t) => t !== tech) : [...state.tech, tech];
      refresh();
    });
  });

  $('#f-score').addEventListener('input', (e) => {
    state.minScore = Number(e.target.value);
    $('#f-scoreval').textContent = state.minScore;
    refresh();
  });
  $('#f-minrev').addEventListener('input', (e) => { state.minReviews = Number(e.target.value) || 0; refresh(); });
  $('#f-maxrev').addEventListener('input', (e) => { state.maxReviews = Number(e.target.value) || Infinity; refresh(); });
  $('#f-lastrev').addEventListener('change', (e) => { state.lastReviewWithinDays = Number(e.target.value); refresh(); });
  $('#f-rating').addEventListener('change', (e) => { state.minRating = Number(e.target.value); refresh(); });
  $('#f-dupe').addEventListener('change', (e) => { state.skipExported = e.target.checked; refresh(); });

  $('#e-go').addEventListener('click', async () => {
    const toast = $('#e-toast');
    try {
      const { csv, count, filename } = await send(MSG.EXPORT, state);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = Object.assign(document.createElement('a'), { href: url, download: filename });
      anchor.click();
      URL.revokeObjectURL(url);
      toast.textContent = `→ exported ${count} leads`;
      await refresh();
    } catch (error) {
      toast.textContent = error.message;
    }
    toast.classList.add('on');
    setTimeout(() => toast.classList.remove('on'), 3000);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.RUN_PROGRESS) refresh();
});

bind();
refresh();
```

- [ ] **Step 3: Write the side panel**

Create `src/ui/sidepanel/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MapProspector</title>
<style>
  body { font: 13px/1.45 system-ui, sans-serif; margin: 0; padding: 14px;
         background: #EDF1F0; color: #0B1E22; }
  h1 { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; margin: 0 0 12px; }
  label { display: block; font-size: 11px; font-weight: 600; margin: 10px 0 4px; }
  input, select { width: 100%; padding: 6px 8px; border: 1px solid #C7D5D2;
                  background: #F8FBFA; font: inherit; }
  button { font: inherit; font-weight: 700; padding: 9px 16px; margin-top: 14px;
           border: 1px solid #0B1E22; background: #0B1E22; color: #EDF1F0; cursor: pointer; }
  button.secondary { background: transparent; color: #0B1E22; margin-left: 6px; }
  #log { margin-top: 14px; font-family: ui-monospace, Menlo, monospace; font-size: 11px;
         white-space: pre-wrap; color: #465A56; max-height: 300px; overflow-y: auto; }
  .warn { color: #9C3B18; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { background: #07161A; color: #E7F0EE; }
    input, select { background: #0C2025; border-color: #1D383D; color: #E7F0EE; }
    button { background: #E7F0EE; color: #07161A; border-color: #E7F0EE; }
    button.secondary { background: transparent; color: #E7F0EE; }
    #log { color: #9DB2AE; }
  }
</style>
</head>
<body>
  <h1>MapProspector</h1>
  <label for="kw">Keywords, comma separated</label>
  <input id="kw" value="dentist, dental clinic">
  <label for="lat">Latitude</label>
  <input id="lat" value="33.7609824">
  <label for="lng">Longitude</label>
  <input id="lng" value="72.342874">
  <label for="radius">Radius km</label>
  <select id="radius">
    <option>2</option><option selected>15</option><option>30</option><option>50</option>
  </select>
  <button id="run">Start harvest</button>
  <button id="stop" class="secondary">Stop</button>
  <button id="open" class="secondary">Open dashboard</button>
  <div id="log"></div>
  <script type="module" src="sidepanel.js"></script>
</body>
</html>
```

Create `src/ui/sidepanel/sidepanel.js`:

```js
import { MSG, makeRequest } from '../../core/messages.js';

const log = document.getElementById('log');
const write = (text, warn = false) => {
  const line = document.createElement('div');
  if (warn) line.className = 'warn';
  line.textContent = text;
  log.prepend(line);
};

document.getElementById('run').addEventListener('click', async () => {
  const config = {
    keywords: document.getElementById('kw').value.split(',').map((k) => k.trim()).filter(Boolean),
    lat: Number(document.getElementById('lat').value),
    lng: Number(document.getElementById('lng').value),
    radiusKm: Number(document.getElementById('radius').value),
    zoom: 14,
  };

  write(`starting: ${config.keywords.join(', ')} within ${config.radiusKm} km`);
  const response = await chrome.runtime.sendMessage(makeRequest(MSG.START_RUN, config));

  if (!response.ok) { write(response.error, true); return; }

  // Coverage caps shrink the area actually searched. Say so, loudly, or the
  // operator reads a short list as a complete one.
  const c = response.data.coverage;
  if (c?.tilesTruncated) {
    write(`COVERAGE CUT: asked for ${c.requestedRadiusKm} km, actually searched about `
      + `${c.effectiveRadiusKm.toFixed(1)} km. ${c.tilesPlanned} tiles needed, only `
      + `${c.tilesUsed} allowed. Raise maxTiles in config or use a smaller radius.`, true);
  }
  if (c?.legsTruncated) {
    write(`COVERAGE CUT: ${c.legsPlanned} query legs planned, only ${c.legsUsed} run. `
      + `Use fewer keywords or raise maxLegsPerRun.`, true);
  }

  write(`finished: ${response.data.stopReason}, ${response.data.total} unique businesses`);
  if (response.data.problems?.length) response.data.problems.forEach((p) => write(p, true));
});

document.getElementById('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage(makeRequest(MSG.ABORT_RUN, {}));
  write('stop requested, finishing the current leg');
});

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/dashboard/index.html') });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.RUN_PROGRESS) {
    const p = message.payload;
    write(`leg ${p.legIndex + 1}/${p.totalLegs}: +${p.freshLeads} new, ${p.uniqueLeads} unique`);
  }
  if (message?.type === MSG.RUN_BLOCKED) {
    write(`PAUSED: ${message.payload.stopReason}. ${message.payload.problems.join('; ')}`, true);
  }
});
```

- [ ] **Step 4: Register the dashboard as a web accessible resource**

Add to `manifest.json`:

```json
  "web_accessible_resources": [
    {
      "resources": ["src/ui/dashboard/index.html"],
      "matches": ["https://www.google.com/*"]
    }
  ],
```

- [ ] **Step 5: Wire the toolbar icon to open the side panel**

Add to `background.js`:

```js
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('side panel behaviour not set', error));
```

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: every test passing across all modules.

- [ ] **Step 7: Live end-to-end verification**

This is the step that proves the phase. Do not skip it and do not report the phase complete without its actual output.

1. Reload the extension.
2. Open `https://www.google.com/maps/search/dentist+in+Attock/` and let it load, so the pb blob is captured.
3. Click the toolbar icon to open the side panel.
4. Set keywords to `dentist`, coordinates to `33.7609824 / 72.342874`, radius to **2 km** for the first run. Start small: a 2 km radius is one leg, which verifies the pipeline without a long throttled run.
5. Watch the log. Expected: leg progress lines, then `finished: end_of_list` or `cap_reached` with a non-zero unique count.
6. Click "Open dashboard".
7. Confirm the table is populated with real Attock businesses, scores are present, and the "why" chips read sensibly.
8. Drag the score slider and toggle Website to None. Confirm the row count and stats change with no network activity in the Network tab.
9. Click Export. Confirm a CSV downloads, opens cleanly in a spreadsheet, and the column count matches `EXPORT_COLUMNS`.
10. Click Export again with "Skip duplicates" on. Confirm the count drops to zero, proving cross-run dedupe works.
11. Re-run the same 2 km harvest. Confirm the unique count in the dashboard does not double, proving merge-on-key works.

Record for the test report: the actual unique business count, the score distribution, the exported row count, and the stop reason. If any step fails, fix it before writing the report.

- [ ] **Step 8: Update the governance files**

- `.claude/TASKLIST.md`: mark Tasks 1 to 14 complete with today's date, update the summary count.
- `.claude/CHANGELOG.md`: add the Phase 1 entries under `## [Unreleased]` / `### Added`.
- `.claude/PROJECT_SCOPE.md`: move Phase 1 from "In Progress" to "Current State" with the real measured numbers from Step 7. Set Phase 2 as In Progress.
- `.claude/KNOWN_ISSUES.md`: add anything discovered during the live run.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: wire dashboard and side panel, completing phase 1 harvest to CSV"
```

---

## Plan Self-Review

**1. Spec coverage.** Walked each spec section against the plan.

| Spec section | Covered by |
|---|---|
| 4, four-stage architecture | Tasks 9, 10 (harvest), 5 (filter), 4 (score), 11 (export) |
| 5.1, payload primary | Tasks 7, 9 |
| 5.2, tiling past the 247 cap | Task 6, Task 10 |
| 5.3, DOM second pass | **Deferred to Phase 3.** Intentional: `ownerReplies` and `lastReviewDays` exist in the schema and filter now, and simply stay null until Phase 3 populates them |
| 5.4, licensed sources | **Deferred to Phase 5.** `source.js` in Task 9 defines the interface they will implement |
| 6, all 21 filters | Task 5. `DEFAULT_FILTER_STATE` has a test asserting the exact key set |
| 7, lead scoring | Task 4, weights isolated in `scoring-config.js` |
| 8, data model, four stores | Task 12 |
| 9, throttling and block detection | Task 8, wired in Tasks 9 and 10 |
| 10, UI | Task 14, from the approved mockup |
| 12, Sheets export | **Deferred to Phase 4.** The manifest `key` it depends on is pinned now, in Task 1 |
| 13, testing strategy | Every task ends with a test cycle. Task 14 Step 7 is the end-to-end run |

Gap found and accepted: the spec's Tier 3 filters are present in `filter.js` from Task 5 but nothing populates their fields until Phase 2. That is correct for a phased build, and `provisional` on the score makes the state visible in the UI rather than hiding it.

Gap found and fixed: nothing captured the `pb` blob. The whole payload engine is inert without it. Added as Task 13.

**2. Placeholder scan.** No TBD, TODO, or "add appropriate error handling" instructions. Every code step carries real code. Two intentional fill-ins are explicitly instructed rather than vague: the manifest `key` value from Step 3 of Task 1, and the extension ID recorded in ADR-004.

**3. Type consistency.** Checked names across task boundaries:

- `leadKey` (Task 3) is consumed as `lead.key` throughout. Consistent.
- `makeLead` returns `hasRealWebsite`; Task 5's website filter and Task 14's renderer both read that name, not `website`. Consistent.
- `classifyTransport` and `classifyPage` (Task 8) are used with exactly those signatures in Task 9. Consistent.
- `harvestLeg` returns `{ leads, stopReason, problems }` in Task 9 and Task 10 destructures those three. Consistent.
- `scoreLead` returns `{ score, reasons, provisional }`; Task 5 spreads it onto leads and Task 14 reads all three. Consistent.
- `setPbCentre` is defined in `google-payload.js` (Task 9) and imported by `harvest.js` (Task 10). Consistent, and noted here because it is the one import that crosses from `sources/` into `pipeline/`.

**Correction to apply:** Task 1's `.claude/TASKLIST.md` lists 13 tasks and a "0 of 13" summary. The plan has 14. Update both numbers when writing that file.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-phase1-harvest-to-csv.md`. Two execution options:

**1. Subagent-Driven (recommended)** - a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
