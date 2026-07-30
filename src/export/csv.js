import { CONFIG } from '../core/config.js';

/**
 * Default export column order. Score first, then identity, then the reasons that
 * justify the score, then the raw signals. This is the order the operator reads
 * on a call, so it is the order the file uses.
 */
export const EXPORT_COLUMNS = Object.freeze([
  { key: 'score', header: 'Score' },
  // Every Phase 1 score is provisional, because website enrichment does not exist
  // yet and the mobile and booking components cannot be answered. The dashboard
  // says so on screen; the CSV is the artifact that outlives the screen.
  { key: 'provisional', header: 'Score provisional' },
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

function renderEnrichmentCell(key, value) {
  if (value === null || value === undefined) return 'unknown';

  const rule = ENRICHMENT_VALUES.get(key);

  // An empty string or empty array is "we looked and found none". Validating it
  // would throw and abort the ENTIRE export over one blank field, which is a far
  // worse outcome than rendering a blank cell.
  if (value === '' || (Array.isArray(value) && value.length === 0)) return '';

  if (!rule.allows(value)) {
    throw new Error(
      `${key} held ${JSON.stringify(value)}, which is not ${rule.describe} or null. `
      + 'Rendering it would make an unverified field indistinguishable from a verified one, '
      + 'and a subtly wrong export is worse than a failed one because nobody notices it.'
    );
  }
  return renderCell(value);
}

/**
 * Enrichment fields, with the exact values each may legitimately hold.
 *
 * Validated rather than merely listed. The whole purpose of this module is
 * keeping "never inspected" distinct from "inspected and absent", and a stray
 * string would defeat that silently: a field holding the string 'yes' renders
 * identically to a genuine true, and one holding 'unknown' renders identically
 * to a genuine null. Nothing downstream could tell them apart.
 *
 * mobileFriendly is genuinely tri-valued, since a site can be partly responsive.
 */
const ENRICHMENT_VALUES = new Map([
  ['mobileFriendly', { allows: (v) => v === true || v === false || v === 'partial',
    describe: 'true, false or "partial"' }],
  ['hasBooking', { allows: (v) => v === true || v === false, describe: 'true or false' }],
  ['hasChatbot', { allows: (v) => v === true || v === false, describe: 'true or false' }],
  ['ownerReplies', { allows: (v) => v === true || v === false, describe: 'true or false' }],
  // email and socials belong here too. They are enrichment, so their null means
  // never inspected and must read as "unknown" rather than blank, which is what an
  // absent value looks like for an ordinary column.
  ['email', { allows: (v) => typeof v === 'string' && v.length > 0, describe: 'an email address' }],
  ['socials', { allows: (v) => Array.isArray(v), describe: 'an array of links' }],
]);

/**
 * Characters that make Excel and Google Sheets treat a cell as a formula.
 *
 * This matters here specifically. Business names come from Google Maps listings,
 * which anyone can register, and this file is opened directly in a spreadsheet.
 * A listing named =HYPERLINK(...) or @SUM(...) would execute on open.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Prefix a formula-triggering cell so the spreadsheet treats it as text.
 *
 * A leading apostrophe is the standard mitigation and is not displayed. Numbers
 * are exempt, because latitude and longitude are legitimately negative and
 * prefixing them would turn real coordinates into text.
 */
function neutraliseFormula(cell) {
  if (cell.length === 0) return cell;
  if (!FORMULA_TRIGGERS.includes(cell[0])) return cell;
  if (Number.isFinite(Number(cell))) return cell;
  return `'${cell}`;
}

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
        const rendered = ENRICHMENT_VALUES.has(c.key)
          ? renderEnrichmentCell(c.key, raw)
          : renderCell(raw);
        return quote(neutraliseFormula(rendered));
      })
      .join(d)
  );

  return [header, ...body].join(nl) + nl;
}
