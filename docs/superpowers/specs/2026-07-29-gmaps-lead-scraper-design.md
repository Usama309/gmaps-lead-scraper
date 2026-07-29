# MapProspector: Google Maps Lead Scraper Extension

**Design spec**
Date: 2026-07-29
Owner: Usama (Muhammad Usama)
Status: Approved for planning

---

## 1. Purpose

A Chrome MV3 extension that harvests small-business listings from Google Maps, enriches each
one by inspecting the business's own website, scores it as a sales opportunity, and exports the
qualified set.

The operator sells **website design** and **online booking / scheduling** systems. A good lead is
therefore a real, reachable, solvent business whose web presence is weak or absent. The tool
exists to find those businesses and to state, per row, why each one qualifies.

Sample target market: the Attock / Hazro area of Punjab, Pakistan
(`33.7609824, 72.342874`, zoom 14.98).

## 2. Scope

**In scope for v1**

- All 21 filters listed in section 6.
- Google Maps as the primary data source, with OpenStreetMap and Foursquare as fallback and
  cross-check behind a shared interface.
- Website enrichment: email, platform detection, mobile-friendliness, booking, chatbot, socials.
- Lead scoring with per-row explanations.
- Cross-run duplicate suppression.
- Export to CSV, Excel, JSON, and Google Sheets via the Sheets API.

**Explicit non-goals for v1**

- No map / pin view. Table only.
- No CRM push. Export is the handoff.
- No email sending, sequencing, or outreach of any kind. This tool produces a list.
- No scheduled or unattended runs. The operator starts each job.
- No multi-user or team features.

## 3. Legal posture

This is recorded deliberately because it was a decision, not an oversight.

Recon established that **every** route to Google Maps business data conflicts with Google's
terms. The Maps/Earth Additional Terms bar using Maps to "create or augment any other business
listings database, mailing list, or telemarketing list." The Places API terms separately name
"copy and save business names, addresses, or user reviews" as prohibited and permit caching only
of place IDs indefinitely and lat/long for 30 days. There is no compliant configuration,
including the paid official API.

The operator reviewed this and chose to proceed with Google as the primary source, with these
risk controls as binding requirements rather than nice-to-haves:

1. **All Google requests use `credentials: 'omit'`.** No Google account is ever attached to a
   request. There is consequently no account to suspend. This is not optional: the operator's
   Gmail, Google Workspace access, and a client's GA4 property all depend on that identity.
2. **Conservative throttling with auto-pause** on any block signal (section 9).
3. **Licensed sources are first-class**, not decorative, so the tool remains usable if the
   Google route ever has to be abandoned.

Rejected: the Places API (New). At $20 to $35 per 1,000 for the fields that matter, all of which
sit in the Enterprise tier, with only 1,000 free Enterprise calls per month since the $200
monthly credit was withdrawn on 2025-03-01, and with terms that forbid storing exactly those
fields, it is simultaneously the most expensive and least permissive option.

## 4. Architecture

Four stages, each independently re-runnable. The governing principle is **scrape once, filter
many**: changing a review threshold must never cost a network request.

```
  HARVEST  ->  FILTER (Tier 1-2)  ->  ENRICH  ->  FILTER (Tier 3) + SCORE  ->  EXPORT
  (network)      (pure, local)       (network)         (pure, local)         (local / Sheets)
```

Filtering appears twice on purpose. The cheap local filters run *before* enrichment so the slow
network stage only ever touches records that already qualify. Everything after harvest is
re-runnable without a single request, except enrichment, which is cache-backed per domain.

**Stage 1, Harvest.** Only filters Google itself understands are pushed into the query: keyword,
location, radius, category, and where available minimum rating and open-now. Nothing else is
applied. Raw records land in IndexedDB. Multiple keywords and multiple radius tiles become a
queue of query legs sharing one dedupe pool.

**Stage 2, Enrich.** Two sub-passes, both run only on records that already survived the cheap
filters, never on the raw harvest:

