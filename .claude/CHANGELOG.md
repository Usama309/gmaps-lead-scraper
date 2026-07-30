# Changelog

## [Unreleased]

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

### Removed
- [2026-07-30 01:30 PM] Unused `currentLeads` variable in `dashboard.js`, written but never read
