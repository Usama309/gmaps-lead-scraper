/**
 * Turn Google's relative review dates into a day count.
 *
 * Google never exposes an absolute review date anywhere the extension can reach:
 * not in the search payload, checked on 2026-07-31 across every numeric leaf of a
 * record, and not in the place panel. Only text like "a year ago" or "3 days ago".
 *
 * The operator's shortest filter is 3 days, so day and week granularity has to be
 * exact. Months and years do not, and pretending otherwise would be the lie: a
 * review "6 months ago" could be 152 days or 195. Those carry `precise: false` so
 * the CSV can say so rather than implying a precision nobody has.
 */

const MINUTE = 1 / (24 * 60);
const HOUR = 1 / 24;

/**
 * Unit to days. Months and years are the approximate ones.
 *
 * 30 and 365 rather than 30.44 and 365.25: the value is already approximate at this
 * scale, and a round number is easier to reason about when reading an export. The
 * `precise` flag is what carries the caveat, not a decimal place.
 */
const UNITS = Object.freeze({
  second: { days: 0, precise: true },
  minute: { days: MINUTE, precise: true },
  hour: { days: HOUR, precise: true },
  day: { days: 1, precise: true },
  week: { days: 7, precise: true },
  month: { days: 30, precise: false },
  year: { days: 365, precise: false },
});

/** Text meaning "essentially now", which Google uses instead of a zero count. */
const NOW_PHRASES = /^(just now|a moment ago|a few seconds ago|moments ago|now)$/i;

/**
 * Google writes the singular as an article: "a day ago", never "1 day ago". Both are
 * accepted because the article form is what appears live and the numeral form is what
 * anyone writing a test reaches for first, and a parser that took only one of them
 * would look correct in tests and fail in production, or the reverse.
 */
const RELATIVE = /^(?:edited\s+)?(?:(\d+)|an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;

/**
 * Parse one relative date.
 *
 * Returns `{ days: null, precise: false }` for anything unrecognised. Null, never
 * zero: zero means "reviewed today", which is the exact opposite of what an
 * unreadable date tells us, and it would make a dormant business read as active and
 * escape the dormancy modifier that exists to catch it.
 */
export function parseRelativeDate(text) {
  if (typeof text !== 'string') return { days: null, precise: false };

  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean === '') return { days: null, precise: false };
  if (NOW_PHRASES.test(clean)) return { days: 0, precise: true };

  const match = RELATIVE.exec(clean);
  if (!match) return { days: null, precise: false };

  const count = match[1] === undefined ? 1 : Number(match[1]);
  if (!Number.isFinite(count)) return { days: null, precise: false };

  const unit = UNITS[match[2].toLowerCase()];
  return { days: Math.round(count * unit.days), precise: unit.precise };
}

/**
 * The most recent of several relative dates.
 *
 * Unparseable entries are skipped rather than treated as recent, so one unreadable
 * row cannot drag a dormant business's age down to zero. If NOTHING parses, the
 * answer is null: we saw dates and could not read any of them, which is not the same
 * as a business with no reviews, but is equally not something to score on.
 */
export function newestReviewDays(texts) {
  const parsed = (texts ?? [])
    .map(parseRelativeDate)
    .filter((r) => r.days !== null);

  if (parsed.length === 0) return { days: null, precise: false };

  return parsed.reduce((best, r) => (r.days < best.days ? r : best));
}
