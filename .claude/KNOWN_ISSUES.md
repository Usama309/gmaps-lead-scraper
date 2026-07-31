# Known Issues

## Open
- Tiling buys very little in a thin market. Measured live at 15 km: leg 1 returned 40 businesses and
  legs 2 through 7 added two more between them, because every tile query returns much the same
  widened result set and the radius filter then keeps the same local businesses each time. A 21-leg
  run costs about 20 minutes for that. Worth revisiting in Phase 2: either detect the plateau and
  stop early, or drop tiling for radii Google already over-serves.
- A wide run fetches far more than it keeps. At 2 km, 195 of 212 results were discarded as
  out-of-area, and at 15 km, 1,062 were. The throttle cost is paid on all of them. This is inherent
  to Google widening a thin search, but an early-stop heuristic would cut it.
- The extension must be reloaded after any code change AND the Maps tab reloaded afterwards, because
  `chrome.storage.session` is cleared on extension reload and takes the captured pb with it. Starting
  a run in that window fails with "no search parameters captured yet". Cosmetic, but confusing.
- The payload canary's field-collision sweep is anchored on `return finish(` and on literal
  arguments, so a comment containing that exact string, or a call passing a variable, would not be
  counted. Ruled acceptable: the separate `handBuilt === 0` assertion is independent of the pattern,
  so protection does not rest on it.
- `effectiveRadiusKm` understates real coverage slightly, because a query fired at the outermost kept
  tile can still return businesses beyond it. Conservative rather than misleading.
- Truncating the tile plan can leave an angularly uneven bite out of the boundary ring rather than a
  clean circle, since candidates are sorted by distance without regard to bearing.
- Google exposes review dates as relative text only, so last-review precision beyond roughly four
  weeks is approximate. Not fixable from our side.
- Mobile friendliness is a heuristic from a single HTML fetch rather than a PageSpeed verdict, and is
  labelled as such in the UI. A deep check on a shortlist is a Phase 2 candidate.
- `.keys/extension.pem` pins the extension ID and is gitignored, so it is not backed up anywhere.
  Losing it changes the ID and breaks the Phase 4 Sheets OAuth client. Copy it somewhere safe.

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

## Resolved
- [2026-07-30] The dashboard footer read "Mockup with sample Attock-area data. Nothing is
  scraped or exported here." while sitting on the same screen as a working export button that
  writes a CSV and calls `markExported`. A UI that misdescribes what it does on the surface
  where it does it is a correctness bug, not a cosmetic one, since the operator calibrates
  trust from that text. Replaced with copy stating that the leads are real and that exporting
  records them so the next sweep can skip them. The amber/grey legend lines beneath it were
  accurate and are unchanged.
- [2026-07-30] Task 14: the approved mockup's inline script called an undefined `LEADS` after
  the sample-data array was removed, and its `.mp-chip` toggle raced `dashboard.js`'s own toggle
  on the same Technology-filter chips, cancelling the visible `aria-pressed` state on every
  click. Fixed by removing the dead render path and scoping the legacy chip handler off
  `[data-tech]` elements. No HTML or CSS changed. See CHANGELOG.md.
