/**
 * GET /api/export/d365 — rows for the Tier 2 / Tier 3 desktop handoff.
 *
 * The split is what makes the D365 round trip survive validation:
 *
 *   Tier 2  companies that already exist as D365 leads. The export MUST carry
 *           d365_lead_id, d365_checksum and d365_modified_on back verbatim —
 *           Dynamics rejects an Excel re-import whose checksum does not match
 *           the row it was exported from. These go out as .xlsx.
 *
 *   Tier 3  net-new companies scouted in the field, with no D365 identity yet.
 *           A checksum would be meaningless, so these go out as a clean .csv
 *           for the standard Import Data wizard.
 *
 * One row per COMPANY (not per activity): D365 leads are accounts, and the
 * most recent touch is what the agent wants reflected on the record.
 */

import { Hono } from 'hono';
import { SYNC_TIERS, matchEnum } from '../lib/validate.js';
import { businessDate, businessDayRangeUtc } from '../lib/time.js';

const exports_ = new Hono();

/**
 * Correlated subqueries rather than a window function: D1 runs SQLite, which
 * supports both, but this shape stays readable and uses idx_activity_company
 * for each lookup.
 */
const EXPORT_SELECT = `
  SELECT
    co.company_id, co.d365_lead_id, co.d365_checksum, co.d365_modified_on,
    co.company_name, co.street_1, co.street_2, co.city, co.state, co.zip_code,
    co.lat, co.long, co.lead_source, co.rating, co.employees, co.industry,
    co.sic_code, co.account_number, co.post_enrollment_date,
    co.is_d365_synced, co.created_at, co.created_at AS company_created_at,
    ct.first_name, ct.last_name, ct.job_title, ct.phone_number, ct.email_address,
    a.log_id, a.timestamp AS last_touched, a.disposition, a.is_in_person,
    a.is_initial, a.is_dm_contact, a.presentation_date, a.enrollment_date,
    a.projected_ap, a.raw_audio_transcription, a.ai_structured_notes,
    a.sync_tier_status,
    (SELECT COUNT(*) FROM activity_logs x WHERE x.company_id = co.company_id AND x.agent_email = co.agent_email) AS touch_count
  FROM companies co
  JOIN activity_logs a ON a.log_id = (
    SELECT log_id FROM activity_logs y
    WHERE y.company_id = co.company_id AND y.agent_email = co.agent_email
    ORDER BY y.timestamp DESC LIMIT 1
  )
  LEFT JOIN contacts ct ON ct.contact_id = COALESCE(
    a.contact_id,
    (SELECT contact_id FROM contacts z
     WHERE z.company_id = co.company_id AND z.agent_email = co.agent_email
     ORDER BY z.is_primary_dm DESC LIMIT 1)
  )
`;

/**
 *   ?date=YYYY-MM-DD  restrict to companies touched on one business day
 *   ?all=1            ignore the date window entirely
 *   ?sync_tier=       default PENDING — rows that have not moved to D365 yet
 */
exports_.get('/d365', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const url = new URL(c.req.url);
  const all = url.searchParams.get('all') === '1';
  const date = url.searchParams.get('date') || businessDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return c.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }

  const where = [];
  const binds = [];

  where.push('co.agent_email = ?');
  binds.push(userEmail);

  if (!all) {
    const { start, end } = businessDayRangeUtc(date);
    where.push('a.timestamp >= ? AND a.timestamp < ?');
    binds.push(start, end);
  }

  // An explicit empty sync_tier ('') means "any tier"; omitting it defaults to
  // the useful case of everything still owing D365 a write.
  const rawTier = url.searchParams.get('sync_tier');
  const syncTier = rawTier === '' ? null : (matchEnum(rawTier, SYNC_TIERS) || 'PENDING');
  if (syncTier) {
    where.push('a.sync_tier_status = ?');
    binds.push(syncTier);
  }

  const { results } = await c.env.DB.prepare(`
    ${EXPORT_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY co.company_name COLLATE NOCASE
    LIMIT 1000
  `).bind(...binds).all();

  const rows = results || [];

  return c.json({
    date: all ? null : date,
    sync_tier: syncTier,
    // Presence of a D365 lead id is the only reliable partition key. A stale
    // is_d365_synced flag would send an existing lead through the net-new
    // import and create a duplicate.
    tier2: rows.filter((r) => r.d365_lead_id),
    tier3: rows.filter((r) => !r.d365_lead_id)
  }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * GET /api/export/tier1 — export Tier 1 activity/leads.
 */
exports_.get('/tier1', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const url = new URL(c.req.url);
  const all = url.searchParams.get('all') === '1';
  const date = url.searchParams.get('date') || businessDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return c.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }

  const where = [];
  const binds = [];

  where.push('co.agent_email = ?');
  binds.push(userEmail);

  if (!all) {
    const { start, end } = businessDayRangeUtc(date);
    where.push('a.timestamp >= ? AND a.timestamp < ?');
    binds.push(start, end);
  }

  const { results } = await c.env.DB.prepare(`
    ${EXPORT_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.timestamp DESC
    LIMIT 1000
  `).bind(...binds).all();

  return c.json({
    success: true,
    date: all ? null : date,
    tier1: results || []
  }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * GET /api/export/tier2 — export Tier 2 existing D365 leads.
 */
exports_.get('/tier2', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const url = new URL(c.req.url);
  const all = url.searchParams.get('all') === '1';
  const date = url.searchParams.get('date') || businessDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return c.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }

  const where = [];
  const binds = [];

  where.push('co.agent_email = ?');
  binds.push(userEmail);

  where.push('co.d365_lead_id IS NOT NULL');

  if (!all) {
    const { start, end } = businessDayRangeUtc(date);
    where.push('a.timestamp >= ? AND a.timestamp < ?');
    binds.push(start, end);
  }

  const { results } = await c.env.DB.prepare(`
    ${EXPORT_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY co.company_name COLLATE NOCASE
    LIMIT 1000
  `).bind(...binds).all();

  return c.json({
    success: true,
    date: all ? null : date,
    tier2: results || []
  }, 200, { 'Cache-Control': 'no-store' });
});

export default exports_;
