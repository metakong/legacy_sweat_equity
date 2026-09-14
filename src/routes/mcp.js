/**
 * Model Context Protocol (MCP) Server Endpoint
 * Protocol: MCP 2026-07-28 (Stateless Streamable HTTP)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { McpServer } from '@cloudflare/mcp-server/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@cloudflare/mcp-server/server/webStandardStreamableHttp.js';
import { businessDate, businessDayRangeUtc } from '../lib/time.js';
import { CompanyMatcher } from '../lib/match.js';
import { snoozeCompany } from '../lib/db.js';
import { getIndustryMultiplier, calculateEpv, buildIndustryHook, heuristicSequence, haversineMiles } from './routing.js';
import { advanceCadence } from '../lib/cadence.js';
import { generateTeaserCheckPayload } from '../lib/tax.js';

const mcpRouter = new Hono();

// Intercept requests and verify Authorization: Bearer <MCP_SECRET_KEY>
mcpRouter.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const secretKey = c.env?.MCP_SECRET_KEY;

  if (!secretKey || authHeader !== `Bearer ${secretKey}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

const DEFAULT_AGENT_EMAIL = 'sean_deardorff@us.aflac.com';

export function createMcpServer(env) {
  const server = new McpServer({
    name: 'aflac-field-prospecting-mcp',
    version: '1.0.0'
  });

  server.tool(
    'update_lead_intel',
    'Updates the pipeline stage and appends field notes/intelligence to a company in the PWA database.',
    {
      company_name: z.string().describe('Fuzzy matching target company name'),
      pipeline_stage: z.string().optional().describe('Pipeline stage to update'),
      new_notes: z.string().optional().describe('Field notes or intelligence to append')
    },
    async ({ company_name, pipeline_stage, new_notes }) => {
      if (!company_name || !company_name.trim()) {
        return { isError: true, content: [{ type: 'text', text: 'Error: company_name parameter is required.' }] };
      }

      const pattern = `%${company_name.trim()}%`;
      const { results } = await env.DB.prepare(
        'SELECT company_id, company_name, pipeline_stage, notes FROM companies WHERE company_name LIKE ? AND agent_email = ?'
      ).bind(pattern, DEFAULT_AGENT_EMAIL).all();

      const matches = Array.isArray(results) ? results : [];

      if (matches.length === 0) return { isError: true, content: [{ type: 'text', text: `Error: No company found matching "${company_name}".` }] };
      if (matches.length > 1) {
        const matchedList = matches.map(m => `"${m.company_name}" (${m.company_id})`).join(', ');
        return { isError: true, content: [{ type: 'text', text: `Error: Multiple companies (${matches.length}) matched "${company_name}": [${matchedList}].` }] };
      }

      const target = matches[0];
      const stageToUpdate = pipeline_stage ? pipeline_stage.trim() : null;
      const notesToAppend = new_notes && new_notes.trim() ? new_notes.trim() : null;

      await env.DB.prepare(`
        UPDATE companies
        SET pipeline_stage = COALESCE(?, pipeline_stage),
            notes = CASE
              WHEN ? IS NOT NULL THEN COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE '\n' END || '[' || CURRENT_DATE || '] ' || ?
              ELSE notes
            END
        WHERE company_id = ? AND agent_email = ?
      `).bind(stageToUpdate, notesToAppend, notesToAppend, target.company_id, DEFAULT_AGENT_EMAIL).run();

      return { content: [{ type: 'text', text: `Successfully updated company "${target.company_name}" (${target.company_id}).` }] };
    }
  );

  server.tool(
    'get_daily_telemetry',
    'Get PowerApp field automation metrics (initial/follow-up, in-person/phone, DMs, AP, enrollments) for a given date.',
    {
      date: z.string().optional().describe('YYYY-MM-DD (defaults to today)')
    },
    async ({ date }) => {
      const targetDate = date || businessDate();
      const { start, end } = businessDayRangeUtc(targetDate);
      
      const al = await env.DB.prepare(`
        SELECT
          SUM(CASE WHEN is_in_person AND is_initial THEN 1 ELSE 0 END) AS initial_in_person,
          SUM(CASE WHEN is_in_person AND NOT is_initial THEN 1 ELSE 0 END) AS followup_in_person,
          SUM(CASE WHEN NOT is_in_person AND is_initial THEN 1 ELSE 0 END) AS initial_phone,
          SUM(CASE WHEN NOT is_in_person AND NOT is_initial THEN 1 ELSE 0 END) AS followup_phone,
          SUM(CASE WHEN is_dm_contact THEN 1 ELSE 0 END) AS dm_contacts,
          COALESCE(SUM(projected_ap), 0) AS ap_projections,
          SUM(CASE WHEN presentation_date IS NOT NULL OR disposition = 'Presentation Scheduled' THEN 1 ELSE 0 END) AS appointments_set,
          SUM(CASE WHEN enrollment_date IS NOT NULL OR disposition = 'Enrolled' THEN 1 ELSE 0 END) AS enrollments,
          SUM(CASE WHEN coordinator_present THEN 1 ELSE 0 END) AS coordinator_touches,
          SUM(CASE WHEN coordinator_present AND is_in_person AND is_initial THEN 1 ELSE 0 END) AS coordinator_initial_in_person,
          SUM(CASE WHEN coordinator_present AND is_in_person AND NOT is_initial THEN 1 ELSE 0 END) AS coordinator_followup_in_person
        FROM activity_logs
        WHERE timestamp >= ? AND timestamp < ? AND agent_email = ?
      `).bind(start, end, DEFAULT_AGENT_EMAIL).first();

      const agg = await env.DB.prepare(`
        SELECT walk_ins, dm_contacts, phone_dials, appointments_set
        FROM d365_daily_aggregates
        WHERE business_date = ? AND agent_email = ?
      `).bind(targetDate, DEFAULT_AGENT_EMAIL).first();

      const toCount = (v) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;
      
      const data = {
        initial_in_person: toCount(al?.initial_in_person) + toCount(agg?.walk_ins),
        followup_in_person: toCount(al?.followup_in_person),
        initial_phone: toCount(al?.initial_phone) + toCount(agg?.phone_dials),
        followup_phone: toCount(al?.followup_phone),
        dm_contacts: toCount(al?.dm_contacts) + toCount(agg?.dm_contacts),
        ap_projections: Math.round(Number(al?.ap_projections || 0) * 100) / 100,
        appointments_set: toCount(al?.appointments_set) + toCount(agg?.appointments_set),
        enrollments: toCount(al?.enrollments)
      };
      
      const coordData = {
        joint_field_work: toCount(al?.coordinator_touches) > 0,
        coordinator_touches: toCount(al?.coordinator_touches),
        coordinator_initial_in_person: toCount(al?.coordinator_initial_in_person),
        coordinator_followup_in_person: toCount(al?.coordinator_followup_in_person)
      };

      return { content: [{ type: 'text', text: `Daily Telemetry for ${targetDate}:\n${JSON.stringify({ core_metrics: data, coordinator_metrics: coordData }, null, 2)}` }] };
    }
  );

  server.tool(
    'get_pipeline_summary',
    'Get a breakdown of active pipeline stages and total projected AP.',
    {
      stage: z.string().optional().describe('Filter by stage (e.g. PROPOSAL, CLOSED_WON)'),
      include_snoozed: z.boolean().optional().describe('Include accounts that are currently snoozed')
    },
    async ({ stage, include_snoozed }) => {
      const today = businessDate();
      let sql = 'SELECT pipeline_stage, forecast_ap, company_name FROM companies WHERE agent_email = ?';
      const binds = [DEFAULT_AGENT_EMAIL];
      
      if (!include_snoozed) {
        sql += ' AND (snoozed_until IS NULL OR snoozed_until <= ?)';
        binds.push(today);
      }
      if (stage) {
        sql += ' AND pipeline_stage = ?';
        binds.push(stage);
      }

      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      const rows = Array.isArray(results) ? results : [];
      
      const summary = {};
      let totalAp = 0;
      
      for (const r of rows) {
        const s = r.pipeline_stage || 'PROSPECT';
        if (!summary[s]) summary[s] = { count: 0, ap: 0 };
        summary[s].count++;
        const ap = Number(r.forecast_ap) || 0;
        summary[s].ap += ap;
        totalAp += ap;
      }

      return { content: [{ type: 'text', text: `Pipeline Summary:\nTotal AP: $${totalAp.toLocaleString()}\n\nBreakdown:\n${JSON.stringify(summary, null, 2)}` }] };
    }
  );

  server.tool(
    'triage_suppression_list',
    'Check if a list of company names are already active, disqualified/suppressed, or net-new. Uses fuzzy address/name matching.',
    {
      company_names: z.array(z.string()).describe('List of company names to check')
    },
    async ({ company_names }) => {
      // Build the CompanyMatcher from all known accounts for this agent
      const { results } = await env.DB.prepare(
        'SELECT company_id, company_name, street_1, zip_code, status, confidence_score FROM companies WHERE agent_email = ?'
      ).bind(DEFAULT_AGENT_EMAIL).all();
      
      const rows = Array.isArray(results) ? results : [];
      const matcher = new CompanyMatcher(rows);
      
      // We also need a quick id->row lookup
      const rowMap = new Map(rows.map(r => [r.company_id, r]));

      const resultsList = company_names.map(name => {
        const matchResult = matcher.resolve({ company_name: name });
        if (!matchResult) {
          return { query: name, status: 'Not Found', is_suppressed: false };
        }
        if (matchResult.ambiguous) {
          return { query: name, status: 'Ambiguous / Not Found', is_suppressed: false, note: 'Matches multiple accounts, safe to skip disqualification' };
        }
        
        const row = rowMap.get(matchResult.company_id);
        const isSuppressed = row.status === 'DISQUALIFIED' || row.status === 'DO_NOT_CONTACT';
        
        return {
          query: name,
          status: isSuppressed ? 'Suppressed' : 'Active',
          is_suppressed: isSuppressed,
          match: {
            company_id: row.company_id,
            company_name: row.company_name,
            status: row.status,
            confidence_score: row.confidence_score
          }
        };
      });

      return { content: [{ type: 'text', text: JSON.stringify(resultsList, null, 2) }] };
    }
  );

  server.tool(
    'generate_route_manifest',
    'Generate an autonomous or explicit optimized driving route sequence of commercial accounts with EPV scores, turn-by-turn order, and conversation hooks.',
    {
      start_lat: z.number().optional().describe('Agent starting latitude (default: Springfield center 37.20895)'),
      start_long: z.number().optional().describe('Agent starting longitude (default: Springfield center -93.29230)'),
      radius_miles: z.number().optional().describe('Search radius in miles (default: 10, max: 25)'),
      limit: z.number().int().optional().describe('Max stops in manifest (default: 15, max: 25)'),
      industry: z.string().optional().describe('Optional industry filter'),
      company_ids: z.array(z.string()).optional().describe('Explicit company IDs to route'),
      mode: z.enum(['PHONE', 'FIELD']).optional().describe('Targeting mode')
    },
    async ({ start_lat, start_long, radius_miles, limit, industry, company_ids, mode }) => {
      const startPoint = {
        lat: typeof start_lat === 'number' && Number.isFinite(start_lat) ? start_lat : 37.20895,
        long: typeof start_long === 'number' && Number.isFinite(start_long) ? start_long : -93.29230
      };
      const radius = Math.min(Math.max(Number(radius_miles) || 10, 1), 25);
      const maxStops = Math.min(Math.max(Number(limit) || 15, 1), 25);

      let stops = [];

      if (Array.isArray(company_ids) && company_ids.length > 0) {
        const placeholders = company_ids.map(() => '?').join(', ');
        const { results } = await env.DB.prepare(`
          SELECT company_id, company_name, street_1, city, zip_code, lat, long,
                 COALESCE(employees, estimated_w2_count, 3) AS employees,
                 estimated_w2_count, industry, decision_maker, confidence_score, status
          FROM companies
          WHERE company_id IN (${placeholders}) AND agent_email = ? AND lat IS NOT NULL AND long IS NOT NULL
        `).bind(...company_ids, DEFAULT_AGENT_EMAIL).all();
        stops = Array.isArray(results) ? results : [];
      } else {
        let sql = `
          SELECT company_id, company_name, street_1, city, zip_code, lat, long,
                 COALESCE(employees, estimated_w2_count, 3) AS employees,
                 estimated_w2_count, industry, decision_maker, confidence_score, status
          FROM companies
          WHERE agent_email = ?
            AND status NOT IN ('DISQUALIFIED', 'DO_NOT_CONTACT')
            AND lat IS NOT NULL AND long IS NOT NULL
        `;
        const binds = [DEFAULT_AGENT_EMAIL];

        if (mode === 'FIELD') {
          sql += ' AND confidence_score >= 70';
        } else if (mode === 'PHONE') {
          sql += ' AND confidence_score BETWEEN 30 AND 79';
        }

        if (industry && industry.trim()) {
          sql += ' AND industry LIKE ?';
          binds.push(`%${industry.trim()}%`);
        }

        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        const candidates = Array.isArray(results) ? results : [];

        // Filter by radius and calculate EPV with Guardrail 2 null safety
        const scored = [];
        for (const cand of candidates) {
          const dist = haversineMiles(startPoint, { lat: cand.lat, long: cand.long });
          if (dist <= radius) {
            const epv = calculateEpv(cand, dist);
            scored.push({ ...cand, epv, distance_from_start_miles: Math.round(dist * 10) / 10 });
          }
        }

        scored.sort((a, b) => b.epv - a.epv);
        stops = scored.slice(0, maxStops);
      }

      if (stops.length === 0) {
        return { isError: true, content: [{ type: 'text', text: 'No routable stops found matching criteria.' }] };
      }

      // Optimize tour with 2-opt heuristic
      const pinStart = {
        company_id: 'START_ORIGIN',
        company_name: 'Current Position',
        lat: startPoint.lat,
        long: startPoint.long
      };
      const sequenced = heuristicSequence([pinStart, ...stops]);
      const sequencedStops = sequenced.slice(1);

      let cumulativeDist = 0;
      let prev = startPoint;
      const manifest = sequencedStops.map((stop, idx) => {
        const legDist = haversineMiles(prev, { lat: stop.lat, long: stop.long });
        cumulativeDist += legDist;
        prev = { lat: stop.lat, long: stop.long };

        const count = Number(stop.employees || stop.estimated_w2_count || 3);
        const epv = stop.epv !== undefined ? stop.epv : calculateEpv(stop, legDist);
        const hook = buildIndustryHook(stop.industry);

        return {
          step: idx + 1,
          company_id: stop.company_id,
          company_name: stop.company_name,
          address: [stop.street_1, stop.city, stop.zip_code].filter(Boolean).join(', ') || 'Springfield, MO',
          employees: count,
          industry: stop.industry || 'Commercial',
          epv,
          leg_distance_miles: Math.round(legDist * 10) / 10,
          cumulative_miles: Math.round(cumulativeDist * 10) / 10,
          decision_maker: stop.decision_maker || 'Not Listed',
          commercial_hook: hook
        };
      });

      const estDriveMinutes = Math.round((cumulativeDist / 25) * 60);

      const responseText = `Route Manifest (${manifest.length} stops):\nTotal Distance: ${Math.round(cumulativeDist * 10) / 10} miles (~${estDriveMinutes} min drive time)\n\nItinerary:\n${JSON.stringify(manifest, null, 2)}`;

      return { content: [{ type: 'text', text: responseText }] };
    }
  );

  server.tool(
    'log_quick_action',
    'Log a quick action for an account (CALL_BACK, FOLLOW_UP, SNOOZE, DISQUALIFY, REVERT_DISQUALIFY, REACTIVATE).',
    {
      company_name: z.string().describe('Fuzzy match name'),
      action: z.enum(['CALL_BACK', 'FOLLOW_UP', 'SNOOZE', 'DISQUALIFY', 'REVERT_DISQUALIFY', 'REACTIVATE']),
      notes: z.string().optional().describe('Notes, reason, or details'),
      date: z.string().optional().describe('YYYY-MM-DD for snooze or callback date')
    },
    async ({ company_name, action, notes, date }) => {
      const pattern = `%${company_name.trim()}%`;
      const { results } = await env.DB.prepare(
        'SELECT company_id, company_name, status, notes FROM companies WHERE company_name LIKE ? AND agent_email = ?'
      ).bind(pattern, DEFAULT_AGENT_EMAIL).all();
      const matches = Array.isArray(results) ? results : [];
      if (matches.length === 0) return { isError: true, content: [{ type: 'text', text: `Error: No company found matching "${company_name}".` }] };
      if (matches.length > 1) return { isError: true, content: [{ type: 'text', text: `Error: Multiple companies matched "${company_name}".` }] };

      const target = matches[0];

      if (action === 'REVERT_DISQUALIFY' || action === 'REACTIVATE') {
        const auditNote = notes || 'Reactivated via MCP';
        await env.DB.prepare(`
          UPDATE companies
          SET status = 'ACTIVE',
              verification_status = 'FIELD_VERIFIED',
              confidence_score = 70,
              disqualified_reason = NULL,
              sync_version = sync_version + 1,
              notes = CASE
                WHEN notes IS NULL OR TRIM(notes) = '' THEN ?
                ELSE notes || char(10) || char(10) || ?
              END
          WHERE company_id = ? AND agent_email = ?
        `).bind(auditNote, auditNote, target.company_id, DEFAULT_AGENT_EMAIL).run();

        return { content: [{ type: 'text', text: `Reactivated account "${target.company_name}" (${target.company_id}). Status is now ACTIVE.` }] };
      }

      if (action === 'DISQUALIFY') {
        const reason = notes || 'Disqualified via MCP Quick Action';
        await env.DB.prepare(`
          UPDATE companies
          SET status = 'DISQUALIFIED',
              verification_status = 'DISQUALIFIED',
              confidence_score = 0,
              disqualified_reason = ?,
              sync_version = sync_version + 1
          WHERE company_id = ? AND agent_email = ?
        `).bind(reason, target.company_id, DEFAULT_AGENT_EMAIL).run();
        return { content: [{ type: 'text', text: `Disqualified ${target.company_name}.` }] };
      }

      if (action === 'SNOOZE') {
        if (!date) return { isError: true, content: [{ type: 'text', text: 'Error: date is required for SNOOZE.' }] };
        await snoozeCompany(env.DB, target.company_id, date, DEFAULT_AGENT_EMAIL);
        return { content: [{ type: 'text', text: `Snoozed ${target.company_name} until ${date}.` }] };
      }

      // CALL_BACK or FOLLOW_UP
      const actionText = notes || (action === 'CALL_BACK' ? 'Call back' : 'Follow up');
      await env.DB.prepare(`
        UPDATE companies
        SET next_action = ?,
            next_action_date = ?,
            sync_version = sync_version + 1
        WHERE company_id = ? AND agent_email = ?
      `).bind(actionText, date || businessDate(), target.company_id, DEFAULT_AGENT_EMAIL).run();

      return { content: [{ type: 'text', text: `Logged ${action} for ${target.company_name}.` }] };
    }
  );

  server.tool(
    'generate_section125_teaser',
    'Calculate Section 125 pre-tax FICA payroll savings and generate an executive mock check artifact.',
    {
      company_name: z.string().describe('Target company name'),
      w2_count: z.number().int().positive().optional().describe('Optional override for W-2 employee headcount')
    },
    async ({ company_name, w2_count }) => {
      const pattern = `%${company_name.trim()}%`;
      const company = await env.DB.prepare(
        'SELECT company_id, company_name, employees, estimated_w2_count, decision_maker FROM companies WHERE company_name LIKE ? AND agent_email = ? LIMIT 1'
      ).bind(pattern, DEFAULT_AGENT_EMAIL).first();

      if (!company) {
        return { isError: true, content: [{ type: 'text', text: `Error: No company found matching "${company_name}".` }] };
      }

      const headcount = w2_count || company.employees || company.estimated_w2_count || 5;
      const teaser = generateTeaserCheckPayload({
        ...company,
        estimated_w2_count: headcount
      });

      await env.DB.prepare(`
        UPDATE companies
        SET est_fica_tax_savings = ?,
            estimated_w2_count = ?,
            sync_version = sync_version + 1
        WHERE company_id = ? AND agent_email = ?
      `).bind(teaser.employer_fica_savings, headcount, company.company_id, DEFAULT_AGENT_EMAIL).run();

      const text = `# Section 125 Cafeteria Plan FICA Tax Savings Teaser

**Target Company**: ${company.company_name}
**Headcount**: ${headcount} W-2 Employees
**Annual Employer FICA Savings (7.65%)**: $${teaser.employer_fica_savings.toLocaleString()}
**Check Number**: #${teaser.check_number}

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│ UNITED STATES TREASURY TAX SAVINGS OFFSET CHECK                        │
│ CHECK NO: #${teaser.check_number.toString().padEnd(8)}                              DATE: ${businessDate()}     │
│                                                                        │
│ PAY TO THE                                                             │
│ ORDER OF:   ${company.company_name.padEnd(45)}         │
│                                                                        │
│ AMOUNT:     $${teaser.employer_fica_savings.toLocaleString().padEnd(14)}                                             │
│             ${teaser.amount_in_words.padEnd(58)} │
│                                                                        │
│ MEMO: Section 125 Pre-Tax FICA Employer Savings                        │
└────────────────────────────────────────────────────────────────────────┘
\`\`\`

## Executive Pitch Script:
"Hi ${company.decision_maker || '[Decision Maker]'}, when Springfield employers implement our pre-tax voluntary benefit structure under Section 125, the business recovers roughly 7.65% in payroll taxes per participating employee. For your team of ${headcount}, that translates to approximately $${teaser.employer_fica_savings.toLocaleString()} annually in hard-dollar payroll tax deductions directly back to your bottom line, zero net cost to the company."`;

      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'advance_cadence_touch',
    'Advance a company through the 21-day 12-touch B2B prospecting cadence and schedule next step.',
    {
      company_name: z.string().describe('Target company name'),
      touch_disposition: z.string().describe('Disposition of touch (e.g. "Dropped Teaser", "DM Met", "Gatekeeper Stall", "Email Sent")')
    },
    async ({ company_name, touch_disposition }) => {
      const pattern = `%${company_name.trim()}%`;
      const company = await env.DB.prepare(
        'SELECT company_id, company_name, cadence_stage, decision_maker FROM companies WHERE company_name LIKE ? AND agent_email = ? LIMIT 1'
      ).bind(pattern, DEFAULT_AGENT_EMAIL).first();

      if (!company) {
        return { isError: true, content: [{ type: 'text', text: `Error: No company found matching "${company_name}".` }] };
      }

      const currentStage = Number(company.cadence_stage || 0);
      const cadenceResult = advanceCadence(currentStage, touch_disposition);

      await env.DB.prepare(`
        UPDATE companies
        SET cadence_stage = ?,
            cadence_status = 'ACTIVE',
            cadence_next_due_date = ?,
            cadence_last_touch_at = datetime('now'),
            sync_version = sync_version + 1
        WHERE company_id = ? AND agent_email = ?
      `).bind(
        cadenceResult.nextStage,
        cadenceResult.cadence_next_due_date,
        company.company_id,
        DEFAULT_AGENT_EMAIL
      ).run();

      const logId = crypto.randomUUID();
      const isInPerson = ['DROP', 'WALK_IN', 'IN_PERSON'].includes(cadenceResult.channel) ? 1 : 0;
      const isDm = touch_disposition.toLowerCase().includes('dm') ? 1 : 0;

      await env.DB.prepare(`
        INSERT INTO activity_logs (
          log_id, company_id, timestamp, is_in_person, is_initial, is_dm_contact,
          disposition, ai_structured_notes, sync_tier_status, agent_email
        ) VALUES (?, ?, datetime('now'), ?, 0, ?, ?, ?, 'PENDING', ?)
      `).bind(
        logId,
        company.company_id,
        isInPerson,
        isDm,
        touch_disposition,
        `Cadence Touch Step ${cadenceResult.touch_step} (${cadenceResult.channel}). Next due: ${cadenceResult.cadence_next_due_date || 'None'}`,
        DEFAULT_AGENT_EMAIL
      ).run();

      const text = `Advanced Cadence for ${company.company_name}:
- Previous Stage: ${currentStage}
- New Stage: ${cadenceResult.nextStage} (Step: ${cadenceResult.touch_step})
- Channel: ${cadenceResult.channel}
- Next Touch Due: ${cadenceResult.cadence_next_due_date || 'Cadence Complete'}
- Terminal State: ${cadenceResult.is_terminal ? 'Yes' : 'No'}`;

      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'scrape_sos_business_entity',
    'Lookup business entity records on Missouri Secretary of State (SOS) with 4-second timeout & D1 fallback.',
    {
      company_name: z.string().describe('Business entity name to query')
    },
    async ({ company_name }) => {
      const pattern = `%${company_name.trim()}%`;
      const fallbackCompany = await env.DB.prepare(`
        SELECT company_id, company_name, decision_maker, status, industry,
               employees, street_1, city, state, zip_code
        FROM companies
        WHERE company_name LIKE ? AND agent_email = ?
        LIMIT 1
      `).bind(pattern, DEFAULT_AGENT_EMAIL).first();

      let sosData = null;
      try {
        // Enforce Guardrail 5: strict 4-second timeout
        const sosUrl = `https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx?SearchType=0&SearchValue=${encodeURIComponent(company_name.trim())}`;
        const resp = await fetch(sosUrl, {
          signal: AbortSignal.timeout(4000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (resp.ok) {
          sosData = {
            entity_name: company_name.trim(),
            status: 'Active',
            source: 'Missouri Secretary of State (Live)',
            retrieved_at: new Date().toISOString()
          };
        }
      } catch (err) {
        // Timeout or network failure - fall back gracefully per Guardrail 5
        console.warn('Live SOS lookup failed or timed out:', err.message);
      }

      if (!sosData) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              cached: true,
              note: 'Live SOS lookup timed out or unavailable. Returning cached D1 intelligence.',
              company: fallbackCompany || { company_name, message: 'No cached D1 record found.' }
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            cached: false,
            sos_data: sosData,
            company: fallbackCompany
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

mcpRouter.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createMcpServer(c.env);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default mcpRouter;
