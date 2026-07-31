# Task List

## Phase 1: Harvest to CSV
- [x] Task 1: Project scaffold, governance files, manifest (completed 2026-07-30)
- [x] Task 2: config.js, the tunables single source of truth (completed 2026-07-30)
- [x] Task 3: identity.js and schema.js (completed 2026-07-30)
- [x] Task 4: scoring-config.js and score.js (completed 2026-07-30)
- [x] Task 5: filter.js (completed 2026-07-30)
- [x] Task 6: tiling.js (completed 2026-07-30)
- [x] Task 7: payload-map.js and the canary (completed 2026-07-30)
- [x] Task 8: guard.js, block versus end-of-list (completed 2026-07-30)
- [x] Task 9: source.js and google-payload.js (completed 2026-07-30)
- [x] Task 10: harvest.js, the leg queue (completed 2026-07-30)
- [x] Task 11: csv.js (completed 2026-07-30)
- [x] Task 12: mergeLead and db.js (completed 2026-07-30)
- [x] Task 13: content script pb capture and background router (completed 2026-07-30)
- [x] Task 14: dashboard wiring (completed 2026-07-30) — Steps 1-6 and 8 done: dashboard
      shell, dashboard.js, side panel, manifest web_accessible_resources, toolbar-to-side-panel
      wiring, and full unit suite green (242/242). **Step 7 (live end-to-end run against a real
      Google Maps search) is explicitly deferred to the operator** and has NOT been performed by
      this task. Phase 1 is not signed off as verified-in-Chrome until Step 7 runs and its
      actual output (unique count, score distribution, exported row count, stop reason) is
      recorded here.

## Summary
14 of 14 tasks have their code complete; 13 of 14 are fully verified (tests pass and, where
applicable, the feature has been exercised). Task 14 is code-complete and unit-tested but
awaits the live-run verification in Step 7 before Phase 1 can be called done end to end.

## Phase 1 sign-off
- [x] Task 14 Step 7: live end-to-end verification in Chrome (completed 2026-07-30)
- [x] Fix the four defects the live run exposed (completed 2026-07-30)
- [x] Re-review the live-run fixes adversarially (completed 2026-07-30; 6 blockers found and fixed)
- [x] Second adversarial review (completed 2026-07-30; 5 blockers found and fixed)
- [x] Third scoped re-review (completed 2026-07-31; 3 blockers + 5 important, all fixed)
- [ ] Phase 2: website enrichment, per docs/superpowers/plans/2026-07-30-phase2-website-enrichment.md
