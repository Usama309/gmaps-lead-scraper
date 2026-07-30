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
  const page = classifyPage({ transport, recordCount: 0 });
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
  assert.equal(classifyPage({ transport, recordCount: 0 }).state, 'blocked');
  assert.equal(classifyPage({ transport, recordCount: 20 }).state, 'blocked');
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
