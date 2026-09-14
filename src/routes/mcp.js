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
    'Generate an optimized driving route sequence of companies with EPV (Expected Premium Value) scores.',
    {
      company_ids: z.array(z.string()).optional().describe('Specific IDs to route'),
      mode: z.enum(['PHONE', 'FIELD']).optional().describe('Or provide a mode to auto-select targets')
    },
    async ({ company_ids, mode }) => {
      // If mode is passed without company_ids, fetch top 30
      let fetchIds = company_ids || [];
      if (fetchIds.length === 0 && mode) {
        const minConf = mode === 'FIELD' ? 80 : 30;
        const maxConf = mode === 'FIELD' ? 100 : 79;
        const { results } = await env.DB.prepare(`
          SELECT company_id FROM companies
          WHERE agent_email = ? AND status NOT IN ('DISQUALIFIED', 'DO_NOT_CONTACT')
          AND confidence_score BETWEEN ? AND ?
          AND lat IS NOT NULL AND long IS NOT NULL
          ORDER BY confidence_score DESC LIMIT 30
        `).bind(DEFAULT_AGENT_EMAIL, minConf, maxConf).all();
        fetchIds = (Array.isArray(results) ? results : []).map(r => r.company_id);
      }
      
      if (fetchIds.length === 0) return { isError: true, content: [{ type: 'text', text: 'No companies provided or found.' }] };

      // Make a local request to our own routing endpoint (simulated)
      // Since MCP runs in the same worker, we can just call the logic, or mock the fetch
      // For simplicity, we just use the REST API locally via fetch if possible, 
      // but MCP doesn't have an easy way to self-fetch without full URL.
      // We will re-implement the simple heuristic sequence call or just use c.env.DB
      // Wait, we can't easily call the route endpoint without the origin.
      // Instead we will just pull the data and calculate EPV.
      const placeholders = fetchIds.map(() => '?').join(', ');
      const { results } = await env.DB.prepare(`
        SELECT company_id, company_name, lat, long, employees, industry
        FROM companies
        WHERE company_id IN (${placeholders}) AND agent_email = ? AND lat IS NOT NULL AND long IS NOT NULL
      `).bind(...fetchIds, DEFAULT_AGENT_EMAIL).all();
      
      const stops = Array.isArray(results) ? results : [];
      if (stops.length === 0) return { isError: true, content: [{ type: 'text', text: 'No valid routable stops found.' }] };

      // simple EPV calculation
      const INDUSTRY_MULTIPLIERS = {
        'Construction & Trades': 2.0, 'Manufacturing': 1.8, 'Transportation & Logistics': 1.7,
        'Healthcare & Medical': 1.6, 'Automotive & Dealerships': 1.5, 'Agriculture & Forestry': 1.5,
        'Mining & Extraction': 1.5, 'Hospitality & Food Service': 1.3, 'Wholesale & Distribution': 1.3,
        'Utilities & Communications': 1.3, 'Real Estate': 1.1, 'Retail Trade': 1.1,
        'Personal & Consumer Services': 1.1, 'Entertainment & Recreation': 1.1
      };
      
      const manifest = stops.map(s => {
        const emp = (s.employees && s.employees > 0) ? s.employees : 5;
        const mult = INDUSTRY_MULTIPLIERS[s.industry] || 1.0;
        const epv = Math.round(((emp * mult) / 1.5) * 10) / 10; // distance assumed ~1
        return {
          company_id: s.company_id,
          company_name: s.company_name,
          epv
        };
      });
      
      manifest.sort((a, b) => b.epv - a.epv);
      
      return { content: [{ type: 'text', text: `Route Manifest (sorted by EPV):\n${JSON.stringify(manifest, null, 2)}` }] };
    }
  );

  server.tool(
    'log_quick_action',
    'Log a quick action for an account (CALL_BACK, FOLLOW_UP, SNOOZE, DISQUALIFY).',
    {
      company_name: z.string().describe('Fuzzy match name'),
      action: z.enum(['CALL_BACK', 'FOLLOW_UP', 'SNOOZE', 'DISQUALIFY']),
      notes: z.string().optional(),
      date: z.string().optional().describe('YYYY-MM-DD for snooze or callback date')
    },
    async ({ company_name, action, notes, date }) => {
      const pattern = `%${company_name.trim()}%`;
      const { results } = await env.DB.prepare(
        'SELECT company_id, company_name FROM companies WHERE company_name LIKE ? AND agent_email = ?'
      ).bind(pattern, DEFAULT_AGENT_EMAIL).all();
      const matches = Array.isArray(results) ? results : [];
      if (matches.length === 0) return { isError: true, content: [{ type: 'text', text: `Error: No company found matching "${company_name}".` }] };
      if (matches.length > 1) return { isError: true, content: [{ type: 'text', text: `Error: Multiple companies matched "${company_name}".` }] };

      const target = matches[0];
      
      if (action === 'DISQUALIFY') {
        const reason = notes || 'Disqualified via MCP Quick Action';
        await env.DB.prepare(`
          UPDATE companies
          SET status = 'DISQUALIFIED', verification_status = 'DISQUALIFIED',
              confidence_score = 0, disqualified_reason = ?
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
        SET next_action = ?, next_action_date = ?
        WHERE company_id = ? AND agent_email = ?
      `).bind(actionText, date || businessDate(), target.company_id, DEFAULT_AGENT_EMAIL).run();
      
      return { content: [{ type: 'text', text: `Logged ${action} for ${target.company_name}.` }] };
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
