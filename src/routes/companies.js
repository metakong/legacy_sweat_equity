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
import { geocodeAddress, classifyIndustry } from '../lib/ai.js';
import { businessDate, businessDayRangeUtc } from '../lib/time.js';

const companies = new Hono();

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

  const sql = `
    SELECT co.company_id, co.company_name, co.street_1, co.street_2, co.city, co.state,
           co.zip_code, co.lat, co.long, co.lead_source, co.rating, co.employees,
           co.industry, co.d365_lead_id, co.is_d365_synced, co.renewal_date, co.created_at,
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
    ORDER BY (SELECT COUNT(*) FROM activity_logs a LEFT JOIN companies c ON a.company_id = c.company_id WHERE a.company_id = co.company_id AND a.agent_email = co.agent_email AND a.timestamp >= date(?, '-7 days')) DESC, co.company_name COLLATE NOCASE
    LIMIT ?
  `;

  const { results } = await c.env.DB.prepare(sql).bind(...binds, todayLocal, limit).all();
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

  return c.json({ success: true, company_id: company.company_id, contact_ids: contactIds });
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
 * Shared import handler for batched company + contact ingestion with auto-geocoding.
 */
export async function handleImport(c) {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const rawCompanies = Array.isArray(body?.companies) ? body.companies.slice(0, 50) : [];
  if (rawCompanies.length === 0) {
    return c.json({ error: 'No companies to import' }, 400);
  }

  // --- PRE-FLIGHT DEDUPLICATION ---
  const existing = await c.env.DB.prepare('SELECT company_id, company_name, street_1, account_number FROM companies WHERE agent_email = ?').bind(userEmail).all();
  const normalizeKey = (n, s) => (String(n || '') + '|' + String(s || '')).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  
  const exactMap = new Map();
  const fuzzyMap = new Map();
  
  if (existing.results) {
    for (const row of existing.results) {
      if (row.account_number) exactMap.set(row.account_number, row.company_id);
      if (row.company_name && row.street_1) {
        fuzzyMap.set(normalizeKey(row.company_name, row.street_1), row.company_id);
      }
    }
  }

  let imported = 0;
  let geocoded = 0;
  let contactCount = 0;
  const skipped = [];

  for (const raw of rawCompanies) {
    try {
      // 1. DEDUPLICATION
      if (raw.account_number && exactMap.has(raw.account_number)) {
        raw.company_id = exactMap.get(raw.account_number);
      } else if (raw.company_name && raw.street_1) {
        const fuzzyKey = normalizeKey(raw.company_name, raw.street_1);
        if (fuzzyMap.has(fuzzyKey)) {
          raw.company_id = fuzzyMap.get(fuzzyKey);
        }
      }

      // Auto-geocode if address is present and coordinates are missing
      if ((!raw?.lat || !raw?.long) && raw?.street_1) {
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

      // AI Industry Classification — only run when D365 did not supply one.
      // Never overwrite a valid SIC/Industry string from a D365 export with
      // an AI guess; that destroys curated CRM data on every re-import.
      if (raw?.company_name && !raw?.industry) {
        try {
          const aiIndustry = await classifyIndustry(raw.company_name, c.env);
          if (aiIndustry) {
            raw.industry = aiIndustry;
          } else {
            raw.industry = 'Other Commercial';
          }
        } catch {
          raw.industry = 'Other Commercial';
        }
      }

      const company = normalizeCompany(raw);
      await upsertCompany(c.env.DB, company, userEmail);
      imported += 1;

      // Insert nested contacts
      const rawContacts = Array.isArray(raw?.contacts) ? raw.contacts.slice(0, 20) : [];
      for (const rawContact of rawContacts) {
        const contact = normalizeContact(rawContact, company.company_id);
        if (contact) {
          await upsertContact(c.env.DB, contact, userEmail);
          contactCount += 1;
        }
      }
    } catch (err) {
      skipped.push({
        company_name: raw?.company_name || '(unknown)',
        reason: err instanceof ValidationError ? err.message : 'Unexpected error'
      });
    }
  }

  return c.json({
    success: true,
    imported,
    contacts: contactCount,
    geocoded,
    skipped
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
