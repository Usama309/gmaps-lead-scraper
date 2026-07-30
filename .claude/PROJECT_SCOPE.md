# Project Scope: MapProspector

## What this is
A Chrome MV3 extension that harvests Google Maps business listings, scores each as a
web-design or online-booking sales opportunity, and exports the qualified set.

Design spec: `docs/superpowers/specs/2026-07-29-gmaps-lead-scraper-design.md`
Phase 1 plan: `docs/superpowers/plans/2026-07-29-phase1-harvest-to-csv.md`
Build journal: `docs/superpowers/journal/2026-07-29-phase1-build-journal.md`
Live verification steps: `docs/FIRST-RUN.md`

## Current State
Phase 1, harvest to CSV, is code-complete and unit-tested (242/242 tests passing, all 14
tasks implemented). The pipeline runs harvest -> filter -> score -> export end to end:
- `src/pipeline/harvest.js` plans and runs tiled legs against the Google payload source
- `src/pipeline/filter.js` / `src/pipeline/score.js` filter and score every stored lead,
  with `provisional` marking scores computed before Phase 2 enrichment exists
- `src/store/db.js` persists leads in IndexedDB with cross-run dedupe via `markExported`
- `src/export/csv.js` writes the CSV, preserving "not looked" versus "looked and absent"
- `src/ui/dashboard/index.html` + `dashboard.js` render the filter rail and lead table from
  real data (`MSG.GET_LEADS`), re-filtering locally on every rail change with no network call
- `src/ui/sidepanel/index.html` + `sidepanel.js` start/stop a harvest and surface COVERAGE CUT
  warnings when the tile cap or leg cap truncates the area actually searched

**Not yet verified live in Chrome.** Task 14 Step 7, the end-to-end run against a real Google
Maps search (load the extension, run a 2 km harvest, confirm the dashboard populates, filter
with no network activity, export, and confirm cross-run dedupe and re-harvest merge), has been
deferred to the operator by explicit instruction and has not been performed by any agent. Phase
1 is code-complete but not sign-off-complete until that step runs and its actual numbers
(unique business count, score distribution, exported row count, stop reason) are recorded here.

## In Progress
Phase 2, website enrichment and full scoring. Not started; Tier 3 filter fields
(`email`, `tech`, `mobileFriendly`, `hasChatbot`, `hasBooking`, `hasSocials`, `ownerReplies`,
`lastReviewDays`) exist in the schema and filter but stay null until Phase 2 populates them.

## Next Priorities
1. Run Task 14 Step 7 (live end-to-end verification) and record the results here
2. Phase 2: website enrichment and full scoring
3. Phase 3: review intelligence via the detail-panel pass
4. Phase 4: export suite including Sheets OAuth
5. Phase 5: OpenStreetMap and Foursquare adapters
6. Phase 6: UI polish beyond the approved design's Phase 1 scope

## Architecture Decisions
See `.claude/DECISIONS.md`.

## Known Issues
See `.claude/KNOWN_ISSUES.md`.

## How this was built, and why the journal is worth reading first

Every task went through a fresh implementer and then an adversarial reviewer instructed to break
the module rather than confirm it. That found **41 real defects, and all 41 were in the plan text**
rather than in transcription, which was byte-perfect every time. A conventional spec-compliance
review would have passed every one of them, because they all did match the spec. The spec was wrong.

Seven would have shipped silently, producing plausible wrong output rather than an error. The worst
examples, each recorded in the journal with its ruling:

- a `"no email"` filter that returned businesses whose websites were never fetched, indistinguishable
  from ones checked and found to have none
- a tiler that fired nine queries at every radius, because spacing as a fraction of the radius
  cancels the radius out
- an identical CID across records collapsing every business into one exported row
- a blocked leg recorded as complete, so every future resume skipped that slice of the market
- business names beginning with `=` or `@` written unescaped into a CSV the operator opens in Excel
- a content script that could not parse and could not reach the extension, so capture was inert while
  every file read correctly

Subagents also caught five regression tests of mine that passed against the very code they were
written to catch. The counter-habit, and the single most useful practice here: after any fix, run the
new tests against the pre-fix code and confirm they fail. Isolate properly, reverting only the
behavioural line, since a test can fail for the wrong reason.
