/**
 * D1 access helpers.
 *
 * Normalization lives here rather than in the routes because the same shapes
 * arrive through three different doors: /api/sync (offline queue drain),
 * /api/transcribe-and-log (FormData from the mic), and /api/companies (typed
 * in on the desktop). One validator, three callers.
 *
 * Only primitives are ever bound — an object reaching .bind() throws inside D1
 * and takes down the whole request with a 500.
 */

import {
  LIMITS,
  RATINGS,
  DISPOSITIONS,
  LEAD_SOURCES,
  SYNC_TIERS,
  cleanCapped,
  matchEnum,
  toBool,
  asId,
  asIsoDate,
  asMoney,
  asLatitude,
  asLongitude,
  asCount,
  deriveDisposition
} from './validate.js';
import { toSqlTimestamp } from './time.js';

/** A field is invalid in a way the caller must be told about. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------
// COMPANIES
// ---------------------------------------------------------------------

/**
 * Validate and coerce a company payload into bindable primitives.
 * Throws ValidationError only for the two fields we genuinely cannot invent.
 */
export function normalizeCompany(raw) {
  const companyName = cleanCapped(raw?.company_name, LIMITS.companyName);
  if (!companyName) throw new ValidationError('company_name is required');

  const companyId = asId(raw?.company_id) || crypto.randomUUID();

  return {
    company_id: companyId,
    d365_lead_id: cleanCapped(raw?.d365_lead_id, LIMITS.d365Id),
    d365_checksum: cleanCapped(raw?.d365_checksum, LIMITS.checksum),
    d365_modified_on: cleanCapped(raw?.d365_modified_on, 64),
    company_name: companyName,
    street_1: cleanCapped(raw?.street_1, LIMITS.street),
    street_2: cleanCapped(raw?.street_2, LIMITS.street),
    city: cleanCapped(raw?.city, LIMITS.city),
    state: cleanCapped(raw?.state, LIMITS.state),
    zip_code: cleanCapped(raw?.zip_code, LIMITS.zip),
    lat: asLatitude(raw?.lat),
    long: asLongitude(raw?.long ?? raw?.lng),
    lead_source: matchEnum(raw?.lead_source, LEAD_SOURCES) || undefined,
    rating: matchEnum(raw?.rating, RATINGS) || undefined,
    employees: asCount(raw?.employees, 5_000_000),
    industry: cleanCapped(raw?.industry, LIMITS.industry),
    sic_code: cleanCapped(raw?.sic_code, 16),
    account_number: cleanCapped(raw?.account_number, 64),
    post_enrollment_date: asIsoDate(raw?.post_enrollment_date),
    renewal_date: asIsoDate(raw?.renewal_date),
    pipeline_stage: cleanCapped(raw?.pipeline_stage, 32) || null,
    stage_entered_at: asIsoDate(raw?.stage_entered_at),
    snoozed_until: asIsoDate(raw?.snoozed_until),
    disqualified_reason: cleanCapped(raw?.disqualified_reason, 500),
    forecast_ap: asMoney(raw?.forecast_ap),
    forecast_confidence: asCount(raw?.forecast_confidence, 100),
    // A record only counts as synced once it carries the D365 identity that
    // proves it round-tripped. Trusting a client-sent flag here is how
    // net-new leads silently drop out of the Tier 3 export.
    is_d365_synced: toBool(raw?.is_d365_synced) && cleanCapped(raw?.d365_lead_id, LIMITS.d365Id) ? 1 : 0
  };
}

/**
 * Insert, or merge into an existing row.
 *
 * COALESCE(excluded.x, companies.x) throughout: a quick field re-log sends
 * only what the agent retyped, and must not blank out an enrichment result or
 * a D365 identity captured earlier.
 */
