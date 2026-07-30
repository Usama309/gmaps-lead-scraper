import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('CRITICAL: the content scripts contain no import statement', () => {
  // Content scripts declared in the manifest are injected as CLASSIC scripts.
  // There is no manifest key to mark one as a module and this project has no
  // build step, so a single import statement makes Chrome throw a SyntaxError at
  // injection and NOTHING in the file runs. The failure is a page-console error
  // nobody is watching, and harvesting then looks exactly like an empty city.
  for (const file of ['../src/content/main-world.js', '../src/content/bridge.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, `${file} cannot use import`);
    assert.doesNotMatch(source, /^\s*export\s/m, `${file} cannot use export`);
  }
});

test('CRITICAL: only the isolated-world half touches chrome.*', () => {
  // world MAIN is the page's own realm and Chrome does not inject extension
  // bindings there, so chrome.runtime is undefined. A sendMessage from the MAIN
  // script throws and the capture never reaches the worker, while everything
  // still looks correct.
  const mainWorld = readFileSync(new URL('../src/content/main-world.js', import.meta.url), 'utf8');
  const bridge = readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');

  // Matches an actual CALL, not prose. The file's own comments explain why
  // chrome.* is unavailable, so a bare string check flags its own documentation.
  assert.doesNotMatch(mainWorld, /chrome\.[\w.]*\(/, 'the MAIN world script cannot call chrome APIs');
  assert.match(mainWorld, /window\.postMessage/, 'its only route out is a window message');
  assert.match(bridge, /chrome\.runtime\.sendMessage/, 'the bridge relays to the worker');
});

test('the duplicated message type matches the real one, since neither file can import', () => {
  // Both content scripts hardcode CAPTURE_PB because a classic script cannot
  // import messages.js. This is the guard that stops the copies drifting.
  for (const file of ['../src/content/main-world.js', '../src/content/bridge.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const match = source.match(/const CAPTURE_PB = '([^']+)'/);
    assert.ok(match, `${file} must declare CAPTURE_PB`);
    assert.equal(match[1], MSG.CAPTURE_PB, `${file} has drifted from messages.js`);
  }
});

test('the bridge validates the sender before relaying a page message', () => {
  // The page shares this window and can post messages too. A forged pb would not
  // leak anything, but it would point the harvester somewhere unasked.
  const bridge = readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /event\.source !== window/, 'must reject messages from other frames');
  assert.match(bridge, /event\.origin !== location\.origin/, 'must reject cross-origin messages');
  assert.match(bridge, /typeof data\.pb !== 'string'/, 'must validate the payload shape');
});

test('the MAIN world script survives a bfcache restore', () => {
  // bfcache fires pagehide on suspend and pageshow on restore. Tearing down
  // without re-installing leaves a restored tab silently unable to capture.
  const source = readFileSync(new URL('../src/content/main-world.js', import.meta.url), 'utf8');
  assert.match(source, /addEventListener\('pageshow', installObservers\)/);
  assert.doesNotMatch(source, /pagehide[^)]*once:\s*true/, 'teardown must not be once-only');
});

test('teardown only restores functions that are still ours', () => {
  // If the page re-wrapped fetch after us, restoring the native function blindly
  // would discard the page's own patch.
  const source = readFileSync(new URL('../src/content/main-world.js', import.meta.url), 'utf8');
  assert.match(source, /window\.fetch === saved\.observedFetch/);
});

test('the manifest registers both worlds, and only the MAIN one declares world', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const scripts = manifest.content_scripts;
  assert.equal(scripts.length, 2, 'both halves of the bridge must be registered');

  const main = scripts.find((s) => s.world === 'MAIN');
  const isolated = scripts.find((s) => s.world === undefined);
  assert.ok(main, 'one script must run in the MAIN world to see the page fetch');
  assert.ok(isolated, 'one must run in the isolated world to reach chrome.runtime');
  assert.deepEqual(main.js, ['src/content/main-world.js']);
  assert.deepEqual(isolated.js, ['src/content/bridge.js']);
  for (const script of scripts) {
    assert.equal(script.run_at, 'document_start', 'both must run before the page fetches');
    assert.deepEqual(script.matches, ['https://www.google.com/maps/*']);
  }
});

test('isResponse distinguishes a response from a request', () => {
  assert.equal(isResponse(makeResponse(true, {})), true);
  assert.equal(isResponse(makeRequest(MSG.GET_LEADS, {})), false);
});
