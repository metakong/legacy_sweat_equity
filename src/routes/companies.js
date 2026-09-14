/**
 * Company + contact CRUD.
 *
 * These back the mobile type-ahead ("have I been here before?"), the desktop
 * route planner's untouched-target list, and net-new scouting from the field.
 */

import { Hono } from 'hono';
import {
  LIMITS,
  RATINGS,
  LEAD_SOURCES,
  DISPOSITIONS,
  asId,
  likePattern
} from '../lib/validate.js';
import {
  ValidationError,
  normalizeCompany,
  normalizeContact,
  upsertCompany,
  upsertContact
} from '../lib/db.js';
import { CompanyMatcher } from '../lib/match.js';
import { geocodeAddress, classifyIndustry } from '../lib/ai.js';
import { businessDate, businessDayRangeUtc } from '../lib/time.js';
import { handleReactivateLead } from './leads.js';

const companies = new Hono();

companies.post('/reactivate', handleReactivateLead);

/**
 * GET /api/companies
 *   ?q=          name / street substring
 *   ?untouched=1 only companies with zero activity_logs rows (route planner)
 *   ?filter=     untouched | follow_ups | all_active
 *   ?rating=Hot  D365 rating filter
 *   ?limit=      1..1000, default 50
 */
companies.get('/', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const url = new URL(c.req.url);
  const q = (url.searchParams.get('q') || '').slice(0, LIMITS.searchQuery).trim();
  const filter = url.searchParams.get('filter');
  const untouched = url.searchParams.get('untouched') === '1' || filter === 'untouched';
  const rating = RATINGS.find((r) => r.toLowerCase() === (url.searchParams.get('rating') || '').toLowerCase());
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 50;
  const offsetRaw = Number(url.searchParams.get('offset'));
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const where = [];
  const binds = [];

  where.push('co.agent_email = ?');
  binds.push(userEmail);

  if (q.length >= 2) {
    where.push('(co.company_name LIKE ? ESCAPE \'\\\' OR co.street_1 LIKE ? ESCAPE \'\\\')');
    binds.push(likePattern(q), likePattern(q));
  }
  if (rating) {
    where.push('co.rating = ?');
    binds.push(rating);
  }

  // Renewal window is evaluated once per request in America/Chicago so the
  // map pins don't flip at 7 PM CDT when UTC midnight crosses the date boundary.
  const todayLocal = businessDate();
  // A company is in its renewal window if its renewal_date falls within 35 days
  // of today.  We compare ISO date strings which sort correctly (zero-padded).
  const [ty, tm, td] = todayLocal.split('-').map(Number);
  const minus35 = new Date(Date.UTC(ty, tm - 1, td - 35)).toISOString().slice(0, 10);
  const terminalDispositions = `'Not Interested', 'Disqualified', 'not_interested', 'appointment_set'`;
  const isEnrolledRenewalActive = `(co.renewal_date IS NOT NULL AND co.renewal_date >= '${minus35}' AND co.renewal_date <= date('${todayLocal}', '+35 days'))`;

  if (untouched) {
    where.push('NOT EXISTS (SELECT 1 FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email)');
  } else if (filter === 'follow_ups') {
    // Has touches, but latest touch is active (or enrolled within the 35-day renewal window)
    where.push(`
      EXISTS (SELECT 1 FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email)
      AND (
        SELECT a.disposition FROM activity_logs a
        WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email
        ORDER BY a.timestamp DESC LIMIT 1
      ) NOT IN (${terminalDispositions})
      AND (
        (
          SELECT a.disposition FROM activity_logs a
          WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email
          ORDER BY a.timestamp DESC LIMIT 1
        ) NOT IN ('Enrolled', 'enrolled')
        OR ${isEnrolledRenewalActive}
      )
    `);
  } else if (filter === 'all_active') {
    // Either untouched or latest disposition is active
    where.push(`
      (
        NOT EXISTS (SELECT 1 FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email)
        OR (
          (
            SELECT a.disposition FROM activity_logs a
            WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email
            ORDER BY a.timestamp DESC LIMIT 1
          ) NOT IN (${terminalDispositions})
          AND (
            (
              SELECT a.disposition FROM activity_logs a
              WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email
              ORDER BY a.timestamp DESC LIMIT 1
            ) NOT IN ('Enrolled', 'enrolled')
            OR ${isEnrolledRenewalActive}
          )
        )
      )
    `);
  }

  const orderClause = filter === 'all_active'
    ? `ORDER BY (SELECT COUNT(*) FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = ? AND a.timestamp >= date(?, '-7 days')) DESC, co.company_name COLLATE NOCASE`
    : `ORDER BY co.company_name COLLATE NOCASE`;

  const sql = `
    SELECT co.company_id, co.company_name, co.street_1, co.street_2, co.city, co.state,
           co.zip_code, co.lat, co.long, co.lead_source, co.rating, co.employees,
           co.industry, co.d365_lead_id, co.is_d365_synced, co.renewal_date, co.created_at,
           -- The field intelligence the agent actually walks in with. Without
           -- these three the import writes a decision maker and a strategy the
           -- UI can never show, which is the same as not storing them at all.
           co.decision_maker, co.company_phone, co.notes,
           (SELECT COUNT(*) FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email) AS touch_count,
           (SELECT MAX(a.timestamp) FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email) AS last_touched,
           (SELECT a.disposition FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email ORDER BY a.timestamp DESC LIMIT 1) AS latest_disposition,
           (SELECT json_extract(a.ai_structured_notes, '$.next_action') FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email AND a.ai_structured_notes IS NOT NULL ORDER BY a.timestamp DESC LIMIT 1) AS latest_next_action,
           (SELECT json_extract(a.ai_structured_notes, '$.product_interests') FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email AND a.ai_structured_notes IS NOT NULL ORDER BY a.timestamp DESC LIMIT 1) AS latest_product_interests,
           (SELECT json_extract(a.ai_structured_notes, '$.objections') FROM activity_logs a WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email AND a.ai_structured_notes IS NOT NULL ORDER BY a.timestamp DESC LIMIT 1) AS latest_objections,
           CASE
             WHEN (
               SELECT a.disposition FROM activity_logs a
               WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email
               ORDER BY a.timestamp DESC LIMIT 1
             ) IN ('Enrolled', 'enrolled')
             AND ${isEnrolledRenewalActive}
             THEN 1
             ELSE 0
           END AS is_renewal_active
    FROM companies co
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ${orderClause}
    LIMIT ? OFFSET ?
  `;

  const queryBinds = filter === 'all_active'
    ? [...binds, userEmail, todayLocal, limit, offset]
    : [...binds, limit, offset];

  const { results } = await c.env.DB.prepare(sql).bind(...queryBinds).all();
  return c.json({ companies: results || [] }, 200, { 'Cache-Control': 'no-store' });
});