- *2a, detail panel* (Google DOM): owner-reply presence and review recency. Costs 1 to 2 seconds
  per business. Required by the last-review filters.
- *2b, website fetch*: one request per unique registrable domain, parsed for all website intel
  signals, cached by domain with a TTL. Re-running the same city costs nothing on the cache hits.

**Stage 3, Filter and score.** A pure function over local data. Instant, no network, re-runnable
without limit. 15 of the 21 filters live here.

**Stage 4, Export.** Whatever currently passes the filter view.

### Why enrichment runs after the cheap filters

Fetching 500 websites when only 120 records pass the review-count floor wastes roughly 80% of the
slowest stage. Stage ordering is therefore: harvest, apply all Tier 1 and Tier 2 filters, enrich
the survivors, apply Tier 3 filters, score.

## 5. Extraction engine

### 5.1 Primary: embedded JSON payload

Verified live on 2026-07-29.

- **Page one:** `window.APP_INITIALIZATION_STATE[3].tg[2]`. Strip to the first newline, then
  `JSON.parse`.
- **Paging:** `GET /search?tbm=map&authuser=0&hl=en&q=<query>&pb=<blob>`, page size `!7i20`,
  offset `!8i<N>`.
- **Records:** `d[64][i][1]`, a positional array. Measured field coverage across 238 records from
  one query: 98% phone, 98% rating, 67% website.
- **Hard cap: 247 records per query.** Offsets 0 through 220 returned 20 each, 240 returned 7,
  260 returned empty. This is a Google-side limit, not a bug to work around in parsing.

Chosen over DOM scraping on evidence: in the same browser session, the DOM infinite-scroll loader
stalled after 10 cards on two separate dense queries while the underlying JSON arrived intact.
The payload route also needs no login, no detail-panel clicks, and no class names.

**Index drift is the real risk, not parseability.** Mitigation: every positional index lives in a
single versioned `payload-map.js`, and a canary self-test asserts a known-good query returns a
plausible record (non-empty name, numeric rating, phone matching a loose pattern) before any run
begins. On failure the run aborts loudly. It must never silently emit nulls.

### 5.2 Exceeding the 247 cap: tiling

Because one query caps at 247, larger targets are reached by multiplying queries:

```
legs = keywords x tiles(centre, radius)
```

`tiling.js` splits a radius into a grid of sub-centres, and each leg runs the same keyword at a
different sub-centre. All legs share one dedupe pool keyed on Google's CID. Three keywords across
a tiled Attock radius comfortably exceeds the 100 to 500 target.

### 5.3 Secondary: DOM second pass

Scoped to exactly two fields the payload lacks: owner-reply presence and review recency.

- Selectors depend on the `[data-item-id]` attribute family (`="address"`, `="authority"` for
  website, `^="phone:tel:"`), found to be the most stable in the application.
- Reviews: `div.jftiEf` rows, `.CDe7pd` for an owner reply, `span.rsqaWe` for the date.
- **Review dates are relative only** ("6 months ago"). Recent reviews are granular enough to
  support 3-day and 1-week filters; older ones degrade to month precision. The filter is
  implemented against a normalised day-count, and the spec accepts that precision beyond about
  4 weeks is approximate.
- Sponsored cards must be excluded: an article carrying `.CpccDe` or a child
  `h1.kpih0e[aria-label="Sponsored"]` is an advert, not a result.

### 5.4 Licensed sources

OpenStreetMap via Overpass (ODbL) and the Foursquare open places dataset. Both implement the same
`source.js` interface as the Google harvesters and set a `provenance` field on every record.
Neither carries ratings, review counts, or owner replies, so records sourced from them score with
the Viability component neutralised rather than zeroed, and are flagged in the UI.

## 6. Filter catalogue

All 21 requested filters, each assigned to the stage that can actually answer it.

### Tier 1, harvest-time (re-runs the search)

