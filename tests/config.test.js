import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/core/config.js';

test('harvest caps match the measured Google limits', () => {
  assert.equal(CONFIG.harvest.pageSize, 20);
  assert.equal(CONFIG.harvest.perQueryCap, 247);
});

test('throttle delay is a sane randomised range', () => {
  assert.ok(CONFIG.harvest.delayMs.min >= 800, 'too aggressive');
  assert.ok(CONFIG.harvest.delayMs.max > CONFIG.harvest.delayMs.min);
});

test('harvest is serial by default', () => {
  assert.equal(CONFIG.harvest.maxParallel, 1);
});

test('the tiling threshold is absolute so the single-tile path can actually fire', () => {
  assert.ok(CONFIG.tiling.minRadiusForTilingKm > 0);
});

test('guard knows the valid payload prefix', () => {
  assert.equal(CONFIG.guard.validPrefix, ")]}'");
});

test('config is frozen so nothing can mutate a tunable at runtime', () => {
  assert.throws(() => { CONFIG.harvest.pageSize = 99; });
});