/** POST /api/companies — create or merge one account with auto-geocoding. */
companies.post('/', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  // Resolve identity before writing. Scouting the same storefront twice from
  // the field — once from the map, once by typing the name — used to mint two
  // accounts, because this door had no duplicate check of any kind.
  const candidates = await c.env.DB.prepare(
    `SELECT company_id, company_name, street_1, zip_code, account_number, d365_lead_id
     FROM companies WHERE agent_email = ?`
  ).bind(userEmail).all();
  const match = new CompanyMatcher(candidates?.results || []).resolve(body);
  if (match?.ambiguous) {
    return c.json({
      error: 'That name matches more than one existing account. Add a street address to disambiguate.',
      candidates: match.candidates
    }, 409);
  }
  if (match) body.company_id = match.company_id;

  // Auto-geocode if address is present and coordinates are missing
  if ((!body?.lat || !body?.long) && body?.street_1) {
    const fullAddress = [body.street_1, body.city || 'Springfield', body.state || 'MO', body.zip_code]
      .filter(Boolean)
      .join(', ');
    const coords = await geocodeAddress(c.env, fullAddress);
    if (coords) {
      body.lat = coords.lat;
      body.long = coords.long;
    }
  }

  let company;
  try {
    company = normalizeCompany(body);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }

  await upsertCompany(c.env.DB, company, userEmail);

  // A company created from the field usually arrives with the one person the
  // agent actually spoke to attached.
  const contactIds = [];
  const rawContacts = Array.isArray(body?.contacts) ? body.contacts.slice(0, 10) : [];
  for (const rawContact of rawContacts) {
    const contact = normalizeContact(rawContact, company.company_id);
    if (contact) contactIds.push(await upsertContact(c.env.DB, contact, userEmail));
  }

  return c.json({
    success: true,
    company_id: company.company_id,
    merged: Boolean(match),
    contact_ids: contactIds
  });
});

