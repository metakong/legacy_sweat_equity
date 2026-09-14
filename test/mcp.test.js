/**
 * Tests for MCP Server Endpoint (/api/mcp)
 * Standard: MCP 2026-07-28 (Stateless Streamable HTTP)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-mcp-')), 'test.sqlite');
}

const callMcp = (env, payload, headers = {}) => {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...headers
  };
  return app.fetch(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: reqHeaders,
      body: payload ? JSON.stringify(payload) : undefined
    }),
    env,
    { waitUntil() {} }
  );
};

test('/api/mcp enforces 401 Unauthorized when token is missing or invalid', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  // Missing Authorization header
  const resNoAuth = await callMcp(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(resNoAuth.status, 401);
  const jsonNoAuth = await resNoAuth.json();
  assert.equal(jsonNoAuth.error, 'Unauthorized');

  // Wrong Bearer token
  const resWrongAuth = await callMcp(
    env,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { 'Authorization': 'Bearer invalid_secret_key' }
  );
  assert.equal(resWrongAuth.status, 401);
  const jsonWrongAuth = await resWrongAuth.json();
  assert.equal(jsonWrongAuth.error, 'Unauthorized');
});

test('/api/mcp allows access with valid Authorization: Bearer <MCP_SECRET_KEY>', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  const resValid = await callMcp(
    env,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { 'Authorization': 'Bearer local_dev_key' }
  );

  assert.equal(resValid.status, 200);
});

test('update_lead_intel successfully updates a mock D1 record when exactly one match is found', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  // Seed a single company
  await env.DB._raw.prepare(
    "INSERT INTO companies (company_id, company_name, pipeline_stage, notes) VALUES ('c101', 'Springfield Manufacturing', 'NEW', 'Initial field notes')"
  ).run();

  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'update_lead_intel',
      arguments: {
        company_name: 'Springfield Manufacturing',
        pipeline_stage: 'QUALIFIED',
        new_notes: 'Owner expressed high interest in short-term disability.'
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /Successfully updated company/);
  assert.match(text, /Springfield Manufacturing/);

  // Verify D1 record updated in SQLite
  const row = env.DB._raw.prepare("SELECT * FROM companies WHERE company_id = 'c101'").get();
  assert.equal(row.pipeline_stage, 'QUALIFIED');
  assert.match(row.notes, /Initial field notes/);
  assert.match(row.notes, /Owner expressed high interest in short-term disability\./);
});

test('update_lead_intel returns explicit error string when 0 matches are found', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  const payload = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'update_lead_intel',
      arguments: {
        company_name: 'Nonexistent Corp',
        pipeline_stage: 'QUALIFIED'
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /Error: No company found matching/);
  assert.match(text, /Nonexistent Corp/);
});

test('update_lead_intel returns explicit error string when multiple matches are found', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  // Seed two matching companies
  await env.DB._raw.prepare(
    "INSERT INTO companies (company_id, company_name, pipeline_stage) VALUES ('c201', 'Midwest Logistics North', 'NEW')"
  ).run();
  await env.DB._raw.prepare(
    "INSERT INTO companies (company_id, company_name, pipeline_stage) VALUES ('c202', 'Midwest Logistics South', 'NEW')"
  ).run();

  const payload = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'update_lead_intel',
      arguments: {
        company_name: 'Midwest Logistics',
        pipeline_stage: 'PITCHED'
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /Error: Multiple companies/);
  assert.match(text, /Midwest Logistics North/);
  assert.match(text, /Midwest Logistics South/);
});

test('/api/mcp tools/list registers all enterprise tools', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  const res = await callMcp(
    env,
    { jsonrpc: '2.0', id: 10, method: 'tools/list' },
    { 'Authorization': 'Bearer local_dev_key' }
  );
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /update_lead_intel/);
  assert.match(text, /get_daily_telemetry/);
  assert.match(text, /get_pipeline_summary/);
  assert.match(text, /triage_suppression_list/);
  assert.match(text, /generate_route_manifest/);
  assert.match(text, /log_quick_action/);
  assert.match(text, /generate_section125_teaser/);
  assert.match(text, /advance_cadence_touch/);
  assert.match(text, /scrape_sos_business_entity/);
});

test('generate_route_manifest runs autonomous spatial EPV routing', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  // Seed two companies in Springfield
  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, lat, long, employees, industry, status, confidence_score)
    VALUES ('c301', 'Ozark Heavy Fabrication', 37.2100, -93.2900, 25, 'Manufacturing', 'ACTIVE', 85)
  `).run();
  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, lat, long, employees, industry, status, confidence_score)
    VALUES ('c302', 'Route 66 Auto Repair', 37.2150, -93.2950, 8, 'Automotive & Dealerships', 'ACTIVE', 75)
  `).run();

  const payload = {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'generate_route_manifest',
      arguments: {
        radius_miles: 15,
        limit: 10
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /Route Manifest/);
  assert.match(text, /Ozark Heavy Fabrication/);
  assert.match(text, /commercial_hook/);
  assert.match(text, /epv/);
});

test('log_quick_action REACTIVATE resets status and clears disqualification', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, status, verification_status, confidence_score, disqualified_reason, sync_version)
    VALUES ('c303', 'Southwest MO Electric', 'DISQUALIFIED', 'DISQUALIFIED', 0, 'Spoke with DM - not interested', 1)
  `).run();

  const payload = {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'log_quick_action',
      arguments: {
        company_name: 'Southwest MO Electric',
        action: 'REACTIVATE',
        notes: 'New management reached out regarding voluntary benefits'
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /Reactivated account/);

  const row = env.DB._raw.prepare("SELECT * FROM companies WHERE company_id = 'c303'").get();
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.verification_status, 'FIELD_VERIFIED');
  assert.equal(row.confidence_score, 70);
  assert.equal(row.disqualified_reason, null);
  assert.equal(row.sync_version, 2);
  assert.match(row.notes, /New management reached out/);
});

test('generate_section125_teaser computes FICA savings and updates company', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, employees, decision_maker)
    VALUES ('c304', 'Midwest Industrial Tool', 20, 'Sarah Connor')
  `).run();

  const payload = {
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'generate_section125_teaser',
      arguments: {
        company_name: 'Midwest Industrial Tool'
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /Section 125 Cafeteria Plan FICA Tax Savings Teaser/);
  assert.match(text, /Midwest Industrial Tool/);
  assert.match(text, /CHECK NO:/);
  assert.match(text, /Sarah Connor/);

  const row = env.DB._raw.prepare("SELECT * FROM companies WHERE company_id = 'c304'").get();
  assert.ok(row.est_fica_tax_savings > 0);
  assert.equal(row.estimated_w2_count, 20);
});

test('advance_cadence_touch advances stage and logs activity', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, cadence_stage)
    VALUES ('c305', 'Springfield Metal Works', 0)
  `).run();

  const payload = {
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: {
      name: 'advance_cadence_touch',
      arguments: {
        company_name: 'Springfield Metal Works',
        touch_disposition: 'Dropped Teaser'
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /Advanced Cadence for Springfield Metal Works/);
  assert.match(text, /New Stage: 1/);

  const row = env.DB._raw.prepare("SELECT * FROM companies WHERE company_id = 'c305'").get();
  assert.equal(row.cadence_stage, 1);
  assert.equal(row.cadence_status, 'ACTIVE');
  assert.ok(row.cadence_next_due_date);
  assert.ok(row.cadence_last_touch_at);

  const logRow = env.DB._raw.prepare("SELECT * FROM activity_logs WHERE company_id = 'c305'").get();
  assert.ok(logRow);
  assert.equal(logRow.disposition, 'Dropped Teaser');
});

test('scrape_sos_business_entity handles timeout gracefully with D1 cached fallback (Guardrail 5)', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, decision_maker, industry, status)
    VALUES ('c306', 'Ozark Premier Builders LLC', 'Mark Miller', 'Construction & Trades', 'ACTIVE')
  `).run();

  const payload = {
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: {
      name: 'scrape_sos_business_entity',
      arguments: {
        company_name: 'Ozark Premier Builders LLC'
      }
    }
  };

  const res = await callMcp(env, payload, { 'Authorization': 'Bearer local_dev_key' });
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.match(text, /cached/);
  assert.match(text, /Ozark Premier Builders LLC/);
  assert.match(text, /Mark Miller/);
});
