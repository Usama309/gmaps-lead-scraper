import { MSG, makeResponse } from './src/core/messages.js';
import { planLegs, runHarvest } from './src/pipeline/harvest.js';
import { googlePayloadSource } from './src/sources/google-payload.js';
import { filterLeads } from './src/pipeline/filter.js';
import { toCsv } from './src/export/csv.js';
import { putLeads, getAllLeads, getExportedKeys, markExported, saveRun } from './src/store/db.js';

/** Live run state. One run at a time by design: concurrent runs would race the dedupe pool. */
let activeRun = null;
let latestPb = null;

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // No listener open. Progress messages are advisory, so dropping one is fine.
  });
}

async function startRun(config) {
  if (activeRun) throw new Error('a run is already in progress');
  if (!latestPb) {
    throw new Error('no search parameters captured yet. Open Google Maps and run one search first.');
  }

  const { legs, coverage } = planLegs(config);
  const controller = new AbortController();
  const runId = `run-${Date.now()}`;

  activeRun = { runId, controller, legs };
  await saveRun({ id: runId, config, legs, completedLegs: 0, startedAt: new Date().toISOString() });

  try {
    const result = await runHarvest({
      legs,
      pb: latestPb,
      source: googlePayloadSource,
      signal: controller.signal,
      onLeads: (leads) => { putLeads(leads).catch((e) => console.error('putLeads failed', e)); },
      onProgress: (p) => {
        broadcast(MSG.RUN_PROGRESS, p);
        saveRun({ id: runId, config, legs, completedLegs: p.legIndex + 1 }).catch(() => {});
      },
    });

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
  [MSG.CAPTURE_PB]: async (payload) => { latestPb = payload.pb; return { captured: true }; },
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
