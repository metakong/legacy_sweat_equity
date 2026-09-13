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
  PIPELINE_STAGES,
  STAGE_RANKS,
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
import { encodeGeohash } from './geo.js';

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
 * True only when a caller actually supplied a value, as opposed to omitting
 * the key or sending an empty string. This is what separates "set status to
 * ACTIVE" from "I did not mention status at all" on an upsert.
 */
function isSupplied(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Validate and coerce a company payload into bindable primitives.
 * Throws ValidationError only for the two fields we genuinely cannot invent.
 */
export function normalizeCompany(raw) {
  const companyName = cleanCapped(raw?.company_name, LIMITS.companyName);
  if (!companyName) throw new ValidationError('company_name is required');

  const companyId = asId(raw?.company_id) || crypto.randomUUID();

  // Both the terse and the descriptive coordinate aliases are accepted so the
  // radar route, the markdown ingestion scripts, and the field PWA can post
  // `lat`/`long`, `lat`/`lng`, or `latitude`/`longitude` without a shim layer.
  const latitude = asLatitude(raw?.lat ?? raw?.latitude);
  const longitude = asLongitude(raw?.long ?? raw?.lng ?? raw?.longitude);

  // V2 Agency OS fields. Each normalized value carries a non-null default so a
  // brand-new row satisfies its NOT NULL columns, but each also records a 0/1
  // presence flag: upsertCompany needs to know whether the caller actually
  // supplied the field before it overwrites a value that is already on the row.
  const currentVoluntaryCarrier = cleanCapped(raw?.current_voluntary_carrier, 120) || 'None';
  const majorMedicalCarrier = cleanCapped(raw?.major_medical_carrier, 120) || null;
  const isHdhp = toBool(raw?.is_hdhp, 0);
  const estimatedW2Count = asCount(raw?.estimated_w2_count, 5_000_000) ?? 0;
  const confidenceScore = asCount(raw?.confidence_score, 100) ?? 30;
  const status = (cleanCapped(raw?.status, 32) || 'ACTIVE').toUpperCase();

  return {
    company_id: companyId,
    d365_lead_id: cleanCapped(raw?.d365_lead_id, LIMITS.d365Id) || null,
    d365_checksum: cleanCapped(raw?.d365_checksum, LIMITS.checksum) || null,
    d365_modified_on: cleanCapped(raw?.d365_modified_on, 64) || null,
    company_name: companyName,
    street_1: cleanCapped(raw?.street_1, LIMITS.street) || null,
    street_2: cleanCapped(raw?.street_2, LIMITS.street) || null,
    city: cleanCapped(raw?.city, LIMITS.city) || null,
    state: cleanCapped(raw?.state, LIMITS.state) || null,
    zip_code: cleanCapped(raw?.zip_code, LIMITS.zip) || null,
    lat: latitude,
    long: longitude,
    lead_source: matchEnum(raw?.lead_source, LEAD_SOURCES) || null,
    rating: matchEnum(raw?.rating, RATINGS) || null,
    employees: asCount(raw?.employees, 5_000_000) ?? null,
    industry: cleanCapped(raw?.industry, LIMITS.industry) || null,
    sic_code: cleanCapped(raw?.sic_code, 16) || null,
    account_number: cleanCapped(raw?.account_number, 64) || null,
    post_enrollment_date: asIsoDate(raw?.post_enrollment_date) || null,
    renewal_date: asIsoDate(raw?.renewal_date) || null,
    pipeline_stage: matchEnum(raw?.pipeline_stage, PIPELINE_STAGES) || null,
    stage_entered_at: asIsoDate(raw?.stage_entered_at) || null,
    snoozed_until: asIsoDate(raw?.snoozed_until) || null,
    disqualified_reason: cleanCapped(raw?.disqualified_reason, 500) || null,
    forecast_ap: asMoney(raw?.forecast_ap) ?? null,
    forecast_confidence: asCount(raw?.forecast_confidence, 100) ?? null,
    // Field intelligence. `custom_1` / `custom_2` are the column names the
    // markdown ingestion scripts emit; they are accepted as aliases so an
    // existing importer keeps working, but the canonical names win.
    company_phone: cleanCapped(raw?.company_phone ?? raw?.phone_number, LIMITS.phone) || null,
    decision_maker: cleanCapped(raw?.decision_maker ?? raw?.custom_1, LIMITS.decisionMaker) || null,
    notes: cleanCapped(raw?.notes ?? raw?.custom_2, LIMITS.notes, { allowNewlines: true }) || null,
    // --- V2 Agency OS: Section 125, confidence, and spatial fields ---
    current_voluntary_carrier: currentVoluntaryCarrier,
    major_medical_carrier: majorMedicalCarrier,
    is_hdhp: isHdhp,
    estimated_w2_count: estimatedW2Count,
    confidence_score: confidenceScore,
    // Derived, never trusted from the caller: a hash supplied alongside a
    // mismatched coordinate pair would file the account in the wrong cell and
    // make it invisible to the radar that is supposed to find it.
    geohash: latitude !== null && longitude !== null
      ? encodeGeohash(latitude, longitude, 7)
      : null,
    status,
    // Sprint 6 — the live callback commitment (migrations/0006). Both are
    // nullable with no non-null default, so a payload that omits them keeps
    // whatever the row already holds rather than manufacturing a value.
    next_action: cleanCapped(raw?.next_action ?? raw?.next_action_text, 240) || null,
    next_action_date: asIsoDate(raw?.next_action_date) || null,
    // Presence flags for upsertCompany. Numbers only — D1 cannot bind a
    // boolean, and normalizeCompany is contractually primitives-only.
    __has_current_voluntary_carrier: isSupplied(raw?.current_voluntary_carrier) ? 1 : 0,
    __has_major_medical_carrier: isSupplied(raw?.major_medical_carrier) ? 1 : 0,
    __has_is_hdhp: isSupplied(raw?.is_hdhp) ? 1 : 0,
    __has_estimated_w2_count: isSupplied(raw?.estimated_w2_count) ? 1 : 0,
    __has_confidence_score: isSupplied(raw?.confidence_score) ? 1 : 0,
    __has_status: isSupplied(raw?.status) ? 1 : 0,
    __has_next_action: isSupplied(raw?.next_action ?? raw?.next_action_text) ? 1 : 0,
    __has_next_action_date: isSupplied(raw?.next_action_date) ? 1 : 0,
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
export async function upsertCompany(db, company, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  await db.prepare(`
    INSERT INTO companies (
      company_id, d365_lead_id, d365_checksum, d365_modified_on, company_name,
      street_1, street_2, city, state, zip_code, lat, long,
      lead_source, rating, employees, industry,
      sic_code, account_number, post_enrollment_date,
      renewal_date, pipeline_stage, stage_entered_at, snoozed_until,
      disqualified_reason, forecast_ap, forecast_confidence, is_d365_synced,
      company_phone, decision_maker, notes,
      current_voluntary_carrier, major_medical_carrier, is_hdhp,
      estimated_w2_count, confidence_score, geohash, status,
      next_action, next_action_date,
      agent_email
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(company_id, agent_email) DO UPDATE SET
      d365_lead_id        = COALESCE(excluded.d365_lead_id, companies.d365_lead_id),
      d365_checksum       = COALESCE(excluded.d365_checksum, companies.d365_checksum),
      d365_modified_on    = COALESCE(excluded.d365_modified_on, companies.d365_modified_on),
      company_name        = excluded.company_name,
      street_1            = COALESCE(excluded.street_1, companies.street_1),
      street_2            = COALESCE(excluded.street_2, companies.street_2),
      city                = COALESCE(excluded.city, companies.city),
      state               = COALESCE(excluded.state, companies.state),
      zip_code            = COALESCE(excluded.zip_code, companies.zip_code),
      -- Incoming coordinates win when they are actually supplied; a payload
      -- that omits them (excluded.* IS NULL) still keeps what we hold. The
      -- old order was existing-first, which meant a row geocoded to the wrong
      -- rooftop could never be corrected through ANY import path — the agent
      -- had to edit D1 by hand. handleImport only geocodes accounts that lack
      -- coordinates, so this does not re-geocode on every re-import.
      lat                 = COALESCE(excluded.lat, companies.lat),
      long                = COALESCE(excluded.long, companies.long),
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
      is_d365_synced      = MAX(excluded.is_d365_synced, companies.is_d365_synced),
      company_phone       = COALESCE(excluded.company_phone, companies.company_phone),
      decision_maker      = COALESCE(excluded.decision_maker, companies.decision_maker),
      -- Notes ACCUMULATE. Each enrichment pass is a new observation about a
      -- live account, not a correction of the last one, so overwriting would
      -- destroy the history the agent is actually working from. The instr()
      -- guard keeps this idempotent: re-running the same import appends
      -- nothing, so a retried batch cannot balloon the field.
      notes = CASE
        WHEN excluded.notes IS NULL OR TRIM(excluded.notes) = '' THEN companies.notes
        WHEN companies.notes IS NULL OR TRIM(companies.notes) = '' THEN excluded.notes
        WHEN instr(companies.notes, excluded.notes) > 0 THEN companies.notes
        ELSE companies.notes || char(10) || char(10) || excluded.notes
      END,
      -- V2 Agency OS fields. The defaults above keep a NEW row valid, so the
      -- presence flags below are what stop a quick field re-log from resetting
      -- a phone-verified confidence score back to 30 or clearing a
      -- DO_NOT_CONTACT suppression. Bind order: the six flags are positional
      -- parameters appearing after the 38 INSERT values.
      current_voluntary_carrier = CASE WHEN ? = 1 THEN excluded.current_voluntary_carrier ELSE companies.current_voluntary_carrier END,
      major_medical_carrier     = CASE WHEN ? = 1 THEN excluded.major_medical_carrier     ELSE companies.major_medical_carrier     END,
      is_hdhp                   = CASE WHEN ? = 1 THEN excluded.is_hdhp                   ELSE companies.is_hdhp                   END,
      estimated_w2_count        = CASE WHEN ? = 1 THEN excluded.estimated_w2_count        ELSE companies.estimated_w2_count        END,
      confidence_score          = CASE WHEN ? = 1 THEN excluded.confidence_score          ELSE companies.confidence_score          END,
      status                    = CASE WHEN ? = 1 THEN excluded.status                    ELSE companies.status                    END,
      -- Sprint 6 callback pointer. Same presence-guard contract: only a payload
      -- that actually carried a commitment may move the pointer.
      next_action               = CASE WHEN ? = 1 THEN excluded.next_action               ELSE companies.next_action               END,
      next_action_date          = CASE WHEN ? = 1 THEN excluded.next_action_date          ELSE companies.next_action_date          END,
      -- Spatial: a full coordinate pair re-derives the hash, a payload with no
      -- coordinates leaves it alone, and a HALF-supplied pair clears it rather
      -- than leaving a hash that no longer describes where the account is.
      geohash = CASE
        WHEN excluded.lat IS NOT NULL AND excluded.long IS NOT NULL THEN excluded.geohash
        WHEN excluded.lat IS NULL     AND excluded.long IS NULL     THEN companies.geohash
        ELSE NULL
      END
  `).bind(
    company.company_id,
    company.d365_lead_id ?? null,
    company.d365_checksum ?? null,
    company.d365_modified_on ?? null,
    company.company_name,
    company.street_1 ?? null,
    company.street_2 ?? null,
    company.city ?? null,
    company.state ?? null,
    company.zip_code ?? null,
    company.lat ?? null,
    company.long ?? null,
    company.lead_source ?? null,
    company.rating ?? null,
    company.employees ?? null,
    company.industry ?? null,
    company.sic_code ?? null,
    company.account_number ?? null,
    company.post_enrollment_date ?? null,
    company.renewal_date ?? null,
    company.pipeline_stage ?? null,
    company.stage_entered_at ?? null,
    company.snoozed_until ?? null,
    company.disqualified_reason ?? null,
    company.forecast_ap ?? null,
    company.forecast_confidence ?? null,
    company.is_d365_synced ?? 0,
    company.company_phone ?? null,
    company.decision_maker ?? null,
    company.notes ?? null,
    // V2 Agency OS columns.
    company.current_voluntary_carrier ?? 'None',
    company.major_medical_carrier ?? null,
    company.is_hdhp ?? 0,
    company.estimated_w2_count ?? 0,
    company.confidence_score ?? 30,
    company.geohash ?? null,
    company.status ?? 'ACTIVE',
    company.next_action ?? null,
    company.next_action_date ?? null,
    userEmail,
    // Presence flags consumed by the CASE expressions above, in order.
    company.__has_current_voluntary_carrier ?? 0,
    company.__has_major_medical_carrier ?? 0,
    company.__has_is_hdhp ?? 0,
    company.__has_estimated_w2_count ?? 0,
    company.__has_confidence_score ?? 0,
    company.__has_status ?? 0,
    company.__has_next_action ?? 0,
    company.__has_next_action_date ?? 0
  ).run();

  return company.company_id;
}

/** Move a company's D365 Rating without touching anything else. */
export async function setCompanyRating(db, companyId, rating, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  const canonical = matchEnum(rating, RATINGS);
  if (!canonical) return null;
  await db.prepare('UPDATE companies SET rating = ? WHERE company_id = ? AND agent_email = ?')
    .bind(canonical, companyId, userEmail)
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
export async function setCompanyRenewalDate(db, companyId, renewalDate, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  const date = asIsoDate(renewalDate);
  if (!date || !companyId) return null;
  await db.prepare('UPDATE companies SET renewal_date = ? WHERE company_id = ? AND agent_email = ?')
    .bind(date, companyId, userEmail)
    .run();
  return date;
}

// ---------------------------------------------------------------------
// PIPELINE STATE TRANSITIONS & INFERENCE
// ---------------------------------------------------------------------

/**
 * Deduce target pipeline stage based on the touch outcome and contact status.
 * Returns the target canonical stage or null if no advancement is indicated.
 */
export function inferTargetPipelineStage(currentStage, disposition, isDmContact) {
  if (!disposition) return null;
  const cur = currentStage || 'PROSPECT';
  const curRank = STAGE_RANKS[cur] || 1;

  if (disposition === 'Enrolled') {
    return 'CLOSED_WON';
  }
  if (disposition === 'Not Interested') {
    return 'CLOSED_LOST';
  }
  if (disposition === 'Disqualified') {
    return 'DISQUALIFIED';
  }
  if (disposition === 'Presentation Scheduled') {
    if (curRank < STAGE_RANKS['PROPOSAL']) {
      return 'PROPOSAL';
    }
  }
  if (toBool(isDmContact) === 1) {
    if (curRank < STAGE_RANKS['QUALIFIED']) {
      return 'QUALIFIED';
    }
  }
  if (['Information Left', 'Gatekeeper Blocked'].includes(disposition)) {
    if (cur === 'PROSPECT') {
      return 'ENGAGED';
    }
  }

  return null;
}

/**
 * Update company pipeline stage and record an audit event in pipeline_events,
 * enforcing forward-only transitions (unless transitioning to a terminal state).
 */
export async function autoAdvancePipelineStage(db, companyId, targetStage, userEmail, logId = null, reason = 'Auto-inferred from field touch') {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  if (!db || !companyId || !targetStage) return null;
  const canonicalStage = matchEnum(targetStage, PIPELINE_STAGES);
  if (!canonicalStage) return null;

  const current = await db.prepare(
    'SELECT pipeline_stage FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1'
  ).bind(companyId, userEmail).first();

  if (!current) return null;

  const fromStage = current.pipeline_stage || 'PROSPECT';
  const fromRank = STAGE_RANKS[fromStage] || 1;
  const toRank = STAGE_RANKS[canonicalStage] || 1;

  const isTerminal = ['CLOSED_WON', 'CLOSED_LOST', 'DISQUALIFIED'].includes(canonicalStage);
  if (fromStage === canonicalStage) return null;
  if (!isTerminal && toRank <= fromRank) return null;

  const eventId = crypto.randomUUID();

  await db.prepare(`
    UPDATE companies
    SET pipeline_stage = ?,
        stage_entered_at = datetime('now')
    WHERE company_id = ? AND agent_email = ?
  `).bind(canonicalStage, companyId, userEmail).run();

  await db.prepare(`
    INSERT INTO pipeline_events (event_id, company_id, from_stage, to_stage, changed_at, trigger_log_id, reason, agent_email)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
  `).bind(eventId, companyId, fromStage, canonicalStage, logId ?? null, reason ?? null, userEmail).run();

  return { event_id: eventId, company_id: companyId, from_stage: fromStage, to_stage: canonicalStage };
}

/**
 * Explicit/manual pipeline state mutation endpoint helper.
 */
export async function transitionPipelineStage(db, { companyId, toStage, reason = null, forecastAp = null, forecastConfidence = null, triggerLogId = null, userEmail }) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  const canonicalStage = matchEnum(toStage, PIPELINE_STAGES);
  if (!canonicalStage) throw new ValidationError(`Invalid pipeline stage. Must be one of: ${PIPELINE_STAGES.join(', ')}`);
  if (!companyId) throw new ValidationError('company_id is required');

  const current = await db.prepare(
    'SELECT pipeline_stage, forecast_ap, forecast_confidence FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1'
  ).bind(companyId, userEmail).first();

  if (!current) throw new ValidationError('Company not found');

  const fromStage = current.pipeline_stage || 'PROSPECT';
  const eventId = crypto.randomUUID();

  const validatedAp = asMoney(forecastAp);
  const validatedConf = asCount(forecastConfidence, 100);
  const cleanReason = cleanCapped(reason, 200);

  await db.prepare(`
    UPDATE companies
    SET pipeline_stage = ?,
        stage_entered_at = datetime('now'),
        forecast_ap = COALESCE(?, forecast_ap),
        forecast_confidence = COALESCE(?, forecast_confidence),
        disqualified_reason = ?
    WHERE company_id = ? AND agent_email = ?
  `).bind(
    canonicalStage,
    validatedAp,
    validatedConf,
    canonicalStage === 'DISQUALIFIED' ? cleanReason : null,
    companyId,
    userEmail
  ).run();

  await db.prepare(`
    INSERT INTO pipeline_events (event_id, company_id, from_stage, to_stage, changed_at, trigger_log_id, reason, agent_email)
    VALUES (?, ?, ?, ?, datetime('now'), NULL, ?, ?)
  `).bind(eventId, companyId, fromStage, canonicalStage, cleanReason, userEmail).run();

  return {
    event_id: eventId,
    company_id: companyId,
    from_stage: fromStage,
    to_stage: canonicalStage,
    forecast_ap: validatedAp !== null ? validatedAp : current.forecast_ap,
    forecast_confidence: validatedConf !== null ? validatedConf : current.forecast_confidence,
    reason: cleanReason
  };
}

/**
 * Snooze a company until a given date. Passing null or empty string un-snoozes.
 */
export async function snoozeCompany(db, companyId, untilDate, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  if (!companyId) throw new ValidationError('company_id is required');
  const until = untilDate ? asIsoDate(untilDate) : null;
  if (untilDate && !until) throw new ValidationError('Invalid date format for until (YYYY-MM-DD expected)');

  const exists = await db.prepare('SELECT company_id FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1').bind(companyId, userEmail).first();
  if (!exists) throw new ValidationError('Company not found');

  await db.prepare('UPDATE companies SET snoozed_until = ? WHERE company_id = ? AND agent_email = ?').bind(until, companyId, userEmail).run();
  return { company_id: companyId, snoozed_until: until };
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
    first_name: firstName || null,
    last_name: lastName || null,
    job_title: jobTitle || null,
    phone_number: cleanCapped(raw?.phone_number, LIMITS.phone) || null,
    // Store only what looks like an address; a mis-transcribed one poisons a
    // D365 import far more expensively than a blank does.
    email_address: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    is_primary_dm: toBool(raw?.is_primary_dm, 1)
  };
}

export async function findExistingContact(db, companyId, firstName, lastName, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  if (!db || !companyId || (!firstName && !lastName)) return null;
  const fn = firstName ? firstName.trim().toLowerCase() : '';
  const ln = lastName ? lastName.trim().toLowerCase() : '';

  if (fn && ln) {
    const row = await db.prepare(`
      SELECT contact_id FROM contacts
      WHERE company_id = ? AND agent_email = ? AND LOWER(TRIM(first_name)) = ? AND LOWER(TRIM(last_name)) = ?
      LIMIT 1
    `).bind(companyId, userEmail, fn, ln).first();
    if (row?.contact_id) return row.contact_id;
  } else if (fn) {
    const row = await db.prepare(`
      SELECT contact_id FROM contacts
      WHERE company_id = ? AND agent_email = ? AND LOWER(TRIM(first_name)) = ? AND (last_name IS NULL OR TRIM(last_name) = '')
      LIMIT 1
    `).bind(companyId, userEmail, fn).first();
    if (row?.contact_id) return row.contact_id;
  } else if (ln) {
    const row = await db.prepare(`
      SELECT contact_id FROM contacts
      WHERE company_id = ? AND agent_email = ? AND (first_name IS NULL OR TRIM(first_name) = '') AND LOWER(TRIM(last_name)) = ?
      LIMIT 1
    `).bind(companyId, userEmail, ln).first();
    if (row?.contact_id) return row.contact_id;
  }
  return null;
}

export async function upsertContact(db, contact, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  // Composite key deduplication: if this contact already exists under the company,
  // reuse its contact_id so the write updates rather than duplicates.
  if (contact.company_id && (contact.first_name || contact.last_name)) {
    const existingId = await findExistingContact(db, contact.company_id, contact.first_name, contact.last_name, userEmail);
    if (existingId) {
      contact.contact_id = existingId;
    }
  }

  await db.prepare(`
    INSERT INTO contacts (
      contact_id, company_id, first_name, last_name, job_title,
      phone_number, email_address, is_primary_dm, agent_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id, agent_email) DO UPDATE SET
      first_name    = COALESCE(excluded.first_name, contacts.first_name),
      last_name     = COALESCE(excluded.last_name, contacts.last_name),
      job_title     = COALESCE(excluded.job_title, contacts.job_title),
      phone_number  = COALESCE(excluded.phone_number, contacts.phone_number),
      email_address = COALESCE(excluded.email_address, contacts.email_address),
      is_primary_dm = excluded.is_primary_dm
  `).bind(
    contact.contact_id,
    contact.company_id,
    contact.first_name ?? null,
    contact.last_name ?? null,
    contact.job_title ?? null,
    contact.phone_number ?? null,
    contact.email_address ?? null,
    contact.is_primary_dm ?? 0,
    userEmail
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
    contact_id: asId(raw?.contact_id) || null,
    // Client-supplied timestamps let a queue drained three hours later still
    // land on the hour the door was actually knocked. Normalized to D1's own
    // 'YYYY-MM-DD HH:MM:SS' so date filters (string comparisons) stay sound.
    timestamp: toSqlTimestamp(raw?.timestamp),
    ...booleans,
    disposition: matchEnum(raw?.disposition, DISPOSITIONS) || deriveDisposition(booleans),
    presentation_date: asIsoDate(raw?.presentation_date) || null,
    enrollment_date: asIsoDate(raw?.enrollment_date) || null,
    projected_ap: asMoney(raw?.projected_ap) ?? null,
    raw_audio_transcription: cleanCapped(raw?.raw_audio_transcription, LIMITS.transcript, { allowNewlines: true }) || null,
    ai_structured_notes: typeof notes === 'string'
      ? cleanCapped(notes, LIMITS.notes, { allowNewlines: true }) || null
      : (notes ? JSON.stringify(notes).slice(0, LIMITS.notes) : null),
    sync_tier_status: matchEnum(raw?.sync_tier_status, SYNC_TIERS) || 'PENDING',
    next_action_date: asIsoDate(raw?.next_action_date) || null,
    next_action_text: cleanCapped(raw?.next_action_text, 300) || null
  };
}

/**
 * Idempotent by log_id: the offline queue retries the same client-generated id
 * after a dropped connection, and that must update rather than duplicate.
 */
export async function upsertActivityLog(db, log, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  await db.prepare(`
    INSERT INTO activity_logs (
      log_id, company_id, contact_id, timestamp,
      is_in_person, is_initial, is_dm_contact, disposition,
      presentation_date, enrollment_date, projected_ap,
      raw_audio_transcription, ai_structured_notes, sync_tier_status,
      next_action_date, next_action_text, agent_email
    ) VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(log_id, agent_email) DO UPDATE SET
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
    log.contact_id ?? null,
    log.timestamp ?? null,
    log.is_in_person ?? 0,
    log.is_initial ?? 0,
    log.is_dm_contact ?? 0,
    log.disposition,
    log.presentation_date ?? null,
    log.enrollment_date ?? null,
    log.projected_ap ?? null,
    log.raw_audio_transcription ?? null,
    log.ai_structured_notes ?? null,
    log.sync_tier_status || 'PENDING',
    log.next_action_date ?? null,
    log.next_action_text ?? null,
    userEmail
  ).run();

  return log.log_id;
}

/** True when the FK target exists. Checked up front so we can 400, not 500. */
export async function companyExists(db, companyId, userEmail) {
  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';
  const row = await db.prepare('SELECT 1 AS ok FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1')
    .bind(companyId, userEmail)
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
