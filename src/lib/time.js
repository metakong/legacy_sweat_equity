/**
 * Business-day math for Springfield, Missouri.
 *
 * The nightly cron fires at 02:00 UTC, which is 21:00 the PREVIOUS evening
 * locally. Deriving a business day from UTC therefore analyzes a window that
 * excludes the entire workday that just finished. Never use DATE('now').
 */

export const BUSINESS_TZ = 'America/Chicago';

/** Current calendar date in the field agent's timezone, as YYYY-MM-DD. */
export function businessDate(instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(instant);
}

/** Offset of BUSINESS_TZ from UTC, in ms, at a given instant (DST-aware). */
function tzOffsetMs(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asIfUtc - instant.getTime();
}

/** Local midnight for a YYYY-MM-DD business date, as a UTC epoch ms value. */
function localMidnightUtcMs(year, month, day) {
  const guess = Date.UTC(year, month - 1, day);
  // Two passes settle the DST edges, where the offset at the guessed instant
  // differs from the offset at true local midnight.
  let ms = guess - tzOffsetMs(new Date(guess));
  ms = guess - tzOffsetMs(new Date(ms));
  return ms;
}

/** SQLite datetime() comparison format: 'YYYY-MM-DD HH:MM:SS' in UTC. */
export const toSqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Right now, in the exact format D1's datetime('now') writes. */
export const sqlNow = () => toSqlUtc(Date.now());

/** UTC bounds of a local business day, for range queries against D1. */
export function businessDayRangeUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    start: toSqlUtc(localMidnightUtcMs(y, m, d)),
    end: toSqlUtc(localMidnightUtcMs(y, m, d + 1))
  };
}

/**
 * Normalize a stored timestamp to something Date.parse handles. SQLite's
 * datetime() carries no zone designator but is always UTC; ISO strings queued
 * by the offline client already carry one.
 */
function toInstant(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(timestamp)
    ? timestamp
    : `${timestamp.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Coerce any client-supplied timestamp into the exact format D1's
 * datetime('now') writes: 'YYYY-MM-DD HH:MM:SS' in UTC.
 *
 * This is not cosmetic. Every date filter in this app is a lexicographic
 * string comparison against that format, and an ISO string stored verbatim
 * sorts ABOVE it for the same instant ('T' is 0x54, ' ' is 0x20). Mixing the
 * two formats in one column silently drops rows from the daily Tier 1 view.
 *
 * @returns {string|null} null when unparseable, so the column falls back to
 *          datetime('now') rather than storing garbage.
 */
export function toSqlTimestamp(value) {
  const parsed = toInstant(value);
  return parsed === null ? null : toSqlUtc(parsed);
}

/** Hour (0-23) of a stored timestamp, in the agent's timezone. */
export function localHourOf(timestamp) {
  const parsed = toInstant(timestamp);
  if (parsed === null) return null;
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    hour12: false,
    hour: '2-digit'
  }).format(new Date(parsed));
  return Number(hour) % 24;
}

/**
 * 'YYYY-MM-DD HH:MM' in Springfield local time. This is what goes on the
 * clipboard for D365 — pasting a UTC stamp into "Created On" would put every
 * evening activity on the wrong day.
 */
export function toLocalStamp(timestamp) {
  const parsed = toInstant(timestamp);
  if (parsed === null) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(parsed));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  // en-CA hour12:false renders midnight as '24' in some ICU builds
  const hour = String(Number(p.hour) % 24).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
}
