import { MSG, makeResponse } from './src/core/messages.js';
import { planLegs, runHarvest } from './src/pipeline/harvest.js';
import { googlePayloadSource } from './src/sources/google-payload.js';
import { filterLeads } from './src/pipeline/filter.js';
import { toCsv } from './src/export/csv.js';
import { putLeads, getAllLeads, getExportedKeys, markExported, saveRun } from './src/store/db.js';

/** Live run state. One run at a time by design: concurrent runs would race the dedupe pool. */
let activeRun = null;
let latestPb = null;

/**
 * An MV3 service worker is terminated after roughly 30 seconds of inactivity, and
 * module state dies with it. Losing the captured pb that way makes an already
 * successful search report "no search parameters captured yet", so it is mirrored
 * into session storage, which survives worker restarts within the browser session.
 */
const PB_STORAGE_KEY = 'latestPb';

async function rememberPb(pb) {
  latestPb = pb;
  try {
    await chrome.storage.session.set({ [PB_STORAGE_KEY]: pb });
  } catch (error) {
    console.error('could not persist the captured search parameters', error);
  }
}

async function recallPb() {
  if (latestPb) return latestPb;
  try {
    const stored = await chrome.storage.session.get(PB_STORAGE_KEY);
    latestPb = stored?.[PB_STORAGE_KEY] ?? null;
  } catch {
    latestPb = null;
  }
  return latestPb;
}

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // No listener open. Progress messages are advisory, so dropping one is fine.
  });
}

async function startRun(config) {
  if (activeRun) throw new Error('a run is already in progress');

  const pb = await recallPb();
  if (!pb) {
    throw new Error('no search parameters captured yet. Open Google Maps and run one search first.');
  }

  const { legs, coverage } = planLegs(config);
  const controller = new AbortController();
  const runId = `run-${Date.now()}`;

  // Serialises every store write for this run, so they land in order and can be
  // drained before the run reports done.
  let pendingWrites = Promise.resolve();

  activeRun = { runId, controller, legs };
  await saveRun({ id: runId, config, legs, completedLegs: 0, startedAt: new Date().toISOString() });

  try {
    const result = await runHarvest({
      legs,
      pb,
      source: googlePayloadSource,
      signal: controller.signal,
      // Writes are chained rather than fired and forgotten. Overlapping calls
      // against a merge-on-write store can interleave, and an un-awaited write is
      // simply lost if the worker is evicted mid-flight, with the failure landing
      // in a console nobody is watching.
      onLeads: (leads) => {
        pendingWrites = pendingWrites
          .then(() => putLeads(leads))
          .then((result) => {
            if (result.failed?.length) {
              console.error(`${result.failed.length} leads could not be stored`, result.failed);
            }
          })
          .catch((error) => console.error('storing leads failed', error));
      },
      onProgress: (p) => {
        broadcast(MSG.RUN_PROGRESS, p);
        pendingWrites = pendingWrites
          .then(() => saveRun({ id: runId, config, legs, completedLegs: p.legIndex + 1 }))
          .catch(() => {});
      },
    });

    await pendingWrites;
    await putLeads(result.leads);
    await saveRun({
      id: runId, config, legs,
      completedLegs: result.completedLegs,
      stopReason: result.stopReason,
      problems: result.problems,
      finishedAt: new Date().toISOString(),
    });

    if (result.stopReason === 'blocked' || result.stopReason === 'canary_failed') {
      broadcast(MSG.RUN_BLOCKED, { stopReason: result.stopReason, problems: result.problems });
    }

    return {
      stopReason: result.stopReason,
      total: result.leads.length,
      completedLegs: result.completedLegs,
      problems: result.problems,
      coverage,
    };
  } finally {
    activeRun = null;
  }
}

async function getLeads(filterState) {
  const [leads, exportedKeys] = await Promise.all([getAllLeads(), getExportedKeys()]);
  return { leads: filterLeads(leads, { ...filterState, exportedKeys }), totalStored: leads.length };
}

async function exportLeads(filterState) {
  const { leads } = await getLeads(filterState);
  const csv = toCsv(leads);
  await markExported(leads.map((l) => l.key));
  return { csv, count: leads.length, filename: `mapprospector-${Date.now()}.csv` };
}

const HANDLERS = {
  [MSG.CAPTURE_PB]: async (payload) => { await rememberPb(payload.pb); return { captured: true }; },
  [MSG.START_RUN]: (payload) => startRun(payload),
  [MSG.ABORT_RUN]: async () => {
    if (!activeRun) return { aborted: false };
    activeRun.controller.abort();
    return { aborted: true };
  },
  [MSG.GET_LEADS]: (payload) => getLeads(payload ?? {}),
  [MSG.EXPORT]: (payload) => exportLeads(payload ?? {}),
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  Promise.resolve(handler(message.payload))
    .then((data) => respond(makeResponse(true, data)))
    .catch((error) => respond(makeResponse(false, null, error?.message ?? String(error))));

  return true; // keep the channel open for the async response
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('side panel behaviour not set', error));
