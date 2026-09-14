/**
 * Unit & Integration tests for Universal Reversibility, Reactivation Guardrails,
 * and D1 Chunked Batch Sync with LWW conflict resolution.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-reactivate-')), 'test.sqlite');
}

const mockJwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ email: 'sean_deardorff@us.aflac.com' })).toString('base64') + '.signature';

const call = (env, url, opts = {}) => {
  return app.fetch(
    new Request(`http://localhost${url}`, {
      method: opts.method || 'GET',
      headers: {
        'cf-access-jwt-assertion': mockJwt,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }),
    env,
    { waitUntil() {} }
  );
};

test('POST /api/leads/reactivate successfully reactivates a DISQUALIFIED company', async () => {
  const env = { DB: createD1(tempDbPath()) };

  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, status, verification_status, confidence_score, disqualified_reason, sync_version, agent_email)
    VALUES ('comp-disq-1', 'Ozark Roofing Pros', 'DISQUALIFIED', 'DISQUALIFIED', 0, 'No commercial interest', 1, 'sean_deardorff@us.aflac.com')
  `).run();

  const res = await call(env, '/api/leads/reactivate', {
    method: 'POST',
    body: { company_id: 'comp-disq-1' }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.status, 'ACTIVE');

  const row = env.DB._raw.prepare("SELECT * FROM companies WHERE company_id = 'comp-disq-1'").get();
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.verification_status, 'FIELD_VERIFIED');
  assert.equal(row.confidence_score, 70);
  assert.equal(row.disqualified_reason, null);
  assert.equal(row.sync_version, 2);
});

test('Guardrail 1: AC Electrical Systems Inc. (7025c556-9a5e-499d-836f-88073172facf) retains DISQUALIFIED integrity', async () => {
  const env = { DB: createD1(tempDbPath()) };
  const targetId = '7025c556-9a5e-499d-836f-88073172facf';

  // Seed AC Electrical Systems Inc. as DISQUALIFIED
  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, status, verification_status, confidence_score, disqualified_reason, sync_version, agent_email)
    VALUES (?, 'AC Electrical Systems Inc.', 'DISQUALIFIED', 'DISQUALIFIED', 0, 'Competitor exclusive contract', 1, 'sean_deardorff@us.aflac.com')
  `).run(targetId);

  // Run various non-targeting operations (e.g. sync other records, get companies)
  const listRes = await call(env, '/api/companies');
  assert.equal(listRes.status, 200);

  // Verify status is completely untouched
  let row = env.DB._raw.prepare('SELECT status, disqualified_reason FROM companies WHERE company_id = ?').get(targetId);
  assert.equal(row.status, 'DISQUALIFIED');
  assert.equal(row.disqualified_reason, 'Competitor exclusive contract');

  // Explicit event-driven reactivation succeeds when specifically requested
  const reactivateRes = await call(env, '/api/leads/reactivate', {
    method: 'POST',
    body: { company_id: targetId }
  });
  assert.equal(reactivateRes.status, 200);

  row = env.DB._raw.prepare('SELECT status, disqualified_reason FROM companies WHERE company_id = ?').get(targetId);
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.disqualified_reason, null);
});

test('POST /api/sync processes >25 operations in atomic chunks of <= 25 and applies LWW', async () => {
  const env = { DB: createD1(tempDbPath()) };

  // Seed target company
  await env.DB._raw.prepare(`
    INSERT INTO companies (company_id, company_name, status, agent_email)
    VALUES ('comp-sync-batch', 'Batch Target Inc', 'ACTIVE', 'sean_deardorff@us.aflac.com')
  `).run();

  // Seed an existing activity log with sync_version 5 and newer timestamp
  await env.DB._raw.prepare(`
    INSERT INTO activity_logs (log_id, company_id, disposition, is_in_person, is_initial, is_dm_contact, client_timestamp_utc, sync_version, agent_email)
    VALUES ('log-conflict-lww', 'comp-sync-batch', 'Presentation Scheduled', 1, 0, 1, '2026-09-14T12:00:00.000Z', 5, 'sean_deardorff@us.aflac.com')
  `).run();

  // Build a batch of 28 log entries to test chunking across the 25-statement boundary
  const logs = [];
  for (let i = 1; i <= 27; i++) {
    logs.push({
      log_id: `chunk-log-${i}`,
      company_id: 'comp-sync-batch',
      disposition: 'Gatekeeper Stall',
      is_in_person: true,
      sync_version: 1,
      client_timestamp_utc: `2026-09-14T10:00:${String(i).padStart(2, '0')}.000Z`
    });
  }

  // 28th log: older sync_version (1 vs 5) trying to overwrite log-conflict-lww
  logs.push({
    log_id: 'log-conflict-lww',
    company_id: 'comp-sync-batch',
    disposition: 'Dropped Material', // should NOT overwrite Presentation Scheduled
    sync_version: 1,
    client_timestamp_utc: '2026-09-14T08:00:00.000Z'
  });

  const res = await call(env, '/api/sync', {
    method: 'POST',
    body: { logs }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.count, 28);
  assert.equal(data.rejected.length, 0);

  // Verify all 27 chunked logs were persisted
  const countRow = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE log_id LIKE 'chunk-log-%'").get();
  assert.equal(countRow.n, 27);

  // Verify LWW conflict resolution: server's Presentation Scheduled with sync_version 5 was preserved!
  const lwwRow = env.DB._raw.prepare("SELECT disposition, sync_version FROM activity_logs WHERE log_id = 'log-conflict-lww'").get();
  assert.equal(lwwRow.disposition, 'Presentation Scheduled');
  assert.equal(lwwRow.sync_version, 5);
});