| Filter | Notes |
|---|---|
| Business keyword | Free text |
| Multiple keywords | Becomes a queue of query legs |
| Location | Place name / city / ZIP, **or** raw latitude and longitude plus zoom. Pasting a Google Maps URL auto-extracts coordinates |
| Radius | 2, 5, 15, 30, 50, 100 km. Drives tiling |
| Business category | Typeahead multi-select over the full Google Business Profile taxonomy. Empty means every category |
| Minimum rating | Pushed into the query where supported, re-checked locally |
| Open now | Pushed into the query |

### Tier 2, Maps data (instant, post-harvest)

| Filter | Notes |
|---|---|
| Minimum reviews | Local |
| Maximum reviews | Local |
| Has phone | Local |
| Has website / no website | Local. A Facebook page in the website slot is classified as *no real website* |
| Owner replies to reviews | Requires the stage 2a detail pass |
| Last review date | Requires stage 2a. Options: 3 days, 1 week, 2 weeks, 1, 3, 6, 12 months |

### Tier 3, website intel (instant to filter, enrichment to populate)

| Filter | Notes |
|---|---|
| Has email | `mailto:` links plus a text-level regex, falling back to `/contact` and `/about`, capped at two extra fetches per domain |
| Website technology | WordPress, Wix, Squarespace, GoDaddy, Shopify, Webflow, custom, none, dead link |
| Mobile friendly | Heuristic: `viewport` meta presence plus fixed-width layout signals. Not a PageSpeed verdict, and labelled as a heuristic in the UI |
| AI chatbot present or missing | Intercom, Drift, Tawk.to, Crisp, Tidio, HubSpot Conversations, LiveChat |
| Online booking available | Calendly, Acuity, Square Appointments, Setmore, SimplyBook, Booksy, Fresha, OpenTable, Resy |
| Social media links | Facebook, Instagram, LinkedIn, X, TikTok, YouTube |

### Tier 4, scoring and output

| Filter | Notes |
|---|---|
| Lead / opportunity score | Minimum-score slider, 0 to 100 |
| Skip duplicates | Suppresses businesses already exported in prior runs. Toggleable |
| Export format | CSV, Excel, Google Sheets, JSON |

## 7. Lead scoring

Four components summing to 100, plus multiplicative modifiers. **Every weight lives in
`scoring-config.js`** and nothing may hardcode a weight elsewhere.

| Component | Max | Rule |
|---|---|---|
| Website gap | 40 | No website 40, Facebook page as website 38, URL dead 35, DIY builder (Wix / Weebly / GoDaddy / Squarespace) 30, WordPress 20, modern custom build (Next / React / Webflow / Shopify) 5, detected but unrecognised platform 12 |
| Mobile gap | 20 | No viewport meta 20, viewport present but fixed-width signals 12, responsive 0 |
| Booking gap | 20 | Appointment-type category with no booking 20, appointment-type already booking 0, non-appointment category 6 |
| Viability | 20 | 10 to 300 reviews 20, 301 to 1000 12, over 1000 4, under 10 8 |

**Modifiers**

- No phone and no email: score x 0.6 (unreachable)
- Last review older than 12 months: x 0.7 (likely dormant)
- Marked permanently closed: score forced to 0

**Website gap is scored on platform identity alone**, never on a judgment like "looks dated". Age
and quality are unmeasurable from a single HTML fetch, and the responsive question is already
priced by the Mobile gap component. Scoring platform *and* an age guess would double-count the
same weakness.

**Components must stay independent.** Each of the four answers a different question, and no signal
may feed two components. A Wix site that fails mobile scores 30 for platform and 20 for mobile
because those are genuinely two separate things the operator can sell against, whereas "old Wix
site" and "Wix site" are one thing counted twice.

**Star rating is deliberately excluded** from the score and available only as a filter. A
3.2-star dentist is not a better or worse web-design prospect, so it must not move the number.

**Explainability is a hard requirement.** `score.js` returns `{ score, reasons[] }`, where
reasons are short human strings such as `Facebook page as website` or
`dentist, no online booking`. The UI renders them per row. A score the operator cannot justify
on a call is not a feature.

