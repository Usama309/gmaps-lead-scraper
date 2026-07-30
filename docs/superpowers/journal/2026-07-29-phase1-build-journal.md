# Phase 1 Build Journal

Copied out of the git-ignored subagent workspace so it survives a `git clean`. This is the
decision record for how Phase 1 was built: every review finding, the ruling on it, and the
reasoning behind that ruling. Read the two sections at the end first if you are picking this
work up cold.

The single most useful thing in here: 46 real defects were found across 14 tasks, and every one
of them was in the PLAN, not in a subagent misreading it. Transcription was byte-perfect every
time. A conventional spec-compliance review would have passed all 46, because they all did match
the spec. The spec was wrong. Instruct reviewers to attack the code rather than confirm it, and
instruct implementers to measure rather than accept your framing.

---

# SDD ledger — plan: docs/superpowers/plans/2026-07-29-phase1-harvest-to-csv.md

Branch: phase-1-harvest-to-csv (off main)
Workspace: .superpowers/sdd/2026-07-29-phase1-harvest-to-csv

## Pre-flight rulings (delegated to controller by user)
- db.js WILL be unit tested. `fake-indexeddb` added as the single devDependency;
  the zero-dependency rule protects the shipped extension, not the test harness.
  Verified working: merge-on-put keeps enrichment and preserves the stored rating.
