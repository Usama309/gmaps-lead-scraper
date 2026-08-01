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

## The account-cookie control, proven against a signed-in browser
**Date:** 2026-07-31

Everything before this was measured in a throwaway profile with no Google account, so
the control was only ever shown not to break. It has now been exercised where it
matters.

Comet, the operator's own Usama profile, signed into Google with all ten account
cookies present in the jar: LSID, HSID, SSID, APISID, SAPISID, SID,
`__Secure-1PSID`, `__Secure-3PSID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`.

A 2 km harvest made 12 requests. Every one carried exactly `NID=...` and nothing
else. Zero account cookies reached the wire. The session rule was gone when the run
finished.

That is the allowlist doing the job it was chosen for: the fetch contributes no
cookie because `credentials: 'omit'` stands, and the rule writes back only names we
listed, so the ten cookies sitting in the same jar could not travel even though the
browser had them.

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

## Ambiguity is reported, drift is halted, and the two must not share a channel
**Date:** 2026-07-30 (second adversarial review)

`runCanary` now returns `warnings` alongside `problems`. Only problems produce `canary_failed`, which
is a HALTING reason that ends the whole job.

This exists because the previous fix put the rating/reviewCount ambiguity into `problems`. That reads
as rigour and is far more damaging than the bug it replaced: the canary runs on the first page of
EVERY leg, up to 60 of them, so a single six-record outer tile of a rural run aborted the entire job.
Thin rural markets are what this product sells into. Measured: a six-record page of genuine new
listings returned `ok: false`.

Ambiguity is not evidence of drift, it is the absence of evidence either way, and the honest response
is to say so and keep working. Real drift still halts through the per-field validators, which are
strictly better at it.

The warning is also gated at the small-page threshold of 2 rather than the coverage threshold of 5.
Using 5 reintroduced the exact blind spot this file had already closed for total field loss: a
four-record page could be fully transposed and say nothing at all.

## Scope the cookie rule on a marker we write, not on `tabIds: [-1]`
**Date:** 2026-07-30 (adversarial review)

`tabIds: [-1]` means "not associated with a tab", which is a strictly larger set than "sent by this
worker": a website's own service worker falls in it, and google.com registers one. Because the rule
SETS the Cookie header rather than appending, a Google-originated service-worker request to /search
would have gone out carrying only our cookie, with the operator's real session stripped. That is the
exact breakage the condition was added to prevent.

The live sentinel check did not catch it: it exercised a page-initiated request, which has a tabId of
0 or more, so it proved nothing about the -1 bucket.

The request now carries a marker query parameter written by exactly one line of code, and the rule
matches on it. No request this extension did not build can match, whatever context it comes from.
`tabIds: [-1]` is kept as a redundant second condition. Verified live that Google's payload is
unchanged with the parameter present.

## Refuse a payload where rating and reviewCount cannot be told apart
**Date:** 2026-07-30 (adversarial review)

Removing the ordering rule outright was wrong, and the argument for removing it was wrong in a
specific way worth recording: "a swap puts a fractional rating into the reviewCount slot, where
Number.isInteger rejects it" fails exactly on the market this tool targets, because a listing with
one review has a whole-number rating by arithmetic. A review reproduced a full index swap on a
20-record thin-market page and the canary reported no problems at all.

The check is now on the sample, not the record: if every rating is a whole number AND no count
exceeds the rating ceiling of 5, the two columns are indistinguishable and the payload is refused.
Both the swapped and unswapped forms are refused, deliberately, because keying on the swap rather
than on the ambiguity would miss the swap for the same reason. Any real page carries at least one
established business, so this does not fire in practice: live in Attock the counts ran to 209.

## Remove the reviewCount-versus-rating ordering rule from the canary
**Date:** 2026-07-30

The rule aborted the first successful live run. Ratings are capped at 5, so `reviewCount < rating`
can only be true when reviewCount is 4 or less, which means the rule fires exclusively on very small
businesses. Live in Attock, 8 of 19 real dentists had a 5.0 rating with one to four reviews. Those
are the target market, not drift.

**This section's original reasoning was wrong, twice, and the corrections are recorded above under
"Refuse a payload where rating and reviewCount cannot be told apart" and below.** The claim that
"real ratings are fractional" fails on a one-review listing, whose rating is a whole number by
arithmetic, which is most of a thin market. The follow-up claim that "the replacement test proves the
integer check carries swap detection" was also false: that test asserted only that a problem
mentioning `reviewCount` was raised, and the ambiguity message contains that word too, so deleting
`Number.isInteger` left the suite green. There is now a test that asserts the integer check produces
a "wrong shape" problem specifically, and it fails when the check is weakened.

## ADR-007: Photon for place-name geocoding, not Nominatim
**Date:** 2026-07-31
**Decision:** Resolve the side panel's "City or place" field through Photon
(photon.komoot.io), not OpenStreetMap's own Nominatim.
**Why:** The operator asked to enter a place by name (e.g. "Kansas City, US") instead of
raw coordinates. Nominatim rejects a browser `fetch` with HTTP 403 unless the request
carries an app-identifying User-Agent, and a page cannot set that header (it is
forbidden). Verified live on 2026-07-31: Nominatim returned 403, Photon returned 200 for
the same query. Photon is keyless, CORS-enabled, OSM-based, and built for autocomplete.
**Consequence:** One external dependency for the lookup, called once per Find click, not
on a loop. `credentials: 'omit'` is carried through so no account is attached, consistent
with ADR-002. Photon's top hit is occasionally a prominent POI rather than the settlement
centre; noted in KNOWN_ISSUES.

## Place lookup does not use Google, because Google cannot answer it
**Date:** 2026-07-31

The obvious source for "find this place" is Google, since the extension already talks
to its map endpoint and already has the cookie machinery. Measured before building:
querying that endpoint for `Attock`, `Kansas City` and `Lahore` returned **zero
records each**. It is a business search, not a gazetteer, so it cannot list localities
at all.

Photon (photon.komoot.io) is used instead: free, keyless, CORS-enabled, OSM-backed.
Nominatim was rejected because it answers a browser fetch with HTTP 403 unless the
request carries an app User-Agent, and a page cannot set that header.

The stronger path needs no geocoder at all. A pasted Google Maps URL carries the map
centre in its own path as `@lat,lng,zoom`, so pasting a link the operator is already
looking at is exact, instant, offline, and free of any question about which Kansas
City was meant. That is the recommended route, and the typed-name lookup is the
fallback rather than the other way round.

Both refuse to guess. A pasted link whose coordinates fall outside real latitude or
longitude ranges is rejected rather than written into the form, because a latitude of
400 fails much later with a message about tiling that says nothing about the link that
caused it. And a typed name that matches several places shows all of them with their
kind, so an airport is distinguishable from a city at a glance.
