import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, makeRequest, makeResponse, isResponse } from '../src/core/messages.js';

test('every message type is a unique namespaced string', () => {
  const values = Object.values(MSG);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.match(v, /^mapprospector\//);
});

test('the message set covers the phase 1 surface', () => {
  for (const key of ['CAPTURE_PB', 'START_RUN', 'ABORT_RUN', 'GET_LEADS', 'EXPORT', 'RUN_PROGRESS']) {
    assert.ok(key in MSG, `missing message type: ${key}`);
  }
});

test('makeRequest stamps the type and carries the payload', () => {
  const r = makeRequest(MSG.START_RUN, { keywords: ['dentist'] });
  assert.equal(r.type, MSG.START_RUN);
  assert.deepEqual(r.payload.keywords, ['dentist']);
});

test('makeRequest rejects an unknown type rather than sending a silent no-op', () => {
  assert.throws(() => makeRequest('not-a-real-type', {}), /unknown message type/i);
});

test('makeResponse carries success data', () => {
  const r = makeResponse(true, { leads: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.leads, []);
  assert.equal(r.error, null);
});

test('makeResponse carries an error string on failure', () => {
  const r = makeResponse(false, null, 'pb capture timed out');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pb capture timed out');
});

test('makeResponse refuses a failure with no error message', () => {
  assert.throws(() => makeResponse(false, null, null), /error message/i);
});

test('isResponse distinguishes a response from a request', () => {
  assert.equal(isResponse(makeResponse(true, {})), true);
  assert.equal(isResponse(makeRequest(MSG.GET_LEADS, {})), false);
});
