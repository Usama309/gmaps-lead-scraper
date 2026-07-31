import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabDriver, STEPS } from '../src/pipeline/tab-driver.js';
import { REVIEW_SELECTORS } from '../src/sources/google-dom.js';

function fakeBrowser({ results = [] } = {}) {
  const calls = [];
  let next = 0;
  return {
    calls,
    tabs: {
      create: async (args) => { calls.push({ create: args }); return { id: 7 }; },
      update: async (id, args) => { calls.push({ update: id, url: args.url }); },
      remove: async (id) => { calls.push({ remove: id }); },
    },
    scripting: {
      executeScript: async (args) => {
        calls.push({ exec: args.files ? `file:${args.files[0]}` : 'func', args: args.args });
        return [{ result: results[next++] ?? { blocked: false, hasReviewsUi: true, rows: [] } }];
      },
    },
  };
}

const driver = (b) => createTabDriver({ tabs: b.tabs, scripting: b.scripting, sleep: async () => {} });

test('one tab is created and reused across leads, not one per lead', async () => {
  // A two-hour pass opening a tab per lead would leave the operator's browser full of
  // them, on top of paying a create and destroy for every 13-second read.
  const b = fakeBrowser({ results: [
    { blocked: false, hasReviewsUi: true, rows: [{ date: '3 days ago', hasReply: false }] },
    { blocked: false, hasReviewsUi: true, rows: [{ date: '3 days ago', hasReply: false }] },
  ] });
  const d = driver(b);
  await d.open('https://example.test/a');
  await d.open('https://example.test/b');
  assert.equal(b.calls.filter((c) => c.create).length, 1);
  assert.equal(b.calls.filter((c) => c.update).length, 2);
});

test('the tab opens in the background, so a long pass does not steal focus', async () => {
  const b = fakeBrowser();
  await driver(b).open('https://example.test/a');
  assert.equal(b.calls.find((c) => c.create).create.active, false);
});

test('an interstitial is reported as blocked, not read as an empty panel', async () => {
  const b = fakeBrowser({ results: [{ blocked: true, hasReviewsUi: false, rows: [] }] });
  const out = await driver(b).open('https://example.test/a');
  assert.equal(out.blocked, true);
});

test('reading a page whose reviews did not render THROWS, so the pass can halt', async () => {
  const b = fakeBrowser({ results: [
    { blocked: false, hasReviewsUi: true, rows: [] },   // open probe
    { blocked: false, hasReviewsUi: true, rows: [] },   // read
  ] });
  const d = driver(b);
  await d.open('https://example.test/a');
  await assert.rejects(() => d.read(), /markup has changed/i);
});

test('a real read is interpreted, not handed back raw', async () => {
  const rows = [{ date: 'a year ago', hasReply: true }, { date: '3 days ago', hasReply: false }];
  const b = fakeBrowser({ results: [
    { blocked: false, hasReviewsUi: true, rows },
    { blocked: false, hasReviewsUi: true, rows },
  ] });
  const d = driver(b);
  await d.open('https://example.test/a');
  const panel = await d.read();
  assert.equal(panel.lastReviewDays, 3);
  assert.equal(panel.ownerReplies, true);
  assert.equal(panel.reviewsSeen, 2);
});

test('steps are named semantically, and the sort control is the shared selector', () => {
  // review-pass.js asks for 'sortNewest' and does not know what a sort menu looks
  // like. Selectors live in google-dom.js and the injected reader, nowhere else.
  assert.equal(STEPS.sortMenu.selector, REVIEW_SELECTORS.sortControl);
  assert.match(STEPS.sortNewest.pattern, /Newest/);
  assert.equal(STEPS.reviewsTab.role, 'tab');
});

test('an unknown step throws rather than silently doing nothing', async () => {
  const b = fakeBrowser();
  const d = driver(b);
  await d.open('https://example.test/a');
  await assert.rejects(() => d.click('sortOldest'), /unknown review pass step/i);
});

test('close removes the tab and forgets it', async () => {
  const b = fakeBrowser();
  const d = driver(b);
  await d.open('https://example.test/a');
  await d.close();
  assert.ok(b.calls.some((c) => c.remove === 7));
  await d.open('https://example.test/b');
  assert.equal(b.calls.filter((c) => c.create).length, 2, 'a new tab is made after close');
});
