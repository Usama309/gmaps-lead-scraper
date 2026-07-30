import { CONFIG } from '../core/config.js';

/**
 * Transport-level classification: did we get a real payload response at all?
 *
 * Google serves a `/sorry/` HTML interstitial when it wants you to stop. That
 * arrives as HTTP 200 with an HTML body, so status alone is not enough: the
 * `)]}'` prefix is the actual signal.
 */
export function classifyTransport({ status, body }) {
  if (status !== 200) {
    return { state: 'blocked', reason: `HTTP ${status}` };
  }
  if (!body) {
    return { state: 'blocked', reason: 'empty response body' };
  }
  if (!body.startsWith(CONFIG.guard.validPrefix)) {
    return { state: 'blocked', reason: 'response is missing the payload prefix, likely a challenge page' };
  }
  return { state: 'ok', reason: null };
}

/**
 * Page-level classification.
 *
 * This is the trap the spec calls out. A finished leg looks like a clean HTTP 200
 * carrying the valid prefix and zero records, roughly 784 bytes. That is SUCCESS.
 * Treating it as a block would pause every single run at its natural end.
 * Treating a real block as end-of-list would silently truncate results and the
 * operator would never know the list was incomplete.
 */
export function classifyPage({ transport, recordCount, rawCount = 0 }) {
  if (transport.state === 'blocked') {
    return { state: 'blocked', reason: transport.reason };
  }
  // Records arrived but none survived extraction. That is index drift, not the
  // end of the results. Without this branch it would be indistinguishable from a
  // finished leg and the operator would read a truncated list as complete.
  if (recordCount === 0 && rawCount > 0) {
    return {
      state: 'extraction_failed',
      reason: `${rawCount} records arrived but none could be extracted, which means the payload indices have drifted`,
    };
  }
  if (recordCount === 0) {
    return { state: 'end_of_list', reason: 'reached the end of results for this leg' };
  }
  return { state: 'ok', reason: null };
}

/** Randomised inter-request delay. Jitter matters more than the absolute value. */
export function nextDelayMs(random = Math.random) {
  const { min, max } = CONFIG.harvest.delayMs;
  return Math.round(min + random() * (max - min));
}

/**
 * Watches response latency with an exponentially weighted moving average.
 *
 * Recon observed latency drifting from 980 ms to 2.2 s under burst pressure
 * without ever producing a 429. Sustained slowdown is therefore the earliest
 * available warning that we are pushing too hard, well before a hard block.
 */
export function createLatencyWatch() {
  const { latencyEwmaAlpha, latencyBreachMultiple } = CONFIG.guard;
  let ewma = null;
  let baseline = null;

  return {
    /** Returns true when smoothed latency has breached the threshold. */
    observe(ms) {
      if (baseline === null) {
        baseline = ms;
        ewma = ms;
        return false;
      }
      ewma = latencyEwmaAlpha * ms + (1 - latencyEwmaAlpha) * ewma;
      return ewma > baseline * latencyBreachMultiple;
    },
  };
}
