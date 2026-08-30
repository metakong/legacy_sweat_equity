/**
 * Input normalization + CRM enum enforcement.
 *
 * Security model (carried over from the retired roofing worker, and still
 * correct): stored text is kept RAW — validated, length-capped, and stripped
 * of control characters. Escaping happens at the point of OUTPUT. Every render
 * path in public/app builds DOM with textContent, and API responses are JSON.
 * HTML-escaping on write corrupts the data (O'Brien -> O&#039;Brien) in the
 * D365 clipboard handoff and in the LLM prompt without adding any safety.
 */

/**
 * Trim and strip C0/C1 control characters. `allowNewlines` preserves \t \n \r
 * so multi-line voice transcripts survive intact.
 *
 * Ranges are written as explicit \uXXXX escapes: a bare '-' at the end of a
 * character class is a literal hyphen and would silently mangle hyphenated
 * street addresses and company names.
 */
export const cleanText = (value, { allowNewlines = false } = {}) => {
  if (typeof value !== 'string') return null;
  const stripped = allowNewlines
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    : value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const trimmed = stripped.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** cleanText plus a hard length cap. Returns null when absent. */
export const cleanCapped = (value, max, opts) => {
  const text = cleanText(value, opts);
  if (text === null) return null;
  return text.length > max ? text.slice(0, max) : text;
};

// Field constraints enforced server-side. The client mirrors these, but a
// direct API call must not be able to store junk.
export const LIMITS = {
  companyName: 200,
  street: 200,
  city: 100,
  state: 32,
  zip: 20,
  personName: 100,
  jobTitle: 120,
  phone: 30,
  email: 254,
  industry: 120,
  leadSource: 60,
  transcript: 20000,
  notes: 8000,
  id: 64,
  d365Id: 64,
  checksum: 256,
  searchQuery: 200,
  syncBatch: 100,
  routeStops: 24,          // Up to 24 stops for multi-leg route staging (12 per leg)
  audioBytes: 20 * 1024 * 1024,
  dossierChars: 2000
};

// ---------------------------------------------------------------------
// CRM ENUMS — contracts with Dynamics 365 option sets. The LLM is
// instructed to emit only these values, and is re-checked here because a
// model is not a validator.
// ---------------------------------------------------------------------

/** D365 Lead "Rating" option set. */
export const RATINGS = ['Hot', 'Warm', 'Cold'];

/** Outcome of a single touch. Derived from the 3-Tap Binary, refined by AI. */
export const DISPOSITIONS = [
  'Presentation Scheduled',
  'Follow-Up Scheduled',
  'Enrolled',
  'Callback Requested',
  'Information Left',
  'Gatekeeper Blocked',
  'Not Interested',
  'No Contact',
  'Disqualified'
];

/** D365 Lead "Lead Source" option set, trimmed to what a field agent uses. */
export const LEAD_SOURCES = [
  'Cold Call',
  'Walk-In',
  'Referral',
  'Trade Show',
  'Partner',
  'Web',
  'Existing Customer',
  'Other'
];

/**
 * Where a log sits in the three-tier D365 handoff pipeline.
 *   PENDING        — logged in the field, not yet moved to D365
 *   TIER1_COPIED   — tab-delimited row copied to clipboard (manual paste)
 *   TIER2_EXPORTED — included in an .xlsx update for an existing d365_lead_id
 *   TIER3_EXPORTED — included in a .csv import for a net-new scouted lead
 *   SYNCED         — confirmed landed in D365
 */
export const SYNC_TIERS = ['PENDING', 'TIER1_COPIED', 'TIER2_EXPORTED', 'TIER3_EXPORTED', 'SYNCED'];

/** Case-insensitive enum match that returns the canonical casing, or null. */
export const matchEnum = (value, allowed) => {
  if (typeof value !== 'string') return null;
  const needle = value.trim().toLowerCase();
  return allowed.find((option) => option.toLowerCase() === needle) || null;
};

/**
 * Coerce the many shapes a boolean arrives in. FormData always delivers
 * strings, IndexedDB round-trips real booleans, and D1 stores 0/1.
 */
export const toBool = (value, fallback = 0) => {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return 1;
    if (['0', 'false', 'no', 'off'].includes(v)) return 0;
  }
  return fallback;
};

/** Identifiers must be opaque and safe to interpolate into an R2 object key. */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const asId = (value) => {
  const text = cleanText(value);
  return text && ID_RE.test(text) ? text : null;
};

/** 'YYYY-MM-DD' only — anything looser corrupts the D365 date columns. */
export const asIsoDate = (value) => {
  const text = cleanText(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? null : text;
};

/** Finite, non-negative, rounded to cents. Annualized premium, never NaN. */
export const asMoney = (value) => {
  const n = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return null;
  return Math.round(n * 100) / 100;
};

export const asLatitude = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= -90 && n <= 90 ? n : null;
};

export const asLongitude = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
};

export const asCount = (value, max = 1000000) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
};

/**
 * Fallback disposition when a log carries no voice journal for the LLM to
 * read. The three booleans fully determine it, so a silent log is still a
 * well-formed CRM row rather than a NOT NULL violation.
 */
export const deriveDisposition = ({ is_in_person, is_initial, is_dm_contact }) => {
  const inPerson = toBool(is_in_person);
  const initial = toBool(is_initial);
  const dm = toBool(is_dm_contact);

  if (!dm) return inPerson ? 'Gatekeeper Blocked' : 'No Contact';
  return initial ? 'Information Left' : 'Follow-Up Scheduled';
};

/**
 * Parse model output that is *supposed* to be JSON. Models still occasionally
 * wrap it in a fenced block or prepend a sentence, and a raw JSON.parse throw
 * here would lose an entire field visit.
 */
export const parseJsonLoose = (raw) => {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(text);
  } catch { /* fall through to brace extraction */ }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
};

/** Escape LIKE metacharacters so a typed '%' cannot turn into a full scan. */
export const likePattern = (query) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
