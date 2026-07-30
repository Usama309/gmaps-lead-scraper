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
