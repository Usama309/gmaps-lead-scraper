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
