import { MSG, makeResponse } from './src/core/messages.js';
import { planLegs, runHarvest } from './src/pipeline/harvest.js';
import { enrichLeads } from './src/pipeline/enrich.js';
import { googlePayloadSource } from './src/sources/google-payload.js';
import { filterLeads, countHiddenByExportSkip } from './src/pipeline/filter.js';
import { toCsv } from './src/export/csv.js';
import {
  putLeads, getAllLeads, getExportedKeys, markExported, saveRun,
  getDomainCache, putDomainCache,
} from './src/store/db.js';
import { installAnonCookieRule, removeAnonCookieRule } from './src/sources/anon-cookie.js';
import { runReviewPass, estimateMinutes } from './src/pipeline/review-pass.js';
import { createTabDriver } from './src/pipeline/tab-driver.js';

/** Live run state. One run at a time by design: concurrent runs would race the dedupe pool. */
let activeRun = null;
/** Its own slot. The review pass and a harvest are independent and must not block each other. */
let activeReviewPass = null;
/**
 * Live enrichment state. Its own slot, separate from activeRun: a harvest and
 * an enrichment pass are different operations with different lifetimes, and
 * conflating their concurrency under one flag would let one refuse to start
 * because the other is running, or let one abort call stop the wrong thing.
 */
let activeEnrich = null;
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

/**
 * Start a harvest. One run at a time.
 *
 * The slot is claimed SYNCHRONOUSLY, before the first await. The check and the
 * claim used to be separated by two awaits, which is a real time-of-check to
 * time-of-use window: two fast clicks could both pass `if (activeRun)` while the
 * first was still suspended, and start concurrent pipelines against one shared
 * dedupe store. Nothing else can run between the check and the first suspension
 * point, so claiming here closes it. The `finally` releases the slot on every
 * path out, including a failed pb lookup, so a rejected start cannot wedge the
 * worker into refusing all later runs.
 */