export async function upsertCompany(db, company) {
  await db.prepare(`
    INSERT INTO companies (
      company_id, d365_lead_id, d365_checksum, d365_modified_on, company_name,
      street_1, street_2, city, state, zip_code, lat, long,
      lead_source, rating, employees, industry,
      sic_code, account_number, post_enrollment_date,
      renewal_date, pipeline_stage, stage_entered_at, snoozed_until,
      disqualified_reason, forecast_ap, forecast_confidence, is_d365_synced
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET
      d365_lead_id        = COALESCE(excluded.d365_lead_id, companies.d365_lead_id),
      d365_checksum       = COALESCE(excluded.d365_checksum, companies.d365_checksum),
      d365_modified_on    = COALESCE(excluded.d365_modified_on, companies.d365_modified_on),
      company_name        = excluded.company_name,
      street_1            = COALESCE(excluded.street_1, companies.street_1),
      street_2            = COALESCE(excluded.street_2, companies.street_2),
      city                = COALESCE(excluded.city, companies.city),
      state               = COALESCE(excluded.state, companies.state),
      zip_code            = COALESCE(excluded.zip_code, companies.zip_code),
      lat                 = COALESCE(companies.lat, excluded.lat),
      long                = COALESCE(companies.long, excluded.long),
      lead_source         = COALESCE(excluded.lead_source, companies.lead_source),
      rating              = COALESCE(excluded.rating, companies.rating),
      employees           = COALESCE(excluded.employees, companies.employees),
      industry            = COALESCE(excluded.industry, companies.industry),
      sic_code            = COALESCE(excluded.sic_code, companies.sic_code),
      account_number      = COALESCE(excluded.account_number, companies.account_number),
      post_enrollment_date = COALESCE(excluded.post_enrollment_date, companies.post_enrollment_date),
      renewal_date        = COALESCE(excluded.renewal_date, companies.renewal_date),
      pipeline_stage      = COALESCE(excluded.pipeline_stage, companies.pipeline_stage),
      stage_entered_at    = COALESCE(excluded.stage_entered_at, companies.stage_entered_at),
      snoozed_until       = COALESCE(excluded.snoozed_until, companies.snoozed_until),
      disqualified_reason = COALESCE(excluded.disqualified_reason, companies.disqualified_reason),
      forecast_ap         = COALESCE(excluded.forecast_ap, companies.forecast_ap),
      forecast_confidence = COALESCE(excluded.forecast_confidence, companies.forecast_confidence),
      is_d365_synced      = MAX(excluded.is_d365_synced, companies.is_d365_synced)
  `).bind(
    company.company_id,
    company.d365_lead_id,
    company.d365_checksum,
    company.d365_modified_on,
    company.company_name,
    company.street_1,
    company.street_2,
    company.city,
    company.state,
    company.zip_code,
    company.lat,
    company.long,
    company.lead_source,
    company.rating,
    company.employees,
    company.industry,
    company.sic_code,
    company.account_number,
    company.post_enrollment_date,
    company.renewal_date,
    company.pipeline_stage,
    company.stage_entered_at,
    company.snoozed_until,
    company.disqualified_reason,
    company.forecast_ap,
    company.forecast_confidence,
    company.is_d365_synced
  ).run();

  return company.company_id;
}

/** Move a company's D365 Rating without touching anything else. */
export async function setCompanyRating(db, companyId, rating) {
  const canonical = matchEnum(rating, RATINGS);
  if (!canonical) return null;
  await db.prepare('UPDATE companies SET rating = ? WHERE company_id = ?')
    .bind(canonical, companyId)
    .run();
  return canonical;
}