Appointment-type categories are enumerated in `scoring-config.js`, seeded with: dentist,
orthodontist, dermatologist, medical clinic, physiotherapist, chiropractor, veterinarian, beauty
salon, hair salon, nail salon, barber shop, spa, massage therapist, tattoo shop, gym, fitness
centre, yoga studio, photographer, auto repair shop, driving school, tutoring service.

## 8. Data model and storage

IndexedDB, four stores:

| Store | Key | Purpose |
|---|---|---|
| `leads` | Google CID | Harvested records for the current dataset |
| `domainCache` | registrable domain | Enrichment results with a TTL, shared across runs |
| `exported` | Google CID | Everything ever exported, powering cross-run dedupe |
| `runs` | run id | Job definition, progress, and resume state |

**Dedupe identity:** Google's CID from the listing URL is the primary key. Fallback composite for
records lacking one, or arriving from a licensed source: normalised name plus normalised phone,
then normalised name plus lat/long rounded to 4 decimal places.

**Resumability:** the `runs` store holds the leg queue and the offset within the current leg, so a
paused, blocked, or crashed job resumes rather than restarting.

## 9. Throttling and safety

**Block detection.** A valid payload response begins with `)]}'`. Missing prefix means a `/sorry/`
interstitial. HTTP 429 or 302 likewise. On any of these: pause the job, ring the bell, fire a
max-priority ntfy, and wait for the operator. Never retry through a block.

**The trap that must not be conflated.** End-of-list is a clean HTTP 200, roughly 784 bytes, with
the `)]}'` prefix intact and an empty record array. That is normal successful completion. Treating
it as a block would make every run pause spuriously; treating a block as end-of-list would silently
truncate results. `guard.js` classifies these as distinct states with distinct handling.

**Throttle.** Randomised inter-request delays with jitter, plus a latency EWMA. Recon could not
trigger a block at 90 requests in 10 minutes including 40 fully parallel, so the practical
threshold is above that and remains unverified. The tool nonetheless paces conservatively, because
the downside of being wrong is asymmetric. All timings live in `config.js`.

**Enrichment fetches** run from the MV3 service worker with `host_permissions`, which is exempt
from CORS by specification. Measured against 60 real harvested domains: 85% returned 200 with no
user agent at all, 1 was user-agent gated, all 6 Cloudflare-fronted sites returned 200. The
dominant failure is 12% dead domains, and **a dead domain is a 35-point scoring signal, not an
error.** Enrichment failures feed the score rather than being swallowed.

## 10. User interface

Two surfaces, split by how the operator actually works.

**Side panel**, on `google.com/maps`: job controls, keyword and location entry, run and pause,
live progress, per-leg counts. Watched while harvesting.

**Dashboard**, a full extension page in its own tab: the filter rail, the results table, and
export. Used for analysis, which needs width the popup cannot give.

Design language, established and approved via a clickable mockup:

- Survey-instrument aesthetic. Condensed uppercase labels set like map legends, hairline rules,
  hard corners, tabular monospace for every number.
- Palette: chart-ink `#0B1E22`, drafting vellum `#EDF1F0`, surveyor teal `#0E6B63` as accent,
  signal amber `#9A5A08` for opportunity, muted `#5D736D` for already-satisfied.
- **Deliberate semantic inversion: a gap is the win.** Missing website, failing mobile, and absent
  booking render in signal amber. Businesses that already have everything render muted and sink.
  Standard dashboard semantics would invert this incorrectly.
- Filter groups are badged by cost: `re-runs harvest` in warning colour on Tier 1, `instant` on
  the rest. The architecture is legible in the UI.
- Both light and dark themes, token-driven, with the manual toggle overriding the OS preference in
  both directions.

Approved mockup: `docs/superpowers/specs/assets/dashboard-mockup.html`

## 11. Module layout

Small units, one purpose each, no shared mutable state between stages.

