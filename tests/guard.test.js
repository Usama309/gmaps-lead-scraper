import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransport, classifyPage, nextDelayMs, createLatencyWatch } from '../src/pipeline/guard.js';
import { CONFIG } from '../src/core/config.js';

const VALID = CONFIG.guard.validPrefix + '\n[[1,2,3]]';

test('a 200 with the valid prefix is ok', () => {
  assert.equal(classifyTransport({ status: 200, body: VALID }).state, 'ok');
});

test('a missing prefix means a sorry interstitial, not an empty result', () => {
  const t = classifyTransport({ status: 200, body: '<!DOCTYPE html><html>sorry' });
  assert.equal(t.state, 'blocked');
  assert.match(t.reason, /prefix/i);
});

test('every blocked status is treated as blocked', () => {
  for (const status of CONFIG.guard.blockedStatuses) {
    assert.equal(classifyTransport({ status, body: VALID }).state, 'blocked', `status ${status}`);
  }
});

test('any non-200 status is blocked, including ones not enumerated', () => {
  assert.equal(classifyTransport({ status: 418, body: VALID }).state, 'blocked');
});

test('an empty body is blocked', () => {
  assert.equal(classifyTransport({ status: 200, body: '' }).state, 'blocked');
});

test('THE TRAP: a valid response with zero records is end_of_list, never blocked', () => {
  const transport = classifyTransport({ status: 200, body: VALID });
  const page = classifyPage({ transport, recordCount: 0, rawCount: 0 });
  assert.equal(page.state, 'end_of_list');
  assert.match(page.reason, /end of/i);
});

test('a valid response with records is ok', () => {
  const transport = classifyTransport({ status: 200, body: VALID });
  assert.equal(classifyPage({ transport, recordCount: 20, rawCount: 20 }).state, 'ok');
});

test('THE OTHER TRAP: records that arrived but all failed extraction is drift, not end of list', () => {
  const transport = classifyTransport({ status: 200, body: VALID });
  const page = classifyPage({ transport, recordCount: 0, rawCount: 20 });
  assert.equal(page.state, 'extraction_failed');
  assert.match(page.reason, /drift/i);
});

test('a blocked transport stays blocked regardless of record count', () => {
  const transport = classifyTransport({ status: 429, body: '' });
  assert.equal(classifyPage({ transport, recordCount: 0, rawCount: 0 }).state, 'blocked');
  assert.equal(classifyPage({ transport, recordCount: 20, rawCount: 20 }).state, 'blocked');
});

test('CRITICAL: classifyPage refuses to guess a missing rawCount', () => {
  // rawCount used to default to 0, so a caller forgetting it turned a drift back
  // into end_of_list: the exact silent truncation this module prevents, brought
  // back by one omitted argument. Absence is a caller bug and must be loud.
  const transport = classifyTransport({ status: 200, body: VALID });
  assert.throws(() => classifyPage({ transport, recordCount: 0 }), /rawCount/);
  assert.throws(() => classifyPage({ transport, rawCount: 20 }), /recordCount/);
});

test('classifyPage rejects malformed counts instead of reporting healthy', () => {
  const transport = classifyTransport({ status: 200, body: VALID });
  for (const bad of [NaN, -1, 1.5, '0', null, undefined]) {
    assert.throws(() => classifyPage({ transport, recordCount: bad, rawCount: 20 }),
      /recordCount/, `recordCount ${JSON.stringify(bad)} should be rejected`);
    assert.throws(() => classifyPage({ transport, recordCount: 0, rawCount: bad }),
      /rawCount/, `rawCount ${JSON.stringify(bad)} should be rejected`);
  }
});

test('classifyPage rejects an impossible recordCount above rawCount', () => {
  // Extraction can only ever lose records, never invent them, so this is a
  // caller bug worth surfacing rather than absorbing.
  const transport = classifyTransport({ status: 200, body: VALID });
  assert.throws(() => classifyPage({ transport, recordCount: 25, rawCount: 20 }), /cannot happen/);
});

test('a non-text body classifies as blocked instead of throwing', () => {
  // A Buffer is realistic from a Node HTTP path. A guard that throws escapes the
  // state machine it exists to enforce, leaving the caller with no state to act on.
  for (const body of [200, {}, [], true, Buffer.from(VALID)]) {
    const t = classifyTransport({ status: 200, body });
    assert.equal(t.state, 'blocked', `body ${typeof body} should classify, not throw`);
    assert.match(t.reason, /not text/);
  }
});