- capture.js monkeypatch KEPT but hardened: double-injection guard, throw-proof
  observer (it runs on Google's own fetch path), restore on pagehide.
- Plan re-verified after both amendments: 159 tests pass, 0 fail.

BASE for task 1: 23d17a9ed724ac33715781b8acbfd56ced2c01a4
Task 1: complete (commits 23d17a9..212517d, review clean) — ext ID ghnhjhnldonkhjojmclnimghpcgocmce
Task 1: minor (deferred): manifest key test asserts length>100 only, not valid base64/DER. Plan-mandated verbatim.
Task 1: minor (deferred): .keys/extension.pem is gitignored and unbacked. Losing it changes the extension ID and breaks Phase 4 Sheets OAuth. Needs a KNOWN_ISSUES entry.
BASE for task 2: 212517ddcc643e6c0c1cf4d10788471ba3a126f7
Task 2: complete (commits 212517d..4462fc1, review clean) — 11 tests pass
BASE for task 3: 4462fc1b6dbb64d245f1bd85fd6e414cf52e9d92
Task 3: fix round 1/5 dispatched — Important: .toFixed(4) inlined in identity.js violates the
  "no magic number outside config.js" constraint. Ruling: promote to an exported named constant
  COORD_KEY_DECIMALS inside identity.js rather than moving it to config.js, because identity.js
  must stay the import-graph leaf AND because changing it invalidates every stored dedupe key,
  so it is an algorithm constant, not an operational knob.
Task 3: minor (deferred): SOCIAL_HOSTS omits wa.me / WhatsApp Business, common in the Pakistan market.
Task 3: minor (deferred): every non-Facebook social host is bucketed as websiteTech 'facebook',
  a misleading label. Matches the brief's tests, so renaming is a later cleanup.
Task 3: fix round 1/5 (1 addressed, 0 open; commits d8ddd10..315c2dc)
Task 3: complete (commits 4462fc1..315c2dc, review clean) — 27 tests pass
BASE for task 4: 315c2dce99e390a1b30782e716a2767aac13ca5a
Task 4: fix round 1/5 dispatched — Important: score.js viability reason strings compared against
  literals (20, 1000, 10) duplicating scoring-config band boundaries. Reviewer PROVED desync:
  retuning points 20->25 silently deletes the explanation; widening the big band makes a
  1500-review lead be told "likely has an agency" on a live call. Also found the 301-1000 band
  emitted no reason at all. Ruling: move reason text into each band object. Plan patched to match.
  Reviewer explicitly ruled score.js:104 Math.max/Math.min 0..100 NOT a defect (output contract, not a weight).
Task 4: fix round 1/5 (1 addressed, 0 open; commits f96fbeb..65adade)
Task 4: complete (commits 315c2dc..65adade, review clean) — 48 tests pass. Plan patched to match; plan-vs-code parity verified by diff.
BASE for task 5: 65adade1004c5a51ee2794b4545887ce773ff8b5
Task 5: fix round 1/5 dispatched — Important: hasEmail:'no' coerced an un-inspected null into
  "confirmed absent" via Boolean(l.email), so unenriched leads landed in a "no email" list the
  operator would believe was verified. Reviewer proved the inconsistency: the other three
  tri-states correctly excluded nulls. Ruling: add a presence(lead,value) helper resolving
  null via the `enriched` flag, and route ALL FIVE enrichment tri-states through it.
Task 5: also folded in a product correction — mobileFriendly:'no' now matches 'partial' as well
  as false, because the owner sells mobile redesigns so a partly responsive site IS a lead.
  Scoring still prices partial below a full failure, which is the correct place for that nuance.
Task 5: CONTROLLER SELF-CORRECTION — my first instruction only covered 2 of the 5 fields and my
  test fixture relied on helper defaults instead of setting the field to null, so it failed.
  Caught by running my own instruction against the plan suite before trusting it. Corrected
  instruction sent. Plan patched and re-verified: 162 passing, 0 failing.
Task 5: fix round 1/5 (2 addressed, 0 open; commits 28958c2..56709b9)
Task 5: complete (commits 65adade..56709b9, review clean) — 69 tests pass
Controller: plan patches committed as 55e7bab (kept plan and code in sync).
BASE for task 6: 55e7babbd1a2149070516492880309dd96b7f602
Task 6: fix round 1/5 dispatched — TWO Important findings, both real design bugs in the plan:
  (1) Scale-invariant tile count. stepsPerSide = ceil(radiusKm / (radiusKm * spacingFactor))
      cancels the radius out, pinning the grid to exactly 9 tiles at EVERY radius. A 30 km
      search fired the same 9 queries as a 6 km one and coverage density fell as 1/radius^2,
      which directly defeats the module's reason for existing (beating the 247-per-query cap).
  (2) maxTiles was unreachable, so the test "tile count is capped" could never fail.
  Ruling: spacing becomes an ABSOLUTE 6 km (tuned so the UI's 15 km default yields 21 tiles and
  never truncates); tileRadius becomes planTiles returning coverage metadata; truncation is
  propagated through planLegs to a loud COVERAGE CUT warning in the side panel, per the
  no-silent-caps principle. Also replaced the vacuous cap test with one that can fail, and added
  a scale-growth regression test. Plan re-verified: 165 passing, 0 failing.
Task 6: minor (deferred): the overlap test proves grid proximity by construction, not real
  coverage; a bare-Node test cannot observe Google's per-query catch radius. Name overclaims.
Task 6: fix round 1/5 (2 addressed, 0 open; commits 6d8d3c6..f5a1e3c) — 82 tests pass
Task 6: complete (commits 55e7bab..f5a1e3c, review clean). Plan-vs-code parity verified by diff.
Task 6: minor (deferred): effectiveRadiusKm is conservative (understates real catch area, since a
  query at the outermost kept tile can still return businesses beyond it). Reviewer judged it not
  misleading. Also, ties at the truncation boundary can leave an angularly uneven bite rather than
  a clean circle. Neither blocks; both worth a KNOWN_ISSUES line before Phase 1 ships.
BASE for task 7: f5a1e3cda527ba12bfdcf211f4f0cbc302722f20
Task 7: fix round 1/5 dispatched — CRITICAL. Reviewer proved the canary was hollow for exactly the
  fields it existed to protect. It checked only name-is-a-string and rating-is-numeric, so ALL of
  these sailed through as ok:true, demonstrated by mutating the fixture:
    - phone index lost entirely (the module's own docstring names this scenario)
    - cid index landing on a shared address string, silently merging distinct businesses
    - a one-index constant shift putting the CID hex into `name` (still a string, so it passed)
    - rating going all-null, because the check only validated non-null values
    - lat/lng and reviewCount drift, unchecked
  Also Important: extractRecords collapsed "no container", "empty container" and "all records
  failed" into one empty array, and the harvester reads empty as end_of_list, so a total drift
  would have reported a completed search over a truncated list.
  Ruling: canary rebuilt around CANARY_RULES with per-field FORMAT validators plus coverage floors
  (name and cid required at any sample size; phone/rating/reviewCount/lat/lng judged on coverage
  once the sample reaches 5). Format validation is what catches a shift onto a populated-but-wrong
  field. Name explicitly rejects CID-shaped strings. extractRecords becomes extractPage returning
  rawCount, and guard gains an 'extraction_failed' state distinct from end_of_list.
  Fixture grew from 1 to 8 records so coverage floors are exercisable.
  Controller self-caught 3 bugs in its own patch before dispatch (missing wrapper index in a test
  fixture, a shadowed `page` variable, and a test helper whose minimal records the new canary
  correctly rejected). Plan re-verified: 176 passing, 0 failing.
Task 7: minor (deferred): PAYLOAD_MAP.record.hours is mapped but never read and is not in
  LEAD_FIELDS. Dead config until a later phase uses it.
Task 7: fix round 1/5 (2 addressed, 0 open; commits 18422c5..d8c940e) — 101 tests pass
Task 7: fix round 2/5 dispatched — the adversarial re-review broke the REBUILT canary three more
  ways, all Critical, all verified by running code:
    GAP1 small-sample total wipeout. Below minRecordsToJudgeCoverage (5) the coverage checks were
         skipped entirely, so a 4-record page could lose phone, rating, reviewCount, lat and lng
         completely and report healthy. A niche keyword in a small town legitimately returns 4.
    GAP2 lat/lng swap. Both values pass their own range validators because a longitude of 72 is a
         valid latitude, which holds for most of the inhabited world. Coordinates silently reversed.
    GAP3 a plausible non-CID string in `name`. Setting name to the address string passed every
         format check. The CID-rejection heuristic only caught one specific shift shape.
  Plus Important: phone's 50% floor sat far below its 98% live baseline, and placeId, address and
  categories were unvalidated (a categories drift silently blinds appointment scoring AND the
  category filter).
  Ruling: three new mechanisms. minAnyValid catches total loss at any sample size above one.
  mustDifferFrom catches a shift onto a populated-but-plausible field by cross-field comparison.
  A proximity check against the queried coordinates catches the swap and names it explicitly.
  Floors raised to 0.80/0.90. Rules added for categories, placeId, address.
  Controller re-verified: 183 passing, 0 failing, and all 8 adversarial cases behave correctly.
Task 7: fix round 2/5 (5 addressed, 0 open; commits d8c940e..9af18f2) — 108 tests pass
Task 7: fix round 3/5 dispatched — the third adversarial pass found MORE, and one was worse than
  anything before it:
    CRITICAL: an identical well-formed cid on every record passed. Format ok, coverage ok, but cid
      is the PRIMARY dedupe key, so eight real businesses would collapse into one exported row.
      The rule's own `why` string warned about exactly this and the rule did not check for it.
    IMPORTANT: mustDifferFrom enumerated only ['address','placeId','cid'], so a shift landing name
      on the phone, the website or the joined categories evaded it. Same bug class as the Critical
      gap it was written to fix, routed through an untracked field.
    MODERATE: minRecordsNearQuery 0.5 tolerated a partial lat/lng swap on up to half the records.
    LOW: the collision threshold used a strict majority, so an exact 50% collision passed.
  Ruling: add minUniqueRatio (cid and placeId, 0.95) so a repeated identifier aborts. REPLACE the
  enumerated mustDifferFrom with a general pairwise sweep over every mapped scalar field, closing
  the whole evasion class rather than one instance. Tighten minRecordsNearQuery to 0.9 and the
  collision threshold to a 0.25 ratio.
  Controller verified 11 adversarial cases, including 2 that must legitimately PASS so we are not
  trading real coverage for false alarms: ALL 11 CORRECT. Plan at 187 passing, 0 failing.
Task 7: fix round 3/5 (4 addressed, 0 open; commits 9af18f2..9db8bf0) — 112 tests pass.
  Implementer made one deliberate, correct deviation: my brief's docstring still listed
  mustDifferFrom after I removed the mechanism, and it refused to transcribe stale docs.
  Plan synced to its wording.
Task 7: fix round 4/5 dispatched — fourth adversarial pass. IMPORTANT: the pairwise sweep detects
  field COLLISIONS (a === b) but not field SWAPS, where two fields exchange values and both remain
  individually valid. Reviewer demonstrated phone <-> placeId undetected (a digit-heavy place ID
  satisfied "has 7 digits" and a phone satisfied "is a non-empty string"), and rating <-> reviewCount
  undetected when both values happen to stay in range.
  Ruling: tighten the two overlapping validators (phone must contain only dialling characters,
  placeId must start with a letter and be 8+ chars), add a relational invariant (reviewCount >=
  rating on 90% of records, since a real business has more reviews than its rating is high), and
  make lat/lng REQUIRED on harvestLeg so the proximity check can never be silently disabled by
  defaulting them to null.
  Also valuable: the reviewer tested 8 realistic HEALTHY payloads and found NO false positives.
  Controller verified 12 cases: 5 must-pass (mall sharing a phone, franchise with repeated names,
  4-review business, new listing without a rating) and 7 must-abort. ALL 12 CORRECT.
  NOTE ON ESCALATION: the skill escalates to a fresh implementer on a stronger model at round 4,
  on the theory that a stuck implementer cannot see its own problem. That does not apply here. The
  implementer has been correct every round and even corrected my documentation; what keeps changing
  is my plan, improved by adversarial review. Resuming the same agent deliberately, to keep its
  module context.
Task 7: fix round 4/5 (1 addressed, 0 open; commits 9db8bf0..1d61ecb) — 117 tests pass, ALL 12 CORRECT.
  Implementer corrected a controller overclaim: I said all 5 new tests fail against round 3; only 2
  do. The other 3 are regression / false-alarm guards. It reported the real number rather than
  letting the inflated one stand. Worth recording as good practice, not a defect.
Task 7: fix round 5/5 dispatched — final round, scope limited to promoting the ordering invariant's
  inline 0.9 into CANARY_RULES.minOrderedRatio, which the implementer correctly flagged as the one
  threshold not reachable from the rules object, violating the project's own tunables rule. Plus a
  test asserting every threshold is a named constant, so a future inline literal fails rather than
  merely being noticed. No behaviour change. Plan re-verified: 194 passing, 0 failing.
DECISION: Task 7 closes after round 5 regardless of further findings. Rationale, recorded for the
  final whole-branch review: four adversarial passes each found something real, but the module now
  passes 5 realistic healthy payloads (mall sharing one phone, franchise with repeated names,
  4-review business, new listing with no rating, baseline fixture) while catching 12 distinct drift
  and swap scenarios. Continuing to tighten thresholds past this point trades a shrinking residual
  blind spot for a growing false-alarm risk, and an operator who learns to ignore the canary has no
  canary at all. A tool that halts on genuine Attock data is worse than one with a known gap.
  Any residual finding from the round-5 re-review will be parked here with a ruling, not looped on.
Task 7: fix round 5/5 (1 addressed, 0 open; commits 1d61ecb..cefc01b) — 118 tests pass.
  Threshold scan clean, all six thresholds read from CANARY_RULES, 12-case table byte-identical.
  Implementer caught a CONTROLLER PROCESS ERROR: I patched the plan then dispatched without running
  scripts/task-brief, so the brief it was told to re-read was stale and it worked from my message
  text instead. It flagged this rather than silently diverging. Briefs 7/8/9 regenerated; plan and
  code verified in agreement.
Task 7: complete (commits f5a1e3c..cefc01b, 5 fix rounds, closed by controller decision at the cap)
Task 7: PARKED — proximity checking is silent unless the caller supplies coordinates. The guarantee
  that it always does lives in Task 9's harvestLeg, which throws without lat/lng, but Task 9 is not
  built yet so the guarantee is plan-only today. Ruling: real but not load-bearing now, and it is a
  cross-task dependency rather than a defect in Task 7. Task 9's implementer and reviewer MUST
  verify the throw exists and that harvest.js passes the leg's coordinates through. Flagging here so
  the final whole-branch review can confirm it landed.
BASE for task 8: 058fa56629044be70b6704a1a34378041c1bae8f

## Task 8 in progress
Task 8: implemented (commit 793155a) — 131 tests pass. Controller independently verified all five
  response states classify correctly: healthy=ok, finished leg=end_of_list, records-arrived-but-none-
  extracted=extraction_failed, /sorry/ HTML at HTTP 200=blocked, 429=blocked. Both traps hold.
Task 8: first review dispatch died on a transient API error mid-sweep. It had confirmed both trap
  tests kill their mutants. Resumed to finish rather than re-dispatched, since it has the context and
  the failure was infrastructure, not the agent. Working tree verified clean afterwards.

Task 8: review complete. Spec PASS, but 3 Critical + 2 Important, all real, all in the plan text:
  C1 rawCount defaulted to 0, so a caller omitting it turned a drift back into end_of_list. One
     missing argument reintroduced the exact silent truncation the module exists to prevent.
  C2 a missing recordCount returned ok, the same failure from the other direction.
  C3 the latency baseline was the first sample and never reset. One slow opening request set it high
     permanently and nothing could breach again, silently killing the pressure signal. A zero reading
     made the next request look infinitely slower; a negative one caused an instant false breach.
  I1 classifyTransport threw a TypeError on a non-string body (a Buffer is realistic from Node HTTP).
     A guard that throws escapes the state machine it exists to enforce.
  I2 no count validation: NaN, '0', -1 and recordCount>rawCount all returned healthy.
  Ruling: both counts REQUIRED and validated with a throw, because only the caller knows whether
  records arrived, so absence is a caller bug and loud beats silent. Non-text body classifies as
  blocked. Latency baseline becomes the MEDIAN of the opening samples, broken readings are ignored,
  and an absolute ceiling stops a high baseline disabling detection.
  Controller verified 11 cases, including one that must NOT fire (6s against a 5s baseline is slow
  but not pressure; flagging it would teach the operator to ignore the warning). All 11 ok.
  Plan committed as fa06b81. Plan suite: 201 passing, 0 failing.
Task 8: fix round 1/5 dispatched. Briefs 2, 8, 9 regenerated BEFORE dispatch this time.
Task 8: minor (deferred): implementer's round-0 report misstated file length and test count
  (claimed 68 lines / 12 tests; actual 84 / 13). Corrected in the fix instructions.

Task 8: fix round 1/5 (5 addressed, 0 open; commits 793155a..347ef5c) — 138 tests pass.
  Implementer raised three concerns, all correct and all worth acting on:
  (a) MY OWN TEST DID NOT DISCRIMINATE. "one slow first request cannot permanently disable the watch"
      passed against the unfixed module too, because a single 60000 sample drove the EWMA to 21500,
      just over the old 5000*4 threshold. A test that passes before and after proves nothing.
  (b) The C3 breach fired via absoluteLatencyCeilingMs, not the relative check, because a median
      baseline computed from a warmup window that is ITSELF slow absorbs the very slowdown we want
      to detect. The ceiling was load-bearing while being documented as a backstop.
  (c) Its own round-0 report misstated file length and test count; it corrected the record unprompted.
Task 8: fix round 2/5 dispatched — baseline becomes the SECOND SMALLEST of the opening samples,
  floored at baselineFloorMs. Rationale, in order of what each alternative gets wrong: the first
  sample lets one slow request blind the watch forever; the median absorbs a slowdown that starts
  during warmup; the minimum lets one cached fast reply make ordinary latency look like a breach.
  Second smallest is robust to a single anomaly in either direction. Comment now states plainly that
  the absolute ceiling is load-bearing when warmup is contaminated, rather than calling it a backstop.
  Replaced the non-discriminating test with one proven to fail against the old behaviour: a 30000 ms
  opening sample then four 900s, then sustained 100000. Old threshold 120000 never fires; new
  threshold ~3600 does. Verified: OLD=false, NEW=true, so the test discriminates.
  Added two false-alarm guards (fast outlier then normal latency; 6s against a 5s baseline) and one
  confirming the ceiling covers a uniformly slow run. Plan suite: 203 passing, 0 failing.

Task 8: fix round 2/5 (2 addressed, 0 open; commits 347ef5c..8f38203) — 140 tests pass.
  Implementer found the sharpest process gap of the run: NONE of the round-2 tests fail against
  round-1. It MEASURED that instead of assuming, so the whole median-to-second-smallest fix was
  unlocked by any test and a regression back to the median would have passed CI green. It then
  derived the separating case itself: [900,900,4000,4000,4000] then sustained 4000 gives
  median=false, second-smallest=true, and 4000 stays under the 15000 ceiling so only the relative
  check can fire. Controller verified independently: discriminates true, ceiling uninvolved.
Task 8: fix round 3/5 dispatched — adds that one locking test and nothing else. Plan: 204 passing.
Task 8: three cosmetic deviations accepted (dropped my leftover duplicate "backstop" comment,
  normalised a blank line, destructured baselineFloorMs).

## WHAT THE ADVERSARIAL REVIEW ACTUALLY BOUGHT, for anyone resuming
Fourteen real defects across eight tasks, EVERY ONE in the plan text rather than a subagent
misreading it. Transcription was byte-perfect every time. A conventional "does this match the spec"
review would have passed all fourteen, because they all DID match the spec. The spec was wrong.
Seven would have shipped silently, producing plausible-looking wrong output rather than an error:
  - a scoring band retune would have told the operator "likely has an agency" about a business that
    had outgrown that band, with no failing test
  - a "no email" filter returned businesses whose websites were never fetched, indistinguishable
    from ones checked and found to have none
  - the tiler fired 9 queries at every radius, because spacing as a fraction of radius cancels out
  - an identical CID across records collapsed every business into one exported row
  - the payload canary ignored phone and CID, the two fields it existed to protect
  - a lat/lng swap passed both range checks, because 72 is a valid latitude
  - rawCount defaulting to 0 turned a drift back into "search complete" on one omitted argument
Three findings came from subagents correcting the CONTROLLER: a stale brief dispatched after a plan
edit, an overclaim about which tests were gap-closers, and a regression test that passed against the
broken code. Instruct reviewers to ATTACK and to test BOTH directions; instruct implementers to
MEASURE rather than accept the framing. That is what produced all of the above.

Task 8: fix round 3/5 (1 addressed, 0 open; commits 8f38203..59fddba) — 141 tests pass.
  Test passed first run with no source edits, which is the correct outcome: the code was already
  right, only the protection was missing. Load-bearing proof: median variant false, second-smallest
  true, ceiling uninvolved. A regression to the median now turns CI red.
Task 8: complete (commits 058fa56..59fddba, 3 fix rounds, review clean)

## SESSION 1 ENDED HERE — 8 of 14 tasks complete
State at handoff: branch phase-1-harvest-to-csv, 31 commits ahead of main, working tree clean,
141 tests passing, 9 source modules, 9 test files. Plan suite verifies at 204 passing.
Built and hardened: config, identity, schema, scoring-config, score, filter, tiling, payload-map,
guard. These carry essentially all of the project's logic and all of its risk.
Not started: Tasks 9-14 (source.js + google-payload.js, harvest.js leg queue, csv.js, mergeLead +
db.js, content script + background router, dashboard wiring + the live end-to-end run).
Stopped deliberately at a task boundary rather than mid-task, to keep review depth consistent.

## Session 2 (2026-07-30)
Task 9: implemented (commit d739574) — 157 tests pass. Carried-forward requirement from Task 7 landed:
  harvestLeg throws on absent or non-finite lat/lng, verified against 5 bad inputs. credentials:'omit'
  present with exactly one fetch in the file.
Task 9: review found TWO CRITICAL, both about the failures this code meets most often rather than
  exotic ones, and both sharing one root cause:
  C1 no try/catch around fetchPage. A rejected request escaped harvestLeg as an uncaught rejection
     instead of a structured result, discarding every lead already collected. Reviewer traced the SAME
     missing boundary into Task 10's unbuilt runHarvest, where one flaky request would crash a
     multi-leg run and throw away every completed leg.
  C2 the abort path was BROKEN, not just untested. signal.aborted was only checked between pages, but
     a real fetch rejects with AbortError while in flight, which is exactly what pressing Stop does.
     Same gap. The implementer had flagged this branch as untested; the reviewer showed it was worse.
  Minor: the cap counted OFFSETS not records. Paging by 20 to an offset of 247 admits 13 full pages =
     260 records. The documented cap was only honoured because Google self-truncates its last page,
     which is an assumption about someone else's server, not a guarantee.
  Ruling: every exit from the paging loop must be a RETURN, never a throw. `leads` holds work already
  paid for in network time and throttle delay; there is no failure mode where crashing beats returning
  what was collected plus a reason. Added 'network_error' to STOP_REASONS, wrapped the fetch, and
  enforced the cap on leads.length. Task 10's brief gains the matching boundary with stopReason
  'leg_threw'.
  Controller verified 7 cases: leads preserved through network error (20), mid-flight abort (20) and a
  late block (20); malformed responses classify instead of crashing; cap lands on exactly 247 not 260.
Task 9: fix round 1/5 dispatched. Briefs 9 and 10 regenerated before dispatch. Plan: 210 passing.

Task 9: fix round 1/5 (2 Critical + 1 Minor addressed, 0 open; commits d739574..d314dc1) — 162 pass.
  Implementer measured which of its 6 new tests fail against the old code: 4, not 6. The two that
  already passed were the pre-aborted-signal case (the top-of-loop check was never the bug, only its
  being the SOLE check) and the cap call count (old code made the right 13 requests, it just kept all
  260 records). Precision like that is why the fix history here is trustworthy.
Task 9: fix round 2/5 dispatched — 2 concerns, both real:
  (a) source.js's doc comment listed 5 stop reasons while the array had 6, and that comment is the
      contract Task 10 reads. Fixed by DELETING the prose list rather than patching it: a
      hand-maintained list drifts the moment a reason is added, which had already happened.
  (b) STOP_REASONS was documentation nothing validated. This is the important one. Downstream code
      decides whether to pause, resume or report purely on that string, so a typo would produce a
      reason no caller branches on, fall through every branch, and be indistinguishable from a clean
      finish. Same silent-success failure mode as the rest of this task.
  Ruling: added assertStopReason and routed all NINE returns in harvestLeg through one finish()
  helper, so a mistyped reason throws at the point of return. Added a test that scans the source for
  finish() calls and asserts every returned reason is declared, so array and code cannot separate
  again. STOP_REASONS also gained 'completed' and 'leg_threw' for Task 10.
  Verified enforcement works and behaviour is unchanged: network_error still returns 20 leads, cap
  still exactly 247. Plan: 212 passing.
GOTCHA worth knowing, reported by the implementer: `git add <gitignored path> && git commit` silently
  no-ops, because git add exits non-zero on an ignored path and && short-circuits. Report files live
  under the gitignored .superpowers/ workspace, so never chain them into a commit.

Task 9: fix round 2/5 (2 addressed, 0 open; commits d314dc1..73b94e8) — 164 tests pass.
  Implementer CORRECTED MY COUNT: I said nine returns to convert, the real number is 11, because the
  two network_error returns are multi-line so their stopReason sits on its own line. Converting only
  nine would have left two hand-built and unvalidated, i.e. exactly the hole that round was closing.
  It checked the file rather than trusting my number. Third such catch on this task.
  It also reported that only 1 of the 2 new tests discriminates (assertStopReason passes the moment
  the export exists and never touches the harvester), and that measuring had to be done in two stages
  because a missing export is a link-time SyntaxError that collapses every test in the file into one
  failure. That level of precision is why this task's fix history can be trusted.
Task 9: fix round 3/5 dispatched — three residual concerns, all real, all being fixed:
  (a) the comment claimed no exit ever throws, which stopped being true once finish() validated via
      assertStopReason. Now distinguishes a PROGRAMMING error (mistyped reason, should be loud in
      development) from an OPERATIONAL one (network fault, must come back as data). Only the second
      is caught. Comment precision has caught real problems twice on this project.
  (b) the scanner test was a regex over call sites, so a changed call shape would match nothing and
      pass VACUOUSLY over an empty list. Now also asserts zero returns build stopReason by hand,
      which is the property actually being protected rather than a proxy for it, and the count floor
      is documented as load-bearing.
  (c) finish() noted as taking a string literal at every call site, since a variable would compile
      fine and silently escape the scan.
  Plan: 212 passing, 0 failing.

CARRY FORWARD INTO TASK 10: STOP_REASONS now declares 'completed' and 'leg_threw', which only
  runHarvest returns, so nothing in Task 9 exercises them. Task 10's tests MUST cover both, and must
  verify runHarvest wraps source.harvestLeg in try/catch: without it, one leg throwing discards the
  leads from every leg already completed. The reviewer traced that exact hole into Task 10's draft.

Task 9: fix round 3/5 (3 addressed, 0 open; commits 73b94e8..d2255b4) — 164 pass.
  The bypass proof was the most valuable measurement on this task. Reverting ONE return to a
  hand-built object left 10 real finish() calls, which SATISFIES the >= 10 floor, so the floor alone
  would have passed and missed the bypass. handBuilt === 0 is the only thing that caught it. That
  turned round 3 from tidying into a necessary fix, established by testing the guard rather than
  assuming it fired.
Task 9: fix round 4/5 (1 addressed, 0 open; commits d2255b4..8e80718) — 164 pass.
  Round 3's own comment text put a literal finish('...') into the source, and the scanner cannot tell
  code from prose. It survived only because the pattern demands [a-z_]+ and dots fail that, which is
  luck rather than design. Anchored on `return finish(`; proved by poisoning a copy, where the loose
  pattern inflates 11->12 while the anchored one holds at 11.
Task 9: complete (commits 113acca..8e80718, 4 fix rounds, review clean)
Task 9: PARKED — the anchor narrows the miscount hazard rather than eliminating it: a comment
  containing the exact contiguous string `return finish('blocked')` would still be counted. Ruling:
  acceptable. handBuilt === 0 is independent of the regex, so the real protection does not rest on
  the pattern. Recorded so the final whole-branch review can weigh it.

Task 9 in summary: FOUR rounds, and in every one the implementer corrected something rather than
  accepting my framing. It flagged the abort branch as untested (the reviewer then showed it was
  BROKEN); corrected my return count from nine to eleven by reading the file, where converting nine
  would have left two unvalidated; showed only 1 of 2 new tests discriminated and why a single-stage
  measurement could not detect it; proved a guard I added was load-bearing rather than assuming; and
  caught a hazard my own comment created. Every one came from checking rather than trusting a number
  in the dispatch.

Task 10: implemented (commit f0d7d2c) — 177 pass. Carried-forward Task 9 boundary landed.
Task 10: review found 4 Critical + 4 Important, all in the plan text:
  C1 the try/catch wrapped only the CALL, not the result handling, so a malformed return escaped and
     destroyed every lead from every completed leg.
  C2 stopReason never validated, so a bogus value ran the queue and reported 'completed'.
  C3 leads as a STRING is iterable but not an array, so it was walked character by character into the
     dedupe map and reported success. Worse than a crash.
  C4 completedLegs advanced BEFORE the halt check, so a blocked leg was recorded done and every
     future resume skipped it. That slice of the market would be silently absent forever.
  I5 non-halting per-leg problems swallowed, so a run where every leg hit ECONNRESET looked clean.
  I6 onLeads got the raw list, not fresh leads, so a streaming writer would double-write.
  I7 startAt unvalidated: out of range returned 'completed' with zero leads, reading as success.
  I8 duplicate keywords produced colliding leg ids, breaking resume-by-index.
Task 10: fix round 1/5 (8 addressed; commits f0d7d2c..5c71324) — 186 pass, 9 of 22 discriminate.
Task 10: fix round 2/5 (3 addressed; commits 5c71324..eaba04d) — 186 pass, 10 of 22 discriminate.

## CONTROLLER ERROR, CORRECTED — read this before trusting the blind-test tally
In round 1 the implementer reported that the C4 test "blocks on leg 0, where completedLegs is 0
either way". I ACCEPTED THAT WITHOUT VERIFYING IT and told the user, as a headline, that I had
written a test for the project's worst defect that could not fail. That was FALSE.

The implementer then re-measured and corrected ITSELF, and I verified the correction empirically:
the old code sets `completedLegs = i + 1` unconditionally, so blocking on leg 0 records 1, while the
round-1 test asserted 0. It FAILED against the old code. It did discriminate. Reconstruction output:
  OLD code, block on leg 0 -> completedLegs = 1
  round-1 test asserted 0 -> FAILED against old code, i.e. it DID discriminate
The rewrite to block on leg 1 is still better sited (it exercises the resume path meaningfully rather
than the degenerate first-leg case) and the count moved 9 -> 10 because of the onLeads rewrite alone.

CORRECTED TALLY of genuinely blind tests found this project: THREE, not four.
  Task 8 latency test passed against the broken baseline (genuine)
  Task 9 assertStopReason test passed the moment the export existed (genuine)
  Task 10 onLeads test used identical lead sets so the old guard hid the duplicate (genuine)
  Task 10 C4 test — NOT blind. My claim, retracted.

The lesson is pointed at me, not the subagent. I spent this session insisting the highest-value habit
is measuring rather than accepting framing, then accepted a subagent's framing unverified and
broadcast it. Verify corrections too, including ones that flatter the process.

Task 10: complete (commits 8e80718..eaba04d, 2 fix rounds, review clean) — 186 tests pass.

Task 11: implemented (commit ef05113) — 199 pass.
Task 11: review found 2 Important, both in the plan text:
  - FORMULA INJECTION. Business names beginning with = + - or @ were written through unescaped, and
    Excel and Sheets execute such a cell on open. Google Maps listing names are attacker-registrable
    and this file is opened directly in a spreadsheet, so this is specific to the tool rather than
    generic hardening. Fixed with a leading apostrophe, EXEMPTING numbers so that legitimately
    negative latitude and longitude stay numeric. Getting only half of that right would be worse
    than neither.
  - UNVALIDATED ENRICHMENT VALUES. renderEnrichmentCell never type-checked, so a field holding the
    string 'yes' rendered identically to a genuine true and 'unknown' identically to a genuine null,
    silently defeating the single guarantee this module exists to provide. Each field now declares
    its permitted values and an unexpected one throws. mobileFriendly keeps its real third state.
  Also replaced naive string splitting in the tests with a real RFC4180 reader: three assertions
  failed by splitting on the delimiter or the newline, which is wrong exactly BECAUSE the escaping
  works. Each looked like an exporter bug and was a test bug.
Task 11: fix round 1/5 (2 addressed; commits ef05113..e4f2d8f) — 204 pass.
Task 11: complete (commits b2e387a..e4f2d8f, 1 fix round, review clean)

## TWO BOOKKEEPING CONVENTIONS, after the Task 11 implementer caught me on both
1. TWO TEST SUITES EXIST AND THEY WILL NEVER MATCH. The REPO suite covers only tasks built so far
   (204 at Task 11). The PLAN suite is the extracted-and-run plan code and covers ALL 14 tasks (226),
   so it is always ahead. My commit messages said "Plan re-verified: 226 passing" without saying
   which suite, and the implementer correctly flagged that 226 matched no state the repo had been in.
   Say WHICH SUITE every time.
2. PLAN-ONLY COMMITS MUST SAY SO. My commits titled like code fixes ("Neutralise spreadsheet
   formulas...") changed only the plan document; the implementer then makes the matching source
   change in a separate commit. Reading git log, mine look like the fix and they are not. From here,
   plan-only commits are titled "plan: ...". Earlier ones cannot be retitled without rewriting
   history, so this note is the record.
Also corrected: I described three test changes as discriminating; only 2 of 18 fail against ef05113.
   The round-trip test passed because the escaping was already correct, and the negative-coordinate
   test passes VACUOUSLY against unfixed code, since code with no neutralisation trivially leaves
   negatives numeric. Both are regression guards, which is legitimate, but not gap-closers.

Task 12: implemented (c614312) — 220 pass. Review found 2 Critical + 2 Important, all in plan text:
  C1 openDb cached its promise INCLUDING rejections, so one transient failure bricked storage for the
     whole session. Reviewer proved it by deleting the database entirely, removing the cause, and
     showing openDb still returned the identical stale rejected promise.
  C2 the exact silent erasure this module exists to prevent. makeLead DERIVES websiteTech from the
     website URL, so a record without one reports 'none' by construction rather than observation.
     mergeLead treated that as fresh enrichment, so a re-harvest leg carrying no website overwrote an
     already-identified platform: stored 'wordpress' became 'none'. Reachable through the documented
     makeLead -> mergeLead -> putLeads path. Fixed by merging websiteTech only when the incoming
     record actually inspected a site, i.e. under the same absent-does-not-erase rule the Maps fields
     already follow, which is where it belonged from the start.
  I1 store.put throws SYNCHRONOUSLY on a non-cloneable value, not via onerror, so one bad lead in a
     batch committed some rows, dropped the rest and returned a bare error. Now reports per-lead
     failures; every input accounted for.
  I2 getDomainCache computed age without checking the timestamp parsed. NaN comparisons are always
     false, so a corrupt stamp read as PERMANENTLY fresh. Corrupt, missing and future-dated now miss.
Task 12: fix rounds 1-2 (5 addressed; commits c614312..e662213) — 227 pass.
Task 12: complete (commits a18e78d..e662213, 2 fix rounds, review clean)
Task 12: added closeDb() as real API (the worker needs it to release the handle; an upgrade in
  another tab blocks until connections close) which also made the recovery path testable.

## THE RECURRING CONTROLLER WEAKNESS, named after the fifth instance
Subagents have now caught FIVE regression tests of mine that passed against the very code they were
written to catch: Task 8 latency, Task 9 assertStopReason, Task 10 onLeads, Task 12 storage-bricking,
plus one I wrongly claimed was blind and retracted. The common cause:
  I write the assertion that DESCRIBES the fixed behaviour, not the one that SEPARATES it from the
  broken behaviour. Those coincide only when the bug failed loudly, which is when a test mattered
  least. When the bug was silent, my test was silent too.
Counter-habit for whoever continues: after writing any fix, run the new tests against the PRE-FIX
code and confirm they fail. And isolate properly. The Task 12 implementer showed that running a test
against old code can fail for the wrong reason (a missing export rather than the defect), so revert
ONLY the behavioural line and keep any new API the test depends on.

Task 13: implemented (46077da) — 235 pass. Review found the capture mechanism COULD NOT RUN AT ALL,
  for two independent, individually fatal platform reasons. Both verified against Chromium docs and
  the chromium-extensions group before rewriting, because the claim was too consequential to accept.
  C1 capture.js opened with an `import`. Content scripts declared in the manifest are injected as
     CLASSIC scripts; there is no manifest key to mark one as a module and this project has no build
     step. Chrome throws SyntaxError at injection and NOTHING in the file runs.
  C2 it called chrome.runtime from world MAIN. MAIN is the page's own JS realm and Chrome does not
     inject extension bindings there, so chrome.runtime is undefined. sendMessage was swallowed by
     the surrounding try/catch; the onMessage listener threw uncaught.
  Together: inert while every file read correctly, and the planned Task 14 browser check would NOT
  have caught it because poking the worker console never exercises the content script. The symptom
  would have been "harvesting returns nothing", indistinguishable from an empty city.
  Fix: the standard two-world split. main-world.js observes the page's own fetch (only MAIN can see
  it) and posts a window message; bridge.js runs isolated, where chrome.runtime exists, validates
  event.source, event.origin and payload shape, and relays. Neither imports; the shared CAPTURE_PB
  literal is duplicated with a test asserting the copies cannot drift.
  Four Important also fixed: pageshow re-installs after a bfcache restore; teardown only restores a
  function still ours; the captured pb is mirrored to chrome.storage.session so MV3 worker eviction
  does not lose it; store writes are chained and drained rather than fired and forgotten.
Task 13: fix round 1/5 (2 Critical + 4 Important; commits 46077da..407102b) — 242 pass.
Task 13: complete (commits e662213..407102b, 1 fix round, review clean)

## CONTROLLER FIX PROMPTED BY TASK 13, and it is the same error class as the five blind tests
The implementer noted my Task 14 browser verification would not have caught the fault Task 13 just
fixed: it poked the WORKER console, which passes even when the content script never parsed. Both
Task 13 and Task 14 now verify from the PAGE console first (window.__mapProspectorPatched must
exist, window.fetch.name must read observedFetch) and only then ask the worker whether the value
arrived. That distinguishes "MAIN script never installed" from "installed but bridge not relaying".
A verification that cannot fail on the bug it exists to catch is the same mistake as a regression
test that passes against broken code. It was sitting in the one step that gates the live run.

Task 14: implemented Steps 1-6 and 8 (148923d). Step 7, the live harvest, deliberately NOT run by any
  agent: the operator chose to run it by hand. Checklist written to docs/FIRST-RUN.md.
Task 14: review found 5, and NOTABLY found NO XSS despite a dispatch that invited one. It traced
  every interpolated value, confirmed each was escaped, and said the assumption was wrong. Declining
  to manufacture a steered finding is worth as much as finding one.
  Medium/High: markExported ran in the same round-trip that built the CSV, BEFORE the dashboard
    received the response and triggered the download. A blocked download, cancelled save dialog or
    no-op click left those businesses flagged exported and skipped on every future sweep, silently.
    Split: export returns keys and marks nothing; the dashboard sends CONFIRM_EXPORT after the click.
  Medium: real TOCTOU on the run guard. activeRun was set after two awaits, so two fast clicks could
    both pass and start concurrent pipelines against the shared dedupe store. Slot now claimed
    synchronously before the first await, released on early failure, Start disabled for the duration.
  Low latent: esc() escaped angle brackets but not quotes. Safe today (nothing sits in a quoted
    attribute) but a live injection the day someone writes href="${esc(...)}". Hardened now.
  Low/Medium: a failed refresh left stale rows and counts under an error toast, reading as current.
  Low: Number(v) || Infinity meant a max of 0 gave no limit, since 0 is falsy.
Task 14: fix rounds 1-2 (7 addressed; commits 148923d..e5d16c4) — 242 pass.
Task 14: complete in code (commits c5a543c..e5d16c4, 2 fix rounds, review clean). Step 7 OUTSTANDING.
Task 14: ADR-006 records a deliberate trade in the export split: a page closed between click and
  confirm now means a lead is re-exported rather than silently omitted. Re-contacting a business is
  recoverable; losing it from every future sweep is not.
Task 14: PARKED — none of the five UI fixes has a test. background.js and the UI files are not
  unit-testable in this harness, so a green suite means "nothing regressed", not "the fixes work".
  FIRST-RUN.md steps 6.3 and 6.4 are the real proof and must be run.

## RESUME INSTRUCTIONS FOR A FRESH SESSION
Branch: phase-1-harvest-to-csv in ~/Sites/gmaps-lead-scraper. Never work on main.
Plan: docs/superpowers/plans/2026-07-29-phase1-harvest-to-csv.md (14 tasks; 1-7 complete)
Spec: docs/superpowers/specs/2026-07-29-gmaps-lead-scraper-design.md
Skill scripts: /Users/mc/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/
  sdd-workspace PLAN | task-brief PLAN N | review-package PLAN BASE HEAD

Process that has been working, and why:
1. Run task-brief for the task, ALWAYS regenerating after any plan edit. I forgot this once on Task 7
   and the implementer worked from a stale brief.
2. Dispatch a fresh implementer (haiku is enough when the brief carries complete code; sonnet for the
   riskiest modules). Give it the brief path, the report path, cross-task interfaces it cannot know,
   and explicit verification commands whose real output it must report.
3. Independently verify the claim yourself with a one-off node script before trusting the report.
4. review-package, then dispatch a reviewer (sonnet) told to ATTACK the module, not confirm it, and
   to test BOTH directions so tightening does not create false alarms. This is what found every
   real defect. A normal review would have missed all of them.
5. Fix rounds resume the same implementer. Patch the PLAN too, so a re-run cannot reintroduce the
   defect, then re-verify the plan by extracting its code and running it.

Verify the plan end to end at any time with:
  extract every ```js block that follows a "Create `path`:" or "Append to `path`:" line into a scratch
  dir, npm install fake-indexeddb there, generate the 8-record fixture from the Task 7 brief script,
  then npm test. Currently 194 passing, 0 failing.

Remaining: Task 8 review in flight; Tasks 9-14 are the payload harvester, the leg queue, CSV export,
storage, the content script plus background router, and the live end-to-end run against real Google
Maps. Task 14 Step 7 is the only step that proves any of this works outside a fixture.

CARRY FORWARD INTO TASK 9: harvestLeg MUST throw when lat/lng are absent, and harvest.js MUST pass
the leg's coordinates through. That throw is the only thing guaranteeing the canary's proximity check
runs, which is the only thing that catches a lat/lng swap. Parked from Task 7; verify it lands.
BASE for task 10: 8e80718a7a0f021a23ad7d674b070bbe0f6ab733
BASE for task 11: b2e387a93f028cc913f8f84a30210dccc82f3eed
BASE for task 12: a18e78d877a16f4691261cd4dd0eb197014658b7
BASE for task 13: e66221371e41da6e17eaaec1f5989ce983699dd1
BASE for task 14: c5a543c39f978acae436c18b37328d45603d7f77
