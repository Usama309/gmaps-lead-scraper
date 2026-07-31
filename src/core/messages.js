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
