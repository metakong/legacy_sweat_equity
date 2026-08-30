/**
 * Aflac B2B Field Prospecting Assistant — Cloudflare Worker
 *
 * Replaces the retired "Legacy Sweat Equity" B2C roofing canvasser backend.
 * Hono handles routing; every route module lives under src/routes/.
 *
 * Env bindings:
 *   DB                  D1 database (see schema.sql)
 *   BUCKET              R2 bucket — archived voice journals
 *   ASSETS              static assets from ./public
 * Secrets (wrangler secret put ...):
 *   GROQ_API_KEY        Whisper transcription
 *   OPENROUTER_API_KEY  structuring + dossier models
 *   TAVILY_API_KEY      pre-call web search
 *   MAPBOX_TOKEN        optional — road-network route optimization
 * Vars:
 *   ALLOWED_ORIGINS     extra comma-separated origins for CORS
 *   STORE_AUDIO         '0' disables R2 voice-journal archiving
 */

import { Hono } from 'hono';

import {
  SECURITY_HEADERS,
  CONTENT_SECURITY_POLICY,
  allowedOrigins,
  isHtmlResponse
} from './lib/security.js';
import { businessDate, businessDayRangeUtc } from './lib/time.js';

import companiesRouter, { contacts as contactsRouter, enums as enumsRouter, importRouter } from './routes/companies.js';
import activityRouter, { root as activityRootRouter, audio as audioRouter } from './routes/activity.js';
import enrichRouter from './routes/enrich.js';
import eodRouter from './routes/eod.js';
import routingRouter from './routes/routing.js';
import exportsRouter from './routes/exports.js';
import { classifyIndustry } from './lib/ai.js';

const app = new Hono();

// ---------------------------------------------------------------------
// SECURITY + CORS
// ---------------------------------------------------------------------
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const origin = c.req.header('Origin');
  const permitted = allowedOrigins(c.env, url);
  const originAllowed = !origin || permitted.has(origin);

  // Reflect only known origins instead of a blanket '*', and always Vary so a
  // cache never serves one origin's CORS grant to another.
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (origin && permitted.has(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }

  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, ...SECURITY_HEADERS } });
  }

  // Cross-site POSTs are rejected outright. Without this, any page on the
  // internet could silently write activity logs into D1 — a simple form POST
  // does not require a CORS preflight.
  if (c.req.method === 'POST' && !originAllowed) {
    return c.json({ error: 'Cross-origin requests are not permitted' }, 403, {
      ...corsHeaders,
      ...SECURITY_HEADERS
    });
  }

  await next();

  // c.res is immutable once set by a handler; mutate its headers in place.
  for (const [key, value] of Object.entries({ ...corsHeaders, ...SECURITY_HEADERS })) {
    c.res.headers.set(key, value);
  }
  if (isHtmlResponse(c.res)) {
    c.res.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  }
});

// ---------------------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------------------
app.route('/api/companies', companiesRouter);
app.route('/api/import', importRouter);
app.route('/api/contacts', contactsRouter);
app.route('/api/enums', enumsRouter);
app.route('/api/enrich', enrichRouter);
app.route('/api/eod-debrief', eodRouter);
app.route('/api/route', routingRouter);
app.route('/api/export', exportsRouter);
app.route('/api/audio', audioRouter);
app.route('/api/activity', activityRouter);

// /api/transcribe-and-log and /api/sync are part of the external contract and
// live at the API root rather than under /api/activity.
app.route('/api', activityRootRouter);

/**
 * POST /api/admin/reclassify-industries — reclassify unclassified/generic companies using OpenRouter AI.
 */
app.post('/api/admin/reclassify-industries', async (c) => {
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: 'OPENROUTER_API_KEY is not configured' }, 503);
  }

  const { results } = await c.env.DB.prepare(
    'SELECT company_id, company_name, industry FROM companies'
  ).all();

  const rows = Array.isArray(results) ? results : [];
  let updated = 0;
  const classifications = [];

  const BATCH_SIZE = 5;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map(async (row) => {
      try {
        const category = await classifyIndustry(row.company_name, c.env);
        if (category && category !== row.industry) {
          await c.env.DB.prepare(
            'UPDATE companies SET industry = ? WHERE company_id = ?'
          ).bind(category, row.company_id).run();
          updated += 1;
          classifications.push({ company_name: row.company_name, from: row.industry, category });
        }
      } catch (err) {
        console.warn(`Reclassify error for ${row.company_name}:`, err.message);
      }
    }));
  }

  return c.json({
    status: 'success',
    total_scanned: rows.length,
    updated,
    classifications
  });
});

