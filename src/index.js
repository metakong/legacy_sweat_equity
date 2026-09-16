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
  extractUserEmail,
  ALLOWED_USERS,
  CONTENT_SECURITY_POLICY,
  allowedOrigins,
  isHtmlResponse
} from './lib/security.js';
import { businessDate, businessDayRangeUtc } from './lib/time.js';
import { CompanyMatcher, getDoorKey } from './lib/match.js';

import companiesRouter, { contacts as contactsRouter, enums as enumsRouter, importRouter } from './routes/companies.js';
import activityRouter, { root as activityRootRouter, audio as audioRouter } from './routes/activity.js';
import enrichRouter from './routes/enrich.js';
import eodRouter, { handleEodAggregates } from './routes/eod.js';
import telemetryRouter from './routes/telemetry.js';
import routingRouter from './routes/routing.js';
import exportsRouter from './routes/exports.js';
import pipelineRouter from './routes/pipeline.js';
import radarRouter, { handleRadar } from './routes/radar.js';
import voiceRouter, { handleVoiceDebrief } from './routes/voice.js';
import leadsRouter, { handleLeads } from './routes/leads.js';
import mcpRouter from './routes/mcp.js';
import oauthRouter, { wellKnownRouter } from './routes/oauth.js';
import { classifyIndustry, tavilySearch, chatJson } from './lib/ai.js';
import { calculateFicaSavings } from './lib/tax.js';
import { scrapeMissouriSosEntity } from './routes/enrich.js';

const app = new Hono();

// ---------------------------------------------------------------------
// GLOBAL ERROR & NOT FOUND HANDLERS
// ---------------------------------------------------------------------
app.onError((err, c) => {
  console.error(`[Worker Error] ${err}`);
  return c.json({ error: 'Internal Server Error', details: err.message }, 500, SECURITY_HEADERS);
});

app.notFound((c) => {
  return c.json({ error: 'Route not found' }, 404, SECURITY_HEADERS);
});

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
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
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
// API AUTHENTICATION MIDDLEWARE
// ---------------------------------------------------------------------
app.use('/api/*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname === '/api/health' || url.pathname.startsWith('/api/mcp') || url.pathname.startsWith('/api/oauth') || url.pathname.startsWith('/.well-known') || c.req.method === 'OPTIONS') {
    return next();
  }

  const jwtEmail = extractUserEmail(c);

  if (jwtEmail && ALLOWED_USERS.includes(jwtEmail)) {
    c.set('userEmail', jwtEmail);
    return next();
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
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
// The D365 compliance block lives in the same module as the debrief (one file
// owns the end of the day) but gets a flat path, because it is pasted into a
// CRM rather than read as a report.
app.get('/api/eod-aggregates', handleEodAggregates);
app.route('/api/telemetry/daily', telemetryRouter);
app.route('/api/route', routingRouter);
app.route('/api/export', exportsRouter);
app.route('/api/exports', exportsRouter);
app.route('/api/pipeline', pipelineRouter);
app.route('/api/audio', audioRouter);
app.route('/api/activity', activityRouter);
app.route('/api/radar', radarRouter);
app.get('/api/radar', handleRadar);
app.route('/api/voice-debrief', voiceRouter);
app.post('/api/voice-debrief', handleVoiceDebrief);
app.route('/api/leads', leadsRouter);
app.get('/api/leads', handleLeads);
app.route('/api/mcp', mcpRouter);
app.route('/api/oauth', oauthRouter);
app.route('/.well-known', wellKnownRouter);

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

  let body = {};
  try {
    body = await c.req.json();
  } catch (_) {}

  const cursor = (body.cursor ?? c.req.query('cursor') ?? '').toString().trim();
  const limitParam = body.limit ?? c.req.query('limit');
  const parsedLimit = Number.parseInt(limitParam, 10);
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 10, 1), 25);

  const onlyUnclassifiedParam = body.only_unclassified ?? c.req.query('only_unclassified');
  const onlyUnclassified = onlyUnclassifiedParam !== undefined
    ? (onlyUnclassifiedParam === true || onlyUnclassifiedParam === 'true' || onlyUnclassifiedParam === '1' || onlyUnclassifiedParam === 1)
    : true;

  let rows = [];
  if (Array.isArray(body.company_ids) && body.company_ids.length > 0) {
    const targetIds = body.company_ids.slice(0, limit);
    const placeholders = targetIds.map(() => '?').join(', ');
    const query = `SELECT company_id, company_name, industry FROM companies WHERE company_id IN (${placeholders}) ORDER BY company_id ASC`;
    const res = await c.env.DB.prepare(query).bind(...targetIds).all();
    rows = Array.isArray(res?.results) ? res.results : [];
  } else {
    let query = 'SELECT company_id, company_name, industry FROM companies WHERE 1=1';
    const params = [];

    if (onlyUnclassified) {
      query += " AND (industry IS NULL OR industry = '' OR industry = 'Other Commercial' OR industry = 'Commercial / Other')";
    }

    if (cursor) {
      query += ' AND company_id > ?';
      params.push(cursor);
    }

    query += ' ORDER BY company_id ASC LIMIT ?';
    params.push(limit);

    const res = await c.env.DB.prepare(query).bind(...params).all();
    rows = Array.isArray(res?.results) ? res.results : [];
  }

  let updated = 0;
  const classifications = [];

  const BATCH_SIZE = 5;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const chunkResults = await Promise.all(chunk.map(async (row) => {
      try {
        const category = await classifyIndustry(row.company_name, c.env);
        if (category && category !== row.industry) {
          await c.env.DB.prepare(
            'UPDATE companies SET industry = ? WHERE company_id = ?'
          ).bind(category, row.company_id).run();
          return {
            company_id: row.company_id,
            company_name: row.company_name,
            from: row.industry,
            category
          };
        }
      } catch (err) {
        console.warn(`Reclassify error for ${row.company_name}:`, err.message);
      }
      return null;
    }));
    for (const resItem of chunkResults) {
      if (resItem) {
        updated += 1;
        classifications.push(resItem);
      }
    }
  }

  const has_more = rows.length === limit;
  const next_cursor = (has_more && rows.length > 0) ? rows[rows.length - 1].company_id : null;

  return c.json({
    status: 'success',
    total_scanned: rows.length,
    updated,
    classifications,
    cursor: cursor || null,
    next_cursor,
    has_more,
    limit
  });
});

