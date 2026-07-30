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
  // A non-text body (a Buffer from a Node HTTP path, an object, a number) must
  // classify rather than throw. A guard that throws escapes the state machine it
  // exists to enforce, and the caller has no state to act on.
  if (typeof body !== 'string') {
    return { state: 'blocked', reason: `response body was ${typeof body}, not text` };
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
export function classifyPage({ transport, recordCount, rawCount }) {
  // Both counts are REQUIRED and validated, deliberately. rawCount previously
  // defaulted to 0, which meant a caller forgetting to pass it turned a drift
  // straight back into end_of_list: the exact silent truncation this module
  // exists to prevent, reintroduced by one omitted argument. Only the caller
  // knows whether records arrived, so absence is a bug and must be loud.
  for (const [name, value] of [['recordCount', recordCount], ['rawCount', rawCount]]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`classifyPage requires a non-negative integer ${name}, got ${JSON.stringify(value)}`);
    }
  }
  if (recordCount > rawCount) {
    throw new Error(
      `classifyPage got recordCount ${recordCount} above rawCount ${rawCount}, `
      + 'which cannot happen: extraction can only ever lose records, never invent them'
    );
  }

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
  const {
    latencyEwmaAlpha, latencyBreachMultiple, baselineSamples, absoluteLatencyCeilingMs,
  } = CONFIG.guard;

  const warmup = [];
  let baseline = null;
  let ewma = null;

  return {
    /** Returns true when smoothed latency has breached the threshold. */
    observe(ms) {
      // A non-positive or non-finite reading is a broken measurement, not a fast
      // response. Admitting one poisons the baseline and every later comparison:
      // a single 0 made the next request look infinitely slower, and a negative
      // value produced an instant false breach.
      if (!Number.isFinite(ms) || ms <= 0) return false;

      ewma = ewma === null ? ms : latencyEwmaAlpha * ms + (1 - latencyEwmaAlpha) * ewma;

      if (baseline === null) {
        warmup.push(ms);
        if (warmup.length < baselineSamples) return false;
        // Median of the opening samples, not the first one. A single unlucky slow
        // request used to become the permanent baseline, after which nothing could
        // ever breach and the pressure signal was silently dead.
        const sorted = [...warmup].sort((a, b) => a - b);
        baseline = sorted[Math.floor(sorted.length / 2)];
      }

      // The absolute ceiling means a legitimately high baseline cannot switch
      // detection off altogether.
      return ewma > baseline * latencyBreachMultiple || ewma > absoluteLatencyCeilingMs;
    },
  };
}
