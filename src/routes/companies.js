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
  const url = new URL(c.req.url);
  const q = (url.searchParams.get('q') || '').slice(0, LIMITS.searchQuery).trim();
  const filter = url.searchParams.get('filter');
  const untouched = url.searchParams.get('untouched') === '1' || filter === 'untouched';
  const rating = RATINGS.find((r) => r.toLowerCase() === (url.searchParams.get('rating') || '').toLowerCase());
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 50;

  const where = [];
  const binds = [];

  if (q.length >= 2) {
    where.push('(co.company_name LIKE ? ESCAPE \'\\\' OR co.street_1 LIKE ? ESCAPE \'\\\')');
    binds.push(likePattern(q), likePattern(q));
  }
  if (rating) {
    where.push('co.rating = ?');
    binds.push(rating);
  }

  const terminalDispositions = `'Not Interested', 'Disqualified', 'Presentation Scheduled', 'not_interested', 'appointment_set'`;
  const isEnrolledRenewalActive = `(co.renewal_date IS NOT NULL AND date('now', 'localtime') >= date(co.renewal_date, '-35 days'))`;

  if (untouched) {
    where.push('NOT EXISTS (SELECT 1 FROM activity_logs a WHERE a.company_id = co.company_id)');
  } else if (filter === 'follow_ups') {
    // Has touches, but latest touch is active (or enrolled within the 35-day renewal window)
    where.push(`
      EXISTS (SELECT 1 FROM activity_logs a WHERE a.company_id = co.company_id)
      AND (
        SELECT a.disposition FROM activity_logs a
        WHERE a.company_id = co.company_id
        ORDER BY a.timestamp DESC LIMIT 1
      ) NOT IN (${terminalDispositions})
      AND (
        (
          SELECT a.disposition FROM activity_logs a
          WHERE a.company_id = co.company_id
          ORDER BY a.timestamp DESC LIMIT 1
        ) NOT IN ('Enrolled', 'enrolled')
        OR ${isEnrolledRenewalActive}
      )
    `);
  } else if (filter === 'all_active') {
    // Either untouched or latest disposition is active
    where.push(`
      (
        NOT EXISTS (SELECT 1 FROM activity_logs a WHERE a.company_id = co.company_id)
        OR (
          (
            SELECT a.disposition FROM activity_logs a
            WHERE a.company_id = co.company_id
            ORDER BY a.timestamp DESC LIMIT 1
          ) NOT IN (${terminalDispositions})
          AND (
            (
              SELECT a.disposition FROM activity_logs a
              WHERE a.company_id = co.company_id
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
           (SELECT COUNT(*) FROM activity_logs a WHERE a.company_id = co.company_id) AS touch_count,
           (SELECT MAX(a.timestamp) FROM activity_logs a WHERE a.company_id = co.company_id) AS last_touched,
           (SELECT a.disposition FROM activity_logs a WHERE a.company_id = co.company_id ORDER BY a.timestamp DESC LIMIT 1) AS latest_disposition,
           (SELECT json_extract(a.ai_structured_notes, '$.next_action') FROM activity_logs a WHERE a.company_id = co.company_id AND a.ai_structured_notes IS NOT NULL ORDER BY a.timestamp DESC LIMIT 1) AS latest_next_action,
           (SELECT json_extract(a.ai_structured_notes, '$.product_interests') FROM activity_logs a WHERE a.company_id = co.company_id AND a.ai_structured_notes IS NOT NULL ORDER BY a.timestamp DESC LIMIT 1) AS latest_product_interests,
           (SELECT json_extract(a.ai_structured_notes, '$.objections') FROM activity_logs a WHERE a.company_id = co.company_id AND a.ai_structured_notes IS NOT NULL ORDER BY a.timestamp DESC LIMIT 1) AS latest_objections,
           CASE
             WHEN (
               SELECT a.disposition FROM activity_logs a
               WHERE a.company_id = co.company_id
               ORDER BY a.timestamp DESC LIMIT 1
             ) IN ('Enrolled', 'enrolled')
             AND co.renewal_date IS NOT NULL
             AND date('now', 'localtime') >= date(co.renewal_date, '-35 days')
             THEN 1
             ELSE 0
           END AS is_renewal_active
    FROM companies co
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY co.company_name COLLATE NOCASE
    LIMIT ?
  `;

  const { results } = await c.env.DB.prepare(sql).bind(...binds, limit).all();
  return c.json({ companies: results || [] }, 200, { 'Cache-Control': 'no-store' });
});

/** POST /api/companies — create or merge one account with auto-geocoding. */
companies.post('/', async (c) => {
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

  await upsertCompany(c.env.DB, company);

  // A company created from the field usually arrives with the one person the
  // agent actually spoke to attached.
  const contactIds = [];
  const rawContacts = Array.isArray(body?.contacts) ? body.contacts.slice(0, 10) : [];
  for (const rawContact of rawContacts) {
    const contact = normalizeContact(rawContact, company.company_id);
    if (contact) contactIds.push(await upsertContact(c.env.DB, contact));
  }

  return c.json({ success: true, company_id: company.company_id, contact_ids: contactIds });
});

/** GET /api/companies/:id — account detail with contacts and full timeline. */
companies.get('/:id', async (c) => {
  const companyId = asId(c.req.param('id'));
  if (!companyId) return c.json({ error: 'Invalid company id' }, 400);

  const company = await c.env.DB
    .prepare('SELECT * FROM companies WHERE company_id = ? LIMIT 1')
    .bind(companyId)
    .first();

  if (!company) return c.json({ error: 'Company not found' }, 404);

  const [{ results: contacts }, { results: activity }] = await Promise.all([
    c.env.DB.prepare(
      'SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary_dm DESC, last_name COLLATE NOCASE'
    ).bind(companyId).all(),
    c.env.DB.prepare(
      `SELECT log_id, contact_id, timestamp, is_in_person, is_initial, is_dm_contact,
              disposition, presentation_date, enrollment_date, projected_ap,
              raw_audio_transcription, ai_structured_notes, sync_tier_status
       FROM activity_logs WHERE company_id = ? ORDER BY timestamp DESC LIMIT 50`
    ).bind(companyId).all()
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

  let imported = 0;
  let geocoded = 0;
  let contactCount = 0;
  const skipped = [];

  for (const raw of rawCompanies) {
    try {
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

      // AI Industry Classification with graceful fallback
      if (raw?.company_name) {
        try {
          const aiIndustry = await classifyIndustry(raw.company_name, c.env);
          if (aiIndustry) {
            raw.industry = aiIndustry;
          } else if (!raw.industry) {
            raw.industry = 'Other Commercial';
          }
        } catch {
          if (!raw.industry) raw.industry = 'Other Commercial';
        }
      }

      const company = normalizeCompany(raw);
      await upsertCompany(c.env.DB, company);
      imported += 1;

      // Insert nested contacts
      const rawContacts = Array.isArray(raw?.contacts) ? raw.contacts.slice(0, 20) : [];
      for (const rawContact of rawContacts) {
        const contact = normalizeContact(rawContact, company.company_id);
        if (contact) {
          await upsertContact(c.env.DB, contact);
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

  await upsertContact(c.env.DB, contact);
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