app.get('/api/health', (c) => c.json({
  status: 'ok',
  business_date: businessDate(),
  providers: {
    groq: Boolean(c.env.GROQ_API_KEY),
    openrouter: Boolean(c.env.OPENROUTER_API_KEY),
    tavily: Boolean(c.env.TAVILY_API_KEY),
    mapbox: Boolean(c.env.MAPBOX_TOKEN)
  }
}, 200, { 'Cache-Control': 'no-store' }));

// Unmatched /api/* must 404 as JSON rather than falling through to the asset
// handler and returning an HTML page to a fetch() caller.
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// ---------------------------------------------------------------------
// STATIC ASSETS
// ---------------------------------------------------------------------
app.all('*', async (c) => {
  if (!c.env.ASSETS) return c.text('Not Found', 404);

  const url = new URL(c.req.url);
  // The prospecting PWA is now the site root. The old homeowner portal that
  // used to live here was removed in the B2B pivot.
  const assetRequest = (url.pathname === '/' || url.pathname === '/index.html')
    ? new Request(new URL('/app/', url).toString(), c.req.raw)
    : c.req.raw;

  const assetResponse = await c.env.ASSETS.fetch(assetRequest);

  // ASSETS responses are immutable — clone before the middleware adds headers.
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers: new Headers(assetResponse.headers)
  });
});

// ---------------------------------------------------------------------
// ERRORS
// ---------------------------------------------------------------------
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ---------------------------------------------------------------------
// NIGHTLY ROLLUP (cron: 0 2 * * *)
// ---------------------------------------------------------------------

/**
 * At 02:00 UTC the Springfield workday that just ended is still "yesterday" in
 * UTC terms, so the target date comes from local time, never DATE('now').
 *
 * This is read-only. The retired schema had an `insights` table for AI daily
 * debriefs; the B2B schema has no equivalent, so the rollup is emitted to logs
 * (`npm run tail`) rather than persisted. Add a table here if the numbers turn
 * out to be worth keeping.
 */
export async function runNightlyRollup(env) {
  const targetDate = businessDate();
  const { start, end } = businessDayRangeUtc(targetDate);

  const summary = await env.DB.prepare(`
    SELECT
      COUNT(*)                                             AS touches,
      COUNT(DISTINCT a.company_id)                         AS accounts,
      SUM(CASE WHEN a.is_dm_contact = 1 THEN 1 ELSE 0 END) AS dm_conversations,
      SUM(CASE WHEN a.is_in_person = 1 THEN 1 ELSE 0 END)  AS in_person,
      SUM(CASE WHEN a.presentation_date IS NOT NULL THEN 1 ELSE 0 END) AS presentations_set,
      COALESCE(SUM(a.projected_ap), 0)                     AS projected_ap,
      SUM(CASE WHEN a.sync_tier_status = 'PENDING' THEN 1 ELSE 0 END)  AS awaiting_d365
    FROM activity_logs a
    WHERE a.timestamp >= ? AND a.timestamp < ?
  `).bind(start, end).first();

  console.log('Nightly rollup', JSON.stringify({ date: targetDate, ...summary }));
  return { date: targetDate, ...summary };
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyRollup(env));
  }
};

// Re-exported for dev-server.js (which serves static files without going
// through the Worker) and for the test suite.
export { SECURITY_HEADERS, CONTENT_SECURITY_POLICY } from './lib/security.js';
export { businessDate, businessDayRangeUtc, toSqlTimestamp, toLocalStamp } from './lib/time.js';
export { cleanText, deriveDisposition, matchEnum, parseJsonLoose, RATINGS, DISPOSITIONS } from './lib/validate.js';
