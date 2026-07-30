/**
 * The contract every harvester implements, so the pipeline never cares whether a
 * record came from Google, OpenStreetMap or Foursquare.
 *
 *   id          string, stamped onto each lead as `provenance`
 *   harvestLeg  async ({ query, ...sourceSpecific }) -> { leads, stopReason, problems }
 *
 * stopReason is one of: 'end_of_list' | 'cap_reached' | 'blocked' | 'canary_failed' | 'aborted'
 */
export const STOP_REASONS = Object.freeze([
  'end_of_list', 'cap_reached', 'blocked', 'canary_failed', 'aborted', 'network_error',
]);

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