/** GET /api/companies/:id — account detail with contacts and full timeline. */
companies.get('/:id', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const companyId = asId(c.req.param('id'));
  if (!companyId) return c.json({ error: 'Invalid company id' }, 400);

  const company = await c.env.DB
    .prepare('SELECT * FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1')
    .bind(companyId, userEmail)
    .first();

  if (!company) return c.json({ error: 'Company not found' }, 404);

  const [{ results: contacts }, { results: activity }] = await Promise.all([
    c.env.DB.prepare(
      'SELECT * FROM contacts WHERE company_id = ? AND agent_email = ? ORDER BY is_primary_dm DESC, last_name COLLATE NOCASE'
    ).bind(companyId, userEmail).all(),
    c.env.DB.prepare(
      `SELECT log_id, contact_id, timestamp, is_in_person, is_initial, is_dm_contact,
              disposition, presentation_date, enrollment_date, projected_ap,
              raw_audio_transcription, ai_structured_notes, sync_tier_status
       FROM activity_logs WHERE company_id = ? AND agent_email = ? ORDER BY timestamp DESC LIMIT 50`
    ).bind(companyId, userEmail).all()
  ]);

  return c.json(
    { company, contacts: contacts || [], activity: activity || [] },
    200,
    { 'Cache-Control': 'no-store' }
  );
});

/**
 * Shared import handler for batched company + contact ingestion.
 *
 * IDENTITY FIRST, THEN ENRICHMENT.
 *
 * The 2026-09-01 incident: this handler used to look for an existing row only
 * when the payload carried BOTH a company_name and a street_1 —
 *
 *     else if (raw.company_name && raw.street_1) { ...lookup... }
 *
 * A notes-only enrichment pass has no street, so the lookup never ran, every
 * record fell through to a fresh crypto.randomUUID(), and ON CONFLICT could
 * not fire on an id that had never existed. 50 of 50 records duplicated.
 *
 * Identity is now resolved by CompanyMatcher (src/lib/match.js) over several
 * tiers of evidence, and a payload that matches nothing is the ONLY thing that
 * creates a row. The matcher is also updated as rows are written, so two
 * entries naming the same business inside one batch merge instead of racing.
 */
