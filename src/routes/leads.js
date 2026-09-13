/**
 * Agency OS lead queues — the data behind the Phone and Field workspaces.
 *
 * WHY A SEPARATE ROUTE FROM /api/companies
 * /api/companies answers "find the account I am standing in front of": it
 * searches by name, filters by rating, and joins activity history. The dialer
 * and the canvass list ask a different question — "give me today's work list" —
 * and they want it pre-filtered by confidence band so the view can start
 * rendering immediately.
 *
 * CONFIDENCE BANDS
 *   PHONE  30-79  a real prospect with an unverified contact path. Below 30 the
 *                 record is junk (schema.sql banding), at 80+ it has already
 *                 been phone-verified and belongs in the field queue instead of
 *                 costing another dial.
 *   FIELD  80+    decision maker confirmed; worth driving to.
 *   TRIAGE 0-39   the hygiene queue: unverified, unenriched or junk. Anything
 *                 here needs a human decision before it deserves a dial.
 *
 * Ordering is deterministic (highest confidence first, then name) because the
 * canvass view re-sorts client-side with its own TSP pass and the dialer needs a
 * stable sequence across reloads.
 *
 * WHY TRIAGE IS A BAND AND NOT A DIFFERENT QUERY
 * "confidence_score < 40" and "BETWEEN 0 AND 39" are the same predicate over an
 * integer column, and keeping one query means the tenants who already rely on
 * idx_companies_agent_geohash6 keep the same plan shape.
 */

import { Hono } from 'hono';
import { normalizeCompany, upsertCompany, companyExists, ValidationError } from '../lib/db.js';
import { asId, cleanCapped } from '../lib/validate.js';

const leads = new Hono();

export const LEAD_MODES = ['PHONE', 'FIELD', 'TRIAGE'];

/** Per-mode list size. The field cap is what bounds the client-side TSP. */
export const LEAD_LIMITS = {
  PHONE: 100,
  FIELD: 30,
  TRIAGE: 200
};

/** Confidence bands, kept in one place so the SQL and the docs cannot drift. */
export const CONFIDENCE_BANDS = {
  PHONE: { min: 30, max: 79 },
  FIELD: { min: 80, max: 100 },
  TRIAGE: { min: 0, max: 39 }
};

/** The triage cut-off: anything at or below this needs a human decision. */
export const TRIAGE_MAX_CONFIDENCE = 39;

/**
 * Where an imported lead lands. New rows only — see the import route for why
 * this is a default rather than a forced write.
 */
export const IMPORT_CONFIDENCE_SCORE = 30;

/** Apify exports of a metro area run large, but not one-request large. */
export const MAX_IMPORT_ROWS = 500;

export const LEAD_SELECT = `
  SELECT
    co.company_id,
    co.company_name,
    co.street_1,
    co.street_2,
    co.city,
    co.state,
    co.zip_code,
    co.company_phone,
    co.lat,
    co.long,
    co.industry,
    co.employees,
    co.rating,
    co.pipeline_stage,
    co.status,
    co.verification_status,
    co.confidence_score,
    co.current_voluntary_carrier,
    co.major_medical_carrier,
    co.is_hdhp,
    co.estimated_w2_count,
    co.geohash,
    co.notes,
    -- The company column is decision_maker; the voice extractor and the views
    -- both call it decision_maker_name. Aliased here so the two spellings can
    -- never drift apart in the UI.
    co.decision_maker,
    co.decision_maker AS decision_maker_name
  FROM companies co
  WHERE co.agent_email = ?
    AND co.status NOT IN ('DISQUALIFIED', 'DO_NOT_CONTACT')
    AND co.confidence_score BETWEEN ? AND ?
  ORDER BY co.confidence_score DESC, co.company_name COLLATE NOCASE ASC
  LIMIT ?
`;

/**
 * GET /api/leads?mode=PHONE|FIELD|TRIAGE
 *
 * Returns `{ success, mode, count, data }`. The agent's own rows only: the
 * tenant predicate is the leading clause, exactly as in the radar lookup.
 *
 * Suppressed records are excluded from every mode, TRIAGE included: an account
 * that stayed in the hygiene queue after being disqualified would be
 * re-disqualified every Friday, and the queue would never empty.
 */