app.get('/api/telemetry', async (c) => {
  const telemetry = await computeTelemetry(c.env.DB, c.env, businessDate(), c.get('userEmail'));
  return c.json(telemetry, 200, { 'Cache-Control': 'no-store' });
});

app.get('/api/health', (c) => c.json({
  status: 'ok',
  business_date: businessDate(),
  providers: {
    groq: Boolean(c.env?.GROQ_API_KEY),
    openrouter: Boolean(c.env?.OPENROUTER_API_KEY),
    tavily: Boolean(c.env?.TAVILY_API_KEY),
    mapbox: Boolean(c.env?.MAPBOX_TOKEN)
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

/**
 * Compute aggregate telemetry for the Data Management dashboard.
 */
export async function computeTelemetry(db, env = {}, targetDate = businessDate(), agentEmail = null) {
  const { start, end } = businessDayRangeUtc(targetDate);

  // Scope every aggregate to one agent when the caller knows who is asking.
  // Omitting it keeps the old whole-database behaviour for callers that
  // legitimately want it (tests, ops tooling).
  const scope = agentEmail ? ' WHERE agent_email = ?' : '';
  const scopeBind = agentEmail ? [agentEmail] : [];

  // A statement with no parameters is executed directly rather than through
  // bind() — binding an empty argument list is a no-op that some D1 shims
  // do not implement.
  const stmt = (sql, binds) => {
    const prepared = db.prepare(sql);
    return binds.length ? prepared.bind(...binds) : prepared;
  };

  let totalCompanies = 0;
  let d365SyncedCompanies = 0;
  let totalContacts = 0;
  let totalActivities = 0;
  let todayActivities = 0;
  let pendingD365Sync = 0;
  let tier1Copied = 0;
  let tier2Exported = 0;
  let tier3Exported = 0;

  if (db) {
    try {
      const coRes = await stmt(`
        SELECT
          COUNT(*) AS total_companies,
          SUM(CASE WHEN is_d365_synced = 1 THEN 1 ELSE 0 END) AS d365_synced_companies
        FROM companies${scope}
      `, scopeBind).first();
      totalCompanies = Number(coRes?.total_companies || 0);
      d365SyncedCompanies = Number(coRes?.d365_synced_companies || 0);
    } catch (_) {}

    try {
      const ctRes = await stmt(`SELECT COUNT(*) AS total_contacts FROM contacts${scope}`, scopeBind).first();
      totalContacts = Number(ctRes?.total_contacts || 0);
    } catch (_) {}

    try {
      const actRes = await stmt(`
        SELECT
          COUNT(*) AS total_activities,
          SUM(CASE WHEN timestamp >= ? AND timestamp < ? THEN 1 ELSE 0 END) AS today_activities,
          SUM(CASE WHEN sync_tier_status = 'PENDING' THEN 1 ELSE 0 END) AS pending_d365_sync,
          SUM(CASE WHEN sync_tier_status = 'TIER1_COPIED' THEN 1 ELSE 0 END) AS tier1_copied,
          SUM(CASE WHEN sync_tier_status = 'TIER2_EXPORTED' THEN 1 ELSE 0 END) AS tier2_exported,
          SUM(CASE WHEN sync_tier_status = 'TIER3_EXPORTED' THEN 1 ELSE 0 END) AS tier3_exported
        FROM activity_logs${scope}
      `, [start, end, ...scopeBind]).first();
      totalActivities = Number(actRes?.total_activities || 0);
      todayActivities = Number(actRes?.today_activities || 0);
      pendingD365Sync = Number(actRes?.pending_d365_sync || 0);
      tier1Copied = Number(actRes?.tier1_copied || 0);
      tier2Exported = Number(actRes?.tier2_exported || 0);
      tier3Exported = Number(actRes?.tier3_exported || 0);
    } catch (_) {}
  }

  const syncHealth = pendingD365Sync > 20 ? 'pending' : 'live';

  return {
    status: 'ok',
    business_date: targetDate,
    sync_health: syncHealth,
    metrics: {
      total_companies: totalCompanies,
      d365_synced_companies: d365SyncedCompanies,
      total_contacts: totalContacts,
      total_activities: totalActivities,
      today_activities: todayActivities,
      pending_d365_sync: pendingD365Sync,
      tier1_copied_count: tier1Copied,
      tier2_exported_count: tier2Exported,
      tier3_exported_count: tier3Exported
    },
    providers: {
      groq: Boolean(env?.GROQ_API_KEY),
      openrouter: Boolean(env?.OPENROUTER_API_KEY),
      tavily: Boolean(env?.TAVILY_API_KEY),
      mapbox: Boolean(env?.MAPBOX_TOKEN)
    }
  };
}

const DEFAULT_AGENT_EMAIL = 'sean_deardorff@us.aflac.com';

// ---------------------------------------------------------------------
// NIGHTLY ROLLUP & ZERO-ADMIN OVERNIGHT PROSPECTING PIPELINE
// ---------------------------------------------------------------------

/**
 * At 02:00 UTC the Springfield workday that just ended is still "yesterday" in
 * UTC terms, so the target date comes from local time, never DATE('now').
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

/**
 * Phase A (Sourcing - runs only on 0 2 * * *):
 * Utilizes Tavily to search for commercial HVAC and light manufacturing businesses
 * in Springfield MO, parses the results, inserts raw targets into raw_targets,
 * and terminates safely.
 */
export async function runNightlySourcing(env) {
  if (!env.DB) {
    console.warn('Phase A aborted: D1 database binding DB missing.');
    return { count: 0 };
  }
  if (!env.TAVILY_API_KEY) {
    console.warn('Phase A aborted: TAVILY_API_KEY is not configured.');
    return { count: 0 };
  }

  console.log('Phase A Sourcing: Searching for commercial HVAC and light manufacturing in Springfield MO');
  let search;
  try {
    search = await tavilySearch(env, 'commercial HVAC and light manufacturing businesses in Springfield MO', {
      maxResults: 15,
      days: 365,
      includeRawContent: false
    });
  } catch (err) {
    console.error('Phase A Tavily search failed:', err.message);
    return { count: 0, error: err.message };
  }

  let targets = [];

  // Attempt structured extraction with OpenRouter if available
  if (env.OPENROUTER_API_KEY && search?.results?.length) {
    try {
      const summary = search.results
        .map((r, idx) => `[${idx + 1}] Title: ${r.title}\nSnippet: ${r.content}\nURL: ${r.url}`)
        .join('\n\n');
      const parsed = await chatJson(env, {
        taskTier: 'simple',
        system: 'Extract commercial HVAC and light manufacturing businesses located in or near Springfield, Missouri from the search results. Return JSON: {"targets": [{"business_name": "Exact Business Name", "address": "Street Address or Springfield, MO"}]}. Exclude directory sites, aggregators, and lists (e.g. Yelp, YellowPages, BBB, Angi).',
        user: `Search answer:\n${search.answer}\n\nSearch results:\n${summary}`
      });
      if (Array.isArray(parsed?.targets)) {
        targets = parsed.targets.filter(t => t?.business_name && typeof t.business_name === 'string');
      }
    } catch (err) {
      console.warn('Phase A AI target extraction fallback:', err.message);
    }
  }

  // Fallback heuristic extraction if AI parsing was empty or unavailable
  if (!targets.length && search?.results?.length) {
    for (const r of search.results) {
      const cleanName = r.title
        .replace(/\s*[-–|].*$/, '')
        .replace(/^(?:The\s+)?(?:Top|Best|\d+)\s+.*$/i, '')
        .trim();
      const lower = cleanName.toLowerCase();
      if (cleanName.length > 2 && !lower.includes('yelp') && !lower.includes('yellowpages') && !lower.includes('bbb') && !lower.includes('angi')) {
        targets.push({
          business_name: cleanName,
          address: 'Springfield, MO'
        });
      }
    }
  }

  let insertedCount = 0;
  for (const t of targets) {
    const name = (t.business_name || '').trim();
    if (!name || name.length < 2) continue;
    const addr = (t.address || 'Springfield, MO').trim();

    try {
      const existing = await env.DB.prepare(
        'SELECT id FROM raw_targets WHERE LOWER(business_name) = LOWER(?) LIMIT 1'
      ).bind(name).first();

      if (!existing) {
        await env.DB.prepare(
          "INSERT INTO raw_targets (business_name, address, status) VALUES (?, ?, 'pending')"
        ).bind(name, addr).run();
        insertedCount++;
      }
    } catch (err) {
      console.warn(`Error inserting raw target "${name}":`, err.message);
    }
  }

  console.log(`Phase A Sourcing completed: ${insertedCount} new targets added to raw_targets`);
  return { count: insertedCount };
}

/**
 * Phase B (Chunked Processing - runs on 15, 30, and 45 minute triggers):
 * Pulls up to 10 pending targets from raw_targets, enriches via Missouri SOS,
 * applies attrition filter, calculates FICA savings, and batch inserts into companies.
 */
export async function runChunkedProcessing(env) {
  if (!env.DB) {
    console.warn('Phase B aborted: D1 database binding DB missing.');
    return { processed: 0 };
  }

  const { results } = await env.DB.prepare(
    "SELECT id, business_name, address FROM raw_targets WHERE status = 'pending' ORDER BY id ASC LIMIT 10"
  ).all();

  const batch = Array.isArray(results) ? results : [];
  if (batch.length === 0) {
    console.log('Phase B: No pending raw_targets to process.');
    return { processed: 0 };
  }

  console.log(`Phase B: Processing ${batch.length} pending targets`);

  const statements = [];
  let survivedCount = 0;
  let failedCount = 0;

  let matcher = null;
  try {
    const candidates = await env.DB.prepare(
      'SELECT company_id, company_name, street_1, zip_code, account_number, d365_lead_id FROM companies WHERE agent_email = ?'
    ).bind(DEFAULT_AGENT_EMAIL).all();
    matcher = new CompanyMatcher(candidates?.results || []);
  } catch (_) {
    matcher = new CompanyMatcher([]);
  }

  for (const target of batch) {
    const businessName = (target.business_name || '').trim();
    const address = (target.address || 'Springfield, MO').trim();

    // 1. Route target name through Missouri SOS logic
    const sos = await scrapeMissouriSosEntity(env, businessName, address);

    // 2. The Attrition Filter: Drop target if null DMs or closed address / dissolved
    if (!sos.decision_maker || sos.is_closed) {
      statements.push(
        env.DB.prepare("UPDATE raw_targets SET status = 'failed' WHERE id = ?").bind(target.id)
      );
      failedCount++;
      continue;
    }

    // 3. Pass surviving targets through calculateFicaSavings (0.70 participation, $120/mo)
    const headcount = 10;
    const fica = calculateFicaSavings(headcount, 0.70, 120);

    // 4. Generate exact smart_calling_pvp formatted string
    const perEmpFormatted = '$' + fica.per_employee_annual_savings.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    const smart_calling_pvp = `We are helping local commercial employers permanently recapture exactly 7.65% in matching FICA tax liabilities—averaging ${perEmpFormatted} per participating employee annually—which for a shop your size equates to ${fica.formatted_savings} directly back to the bottom line.`;

    // Categorize industry
    const lowerName = businessName.toLowerCase();
    let industry = 'Other Commercial';
    if (lowerName.includes('hvac') || lowerName.includes('heating') || lowerName.includes('cooling') || lowerName.includes('air') || lowerName.includes('plumb')) {
      industry = 'Construction & Trades';
    } else if (lowerName.includes('mfg') || lowerName.includes('manufacturing') || lowerName.includes('fabricat') || lowerName.includes('machine') || lowerName.includes('metal')) {
      industry = 'Manufacturing';
    }

    const notes = [
      `[Overnight Intelligence]`,
      sos.formation_year ? `Formation Year: ${sos.formation_year}` : null,
      sos.officers?.length ? `Officers: ${sos.officers.join(', ')}` : null,
      `PVP: ${smart_calling_pvp}`
    ].filter(Boolean).join('\n');

    // Identity resolution via CompanyMatcher
    const match = matcher.resolve({
      company_name: businessName,
      street_1: address
    });

    const companyId = match?.company_id || crypto.randomUUID();
    if (!match?.company_id) {
      matcher.add({
        company_id: companyId,
        company_name: businessName,
        street_1: address
      });
    }
    const syncVersion = 1;
    const doorKey = getDoorKey(businessName, address);

    const conflictClause = (doorKey && address)
      ? "ON CONFLICT(agent_email, door_key) WHERE street_1 IS NOT NULL AND street_1 != '' AND door_key IS NOT NULL DO UPDATE SET"
      : "ON CONFLICT(company_id, agent_email) DO UPDATE SET";

    // 5. Batch insert directly into active companies table
    statements.push(
      env.DB.prepare(`
        INSERT INTO companies (
          company_id, company_name, street_1, city, state, zip_code,
          industry, lead_source, rating, pipeline_stage, status, verification_status,
          confidence_score, decision_maker, notes,
          estimated_w2_count, est_fica_tax_savings,
          sync_version, door_key, agent_email, updated_at_utc, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, 'Cold Call', 'Warm', 'PROSPECT', 'ACTIVE', 'UNVERIFIED',
          60, ?, ?,
          ?, ?,
          ?, ?, ?, datetime('now'), datetime('now')
        )
        ${conflictClause}
          company_name = excluded.company_name,
          door_key = excluded.door_key,
          street_1 = excluded.street_1,
          decision_maker = excluded.decision_maker,
          notes = excluded.notes,
          est_fica_tax_savings = excluded.est_fica_tax_savings,
          sync_version = companies.sync_version + 1,
          updated_at_utc = datetime('now')
      `).bind(
        companyId,
        businessName,
        address,
        'Springfield',
        'MO',
        '65807',
        industry,
        sos.decision_maker,
        notes,
        headcount,
        fica.employer_fica_savings,
        syncVersion,
        doorKey,
        DEFAULT_AGENT_EMAIL
      )
    );

    // Mark processed target as completed
    statements.push(
      env.DB.prepare("UPDATE raw_targets SET status = 'completed' WHERE id = ?").bind(target.id)
    );

    survivedCount++;
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  console.log(`Phase B Batch Complete: ${survivedCount} survived & inserted, ${failedCount} dropped via attrition`);
  return {
    processed: batch.length,
    survived: survivedCount,
    failed: failedCount
  };
}

/**
 * Router for scheduled cron triggers:
 * - 0 2 * * *: Nightly rollup + Phase A (Sourcing)
 * - 15 2 * * *, 30 2 * * *, 45 2 * * *: Phase B (Chunked Processing)
 */
export async function handleScheduledEvent(event, env) {
  const cron = event?.cron;
  console.log(`Cron triggered with schedule: "${cron}"`);

  if (cron === '0 2 * * *') {
    await runNightlyRollup(env).catch(err => console.error('Nightly rollup error:', err));
    await runNightlySourcing(env).catch(err => console.error('Phase A sourcing error:', err));
  } else {
    await runChunkedProcessing(env).catch(err => console.error('Phase B chunked processing error:', err));
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledEvent(event, env));
  }
};

export { app };
export { SECURITY_HEADERS, CONTENT_SECURITY_POLICY } from './lib/security.js';
export { businessDate, businessDayRangeUtc, toSqlTimestamp, toLocalStamp } from './lib/time.js';
export { cleanText, deriveDisposition, matchEnum, parseJsonLoose, RATINGS, DISPOSITIONS } from './lib/validate.js';

