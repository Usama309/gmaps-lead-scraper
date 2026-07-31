/**
 * The message vocabulary between the content script, the service worker and the UI.
 * Namespaced so a stray message from another extension can never be mistaken for ours.
 */
export const MSG = Object.freeze({
  CAPTURE_PB: 'mapprospector/capture-pb',
  START_RUN: 'mapprospector/start-run',
  ABORT_RUN: 'mapprospector/abort-run',
  GET_LEADS: 'mapprospector/get-leads',
  EXPORT: 'mapprospector/export',
  // Split from EXPORT deliberately. EXPORT builds the CSV and marks nothing;
  // CONFIRM_EXPORT is sent only once the download has actually been triggered.
  // Marking inside EXPORT meant a blocked or cancelled download still flagged
  // those businesses as exported, silently skipping them on every later sweep.
  CONFIRM_EXPORT: 'mapprospector/confirm-export',
  RUN_PROGRESS: 'mapprospector/run-progress',
  RUN_BLOCKED: 'mapprospector/run-blocked',
  RUN_COVERAGE: 'mapprospector/run-coverage',
  // A run that is proceeding, but degraded in a way the operator must know about.
  // Kept separate from RUN_COVERAGE because that payload has a fixed shape and the
  // panel's renderer silently ignores anything that does not match it.
  RUN_NOTICE: 'mapprospector/run-notice',

  // Phase 2: enrichment runs over the currently filtered set, not the whole
  // store. Kept as its own message rather than reusing START_RUN because it
  // carries a filter state, not a harvest config, and the two run under
  // separate concurrency slots in background.js.
  ENRICH: 'mapprospector/enrich',
  ENRICH_PROGRESS: 'mapprospector/enrich-progress',
  // A dedicated abort, not a reuse of ABORT_RUN. Harvest and enrichment are
  // independent operations with independent slots (activeRun vs activeEnrich);
  // one name for both would either abort the wrong one or have to guess which
  // slot the operator meant.
  ABORT_ENRICH: 'mapprospector/abort-enrich',

  // Phase 3: the review pass. Its own slot and its own abort for the same reason
  // enrichment has them, and one more besides: this is the only stage that runs in a
  // real session carrying the operator's account, so it must be stoppable on its own
  // without touching anything else that happens to be running.
  REVIEW_PASS: 'mapprospector/review-pass',
  REVIEW_PASS_PROGRESS: 'mapprospector/review-pass-progress',
  ABORT_REVIEW_PASS: 'mapprospector/abort-review-pass',
  // Sent BEFORE the pass starts, because 500 leads is nearly two hours and the
  // operator should learn that from us rather than from the clock.
  REVIEW_PASS_ESTIMATE: 'mapprospector/review-pass-estimate',
});

const KNOWN = new Set(Object.values(MSG));

export function makeRequest(type, payload = {}) {
  if (!KNOWN.has(type)) throw new Error(`unknown message type: ${type}`);
  return { type, payload };
}

export function makeResponse(ok, data = null, error = null) {
  if (!ok && !error) {
    throw new Error('a failed response requires an error message');
  }
  return { ok, data, error: error ?? null };
}

export function isResponse(message) {
  return Boolean(message) && typeof message === 'object' && 'ok' in message;
}
