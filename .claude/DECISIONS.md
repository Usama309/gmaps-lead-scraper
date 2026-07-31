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

## ADR-006: Export is confirmed by the dashboard, not by the worker that builds the CSV
**Date:** 2026-07-30
**Decision:** `MSG.EXPORT` builds the CSV and returns the affected keys without recording
anything. A separate `MSG.CONFIRM_EXPORT` records them, sent by the dashboard only after
`anchor.click()` has fired. `markExported` has exactly one call site, inside `confirmExport`.
**Why:** Marking inside the same round-trip that built the CSV flagged businesses as exported
before the dashboard had even received the response, let alone constructed the Blob and
triggered the download. A blocked download, a cancelled save dialog, or an anchor click that
no-ops would then skip those businesses on every future sweep, with no error raised and no way
for the operator to learn which ones vanished. Silent permanent data loss is the worst failure
mode this tool has, because the operator cannot detect it from the output.
**Consequence:** The confirmation can still be lost if the page closes between the click and the
confirm, but that direction fails safe: the lead is exported again next time rather than never.
Preferring duplicate work over silent omission is the right bias for a lead list.

## Send one allowlisted anonymous cookie, rather than dropping `credentials: 'omit'`
**Date:** 2026-07-30 (operator decision, presented with measurements)

Google omits the review count from the search payload on a cookieless request. Measured live, same
pb and same context back to back: `omit` gave 5% coverage on reviewCount, `include` gave 95%, and no
other mapped field moved by more than one record out of twenty. Review count carries two of the 21
requested filters and the entire 20-point viability component, so losing it is not cosmetic.

Three options were put to the operator: keep `omit` and lose the field, switch to `include`, or send
an anonymous cookie only. They chose the third.

The implementation is an ALLOWLIST, not a denylist, and that distinction is the whole design. The
fetch stays `credentials: 'omit'`, so Chrome contributes no cookie of its own, and a
declarativeNetRequest rule then writes the Cookie header from a named list. A Google account cookie
therefore cannot travel even if Google ships a cookie name nobody has heard of yet. A denylist would
have started leaking on that day.

Two scoping properties carry as much weight as the allowlist, and both were verified live:
- the rule is SESSION scoped, so it cannot outlive the browser
- the rule matches `tabIds: [-1]`, so it applies only to requests the worker makes itself. Verified
  with a sentinel value: a page-initiated request to the same endpoint still carried the operator's
  real cookie, not ours. Without that condition the rule would strip their live Maps session.

**Rejected:** `credentials: 'include'`. One line, full data, but in a signed-in browser it attaches
the operator's Google account to every harvest request, which is the exact risk the control exists
to prevent.

## Enforce the search radius on results, not on the request
**Date:** 2026-07-30

Google treats the viewport inside a pb as a hint. Asked for 2 km live and it returned 211
businesses with a median distance of 62.5 km, a 90th percentile of 82 km, and a furthest result
12,434 km away. Only 17 were actually within 2 km.

The radius is therefore applied to harvested leads, before the dedupe map so an out-of-area business
can never occupy a key. Leads without coordinates are kept: we cannot show they are outside, and
discarding a real business because Google omitted its position is the worse error.

The discard count is reported to the operator rather than swallowed, because its size is
information. A large number means the radius is thinner than the keyword can fill.

## Remove the reviewCount-versus-rating ordering rule from the canary
**Date:** 2026-07-30

The rule aborted the first successful live run. Ratings are capped at 5, so `reviewCount < rating`
can only be true when reviewCount is 4 or less, which means the rule fires exclusively on very small
businesses. Live in Attock, 8 of 19 real dentists had a 5.0 rating with one to four reviews. Those
are the target market, not drift.

Nothing was lost by removing it. A genuine index swap puts the rating into the reviewCount slot, and
real ratings are fractional, so `Number.isInteger` rejects it; it also puts the count into the rating
slot, where anything above 5 fails the range check. Surviving both would require every rating in a
20-record sample to be a whole number AND every count to be 5 or under. The replacement test proves
the integer check is what now carries swap detection: weakening it makes that test fail.
