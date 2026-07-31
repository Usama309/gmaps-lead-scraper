# Changelog

## [Unreleased]

### Added
- [2026-07-31 05:30 AM] Phase 3 Tasks 1 and 2: `src/sources/review-dates.js` parses Google's relative
  review dates, and `src/sources/google-dom.js` reads owner replies and recency off the rendered
  place panel. Both pure and testable in bare Node
- [2026-07-31 04:30 AM] Enrichment control on the dashboard: candidate count, live progress, stop,
  and a real outcome line. Phase 2 Tasks 6 to 8 complete
- [2026-07-31 03:15 AM] Enrichment wiring: `ENRICH` / `ENRICH_PROGRESS` / `ABORT_ENRICH`, a separate
  concurrency slot from harvest, throttling between fetches, and the domain cache actually consulted
  so two leads sharing a host cost one fetch
- [2026-07-31 03:15 AM] Phase 2 begins. `src/core/fingerprints.js`: platform, chatbot, booking, social
  and mobile-friendliness detectors, matching raw markup because the MV3 worker has no DOMParser
- [2026-07-31 02:30 AM] `src/pipeline/enrich.js`: `scanHtml` (pure) plus `enrichOne` / `enrichLeads`.
  A dead domain is a 35-point scoring signal rather than an error; an UNEXPLAINED failure leaves the
  lead unenriched instead, so one transient fault cannot permanently score a live business as dead
- [2026-07-31 02:30 AM] The JavaScript-shell outcome, found in live recon: a 200 response carrying
  too little markup to read leaves the boolean signals null and the lead provisional. Positive
  evidence such as a mailto or a WordPress asset path is still taken, because a signal that IS
  present is real at any page size, while its absence is only meaningful once there is markup to
  read. Phase 1's domain cache already satisfied the planned Task 2

### Fixed
- [2026-07-31 04:30 AM] A canary coverage shortfall aborted the whole run. Measured in Attock the same
  day: phone coverage is 98% for dentists but 65% for beauty salons and 60% for gyms, so an 80% floor
  calibrated on one vertical returned ZERO businesses for two others. It is now a warning; TOTAL loss
  of a field still halts, which is what uniform index drift actually looks like. Beauty salon went
  from 0 to 67 businesses and gym from 0 to 8
- [2026-07-31 04:30 AM] The enrich button read "Enrich 1 leads", and counted leads rather than
  websites, which overstates the work about sevenfold on a real harvest
- [2026-07-31 03:15 AM] A platform detected on a client-rendered page was silently discarded at the
  enrich/schema boundary: `mergeLead` gated every positive finding on `enriched`, which enrichment
  deliberately leaves false for a page too thin to judge an absence. A Next or React site therefore
  kept websiteTech null, scored as `unknown` for 12 points instead of `modern` for 5, and so read as
  a BETTER lead than it is, while never persisting so every later run refetched it
- [2026-07-31 01:30 AM] Third review, three blockers, all from one root cause I introduced: canary
  notices were merged into `problems`. `completed_with_errors` keys off that array, and FIRST-RUN.md
  defines it as "at least one query failed, the list is incomplete", so every thin-market run was
  labelled errored and incomplete when it was flawless. It also buried the halt reason: a 60-leg run
  blocked at leg 31 produced a 9,212 character PAUSED line with "HTTP 429" as the last twelve
  characters. Notices now travel on their own field end to end, deduplicated
- [2026-07-31 01:30 AM] The entire notice path had no test: deleting either half left all 292 green.
  Now exercised through the real source, and both deletions bite
- [2026-07-31 01:30 AM] The markup guard only read a slot's first text node, so a number after a
  nested tag was invisible. `#s-nosite` already has that exact shape
- [2026-07-31 01:30 AM] The DNR test re-implemented Chrome's urlFilter matcher and got it wrong in
  both directions; replaced with the literal pattern. `buildRule` read the endpoint from the global
  while accepting a config parameter, so the one value that decides where the cookie travels could
  not be varied
- [2026-07-31 01:30 AM] The duplicates count is now a pure tested function; the ambiguity gate is
  pinned by a test rather than defended by a comment
- [2026-07-31 12:30 AM] Second adversarial review found five blockers, all fixed. The worst was mine:
  the ambiguity check I added to the canary raised a PROBLEM, and `canary_failed` halts the whole
  job, so a single six-record outer tile of a rural run aborted a sixty-leg harvest. Ambiguity is now
  a warning on a separate channel, gated at the small-page threshold so a four-record page is no
  longer a blind spot
- [2026-07-31 12:30 AM] The marker that scopes the cookie rule had no end-to-end test: deleting the
  only line that writes it left all 287 tests green while the cookie silently stopped travelling
- [2026-07-31 12:30 AM] The reviewCount integer check, which actually carries swap detection, could
  be deleted with the suite still green, because the test matched a string the ambiguity message also
  contained
- [2026-07-31 12:30 AM] The runtime-slots markup test named `e-count` in its pattern but could never
  match it, and a `length >= 5` assertion masked the miss
- [2026-07-31 12:30 AM] The search endpoint was two literals in two files, either of which silently
  made the cookie rule match nothing; now one value in config
- [2026-07-31 12:30 AM] `hiddenAsDuplicates` counted every exported lead rather than the ones the
  toggle alone hid, so two numbers on the same readout could not be reconciled
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