async function startRun(config) {
  if (activeRun) throw new Error('a run is already in progress');

  const controller = new AbortController();
  const runId = `run-${Date.now()}`;
  activeRun = { runId, controller, legs: [] };

  try {
    const pb = await recallPb();
    if (!pb) {
      throw new Error('no search parameters captured yet. Open Google Maps and run one search first.');
    }

    const { legs, coverage, area } = planLegs(config);
    activeRun.legs = legs;

    // Google omits the review count from every record unless the request carries an
    // anonymous session cookie, and `credentials: 'omit'` suppresses all of them.
    // This writes back exactly one allowlisted, account-free cookie for the run.
    //
    // Fatal, not advisory. Without the cookie, reviewCount coverage is about 5%
    // against a canary floor of 80%, so the first page fails and the run halts
    // anyway, but with a payload-drift message that misdirects the operator
    // entirely. Better to say the true reason before spending a single request.
    const cookieRule = await installAnonCookieRule(chrome);
    if (!cookieRule.installed) throw new Error(cookieRule.reason);

    // Serialises every store write for this run, so they land in order and can be
    // drained before the run reports done.
    let pendingWrites = Promise.resolve();

    await saveRun({ id: runId, config, legs, completedLegs: 0, startedAt: new Date().toISOString() });

    // Announced at the START, not only in the final response. A wide run takes
    // minutes on a single awaited message, so a warning delivered at the end is lost
    // if the panel closes or the worker is evicted, and the operator would never
    // learn their search area was cut.
    broadcast(MSG.RUN_COVERAGE, coverage);

    const result = await runHarvest({
      legs,
      pb,
      area,
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
          // p.completedLegs, not legIndex + 1. The queue deliberately stops advancing
          // that number past a failed leg so a resume retries it; recomputing it here
          // would undo exactly that.
          .then(() => saveRun({ id: runId, config, legs, completedLegs: p.completedLegs }))
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

    // Observations the canary could not confirm. Deduplicated upstream, so this is
    // one line per distinct observation rather than one per leg.
    for (const notice of result.notices ?? []) broadcast(MSG.RUN_NOTICE, { message: notice });

    // Google widens a search that runs out of local results, so this number is
    // routinely large and its size is information: it says the requested radius is
    // thinner than the keyword can fill.
    if (result.outsideArea > 0) {
      broadcast(MSG.RUN_NOTICE, {
        message: `${result.outsideArea} results fell outside the ${config.radiusKm} km radius `
          + 'and were discarded. Google widens a search when local results run out.',
      });
    }

    return {
      stopReason: result.stopReason,
      total: result.leads.length,
      completedLegs: result.completedLegs,
      problems: result.problems,
      notices: result.notices,
      outsideArea: result.outsideArea,
      coverage,
    };
  } finally {
    // Every path out, including abort and failure. A rule left installed keeps
    // rewriting a header in the operator's browser after the run that needed it is
    // long gone. The result is checked rather than discarded: a silent failure here
    // is exactly the case where nobody would ever find out.
    const removal = await removeAnonCookieRule(chrome);
    if (!removal.removed) {
      console.error('the anonymous-cookie rule could not be removed', removal.reason);
      broadcast(MSG.RUN_NOTICE, {
        message: 'the anonymous-cookie rule could not be removed and is still active. '
          + 'Restart the browser to clear it.',
      });
    }
    activeRun = null;
  }
}

/**
 * Clear any rule stranded by a previous worker.
 *
 * `finally` is not a guarantee in MV3. The worker can be evicted, crashed or stopped
 * from chrome://extensions between installing the rule and removing it, and a
 * SESSION rule survives all three: it is held for the browser session, not for the
 * worker's lifetime. `activeRun` dies with the worker, the rule does not, so without
 * this sweep the asymmetry leaves a header-rewriting rule running with no run behind
 * it. Runs on every worker start, which is the one moment we know no run is active.
 */
removeAnonCookieRule(chrome).catch((error) => {
  console.error('could not sweep a stranded anonymous-cookie rule', error);
});

async function getLeads(filterState) {
  const [leads, exportedKeys] = await Promise.all([getAllLeads(), getExportedKeys()]);
  const state = { ...filterState, exportedKeys };
  const filtered = filterLeads(leads, state);
  return {
    leads: filtered,
    totalStored: leads.length,
    // Both returned so the UI can state real numbers. Three figures in that panel
    // were hardcoded from the mockup and never replaced, so it asserted that 1,284
    // businesses had been exported and 6 duplicates hidden no matter what had
    // actually happened.
    exportedCount: exportedKeys?.size ?? 0,
    hiddenAsDuplicates: countHiddenByExportSkip(leads, state),
  };
}

/**
 * Build the CSV and return it with the keys it covers. Marks NOTHING as exported.
 *
 * Marking here would flag these businesses before the dashboard had even received
 * the response, let alone built the Blob and triggered the download. A blocked
 * download, a cancelled save dialog, or an anchor click that silently no-ops would
 * then leave them permanently skipped on every later sweep, with no error raised
 * and no way for the operator to learn which ones went missing. The dashboard
 * sends CONFIRM_EXPORT once the download has actually been triggered.
 */
async function exportLeads(filterState) {
  const { leads } = await getLeads(filterState);
  const csv = toCsv(leads);
  return {
    csv,
    count: leads.length,
    keys: leads.map((l) => l.key),
    filename: `mapprospector-${Date.now()}.csv`,
  };
}

/** Record an export that actually reached the operator. The only caller of markExported. */
async function confirmExport(payload) {
  const keys = payload?.keys;
  if (!Array.isArray(keys)) throw new Error('confirm-export needs the keys array from the export');
  await markExported(keys);
  return { confirmed: keys.length };
}

/**
 * Enrich the leads the operator is currently looking at.
 *
 * The slot is claimed SYNCHRONOUSLY, before the first await, for the same
 * reason as startRun: a check and a claim separated by an await is a real
 * time-of-check to time-of-use window, and two fast clicks would both pass
 * `if (activeEnrich)` while the first was still suspended, running two
 * enrichment passes that double-fetch the same domains and race the same
 * merge-on-write store.
 */
async function runEnrich(filterState) {
  if (activeEnrich) throw new Error('an enrichment is already in progress');

  const controller = new AbortController();
  activeEnrich = { controller };

  try {
    // Resolved through getLeads, not getAllLeads. Enrichment must run over the
    // filtered set the operator is looking at, never the whole store: measured
    // live, only 7 of 42 harvested leads even had a website, so enriching
    // everything stored would spend most of the run's fetches on leads nobody
    // asked to see.
    const { leads } = await getLeads(filterState);

    // Serialises every store write for this pass, so they land in order and
    // can be drained before the run reports done. Same reasoning as startRun:
    // overlapping writes against a merge-on-write store can interleave, and an
    // un-awaited write is simply lost if the worker is evicted mid-flight.
    let pendingWrites = Promise.resolve();

    const result = await enrichLeads({
      leads,
      signal: controller.signal,
      getCached: getDomainCache,
      putCached: putDomainCache,
      // Broadcast AND write per lead, not only once at the end. One fetch per
      // candidate, throttled between them, can run for minutes, and a single
      // awaited response is lost if the panel closes or the worker is evicted
      // before the batch finishes.
      onProgress: (p) => {
        broadcast(MSG.ENRICH_PROGRESS, { lead: p.lead, patch: p.patch, done: p.done, total: p.total });
        pendingWrites = pendingWrites
          .then(() => putLeads([{
            key: p.lead.key,
            // enrichLeads only ever enriches a lead that already has a real
            // website, but the patch itself does not carry that fact, only
            // whatever scanHtml/enrichOne observed. mergeLead only accepts an
            // incoming websiteTech when incoming.hasRealWebsite is true, so
            // without this line the detected platform (or 'dead', a 35-point
            // scoring signal) would merge to nothing while email and the rest
            // of the same patch landed fine.
            hasRealWebsite: true,
            ...p.patch,
          }]))
          .then((res) => {
            if (res.failed?.length) {
              console.error(`${res.failed.length} enrichment patches could not be stored`, res.failed);
            }
          })
          .catch((error) => console.error('storing an enrichment patch failed', error));
      },
    });

    await pendingWrites;

    return { stats: result.stats, enrichedCount: result.patches.length };
  } finally {
    // Every path out, including a thrown error, releases the slot. Otherwise a
    // failed enrichment permanently wedges the worker into refusing every
    // later attempt.
    activeEnrich = null;
  }
}

/**
 * Read review recency and owner replies for every stored lead.
 *
 * The operator chose, on 2026-07-31, to run this over everything rather than a
 * shortlist. That is their call, but it makes the cost real: at the measured 13
 * seconds a lead, 500 leads is nearly two hours. The estimate is broadcast BEFORE the
 * first page opens so they learn it from us rather than from the clock.
 *
 * This is the only stage that runs in a real session carrying their Google account,
 * so it stops on the first block rather than pushing through, and it resumes, because
 * something will interrupt a two-hour job.
 */
async function runReviewPassJob(payload) {
  if (activeReviewPass) throw new Error('a review pass is already in progress');

  const controller = new AbortController();
  activeReviewPass = { controller };

  let driver = null;
  try {
    const leads = await getAllLeads();
    const startAt = Number.isInteger(payload?.startAt) ? payload.startAt : 0;

    broadcast(MSG.REVIEW_PASS_ESTIMATE, {
      leads: leads.length,
      remaining: Math.max(0, leads.length - startAt),
      estimatedMinutes: estimateMinutes(Math.max(0, leads.length - startAt)),
    });

    driver = createTabDriver({ tabs: chrome.tabs, scripting: chrome.scripting });

    let pendingWrites = Promise.resolve();

    const result = await runReviewPass({
      leads,
      driver,
      startAt,
      signal: controller.signal,
      onProgress: (p) => {
        broadcast(MSG.REVIEW_PASS_PROGRESS, {
          index: p.index, total: p.total, status: p.status,
          name: p.lead?.name ?? null, completedLeads: p.completedLeads,
        });
      },
    });

    // Written in one batch at the end rather than per lead. Unlike enrichment, every
    // patch here is tiny and the pass already holds them, so a mid-pass eviction
    // costs the batch rather than the hour: the resume point is what protects the
    // work, and it is returned either way.
    pendingWrites = pendingWrites.then(() => (result.patches.length ? putLeads(result.patches) : null));
    await pendingWrites;

    if (result.stopReason === 'blocked' || result.stopReason === 'selector_drift') {
      broadcast(MSG.RUN_BLOCKED, { stopReason: result.stopReason, problems: result.problems });
    }

    return {
      stopReason: result.stopReason,
      read: result.patches.length,
      skipped: result.skipped,
      completedLeads: result.completedLeads,
      problems: result.problems,
    };
  } finally {
    // The tab is ours, so it goes when we do, on every path out including a throw.
    if (driver) await driver.close();
    activeReviewPass = null;
  }
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
  [MSG.CONFIRM_EXPORT]: (payload) => confirmExport(payload ?? {}),
  [MSG.ENRICH]: (payload) => runEnrich(payload ?? {}),
  [MSG.REVIEW_PASS]: (payload) => runReviewPassJob(payload ?? {}),
  [MSG.ABORT_REVIEW_PASS]: async () => {
    if (!activeReviewPass) return { aborted: false };
    activeReviewPass.controller.abort();
    return { aborted: true };
  },
  [MSG.ABORT_ENRICH]: async () => {
    if (!activeEnrich) return { aborted: false };
    activeEnrich.controller.abort();
    return { aborted: true };
  },
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
