# Phase 1 Build Journal

Copied out of the git-ignored subagent workspace so it survives a `git clean`. This is the
decision record for how Phase 1 was built: every review finding, the ruling on it, and the
reasoning behind that ruling. Read the two sections at the end first if you are picking this
work up cold.

The single most useful thing in here: fourteen real defects were found across eight tasks, and
every one of them was in the PLAN, not in a subagent misreading it. Transcription was
byte-perfect every time. A conventional spec-compliance review would have passed all fourteen,
because they all did match the spec. The spec was wrong. Instruct reviewers to attack the code
rather than confirm it, and instruct implementers to measure rather than accept your framing.

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
