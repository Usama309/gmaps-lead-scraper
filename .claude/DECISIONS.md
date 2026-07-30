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
**Extension ID:** ghnhjhnldonkhjojmclnimghpcgocmce

## ADR-005: The dashboard mockup's dead sample-data code was removed, not just its two named lines
**Date:** 2026-07-30
**Decision:** Task 14's brief named exactly two edits to the mockup's inline script: delete the
`LEADS` array and delete the final `render();` bootstrap call. Implementing only those two,
literally, leaves `render()`, `passes()`, `stripeColor()` and `LASTDAYS` in place referencing
the now-undefined `LEADS`, still wired to the score slider, review-count fields, tech chips,
segmented buttons and sort headers. Those would throw a ReferenceError on every such click.
Worse, the mockup's own `.mp-chip` toggle and `#e-go` export handler stay bound alongside
`dashboard.js`'s real handlers on the same elements: the chip toggle is read-then-flip, so the
two handlers cancel each other's `aria-pressed` state and the Technology filter never actually
engages, and the export handler overwrites the real toast with fake "(mockup)" text.
**Why:** The task's own stated priorities are "never mislead the operator" (provisional score,
coverage-cut warnings) and the user's standing rule to remove dead code rather than ship it
broken. A literal two-line edit ships a filter control that visibly does not work and an export
confirmation that can show false text, which contradicts both.
**Consequence:** Removed the entire sample-data render path and every `render()` call site, and
scoped the mockup's chip handler to skip `[data-tech]` chips (owned by `dashboard.js`) and
removed its `#e-go` handler entirely. Zero HTML or CSS changed; every ID, class and visible
layout is exactly the approved mockup. Category typeahead, location-mode toggle, export-format
toggle and sort-arrow display, none of which conflict with `dashboard.js`, were left untouched.
