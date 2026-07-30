# Known Issues

## Open
- Google review dates are relative text only, so last-review precision beyond roughly
  four weeks is approximate. Documented in the spec, not fixable.
- Mobile-friendliness is a heuristic from a single HTML fetch, not a PageSpeed verdict.
  Labelled as such in the UI.
- The sub-940px dashboard layout has never been rendered and verified. The CSS exists.
- The `np:` fallback dedupe key can merge two distinct locations. Two branches of a
  same-named business that share a central switchboard number produce an identical
  name plus phone key, so one location is silently lost. Only affects records where
  Google supplied no CID, which is the degraded-data path rather than the normal one.
- Task 14 Step 7 (live end-to-end run against a real Google Maps search) has not been
  performed. The whole dashboard/side-panel wiring is unverified against a live worker,
  a live content-script capture, and a live export/dedupe cycle. See PROJECT_SCOPE.md.
- The dashboard table's column-header sort (`th.sortable`) is cosmetic only in this phase:
  clicking a header rotates the arrow icon but does not resort the table, since `dashboard.js`
  does not bind a click listener there and `DEFAULT_FILTER_STATE.sortBy`/`sortDir` are never
  updated from the UI. Sorting is fixed at score-descending until wired.
- The dashboard's "Social links" chips (Facebook/Instagram/Any) toggle visually but filter
  nothing, since `hasSocials` is not in `dashboard.js`'s `bind()`. Matches the plan's documented
  Tier 3 deferral to Phase 2.
- The dashboard footer still reads "Mockup with sample Attock-area data. Nothing is scraped or
  exported here." That sentence is now false (the page is wired to the real pipeline) but was
  left as-is rather than silently edited, since it is copy inside the operator-approved mockup
  and the task brief limited HTML edits to three specific, non-copy changes. Flagged for the
  operator to confirm before it ships user-facing.

## Resolved
- [2026-07-30] Task 14: the approved mockup's inline script called an undefined `LEADS` after
  the sample-data array was removed, and its `.mp-chip` toggle raced `dashboard.js`'s own toggle
  on the same Technology-filter chips, cancelling the visible `aria-pressed` state on every
  click. Fixed by removing the dead render path and scoping the legacy chip handler off
  `[data-tech]` elements. No HTML or CSS changed. See CHANGELOG.md.