```
src/
  core/
    config.js            all tunables: throttle, caps, TTLs
    scoring-config.js    weights, modifiers, appointment categories
    categories.js        Google Business Profile taxonomy
    fingerprints.js      tech / booking / chatbot / social signatures
    schema.js            Lead record shape and normalisation
  sources/
    source.js            interface every harvester implements
    payload-map.js       pinned positional indices, version, canary
    google-payload.js    primary harvester
    google-dom.js        second pass: owner replies, review recency
    osm-overpass.js      licensed fallback
    foursquare.js        licensed fallback
  pipeline/
    tiling.js            radius to grid of sub-centres
    harvest.js           leg queue, dedupe pool
    enrich.js            website fetch and parse, domain cache
    filter.js            pure: (leads, filterState) -> leads
    score.js             pure: (lead) -> { score, reasons[] }
    guard.js             block detection, throttle, backoff, ntfy
  store/
    db.js                IndexedDB access, the only module that touches storage
  export/
    csv.js  xlsx.js  json.js  sheets.js  clipboard-tsv.js
  ui/
    sidepanel/           job controls, live progress
    dashboard/           filter rail, table, export
background.js            MV3 service worker
manifest.json            includes a pinned `key` for a stable extension ID
```

`filter.js` and `score.js` are pure and therefore the easiest units to test exhaustively. They
carry most of the product logic on purpose.

## 12. Google Sheets export

Uses `chrome.identity` against an OAuth client the operator creates once in Google Cloud.

**The manifest pins a `key`** so the extension ID is stable across reloads and machines. Without
it the ID changes on every unpacked reload and the OAuth client silently breaks, which is the
usual failure mode for this feature.

Sheets export appends across runs and reuses the `exported` store to avoid writing a business
twice.

## 13. Testing strategy

| Layer | Approach |
|---|---|
| `score.js`, `filter.js`, `tiling.js`, dedupe keys | Unit tests. Pure functions, table-driven cases including every modifier and boundary |
| `payload-map.js` | Canary self-test against a recorded fixture, plus a live pre-run assertion |
| `fingerprints.js` | Fixture HTML files per platform (WordPress, Wix, Squarespace, GoDaddy, Shopify, Webflow) and per booking and chatbot vendor |
| `guard.js` | Simulated responses: valid payload, `/sorry/` interstitial, 429, and the 784-byte empty end-of-list, asserting the last is classified as completion |
| Enrichment | Recorded fixtures plus a live smoke run against a small real domain set |
| UI | Driven in a real browser, asserting filter counts against a known fixture dataset |
| End to end | One real throttled harvest of a small radius, verifying record count, dedupe, score distribution, and every export format |

Every implementation step reports what was tested, how, the actual output, and a plain PASS or
FAIL. Anything not exercised is labelled NOT VERIFIED rather than implied.

## 14. Known risks

| Risk | Severity | Mitigation |
|---|---|---|
| Google changes payload indices | High | Pinned versioned index map plus loud canary failure. DOM and licensed sources as fallback |
| Terms-of-service exposure | Accepted | Logged-out requests, conservative throttle, licensed sources kept first-class |
| Review-date precision beyond 4 weeks | Low | Documented as approximate; relative dates are all Google exposes |
| Mobile-friendly heuristic disagrees with PageSpeed | Low | Labelled a heuristic in the UI. Optional PageSpeed deep-check on a shortlist is a v2 candidate |
| 247-per-query cap misread as a bug | Low | Documented here and surfaced in the UI as a per-leg counter |
| Sheets OAuth breaks on reload | Medium | Pinned extension `key` in the manifest |

## 15. Open questions for the plan

1. Tile grid geometry: fixed square grid versus rings sized by result density. Density-adaptive is
   better but harder; recommend fixed grid in v1.
2. Whether the side panel and dashboard share a rendering layer or stay independent. Recommend
   independent, since their jobs differ enough that sharing would couple them badly.
3. Excel export via a bundled writer versus emitting CSV with an `.xlsx` wrapper. Recommend a
   minimal real xlsx writer, since a renamed CSV will annoy the operator the first time Excel
   warns about it.
