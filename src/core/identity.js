/**
 * Normalisers and dedupe identity. Deliberately dependency-free: this is the
 * leaf of the import graph and every other core module may import it.
 */

/**
 * Decimal places used when coordinates form part of a dedupe key.
 * This lives here rather than in config.js because it is an algorithm constant,
 * not an operational tunable. Changing it silently invalidates every dedupe key
 * already written to IndexedDB, so it must not sit next to knobs like throttle
 * delays that someone may reasonably tune.
 */
export const COORD_KEY_DECIMALS = 4;

export function normalizeName(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D+/g, '');
  return digits.length ? digits : null;
}

export function normalizeDomain(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  // A hostname with no dot is not a real domain, it is stray text.
  if (!host.includes('.')) return null;
  return host.replace(/^www\./, '');
}

/**
 * Stable identity for deduplication, in descending order of trust.
 * Throws rather than inventing a key, because a colliding key silently merges
 * two different businesses and that corruption is unrecoverable.
 */
export function leadKey(lead) {
  if (lead.cid) return `cid:${lead.cid}`;

  const name = normalizeName(lead.name);
  const phone = normalizePhone(lead.phone);
  if (name && phone) return `np:${name}|${phone}`;

  if (name && Number.isFinite(lead.lat) && Number.isFinite(lead.lng)) {
    return `nl:${name}|${lead.lat.toFixed(COORD_KEY_DECIMALS)}|${lead.lng.toFixed(COORD_KEY_DECIMALS)}`;
  }

  throw new Error('cannot derive a dedupe key: lead has no cid, no name+phone, no name+coords');
}
