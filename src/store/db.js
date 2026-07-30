import { CONFIG } from '../core/config.js';
import { mergeLead } from '../core/schema.js';

const STORES = Object.freeze({
  leads: 'leads',
  exported: 'exported',
  domainCache: 'domainCache',
  runs: 'runs',
});

let dbPromise = null;

/**
 * Open the database, creating stores on first use.
 *
 * Deliberately the only module in the project that touches IndexedDB. Everything
 * upstream deals in plain arrays of leads, which is what makes the pipeline
 * testable in bare Node.
 */
export function openDb() {
  if (dbPromise) return dbPromise;

  // A REJECTED promise must never stay cached. Without this, one transient
  // failure (a version conflict, a blocked tab) permanently bricks storage for
  // the rest of the session, long after the cause has gone away, and every later
  // call rejects with the same stale error.
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG.db.name, CONFIG.db.version);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.leads)) {
        db.createObjectStore(STORES.leads, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.exported)) {
        db.createObjectStore(STORES.exported, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.domainCache)) {
        db.createObjectStore(STORES.domainCache, { keyPath: 'domain' });
      }
      if (!db.objectStoreNames.contains(STORES.runs)) {
        db.createObjectStore(STORES.runs, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  dbPromise.catch(() => { dbPromise = null; });

  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Upsert leads, merging with anything already stored under the same key. */
export async function putLeads(leads) {
  const db = await openDb();
  const store = tx(db, STORES.leads, 'readwrite');
  let inserted = 0;
  let merged = 0;

  // Per-lead, not per-batch. A single unstorable record used to abort the loop
  // and leave the caller with a bare error and no idea which rows landed, so a
  // harvest could half-save in silence. Losing one lead is acceptable; losing the
  // other nineteen without saying so is not.
  const failed = [];

  for (const lead of leads) {
    try {
      const existing = await wrap(store.get(lead.key));
      if (existing) {
        await wrap(store.put(mergeLead(existing, lead)));
        merged += 1;
      } else {
        await wrap(store.put(lead));
        inserted += 1;
      }
    } catch (error) {
      failed.push({ key: lead.key, reason: error?.message ?? String(error) });
    }
  }

  return { inserted, merged, failed };
}

/**
 * Close the database and drop the cached handle.
 *
 * Real API rather than a test hook: the worker needs it to release the handle
 * when a run ends, and an upgrade in another tab needs the old connection gone
 * or the new one blocks. It also makes the failed-open recovery path testable,
 * which was previously only assertable by reading the code.
 */
export async function closeDb() {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    db.close();
  } catch {
    // Already rejected or already closed. Either way there is nothing to release.
  }
  dbPromise = null;
}

export async function getAllLeads() {
  const db = await openDb();
  return wrap(tx(db, STORES.leads, 'readonly').getAll());
}

export async function clearLeads() {
  const db = await openDb();
  return wrap(tx(db, STORES.leads, 'readwrite').clear());
}

export async function getExportedKeys() {
  const db = await openDb();
  const rows = await wrap(tx(db, STORES.exported, 'readonly').getAll());
  return new Set(rows.map((r) => r.key));
}

export async function markExported(keys, runId = null) {
  const db = await openDb();
  const store = tx(db, STORES.exported, 'readwrite');
  const at = new Date().toISOString();
  for (const key of keys) await wrap(store.put({ key, runId, exportedAt: at }));
  return keys.length;
}

export async function getDomainCache(domain) {
  const db = await openDb();
  const row = await wrap(tx(db, STORES.domainCache, 'readonly').get(domain));
  if (!row) return null;

  // A corrupt or missing timestamp parses to NaN, and every comparison against
  // NaN is false, so a stale row would have read as permanently fresh. A
  // future-dated row means the clock moved and is equally untrustworthy. Both are
  // treated as a miss, because re-fetching costs one request while trusting bad
  // cache data poisons every later decision about that domain.
  const cachedAt = new Date(row.cachedAt).getTime();
  if (!Number.isFinite(cachedAt)) return null;

  const ageDays = (Date.now() - cachedAt) / 86400000;
  if (ageDays < 0 || ageDays > CONFIG.enrich.domainCacheTtlDays) return null;
  return row.data;
}

export async function putDomainCache(domain, data) {
  const db = await openDb();
  return wrap(tx(db, STORES.domainCache, 'readwrite').put({
    domain, data, cachedAt: new Date().toISOString(),
  }));
}

export async function saveRun(run) {
  const db = await openDb();
  return wrap(tx(db, STORES.runs, 'readwrite').put(run));
}

export async function loadRun(id) {
  const db = await openDb();
  return wrap(tx(db, STORES.runs, 'readonly').get(id));
}

export async function listRuns() {
  const db = await openDb();
  return wrap(tx(db, STORES.runs, 'readonly').getAll());
}
