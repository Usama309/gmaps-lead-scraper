/**
 * The contract every harvester implements, so the pipeline never cares whether a
 * record came from Google, OpenStreetMap or Foursquare.
 *
 *   id          string, stamped onto each lead as `provenance`
 *   harvestLeg  async ({ query, ...sourceSpecific }) -> { leads, stopReason, problems }
 *
 * stopReason is one of the values in STOP_REASONS below. Read that array rather than
 * this sentence: a prose list drifts out of date the moment a reason is added, and
 * this comment is the contract the pipeline layer relies on.
 */
export const STOP_REASONS = Object.freeze([
  'end_of_list', 'cap_reached', 'blocked', 'canary_failed', 'aborted', 'network_error',
  'completed', 'leg_threw',
]);

/**
 * Validate a stopReason at the point of return.
 *
 * STOP_REASONS was previously documentation that nothing checked, so a typo would
 * have produced a reason no caller branches on. Downstream code decides whether to
 * pause, resume or report on the strength of this string, and an unrecognised value
 * would fall through every branch and look like success.
 */
export function assertStopReason(reason) {
  if (!STOP_REASONS.includes(reason)) {
    throw new Error(
      `unknown stopReason "${reason}". Add it to STOP_REASONS in source.js, or fix the typo.`
    );
  }
  return reason;
}

export function assertSource(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('source must be an object');
  }
  if (typeof candidate.id !== 'string' || !candidate.id) {
    throw new Error('source must expose a non-empty string id');
  }
  if (typeof candidate.harvestLeg !== 'function') {
    throw new Error('source must expose an async harvestLeg function');
  }
}
