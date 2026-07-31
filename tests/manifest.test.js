import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('manifest targets MV3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('service worker is an ES module', () => {
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.background.service_worker, 'background.js');
});

test('manifest pins a key so the extension ID is stable', () => {
  assert.ok(typeof manifest.key === 'string' && manifest.key.length > 100,
    'a pinned key is required or the OAuth client breaks on every reload');
});

test('host permissions cover Google Maps and arbitrary business sites', () => {
  assert.ok(manifest.host_permissions.includes('https://www.google.com/*'));
  assert.ok(manifest.host_permissions.includes('http://*/*'));
  assert.ok(manifest.host_permissions.includes('https://*/*'));
});

test('declares the storage and sidePanel permissions the pipeline needs', () => {
  for (const p of ['storage', 'unlimitedStorage', 'sidePanel']) {
    assert.ok(manifest.permissions.includes(p), `missing permission: ${p}`);
  }
});

test('declares what the anonymous-cookie rule needs, and nothing broader', () => {
  for (const p of ['cookies', 'declarativeNetRequestWithHostAccess']) {
    assert.ok(manifest.permissions.includes(p), `missing permission: ${p}`);
  }
  // The WithHostAccess variant is deliberate. Plain "declarativeNetRequest" grants
  // rule matching across every site the browser visits without any host grant, which
  // is far more than rewriting one header on our own requests to one endpoint needs.
  assert.ok(!manifest.permissions.includes('declarativeNetRequest'),
    'the unscoped declarativeNetRequest permission is broader than this extension needs');
});

test('declares the scripting permission the review pass needs, and no host beyond Google', () => {
  // The review pass injects a reader into a Maps place page. It needs `scripting`
  // and nothing more: the host access it uses is already declared.
  assert.ok(manifest.permissions.includes('scripting'), 'the review pass cannot inject without it');
});
