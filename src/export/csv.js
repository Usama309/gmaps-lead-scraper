import { CONFIG } from '../core/config.js';

/**
 * Default export column order. Score first, then identity, then the reasons that
 * justify the score, then the raw signals. This is the order the operator reads
 * on a call, so it is the order the file uses.
 */
export const EXPORT_COLUMNS = Object.freeze([
  { key: 'score', header: 'Score' },
  { key: 'name', header: 'Business' },
  { key: 'categories', header: 'Category' },
  { key: 'reasons', header: 'Why it scored' },
  { key: 'phone', header: 'Phone' },
  { key: 'email', header: 'Email' },
  { key: 'website', header: 'Website' },
  { key: 'websiteTech', header: 'Platform' },
  { key: 'mobileFriendly', header: 'Mobile friendly' },
  { key: 'hasBooking', header: 'Online booking' },
  { key: 'hasChatbot', header: 'Chatbot' },
  { key: 'socials', header: 'Social links' },
  { key: 'rating', header: 'Rating' },
  { key: 'reviewCount', header: 'Reviews' },
  { key: 'ownerReplies', header: 'Owner replies' },
  { key: 'lastReviewDays', header: 'Days since last review' },
  { key: 'address', header: 'Address' },
  { key: 'lat', header: 'Latitude' },
  { key: 'lng', header: 'Longitude' },
  { key: 'provenance', header: 'Source' },
  { key: 'cid', header: 'Google CID' },
]);

/**
 * Render one value as a CSV cell.
 *
 * null means "we did not look", which is genuinely different from false. Emitting
 * "unknown" rather than blank or "no" keeps that distinction visible in the export,
 * so the operator never reads an un-enriched row as a confirmed absence.
 */
function renderCell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return String(value);
}

function renderEnrichmentCell(value) {
  if (value === null || value === undefined) return 'unknown';
  return renderCell(value);
}

/** Enrichment fields where null must read as "unknown" rather than blank. */
const ENRICHMENT_KEYS = new Set(['mobileFriendly', 'hasBooking', 'hasChatbot', 'ownerReplies']);

function quote(cell) {
  const d = CONFIG.export.csvDelimiter;
  if (cell.includes(d) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function toCsv(leads, columns = EXPORT_COLUMNS) {
  const d = CONFIG.export.csvDelimiter;
  const nl = CONFIG.export.csvNewline;

  const header = columns.map((c) => quote(c.header)).join(d);

  const body = leads.map((lead) =>
    columns
      .map((c) => {
        const raw = lead[c.key];
        const rendered = ENRICHMENT_KEYS.has(c.key) ? renderEnrichmentCell(raw) : renderCell(raw);
        return quote(rendered);
      })
      .join(d)
  );

  return [header, ...body].join(nl) + nl;
}
