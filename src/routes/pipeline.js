/**
 * CRM Pipeline Core & State Mutation APIs.
 *
 * Backs the B2B Deal-Flow Pipeline CRM, stage management, snooze scheduling,
 * and deal-flow metrics.
 */

import { Hono } from 'hono';
import {
  PIPELINE_STAGES,
  matchEnum,
  asId,
  asIsoDate,
  asMoney,
  asCount,
  LIMITS
} from '../lib/validate.js';
import {
  ValidationError,
  transitionPipelineStage,
  snoozeCompany
} from '../lib/db.js';
import { businessDate } from '../lib/time.js';

const pipeline = new Hono();

/**
 * GET /api/pipeline
 *   ?stage=QUALIFIED      filter to a specific pipeline stage
 *   ?include_snoozed=1   include currently snoozed accounts
 *   ?limit=              1..1000, default 500
 */
pipeline.get('/', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const url = new URL(c.req.url);
  const stageParam = url.searchParams.get('stage');
  const stage = stageParam ? matchEnum(stageParam, PIPELINE_STAGES) : null;
  const includeSnoozed = url.searchParams.get('include_snoozed') === '1' || url.searchParams.get('snoozed') === '1';
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 500;

  const today = businessDate();

  const where = [];
  const binds = [today, today]; // For julianday days_in_stage calculation

  where.push('c.agent_email = ?');
  binds.push(userEmail);

  if (!includeSnoozed) {
    where.push('(c.snoozed_until IS NULL OR c.snoozed_until <= ?)');
    binds.push(today);
  }

  if (stage) {
    where.push('c.pipeline_stage = ?');
    binds.push(stage);
  }

  binds.push(limit);

  const sql = `
    WITH latest AS (
      SELECT
        a.company_id,
        a.log_id AS latest_log_id,
        a.timestamp AS latest_timestamp,
        a.disposition AS latest_disposition,
        a.next_action_date,
        a.next_action_text,
        a.ai_structured_notes,
        ROW_NUMBER() OVER (PARTITION BY a.company_id ORDER BY a.timestamp DESC) AS rn
      FROM activity_logs a
      WHERE a.agent_email = '${userEmail}'
    ),
    agg AS (
      SELECT
        company_id,
        COUNT(*) AS touch_count,
        MAX(timestamp) AS last_touched
      FROM activity_logs
      WHERE agent_email = '${userEmail}'
      GROUP BY company_id
    )
    SELECT
      c.company_id,
      c.company_name,
      c.street_1,
      c.street_2,
      c.city,
      c.state,
      c.zip_code,
      c.lat,
      c.long,
      c.rating,
      c.employees,
      c.industry,
      c.sic_code,
      c.account_number,
      c.pipeline_stage,
      c.stage_entered_at,
      c.snoozed_until,
      c.disqualified_reason,
      c.forecast_ap,
      c.forecast_confidence,
      c.created_at,
      COALESCE(agg.touch_count, 0) AS touch_count,
      agg.last_touched,
      l.latest_disposition,
      l.next_action_date,
      l.next_action_text,
      json_extract(l.ai_structured_notes, '$.summary') AS latest_summary,
      CAST(ROUND(julianday(?) - julianday(COALESCE(c.stage_entered_at, c.created_at, ?))) AS INTEGER) AS days_in_stage
    FROM companies c
    LEFT JOIN latest l ON c.company_id = l.company_id AND l.rn = 1
    LEFT JOIN agg ON c.company_id = agg.company_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.pipeline_stage, days_in_stage DESC, c.company_name COLLATE NOCASE
    LIMIT ?
  `;

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  const rows = Array.isArray(results) ? results : [];

  return c.json({
    success: true,
    count: rows.length,
    pipeline: rows,
    companies: rows
  }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * POST /api/pipeline/stage — mutate company pipeline stage and record audit row.
 * Body: { company_id, to_stage, reason?, forecast_ap?, forecast_confidence? }
 */
pipeline.post('/stage', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const companyId = asId(body?.company_id);
  if (!companyId) return c.json({ error: 'company_id is required' }, 400);

  const toStage = matchEnum(body?.to_stage, PIPELINE_STAGES);
  if (!toStage) {
    return c.json({
      error: `Invalid to_stage. Must be one of: ${PIPELINE_STAGES.join(', ')}`
    }, 400);
  }

  try {
    const result = await transitionPipelineStage(c.env.DB, {
      companyId,
      toStage,
      reason: body?.reason,
      forecastAp: body?.forecast_ap,
      forecastConfidence: body?.forecast_confidence
    }, userEmail);
    return c.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

/**
 * POST /api/pipeline/snooze — snooze an account until a specific date.
 * Body: { company_id, until }
 */
pipeline.post('/snooze', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const companyId = asId(body?.company_id);
  if (!companyId) return c.json({ error: 'company_id is required' }, 400);

  try {
    const result = await snoozeCompany(c.env.DB, companyId, body?.until, userEmail);
    return c.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

/**
 * GET /api/pipeline/events/:companyId — retrieve pipeline transition audit trail.
 */
pipeline.get('/events/:companyId', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const companyId = asId(c.req.param('companyId'));
  if (!companyId) return c.json({ error: 'Invalid company_id' }, 400);

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM pipeline_events WHERE company_id = ? AND agent_email = ? ORDER BY changed_at DESC'
  ).bind(companyId, userEmail).all();

  return c.json({ success: true, events: results || [] });
});

export default pipeline;
