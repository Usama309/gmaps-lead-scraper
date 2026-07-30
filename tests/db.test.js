import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeLead } from '../src/core/schema.js';
import {
  openDb, closeDb,
  putLeads, getAllLeads, clearLeads,
  getExportedKeys, markExported,
  putDomainCache, getDomainCache,
  saveRun, loadRun, listRuns,
} from '../src/store/db.js';

let n = 0;
function lead(overrides = {}) {
  n += 1;
  return makeLead({ cid: `0xaa${n}:0xbb${n}`, name: `Business ${n}`, phone: '+92 300 000 0000', ...overrides });
}

beforeEach(async () => { await clearLeads(); });

test('closeDb releases the handle so a later call reopens', async () => {
  const first = await openDb();
  await closeDb();
  const second = await openDb();
  assert.notEqual(first, second, 'a closed handle must not be handed out again');
});

test('putLeads inserts new leads and reports the count', async () => {
  const result = await putLeads([lead(), lead()]);
  assert.equal(result.inserted, 2);
  assert.equal(result.merged, 0);
  assert.equal((await getAllLeads()).length, 2);
});

test('putLeads merges on re-put instead of duplicating', async () => {
  const a = lead({ rating: 4.3, reviewCount: 87 });
  await putLeads([a]);

  const enriched = makeLead({
    cid: a.cid, name: a.name, website: 'https://x.wixsite.com',
    enriched: true, websiteTech: 'wix', mobileFriendly: false,
  });
  const result = await putLeads([enriched]);

  assert.equal(result.inserted, 0);
  assert.equal(result.merged, 1, 'the same business must not create a second row');

  const stored = await getAllLeads();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].websiteTech, 'wix', 'enrichment must land');
  assert.equal(stored[0].rating, 4.3, 'an incoming null must not erase the stored rating');
});

test('markExported and getExportedKeys round trip, powering cross-run dedupe', async () => {
  const a = lead(); const b = lead();
  await putLeads([a, b]);
  await markExported([a.key], 'run-1');

  const exported = await getExportedKeys();
  assert.ok(exported instanceof Set);
  assert.ok(exported.has(a.key));
  assert.ok(!exported.has(b.key));
});

test('exported keys survive a leads wipe, because they track history not state', async () => {
  const a = lead();
  await putLeads([a]);
  await markExported([a.key]);
  await clearLeads();
  assert.ok((await getExportedKeys()).has(a.key));
});

test('domain cache returns stored data on a hit', async () => {
  await putDomainCache('alshifa.pk', { tech: 'wordpress', mobileFriendly: false });
  assert.deepEqual(await getDomainCache('alshifa.pk'), { tech: 'wordpress', mobileFriendly: false });
});

test('domain cache returns null on a miss', async () => {
  assert.equal(await getDomainCache('never-fetched.pk'), null);
});

test('domain cache expires an entry past its TTL', async () => {
  // Write a deliberately stale record straight through putDomainCache, then age it
  // by rewriting cachedAt. Uses the real TTL from config rather than a literal.
  const { CONFIG } = await import('../src/core/config.js');
  await putDomainCache('stale.pk', { tech: 'wix' });

  const db = await (await import('../src/store/db.js')).openDb();
  const store = db.transaction('domainCache', 'readwrite').objectStore('domainCache');
  const ancient = new Date(Date.now() - (CONFIG.enrich.domainCacheTtlDays + 1) * 86400000);
  await new Promise((resolve, reject) => {
    const req = store.put({ domain: 'stale.pk', data: { tech: 'wix' }, cachedAt: ancient.toISOString() });
    req.onsuccess = resolve; req.onerror = () => reject(req.error);
  });

  assert.equal(await getDomainCache('stale.pk'), null, 'a stale entry must read as a miss');
});

test('CRITICAL: a failed open does not brick storage for the rest of the session', async () => {
  // dbPromise used to cache a rejection forever, so ONE transient failure, a
  // version conflict or a blocked tab, meant every later call rejected with the
  // same stale error even after the cause was gone.
  //
  // The test forces a failure, then REMOVES the cause and retries. That second
  // step is the whole point: an earlier version of this test only checked that a
  // healthy open resolves and cached, which passes against the broken code too.
  await closeDb();

  const realOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = () => {
    const request = { onsuccess: null, onerror: null, onupgradeneeded: null,
      error: new Error('simulated version conflict') };
    queueMicrotask(() => { if (request.onerror) request.onerror(); });
    return request;
  };

  await assert.rejects(() => openDb(), /simulated version conflict/);

  indexedDB.open = realOpen;
  const recovered = await openDb();
  assert.ok(recovered, 'openDb must retry after a failure, not serve the cached rejection');

  const again = await openDb();
  assert.equal(recovered, again, 'a successful open is still cached');
});

test('one unstorable lead does not silently drop the rest of the batch', async () => {
  const good1 = lead();
  const good2 = lead();
  const unstorable = lead();
  unstorable.notCloneable = () => {};

  const result = await putLeads([good1, unstorable, good2]);
  const total = result.inserted + result.merged;
  assert.ok(Array.isArray(result.failed), 'putLeads must report which leads failed');
  assert.equal(total + result.failed.length, 3, 'every lead is accounted for');
  assert.ok(result.failed.length >= 1, 'the unstorable lead must be reported, not swallowed');
});

test('a corrupt cache timestamp reads as a miss, not as infinitely fresh', async () => {
  // Every comparison against NaN is false, so a row with a broken cachedAt used
  // to pass the TTL check forever.
  const { openDb } = await import('../src/store/db.js');
  const db = await openDb();
  for (const [domain, cachedAt] of [
    ['no-stamp.pk', undefined],
    ['bad-stamp.pk', 'not-a-date'],
    ['future.pk', new Date(Date.now() + 86400000 * 30).toISOString()],
  ]) {
    const store = db.transaction('domainCache', 'readwrite').objectStore('domainCache');
    await new Promise((resolve, reject) => {
      const req = store.put({ domain, data: { tech: 'wix' }, cachedAt });
      req.onsuccess = resolve; req.onerror = () => reject(req.error);
    });
    assert.equal(await getDomainCache(domain), null, `${domain} should read as a miss`);
  }
});

test('runs round trip so a blocked job can resume', async () => {
  await saveRun({ id: 'run-7', config: { keywords: ['dentist'] }, completedLegs: 3 });
  const loaded = await loadRun('run-7');
  assert.equal(loaded.completedLegs, 3);
  assert.deepEqual(loaded.config.keywords, ['dentist']);
  assert.ok((await listRuns()).some((r) => r.id === 'run-7'));
});

test('saveRun overwrites the same id rather than appending', async () => {
  await saveRun({ id: 'run-8', completedLegs: 1 });
  await saveRun({ id: 'run-8', completedLegs: 5 });
  assert.equal((await loadRun('run-8')).completedLegs, 5);
  assert.equal((await listRuns()).filter((r) => r.id === 'run-8').length, 1);
});