export async function handleLeads(c) {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  const url = new URL(c.req.url);
  const requested = String(url.searchParams.get('mode') || 'PHONE').trim().toUpperCase();
  if (!LEAD_MODES.includes(requested)) {
    return c.json({ error: `mode must be one of ${LEAD_MODES.join(', ')}` }, 400);
  }

  const band = CONFIDENCE_BANDS[requested];

  const { results } = await c.env.DB
    .prepare(LEAD_SELECT)
    .bind(userEmail, band.min, band.max, LEAD_LIMITS[requested])
    .all();

  const data = Array.isArray(results) ? results : [];

  return c.json(
    { success: true, mode: requested, count: data.length, data },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

leads.get('/', handleLeads);

// ---------------------------------------------------------------------
// POST /api/leads/import — Apify scrape ingestion
// ---------------------------------------------------------------------

/**
 * Body: a bare array `[ {...} ]`, or `{ leads: [ {...} ] }`.
 *
 * WHY ROWS FAIL INDIVIDUALLY
 * An Apify Google-Maps export is a scraped corpus, not a clean list: it carries
 * directory pages, "permanently closed" shells and rows with no business name.
 * Failing the whole batch on the first bad row would mean the agent re-uploads
 * the same 400-line file until it happens to pass, so each rejection is
 * reported by index and the good rows are committed.
 *
 * WHY confidence_score / status ARE NOT WRITTEN EXPLICITLY
 * normalizeCompany() already defaults a new record to confidence 30 and status
 * ACTIVE, and upsertCompany() only overwrites a column the caller actually
 * supplied. Passing them here would make a re-import of Friday's file reset a
 * phone-verified 90 back to 30 — the exact data loss the presence flags in
 * src/lib/db.js exist to prevent. New rows land at 30/ACTIVE either way.
 */
leads.post('/import', async (c) => {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const rows = Array.isArray(body) ? body : body?.leads;
  if (!Array.isArray(rows)) {
    return c.json({ error: 'Expected a JSON array of leads, or { leads: [...] }' }, 400);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return c.json({ error: `Import batch too large (max ${MAX_IMPORT_ROWS})` }, 400);
  }
  if (rows.length === 0) {
    return c.json({ success: true, imported: 0, rejected: 0, errors: [] });
  }

  let imported = 0;
  const errors = [];
  let created = 0;

  for (let index = 0; index < rows.length; index += 1) {
    try {
      const row = rows[index];
      // A row that already carries our id is an update; one that does not is a
      // brand-new lead and must land in the Triage queue.
      const existed = row?.company_id
        ? await companyExists(c.env.DB, asId(row.company_id), userEmail)
        : false;

      const company = normalizeCompany(row);
      await upsertCompany(c.env.DB, company, userEmail);
      imported += 1;
      if (!existed) created += 1;
    } catch (err) {
      if (!(err instanceof ValidationError)) {
        console.error('Lead import row failed:', err);
      }
      errors.push({
        row: index,
        error: err instanceof ValidationError ? err.message : 'Could not import this row'
      });
    }
  }

  return c.json({
    success: true,
    imported,
    created,
    rejected: errors.length,
    // Capped so a malformed file cannot return a 400-row error novel.
    errors: errors.slice(0, 25)
  });
});

// ---------------------------------------------------------------------
// POST /api/leads/disqualify — the Triage grid's one button
// ---------------------------------------------------------------------

/**
 * Body: { company_id, reason? }
 *
 * Sets the terminal suppression in one statement. confidence_score goes to 0 as
 * well as status, because a record that is disqualified but still scores 60
 * would keep resurfacing in the phone queue if anything ever cleared its status.
 */
leads.post('/disqualify', async (c) => {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const companyId = asId(body?.company_id);
  if (!companyId) return c.json({ error: 'company_id is required' }, 400);

  const reason = cleanCapped(body?.reason, 500) || 'Disqualified in Triage';

  const result = await c.env.DB.prepare(`
    UPDATE companies
    SET status = 'DISQUALIFIED',
        verification_status = 'DISQUALIFIED',
        confidence_score = 0,
        disqualified_reason = ?
    WHERE company_id = ? AND agent_email = ?
  `).bind(reason, companyId, userEmail).run();

  if (!result?.meta?.changes) return c.json({ error: 'Unknown company_id' }, 404);

  return c.json({
    success: true,
    company_id: companyId,
    status: 'DISQUALIFIED',
    confidence_score: 0
  });
});

export default leads;