/** Calculate annual renewal date (1 year out from enrollment or current date). */
export function calculateRenewalDate(enrollmentDate, fallbackDate) {
  const base = asIsoDate(enrollmentDate) || asIsoDate(fallbackDate) || new Date().toISOString().slice(0, 10);
  const [year, month, day] = base.split('-').map(Number);
  const nextYear = year + 1;
  let targetDay = day;
  if (month === 2 && day === 29) {
    targetDay = 28;
  }
  const yStr = String(nextYear).padStart(4, '0');
  const mStr = String(month).padStart(2, '0');
  const dStr = String(targetDay).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

/** Update a company's renewal date. */
export async function setCompanyRenewalDate(db, companyId, renewalDate) {
  const date = asIsoDate(renewalDate);
  if (!date || !companyId) return null;
  await db.prepare('UPDATE companies SET renewal_date = ? WHERE company_id = ?')
    .bind(date, companyId)
    .run();
  return date;
}

// ---------------------------------------------------------------------
// CONTACTS
// ---------------------------------------------------------------------

export function normalizeContact(raw, companyId) {
  const contactCompanyId = asId(raw?.company_id) || companyId;
  if (!contactCompanyId) throw new ValidationError('contact requires a company_id');

  const firstName = cleanCapped(raw?.first_name, LIMITS.personName);
  const lastName = cleanCapped(raw?.last_name, LIMITS.personName);
  const jobTitle = cleanCapped(raw?.job_title, LIMITS.jobTitle);
  // A contact with no name and no title is noise, not a record.
  if (!firstName && !lastName && !jobTitle) return null;

  const email = cleanCapped(raw?.email_address, LIMITS.email);

  return {
    contact_id: asId(raw?.contact_id) || crypto.randomUUID(),
    company_id: contactCompanyId,
    first_name: firstName,
    last_name: lastName,
    job_title: jobTitle,
    phone_number: cleanCapped(raw?.phone_number, LIMITS.phone),
    // Store only what looks like an address; a mis-transcribed one poisons a
    // D365 import far more expensively than a blank does.
    email_address: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    is_primary_dm: toBool(raw?.is_primary_dm, 1)
  };
}

export async function findExistingContact(db, companyId, firstName, lastName) {
  if (!db || !companyId || (!firstName && !lastName)) return null;
  const fn = firstName ? firstName.trim().toLowerCase() : '';
  const ln = lastName ? lastName.trim().toLowerCase() : '';

  if (fn && ln) {
    const row = await db.prepare(`
      SELECT contact_id FROM contacts
      WHERE company_id = ? AND LOWER(TRIM(first_name)) = ? AND LOWER(TRIM(last_name)) = ?
      LIMIT 1
    `).bind(companyId, fn, ln).first();
    if (row?.contact_id) return row.contact_id;
  } else if (fn) {
    const row = await db.prepare(`
      SELECT contact_id FROM contacts
      WHERE company_id = ? AND LOWER(TRIM(first_name)) = ? AND (last_name IS NULL OR TRIM(last_name) = '')
      LIMIT 1
    `).bind(companyId, fn).first();
    if (row?.contact_id) return row.contact_id;
  } else if (ln) {
    const row = await db.prepare(`
      SELECT contact_id FROM contacts
      WHERE company_id = ? AND (first_name IS NULL OR TRIM(first_name) = '') AND LOWER(TRIM(last_name)) = ?
      LIMIT 1
    `).bind(companyId, ln).first();
    if (row?.contact_id) return row.contact_id;
  }
  return null;
}

export async function upsertContact(db, contact) {
  // Composite key deduplication: if this contact already exists under the company,
  // reuse its contact_id so the write updates rather than duplicates.
  if (contact.company_id && (contact.first_name || contact.last_name)) {
    const existingId = await findExistingContact(db, contact.company_id, contact.first_name, contact.last_name);
    if (existingId) {
      contact.contact_id = existingId;
    }
  }

  await db.prepare(`
    INSERT INTO contacts (
      contact_id, company_id, first_name, last_name, job_title,
      phone_number, email_address, is_primary_dm
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET
      first_name    = COALESCE(excluded.first_name, contacts.first_name),
      last_name     = COALESCE(excluded.last_name, contacts.last_name),
      job_title     = COALESCE(excluded.job_title, contacts.job_title),
      phone_number  = COALESCE(excluded.phone_number, contacts.phone_number),
      email_address = COALESCE(excluded.email_address, contacts.email_address),
      is_primary_dm = excluded.is_primary_dm
  `).bind(
    contact.contact_id,
    contact.company_id,
    contact.first_name,
    contact.last_name,
    contact.job_title,
    contact.phone_number,
    contact.email_address,
    contact.is_primary_dm
  ).run();

  return contact.contact_id;
}

// ---------------------------------------------------------------------
// ACTIVITY LOGS
// ---------------------------------------------------------------------

/**
 * Validate one touch. The three booleans are the whole disposition UI on
 * mobile, so `disposition` is derived from them when the caller (or the LLM)
 * did not supply a valid one — activity_logs.disposition is NOT NULL and a
 * silent log must still be a well-formed CRM row.
 */
export function normalizeActivityLog(raw) {
  const companyId = asId(raw?.company_id);
  if (!companyId) throw new ValidationError('company_id is required');

  const booleans = {
    is_in_person: toBool(raw?.is_in_person),
    is_initial: toBool(raw?.is_initial),
    is_dm_contact: toBool(raw?.is_dm_contact)
  };

  const notes = raw?.ai_structured_notes;

  return {
    log_id: asId(raw?.log_id) || crypto.randomUUID(),
    company_id: companyId,
    contact_id: asId(raw?.contact_id),
    // Client-supplied timestamps let a queue drained three hours later still
    // land on the hour the door was actually knocked. Normalized to D1's own
    // 'YYYY-MM-DD HH:MM:SS' so date filters (string comparisons) stay sound.
    timestamp: toSqlTimestamp(raw?.timestamp),
    ...booleans,
    disposition: matchEnum(raw?.disposition, DISPOSITIONS) || deriveDisposition(booleans),
    presentation_date: asIsoDate(raw?.presentation_date),
    enrollment_date: asIsoDate(raw?.enrollment_date),
    projected_ap: asMoney(raw?.projected_ap),
    raw_audio_transcription: cleanCapped(raw?.raw_audio_transcription, LIMITS.transcript, { allowNewlines: true }),
    ai_structured_notes: typeof notes === 'string'
      ? cleanCapped(notes, LIMITS.notes, { allowNewlines: true })
      : (notes ? JSON.stringify(notes).slice(0, LIMITS.notes) : null),
    sync_tier_status: matchEnum(raw?.sync_tier_status, SYNC_TIERS) || 'PENDING',
    next_action_date: asIsoDate(raw?.next_action_date),
    next_action_text: cleanCapped(raw?.next_action_text, 300)
  };
}

/**
 * Idempotent by log_id: the offline queue retries the same client-generated id
 * after a dropped connection, and that must update rather than duplicate.
 */
export async function upsertActivityLog(db, log) {
  await db.prepare(`
    INSERT INTO activity_logs (
      log_id, company_id, contact_id, timestamp,
      is_in_person, is_initial, is_dm_contact, disposition,
      presentation_date, enrollment_date, projected_ap,
      raw_audio_transcription, ai_structured_notes, sync_tier_status,
      next_action_date, next_action_text
    ) VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(log_id) DO UPDATE SET
      contact_id              = COALESCE(excluded.contact_id, activity_logs.contact_id),
      is_in_person            = excluded.is_in_person,
      is_initial              = excluded.is_initial,
      is_dm_contact           = excluded.is_dm_contact,
      disposition             = excluded.disposition,
      presentation_date       = COALESCE(excluded.presentation_date, activity_logs.presentation_date),
      enrollment_date         = COALESCE(excluded.enrollment_date, activity_logs.enrollment_date),
      projected_ap            = COALESCE(excluded.projected_ap, activity_logs.projected_ap),
      raw_audio_transcription = COALESCE(excluded.raw_audio_transcription, activity_logs.raw_audio_transcription),
      ai_structured_notes     = COALESCE(excluded.ai_structured_notes, activity_logs.ai_structured_notes),
      sync_tier_status        = excluded.sync_tier_status,
      next_action_date        = COALESCE(excluded.next_action_date, activity_logs.next_action_date),
      next_action_text        = COALESCE(excluded.next_action_text, activity_logs.next_action_text)
  `).bind(
    log.log_id,
    log.company_id,
    log.contact_id,
    log.timestamp,
    log.is_in_person,
    log.is_initial,
    log.is_dm_contact,
    log.disposition,
    log.presentation_date,
    log.enrollment_date,
    log.projected_ap,
    log.raw_audio_transcription,
    log.ai_structured_notes,
    log.sync_tier_status,
    log.next_action_date,
    log.next_action_text
  ).run();

  return log.log_id;
}

/** True when the FK target exists. Checked up front so we can 400, not 500. */
export async function companyExists(db, companyId) {
  const row = await db.prepare('SELECT 1 AS ok FROM companies WHERE company_id = ? LIMIT 1')
    .bind(companyId)
    .first();
  return Boolean(row);
}

/** The columns every activity view needs, joined to company + contact. */
export const ACTIVITY_SELECT = `
  SELECT
    a.log_id, a.company_id, a.contact_id, a.timestamp,
    a.is_in_person, a.is_initial, a.is_dm_contact, a.disposition,
    a.presentation_date, a.enrollment_date, a.projected_ap,
    a.raw_audio_transcription, a.ai_structured_notes, a.sync_tier_status,
    c.company_name, c.street_1, c.street_2, c.city, c.state, c.zip_code,
    c.lead_source, c.rating, c.employees, c.industry,
    c.sic_code, c.account_number, c.post_enrollment_date,
    c.d365_lead_id, c.d365_checksum, c.d365_modified_on, c.is_d365_synced,
    -- D365 separates the lead's own "Created On" from "Last Activity"; the
    -- Tier 1 clipboard row needs both, and only the touch is on activity_logs.
    c.created_at AS company_created_at,
    ct.first_name, ct.last_name, ct.job_title, ct.phone_number, ct.email_address
  FROM activity_logs a
  JOIN companies c ON c.company_id = a.company_id
  -- Fall back to the account's primary decision maker when the touch itself
  -- names no one. A silent 3-tap log carries no contact_id, and without this
  -- the Tier 1 clipboard row pastes blank Name/Phone/Email columns for an
  -- account whose DM we already know. Mirrors EXPORT_SELECT in routes/exports.js.
  LEFT JOIN contacts ct ON ct.contact_id = COALESCE(
    a.contact_id,
    (SELECT contact_id FROM contacts z
     WHERE z.company_id = a.company_id
     ORDER BY z.is_primary_dm DESC LIMIT 1)
  )
`;
