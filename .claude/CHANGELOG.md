# Changelog

## [Unreleased]

### Fixed
- [2026-07-30 11:40 PM] Adversarial review of the live-run fixes found six blockers, all fixed:
  a swap of rating and reviewCount went undetected in a thin market (whole-number ratings defeat
  the integer check, so the sample-level ambiguity check replaces it); the cookie rule's scope was
  `tabIds: [-1]`, which includes a website's own service worker, so it is now matched on a marker
  only our own requests carry; a session rule stranded by a killed worker was never swept; a failed
  removal was silently discarded; a missing cookie was announced as advisory when it is fatal; and
  two shipped tests certified properties they could not detect
- [2026-07-30 11:40 PM] Three further hardcoded mockup values in the dashboard: a duplicates count
  of 6, a harvested count of 18, and a permanent "Harvest leg 2 of 3" header
- [2026-07-30 11:40 PM] Out-of-area results were counted per record rather than per business, so an
  overlapping 21-leg run inflated the figure by roughly the leg count
- [2026-07-30 10:45 PM] Review count was missing from every harvested lead. Google omits it unless
  the request carries a session cookie, and `credentials: 'omit'` suppressed all of them. Isolated
  live, same pb and context back to back: cookieless 5% coverage, cookie-bearing 95%
- [2026-07-30 10:45 PM] The requested radius was never applied to results, only to tile placement.
  A 2 km search returned a median distance of 62 km and a furthest of 12,434 km
- [2026-07-30 10:45 PM] The canary's reviewCount-versus-rating ordering rule aborted every run in a
  thin market. Ratings cap at 5, so the rule could only ever fire on businesses with four reviews or
  fewer, which is the target market. Swap detection moved to the integer check, which is stronger
- [2026-07-30 10:45 PM] The Skip duplicates control claimed "1,284 businesses already exported", a
  number hardcoded from the mockup and never replaced. Now bound to the real count
- [2026-07-30 10:45 PM] FIRST-RUN.md's timing table was estimated and wrong by about an order of
  magnitude, and it described the Skip duplicates default backwards

### Added
- [2026-07-30 10:45 PM] `src/sources/anon-cookie.js`: attaches exactly one allowlisted, account-free
  cookie to our own requests via a session-scoped declarativeNetRequest rule, scoped to tabId -1 so
  it cannot touch Google Maps' requests in the operator's own tab
- [2026-07-30 10:45 PM] `RUN_NOTICE` message, for a run that proceeds but is degraded in a way the
  operator has to know about
- [2026-07-30 10:45 PM] 23 tests, each verified to fail against the defect it describes

### Fixed
- [2026-07-30 08:00 PM] BLOCKER found by the final whole-branch review: the default filter carried
  maxReviews Infinity, which becomes null over the extension message boundary and then compares as
  zero, so the dashboard and CSV silently kept only businesses with no reviews at all
- [2026-07-30 08:00 PM] Seven more from the same review, including a merge that flipped
  hasRealWebsite to false on re-harvest and a stale "No website" verdict beside a live URL


### Added
- [2026-07-30 05:30 PM] Phase 1 complete in code: harvest, dedupe, score, filter and CSV export,
  across 14 tasks and 242 passing tests
- [2026-07-30 05:30 PM] `docs/FIRST-RUN.md`, the operator checklist for the live verification, which
  is the one Phase 1 step no agent performed
- [2026-07-30 05:30 PM] `docs/superpowers/journal/`, the build journal recording all 41 review
  findings with the ruling and reasoning behind each

### Fixed
- [2026-07-30 05:30 PM] Seven defects that would have shipped silently rather than as errors. Named
  individually in the build journal; the sharpest were a blocked leg being skipped on every future
  resume, spreadsheet formula injection through business names, and a content script that could not
  parse so capture was inert while reading correctly

### Security
- [2026-07-30 05:30 PM] CSV cells beginning with a formula trigger are neutralised, since Google
  Maps listing names are attacker-registrable and the export opens directly in a spreadsheet.
  Numbers are exempt so coordinates stay numeric
- [2026-07-30 05:30 PM] Every Google request uses `credentials: 'omit'`, so no account is attached

### Added
- [2026-07-29 04:00 PM] Design spec and Phase 1 implementation plan
- [2026-07-30 12:00 PM] Config, identity, schema, scoring, filter, tiling, payload mapping,
  block-detection guard, Google payload source, harvest leg queue, CSV export, lead merge and
  IndexedDB store, and the content-script pb capture and background message router (Tasks 1-13)
- [2026-07-30 12:00 PM] Dashboard shell at `src/ui/dashboard/index.html`, adapted from the
  approved mockup, wired to real data through `dashboard.js`
- [2026-07-30 12:00 PM] Side panel at `src/ui/sidepanel/index.html` with job controls
  (`sidepanel.js`), including coverage-cut warnings when tiling or leg caps truncate a run
- [2026-07-30 12:00 PM] Manifest `web_accessible_resources` entry for the dashboard page, and
  `chrome.sidePanel.setPanelBehavior` so the toolbar icon opens the side panel

### Fixed
- [2026-07-30 12:00 PM] Removed the approved mockup's sample-data render path (`LEADS`,
  `LASTDAYS`, `passes()`, `stripeColor()`, `render()`) from the dashboard's inline script so it
  cannot throw on the now-undefined `LEADS`, and scoped its leftover `.mp-chip` toggle to
  chips `dashboard.js` does not own, since the two toggle handlers on the same element were
  cancelling each other's `aria-pressed` state on every click. No HTML or CSS changed.
- [2026-07-30 01:30 PM] Corrected the dashboard footer, which claimed "Nothing is scraped or
  exported here" on the same screen as a working export button that writes a CSV and marks
  leads exported. It now states that the leads are real and that exporting records them so the
  next sweep can skip them.

- [2026-07-30 03:00 PM] Split export confirmation from CSV generation. `MSG.EXPORT` now returns
  the keys and marks nothing; the new `MSG.CONFIRM_EXPORT` records them, and the dashboard sends
  it only after the download has actually been triggered. Previously a blocked or cancelled
  download still flagged those businesses as exported, silently skipping them on every later sweep
- [2026-07-30 03:00 PM] Closed a time-of-check to time-of-use window in the run guard. The
  `activeRun` slot is now claimed synchronously before the first await, so two fast clicks cannot
  both pass the check and start concurrent pipelines against the shared dedupe store. The side
  panel also disables Start for the duration of a run
- [2026-07-30 03:00 PM] `esc()` in `dashboard.js` now escapes single and double quotes as well as
  angle brackets, hardening it before anything lands inside a quoted attribute
- [2026-07-30 03:00 PM] A failed dashboard refresh now clears the table and zeroes the stats
  instead of leaving stale numbers readable under an error toast, and errors persist until the
  next successful refresh rather than fading like a success message
- [2026-07-30 03:00 PM] Review-count inputs parse explicitly, so a maximum of 0 means zero rather
  than no limit. `Number(v) || Infinity` treated the valid value 0 as absent

### Removed
- [2026-07-30 01:30 PM] Unused `currentLeads` variable in `dashboard.js`, written but never read