test('CRITICAL: one slow first request cannot permanently disable the latency watch', () => {
  // Deliberately chosen so the OLD behaviour cannot pass. With the baseline set
  // from the first sample, the threshold would be 30000 x 4 = 120000, which a
  // sustained 100000 never reaches, so the watch stayed silent forever. Taking
  // the second smallest of the opening samples puts the baseline near 900, where
  // a sustained 100000 breaches on the relative check alone.
  const watch = createLatencyWatch();
  watch.observe(30000);
  for (let i = 0; i < 4; i += 1) watch.observe(900);
  let breached = false;
  for (let i = 0; i < 10 && !breached; i += 1) breached = watch.observe(100000);
  assert.equal(breached, true, 'a slow opening sample must not blind the watch');
});

test('one anomalously fast response does not drag the baseline down', () => {
  // The mirror risk of using the minimum: a cached 50 ms reply would make
  // ordinary latency look like a breach and train the operator to ignore it.
  const watch = createLatencyWatch();
  let breached = false;
  for (const ms of [50, 900, 950, 1000, 980, 1000, 950, 900]) {
    breached = watch.observe(ms) || breached;
  }
  assert.equal(breached, false, 'normal latency after one fast outlier is not pressure');
});

test('a slowdown beginning during warmup breaches on the relative check alone', () => {
  // THE TEST THAT LOCKS THE BASELINE CHOICE. Every other latency test passes with
  // either a median or a second-smallest baseline, which meant the choice between
  // them was unprotected and a regression to the median would have gone green.
  //
  // Two fast samples then a sustained 4000 ms. A median baseline lands on 4000 and
  // sees nothing wrong; the second smallest lands on 900 and breaches. Deliberately
  // kept under absoluteLatencyCeilingMs so the ceiling cannot mask the difference,
  // which is what makes this case separating rather than merely slow.
  const watch = createLatencyWatch();
  let breached = false;
  for (const ms of [900, 900, 4000, 4000, 4000, 4000, 4000, 4000]) {
    breached = watch.observe(ms) || breached;
  }
  assert.ok(4000 < CONFIG.guard.absoluteLatencyCeilingMs,
    'this case only separates while it stays under the ceiling');
  assert.equal(breached, true,
    'a slowdown starting during warmup must still register as pressure');
});

test('the absolute ceiling covers a slowdown that begins during warmup', () => {
  // When the warmup window is itself contaminated, no relative comparison can
  // help, so the ceiling is the only thing that can fire. Documenting that it is
  // load-bearing rather than a backstop.
  const watch = createLatencyWatch();
  let breached = false;
  for (let i = 0; i < 10 && !breached; i += 1) breached = watch.observe(60000);
  assert.equal(breached, true, 'a uniformly slow run must still breach');
});

test('the latency watch ignores broken measurements rather than absorbing them', () => {
  // A zero made the next request look infinitely slower; a negative produced an
  // instant false breach.
  const zeroFirst = createLatencyWatch();
  assert.equal(zeroFirst.observe(0), false);
  assert.equal(zeroFirst.observe(900), false, 'a zero must not become the baseline');

  const negativeFirst = createLatencyWatch();
  assert.equal(negativeFirst.observe(-500), false);
  assert.equal(negativeFirst.observe(900), false, 'a negative must not trigger a breach');

  const nan = createLatencyWatch();
  assert.equal(nan.observe(NaN), false);
});

test('a modestly slower baseline is not treated as pressure', () => {
  // 6 seconds against a 5 second baseline is slow but not a signal. Flagging it
  // would teach the operator to ignore the warning.
  const watch = createLatencyWatch();
  let breached = false;
  for (let i = 0; i < 20; i += 1) breached = watch.observe(i === 0 ? 5000 : 6000) || breached;
  assert.equal(breached, false);
});

test('nextDelayMs stays inside the configured range', () => {
  assert.equal(nextDelayMs(() => 0), CONFIG.harvest.delayMs.min);
  assert.equal(nextDelayMs(() => 0.999999), Math.round(CONFIG.harvest.delayMs.max));
  for (let i = 0; i < 200; i += 1) {
    const d = nextDelayMs();
    assert.ok(d >= CONFIG.harvest.delayMs.min && d <= CONFIG.harvest.delayMs.max, `out of range: ${d}`);
  }
});

test('nextDelayMs is actually randomised, not a constant', () => {
  const values = new Set(Array.from({ length: 50 }, () => nextDelayMs()));
  assert.ok(values.size > 5, 'delay is not varying');
});

test('latency watch tolerates normal drift', () => {
  const watch = createLatencyWatch();
  assert.equal(watch.observe(900), false);
  assert.equal(watch.observe(1100), false);
  assert.equal(watch.observe(1300), false);
});

test('latency watch breaches when responses slow down dramatically', () => {
  const watch = createLatencyWatch();
  watch.observe(900);
  let breached = false;
  for (let i = 0; i < 12 && !breached; i += 1) breached = watch.observe(20000);
  assert.equal(breached, true, 'a sustained 20x slowdown must breach');
});
