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
