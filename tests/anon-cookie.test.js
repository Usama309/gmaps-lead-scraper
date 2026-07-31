import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCookieHeader,
  buildRule,
  markerParam,
  installAnonCookieRule,
  removeAnonCookieRule,
  ACCOUNT_COOKIE_NAMES,
} from '../src/sources/anon-cookie.js';
import { buildSearchUrl } from '../src/sources/google-payload.js';
import { CONFIG } from '../src/core/config.js';

const NID = { name: 'NID', value: '533=abc123' };

function fakeChrome({ jar = [NID], failGetAll = false, failUpdate = false } = {}) {
  const calls = [];
  return {
    calls,
    cookies: {
      getAll: async () => {
        if (failGetAll) throw new Error('cookies unavailable');
        return jar;
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async (arg) => {
        if (failUpdate) throw new Error('rule rejected');
        calls.push(arg);
      },
    },
  };
}

test('the header carries the allowlisted cookie', () => {
  assert.equal(buildCookieHeader([NID]), 'NID=533=abc123');
});

test('an account cookie is never written, even when it is the only thing present', () => {
  for (const name of ACCOUNT_COOKIE_NAMES) {
    const header = buildCookieHeader([{ name, value: 'secret' }]);
    assert.equal(header, null, `${name} must not produce a header`);
  }
});

test('an account cookie sitting beside the allowlisted one is dropped', () => {
  const jar = [
    { name: 'SID', value: 'account-secret' },
    NID,
    { name: '__Secure-3PSID', value: 'another-secret' },
  ];
  const header = buildCookieHeader(jar);
  assert.equal(header, 'NID=533=abc123');
  assert.doesNotMatch(header, /secret/);
});

test('a cookie nobody listed anywhere is still not sent', () => {
  // This is the test that distinguishes an allowlist from a denylist, and the only
  // one that does. Every other case here uses a name that appears in
  // ACCOUNT_COOKIE_NAMES, so a denylist implementation passes all of them. The
  // whole reason for an allowlist is the cookie Google ships next year that no
  // denylist mentions, so that is what this asserts.
  const jar = [
    NID,
    { name: '__Secure-STRP', value: 'unknown-but-real' },
    { name: '__Secure-9PSID', value: 'a-future-account-cookie' },
    { name: 'SEARCH_SAMESITE', value: 'whatever' },
  ];
  assert.equal(buildCookieHeader(jar), 'NID=533=abc123');
});

test('a value that could smuggle a second cookie is rejected outright', () => {
  const smuggler = { name: 'NID', value: '533=abc; SID=stolen-account-cookie' };
  assert.equal(buildCookieHeader([smuggler]), null);
});

test('values with whitespace, quotes, commas or backslashes are rejected', () => {
  for (const value of ['a b', 'a"b', 'a,b', 'a\\b', 'a\nb']) {
    assert.equal(buildCookieHeader([{ name: 'NID', value }]), null, `value ${JSON.stringify(value)}`);
  }
});

test('an empty or missing jar yields null rather than an empty header', () => {
  assert.equal(buildCookieHeader([]), null);
  assert.equal(buildCookieHeader(null), null);
  assert.equal(buildCookieHeader([{ name: 'NID', value: '' }]), null);
});

test('the rule sets the header rather than appending to it', () => {
  const rule = buildRule('NID=x');
  assert.equal(rule.action.requestHeaders[0].operation, 'set');
  assert.equal(rule.action.requestHeaders[0].header, 'cookie');
});

test('the rule only matches requests that come from no tab', () => {
  // Without this the rule also rewrites Google Maps' own requests in the operator's
  // tab, stripping their real session out of the page they are looking at.
  assert.deepEqual(buildRule('NID=x').condition.tabIds, [-1]);
});

test('the rule is scoped to the Google search endpoint and to our own marker', () => {
  // Asserted against literals on purpose. Comparing the rule back to the same config
  // value it was built from is a tautology: it passed even when the filter was
  // changed to an unrelated attacker-controlled host, which is the one thing that
  // bounds where the cookie can travel.
  const filter = buildRule('NID=x').condition.urlFilter;
  assert.match(filter, /^\|\|www\.google\.com\/search\?/, `rule must target Google search, got ${filter}`);
  assert.match(filter, /mpsrc=1/, 'rule must require our own request marker');
});

test('the URL the harvester actually builds carries the marker', () => {
  // The end-to-end gap. The previous version of this test compared buildRule()
  // against markerParam(), both read from the same config object, so deleting the
  // one line in google-payload.js that writes the marker left all 287 tests green
  // while the cookie silently stopped travelling and every run died blaming Google
  // for payload drift. This asserts the REQUEST, which is the thing that can drift.
  const url = buildSearchUrl({ query: 'dentist', pb: '!1sdentist' });
  const { name, value } = markerParam();
  assert.equal(url.searchParams.get(name), value,
    'the request must carry the marker the cookie rule matches on');
});

test('the DNR rule pattern matches the URL the harvester builds', () => {
  // Chrome's urlFilter grammar treats only *, |, || and ^ as constructs; ? is a
  // literal. Translating the pattern faithfully is the only way to check the two
  // halves agree without a browser.
  const url = buildSearchUrl({ query: 'dentist in Attock', pb: '!1sx!8i0' });
  const filter = buildRule('NID=x').condition.urlFilter;

  assert.ok(filter.startsWith('||'), 'expected a host-anchored pattern');
  const [literalPrefix, ...rest] = filter.slice(2).split('*');
  assert.ok(url.href.includes(literalPrefix),
    `pattern prefix ${literalPrefix} is absent from ${url.href}`);
  let cursor = url.href.indexOf(literalPrefix) + literalPrefix.length;
  for (const chunk of rest) {
    const found = url.href.indexOf(chunk, cursor);
    assert.notEqual(found, -1, `pattern chunk ${chunk} is absent from ${url.href}`);
    cursor = found + chunk.length;
  }
});

test('the endpoint has one source of truth, shared by the request and the rule', () => {
  // Two separate literals decided whether the cookie travelled. Changing either
  // silently made the rule match nothing.
  const url = buildSearchUrl({ query: 'x', pb: 'y' });
  const filter = buildRule('NID=x').condition.urlFilter;
  assert.ok(filter.includes(new URL(CONFIG.googleSearchUrl).host));
  assert.equal(url.origin + url.pathname, CONFIG.googleSearchUrl);
});

test('a request without our marker does not match the rule', () => {
  const filter = buildRule('NID=x').condition.urlFilter;
  const pattern = filter.replace('||', 'https://').replace(/\?\*/, '\\?.*');
  assert.ok(!new RegExp(pattern).test('https://www.google.com/search?tbm=map&q=x'),
    'a Google search request built by anyone else must not match');
});

test('installing writes a session rule, never a dynamic one', async () => {
  const chrome = fakeChrome();
  const result = await installAnonCookieRule(chrome);
  assert.equal(result.installed, true);
  assert.equal(chrome.calls.length, 1);
  assert.deepEqual(chrome.calls[0].removeRuleIds, [CONFIG.anonCookie.ruleId]);
  assert.equal(chrome.calls[0].addRules[0].action.requestHeaders[0].value, 'NID=533=abc123');
});

test('with no anonymous cookie available, no rule is installed at all', async () => {
  // The failure mode this forbids: falling back to sending whatever is in the jar.
  const chrome = fakeChrome({ jar: [{ name: 'SID', value: 'account' }] });
  const result = await installAnonCookieRule(chrome);
  assert.equal(result.installed, false);
  assert.equal(chrome.calls.length, 0);
  assert.match(result.reason, /NID/);
});

test('a failure reading cookies degrades to no rule, and does not throw', async () => {
  const chrome = fakeChrome({ failGetAll: true });
  const result = await installAnonCookieRule(chrome);
  assert.equal(result.installed, false);
  assert.equal(chrome.calls.length, 0);
});

test('a failure writing the rule reports it rather than throwing', async () => {
  const chrome = fakeChrome({ failUpdate: true });
  const result = await installAnonCookieRule(chrome);
  assert.equal(result.installed, false);
  assert.match(result.reason, /rule rejected/);
});

test('removing clears the rule id and does not throw when it cannot', async () => {
  const chrome = fakeChrome();
  assert.equal((await removeAnonCookieRule(chrome)).removed, true);
  assert.deepEqual(chrome.calls[0].removeRuleIds, [CONFIG.anonCookie.ruleId]);

  const broken = fakeChrome({ failUpdate: true });
  assert.equal((await removeAnonCookieRule(broken)).removed, false);
});

test('the allowlist itself contains no account cookie', () => {
  for (const name of CONFIG.anonCookie.allow) {
    assert.ok(!ACCOUNT_COOKIE_NAMES.includes(name), `${name} is an account cookie and must not be allowlisted`);
  }
});