export async function handleImport(c) {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const allCompanies = Array.isArray(body?.companies) ? body.companies : [];
  if (allCompanies.length === 0) {
    return c.json({ error: 'No companies to import' }, 400);
  }

  // Bounded because each net-new row costs a geocode plus an AI classification
  // subrequest. The overflow is REPORTED, never dropped in silence: the old
  // `.slice(0, 50)` sent 63 targets, imported 50, answered `imported: 50` with
  // no error, and 12 real prospects were never seen again.
  const rawCompanies = allCompanies.slice(0, LIMITS.importBatch);
  const notProcessed = allCompanies.slice(LIMITS.importBatch)
    .map((r) => r?.company_name || '(unnamed)');

  // --- IDENTITY RESOLUTION INDEX ---
  // lat/long/industry come back too so an already-geocoded, already-classified
  // account does not pay for a second geocode and a second model call on every
  // re-import.
  const existing = await c.env.DB.prepare(
    `SELECT company_id, company_name, street_1, zip_code, account_number,
            d365_lead_id, lat, long, industry
     FROM companies WHERE agent_email = ?`
  ).bind(userEmail).all();

  const existingRows = existing?.results || [];
  const matcher = new CompanyMatcher(existingRows);
  const byId = new Map(existingRows.map((row) => [row.company_id, row]));

  let created = 0;
  let merged = 0;
  let geocoded = 0;
  let contactCount = 0;
  const skipped = [];
  const ambiguous = [];

  for (const raw of rawCompanies) {
    try {
      // 1. IDENTITY
      const match = matcher.resolve(raw);

      if (match?.ambiguous) {
        // Several real accounts carry this name and the payload gives nothing
        // to separate them. Creating a third row would be wrong and picking
        // one at random would be worse, so hand the decision back.
        ambiguous.push({
          company_name: raw?.company_name || '(unknown)',
          reason: 'Name matches more than one existing account; add a street or account_number',
          candidates: match.candidates
        });
        continue;
      }

      const existingRow = match ? byId.get(match.company_id) : null;
      if (match) raw.company_id = match.company_id;

      // 2. GEOCODE — only when we still lack coordinates for this account.
      const needsGeocode = !existingRow?.lat || !existingRow?.long;
      if (needsGeocode && (!raw?.lat || !raw?.long) && raw?.street_1) {
        const fullAddress = [raw.street_1, raw.city || 'Springfield', raw.state || 'MO', raw.zip_code]
          .filter(Boolean)
          .join(', ');
        const coords = await geocodeAddress(c.env, fullAddress);
        if (coords) {
          raw.lat = coords.lat;
          raw.long = coords.long;
          geocoded += 1;
        }
      }

      // 3. INDUSTRY — only when D365 did not supply one and we do not already
      // hold one. Never overwrite a curated SIC/Industry string with an AI
      // guess; that destroys CRM data on every re-import.
      if (raw?.company_name && !raw?.industry && !existingRow?.industry) {
        try {
          raw.industry = (await classifyIndustry(raw.company_name, c.env)) || 'Other Commercial';
        } catch {
          raw.industry = 'Other Commercial';
        }
      }

      // 4. WRITE
      const company = normalizeCompany(raw);
      await upsertCompany(c.env.DB, company, userEmail);
      if (match) merged += 1; else created += 1;

      // Keep the index live so a later entry in this same batch resolves to
      // the row we just wrote instead of creating its own.
      const writtenRow = {
        company_id: company.company_id,
        company_name: company.company_name,
        street_1: company.street_1 ?? existingRow?.street_1 ?? null,
        zip_code: company.zip_code ?? existingRow?.zip_code ?? null,
        account_number: company.account_number ?? existingRow?.account_number ?? null,
        d365_lead_id: company.d365_lead_id ?? existingRow?.d365_lead_id ?? null,
        lat: existingRow?.lat ?? company.lat ?? null,
        long: existingRow?.long ?? company.long ?? null,
        industry: existingRow?.industry ?? company.industry ?? null
      };
      matcher.add(writtenRow);
      byId.set(company.company_id, writtenRow);

      // 5. CONTACTS — attached to the RESOLVED account. Before the fix these
      // hung off the duplicate that had just been minted, which is how 45
      // decision makers ended up on rows the agent never sees.
      const rawContacts = Array.isArray(raw?.contacts) ? raw.contacts.slice(0, 20) : [];
      for (const rawContact of rawContacts) {
        const contact = normalizeContact(rawContact, company.company_id);
        if (contact) {
          await upsertContact(c.env.DB, contact, userEmail);
          contactCount += 1;
        }
      }
    } catch (err) {
      // A swallowed error is how the last data-integrity bug stayed invisible:
      // the response said success either way. The real message goes into the
      // payload (single-tenant app behind Cloudflare Access) and to the log, so
      // a schema drift or a bad row is diagnosable from the response alone.
      if (!(err instanceof ValidationError)) console.error('import row failed', err);
      skipped.push({
        company_name: raw?.company_name || '(unknown)',
        reason: err instanceof ValidationError ? err.message : `Unexpected error: ${err?.message || err}`
      });
    }
  }

  return c.json({
    success: skipped.length === 0,
    received: allCompanies.length,
    imported: created + merged,
    created,
    merged,
    contacts: contactCount,
    geocoded,
    skipped,
    ambiguous,
    not_processed: notProcessed
  });
}

/**
 * POST /api/companies/import — batched company + contact ingestion for the D365 importer.
 */
companies.post('/import', handleImport);

/** Mounted separately at /api/import. */
export const importRouter = new Hono();
importRouter.post('/', handleImport);

export default companies;

/** Mounted separately at /api/contacts. */
export const contacts = new Hono();

/** POST /api/contacts — attach or update a person on an account. */
contacts.post('/', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  let contact;
  try {
    contact = normalizeContact(body, null);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (!contact) return c.json({ error: 'Contact needs at least a name or a job title' }, 400);

  await upsertContact(c.env.DB, contact, userEmail);
  return c.json({ success: true, contact_id: contact.contact_id });
});

/**
 * Mounted at /api/enums — the option sets the UI renders, served from the
 * single source of truth so a dropdown can never drift from what the API
 * accepts.
 */
export const enums = new Hono();
enums.get('/', (c) => c.json({
  ratings: RATINGS,
  dispositions: DISPOSITIONS,
  lead_sources: LEAD_SOURCES
}, 200, { 'Cache-Control': 'public, max-age=300' }));
