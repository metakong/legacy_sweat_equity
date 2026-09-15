/**
 * Phase 2 Edge Defenses Test Suite
 *
 * Verifies deterministic pre-flight gates, native DNC screening,
 * batch MCP ingestion, and curbside access barrier handling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';
import { checkDncSuppression, upsertCompany } from '../src/lib/db.js';
import { fetchUnvisitedCompanies } from '../src/routes/routing.js';
import { AUTH_HEADERS, TEST_EMAIL } from './test-auth.js';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-phase2-')), 'test.sqlite');
}

const callMcp = (env, payload, headers = {}) => {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer local_dev_key',
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

function parseMcpResponse(rawText) {
  for (const line of rawText.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      if (data.error) return data;
      const text = data?.result?.content?.[0]?.text;
      if (text) {
        try { return JSON.parse(text); } catch (_) { return text; }
      }
      return data;
    }
  }
  return JSON.parse(rawText);
}

// ---------------------------------------------------------------------------
// SUITE 1: Native DNC Matching and Suppression
// ---------------------------------------------------------------------------
test('checkDncSuppression matches exact normalized name or address', async () => {
  const env = { DB: createD1(tempDbPath()) };

  env.DB._raw.prepare(`
    INSERT INTO do_not_contact (company_name, normalized_name, street_address, exclusion_reason)
    VALUES
      ('Springfield Lumber Co', 'SPRINGFIELD LUMBER', NULL, 'EXISTING_ACCOUNT'),
      ('ABC Logistics Inc', 'ABC LOGISTICS', '123 Main St', 'NATIONAL_FRANCHISE')
  `).run();

  // Match by normalized name (suffixes like Company, LLC ignored)
  const dnc1 = await checkDncSuppression(env.DB, 'Springfield Lumber Company, LLC', null);
  assert.equal(dnc1.suppressed, true);
  assert.equal(dnc1.reason, 'EXISTING_ACCOUNT');

  // Match by exact street address
  const dnc2 = await checkDncSuppression(env.DB, 'Different Name At Same Building', '123 Main St');
  assert.equal(dnc2.suppressed, true);
  assert.equal(dnc2.reason, 'NATIONAL_FRANCHISE');

  // Clean company does NOT match
  const dncClean = await checkDncSuppression(env.DB, 'Clean Unrelated Roofing', '789 Oak Ave');
  assert.equal(dncClean.suppressed, false);
});

test('upsertCompany suppresses matched DNC record to SUPPRESSED_TERRITORY', async () => {
  const env = { DB: createD1(tempDbPath()) };

  env.DB._raw.prepare(`
    INSERT INTO do_not_contact (company_name, normalized_name, exclusion_reason)
    VALUES ('Springfield Lumber Co', 'SPRINGFIELD LUMBER', 'EXISTING_ACCOUNT')
  `).run();

  const companyId = await upsertCompany(
    env.DB,
    {
      company_name: 'Springfield Lumber Co',
      street_1: '500 Commercial St',
      city: 'Springfield',
      state: 'MO',
      zip_code: '65803'
    },
    TEST_EMAIL
  );

  const row = env.DB._raw.prepare('SELECT status, qualification_status FROM companies WHERE company_id = ?').get(companyId);
  assert.equal(row.status, 'SUPPRESSED_TERRITORY');
  assert.equal(row.qualification_status, 'SUB_THRESHOLD');
});

// ---------------------------------------------------------------------------
// SUITE 2: batch_ingest_prospects MCP Tool (Gates 1-4 & Max Batch)
// ---------------------------------------------------------------------------
test('batch_ingest_prospects enforces Gate 1 (address & citation URL)', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'batch_ingest_prospects',
      arguments: {
        prospects: [
          {
            // Invalid: missing street number
            business_name: 'No Number Clinic',
            street_address: 'Sunshine Street',
            estimated_w2_count: 10,
            headcount_confidence_score: 0.8,
            source_url: 'https://example.com/source'
          },
          {
            // Invalid: empty citation URL
            business_name: 'No Citation HVAC',
            street_address: '100 Commercial St',
            estimated_w2_count: 10,
            headcount_confidence_score: 0.8,
            source_url: ''
          }
        ]
      }
    }
  };

  const res = await callMcp(env, payload);
  assert.equal(res.status, 200);
  const data = parseMcpResponse(await res.text());
  assert.equal(data.rejected_invalid, 2);
  assert.equal(data.inserted_active, 0);
});

test('batch_ingest_prospects enforces Gate 2 (W-2 >= 5 and confidence >= 0.50)', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  const payload = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'batch_ingest_prospects',
      arguments: {
        prospects: [
          {
            // Sub-threshold headcount (< 5)
            business_name: 'Small Bakery',
            street_address: '120 S Campbell Ave',
            estimated_w2_count: 4,
            headcount_confidence_score: 0.9,
            source_url: 'https://example.com/bakery'
          },
          {
            // Low confidence (< 0.50)
            business_name: 'Uncertain Auto Repair',
            street_address: '340 N Boonville Ave',
            estimated_w2_count: 12,
            headcount_confidence_score: 0.40,
            source_url: 'https://example.com/autorepair'
          }
        ]
      }
    }
  };

  const res = await callMcp(env, payload);
  assert.equal(res.status, 200);
  const data = parseMcpResponse(await res.text());
  assert.equal(data.rejected_sub_threshold, 2);
  assert.equal(data.inserted_active, 0);
});

test('batch_ingest_prospects enforces Gate 3 (DNC screening)', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  env.DB._raw.prepare(`
    INSERT INTO do_not_contact (company_name, normalized_name, exclusion_reason)
    VALUES ('Banned Transport Co', 'BANNED TRANSPORT', 'TERRITORY_COLLEAGUE')
  `).run();

  const payload = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'batch_ingest_prospects',
      arguments: {
        prospects: [
          {
            business_name: 'Banned Transport Co',
            street_address: '800 W Division St',
            estimated_w2_count: 20,
            headcount_confidence_score: 0.95,
            source_url: 'https://example.com/banned'
          }
        ]
      }
    }
  };

  const res = await callMcp(env, payload);
  assert.equal(res.status, 200);
  const data = parseMcpResponse(await res.text());
  assert.equal(data.suppressed_dnc, 1);
  assert.equal(data.inserted_active, 0);
});

test('batch_ingest_prospects executes Gate 4 (FICA math, contact, citation)', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  const payload = {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'batch_ingest_prospects',
      arguments: {
        prospects: [
          {
            business_name: 'Midwest Premier Dental',
            street_address: '1500 E Sunshine St',
            city: 'Springfield',
            state: 'MO',
            zip_code: '65804',
            estimated_w2_count: 12,
            headcount_confidence_score: 0.85,
            dm_name: 'Sarah Jenkins',
            dm_title: 'Practice Administrator',
            source_url: 'https://midwestdental.com/about',
            industry: 'Healthcare',
            notes: 'Spoke with office manager.'
          }
        ]
      }
    }
  };

  const res = await callMcp(env, payload);
  assert.equal(res.status, 200);
  const data = parseMcpResponse(await res.text());
  assert.equal(data.inserted_active, 1);
  assert.ok(data.sample_pvp);

  // Verify SQLite row
  const company = env.DB._raw.prepare(
    "SELECT * FROM companies WHERE company_name = 'Midwest Premier Dental'"
  ).get();

  assert.ok(company);
  assert.equal(company.status, 'ACTIVE');
  assert.equal(company.qualification_status, 'QUALIFIED');
  assert.equal(company.verification_status, 'FIELD_VERIFIED');
  assert.equal(company.headcount_confidence_score, 0.85);
  assert.equal(company.estimated_w2_count, 12);
  assert.ok(company.est_fica_tax_savings > 0);
  assert.equal(company.access_type, 'OPEN_COMMERCIAL');
  assert.match(company.notes, /https:\/\/midwestdental\.com\/about/);
  assert.match(company.notes, /Smart Calling PVP/);

  // Verify Primary DM contact creation
  const contact = env.DB._raw.prepare(
    'SELECT * FROM contacts WHERE company_id = ?'
  ).get(company.company_id);

  assert.ok(contact);
  assert.equal(contact.first_name, 'Sarah');
  assert.equal(contact.last_name, 'Jenkins');
  assert.equal(contact.job_title, 'Practice Administrator');
  assert.equal(contact.is_primary_dm, 1);
});

test('batch_ingest_prospects enforces maximum batch size of 25', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  const prospects = Array.from({ length: 26 }, (_, i) => ({
    business_name: `Company ${i + 1}`,
    street_address: `${100 + i} Main St`,
    estimated_w2_count: 10,
    headcount_confidence_score: 0.8,
    source_url: 'https://example.com/source'
  }));

  const payload = {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'batch_ingest_prospects',
      arguments: { prospects }
    }
  };

  const res = await callMcp(env, payload);
  const text = await res.text();
  assert.match(text, /error|isError/i);
});

// ---------------------------------------------------------------------------
// SUITE 3: Curbside Access Barrier Handling & Sync
// ---------------------------------------------------------------------------
test('POST /api/activity with SET_ACCESS_BARRIER updates access_type and sets PHONE_POWER_DIAL', async () => {
  const env = { DB: createD1(tempDbPath()) };

  env.DB._raw.prepare(`
    INSERT INTO companies (company_id, agent_email, company_name, status, access_type)
    VALUES ('comp-barrier-1', ?, 'Gated Medical Office', 'ACTIVE', 'OPEN_COMMERCIAL')
  `).run(TEST_EMAIL);

  const res = await app.fetch(
    new Request('http://localhost/api/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        company_id: 'comp-barrier-1',
        action_type: 'SET_ACCESS_BARRIER',
        access_type: 'LOCKED_DOOR_PHONE_ONLY',
        notes: 'Security buzzer required for entry'
      })
    }),
    env,
    { waitUntil() {} }
  );

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.access_type, 'LOCKED_DOOR_PHONE_ONLY');
  assert.equal(data.next_action, 'PHONE_POWER_DIAL');
  assert.ok(data.next_action_date);

  const row = env.DB._raw.prepare('SELECT access_type, next_action, next_action_date, notes FROM companies WHERE company_id = ?').get('comp-barrier-1');
  assert.equal(row.access_type, 'LOCKED_DOOR_PHONE_ONLY');
  assert.equal(row.next_action, 'PHONE_POWER_DIAL');
  assert.ok(row.next_action_date);
  assert.match(row.notes, /Security buzzer required for entry/);
});

test('POST /api/sync processes SET_ACCESS_BARRIER logs', async () => {
  const env = { DB: createD1(tempDbPath()) };

  env.DB._raw.prepare(`
    INSERT INTO companies (company_id, agent_email, company_name, status, access_type)
    VALUES ('comp-sync-barr', ?, 'Gated Industrial Complex', 'ACTIVE', 'OPEN_COMMERCIAL')
  `).run(TEST_EMAIL);

  const res = await app.fetch(
    new Request('http://localhost/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        logs: [
          {
            log_id: 'sync-barr-log-1',
            company_id: 'comp-sync-barr',
            action_type: 'SET_ACCESS_BARRIER',
            access_type: 'GATED_SECURITY',
            notes: 'Guard booth at perimeter gate'
          }
        ]
      })
    }),
    env,
    { waitUntil() {} }
  );

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);

  const row = env.DB._raw.prepare('SELECT access_type, next_action FROM companies WHERE company_id = ?').get('comp-sync-barr');
  assert.equal(row.access_type, 'GATED_SECURITY');
  assert.equal(row.next_action, 'PHONE_POWER_DIAL');
});

// ---------------------------------------------------------------------------
// SUITE 4: Routing & Manifest Barrier Filtering
// ---------------------------------------------------------------------------
test('fetchUnvisitedCompanies excludes barrier access types from autonomous routing', async () => {
  const env = { DB: createD1(tempDbPath()) };

  env.DB._raw.prepare(`
    INSERT INTO companies (company_id, agent_email, company_name, status, confidence_score, lat, long, access_type)
    VALUES
      ('c-open', ?, 'Open Commercial Shop', 'ACTIVE', 80, 37.20, -93.29, 'OPEN_COMMERCIAL'),
      ('c-null', ?, 'Legacy Null Access', 'ACTIVE', 80, 37.21, -93.28, NULL),
      ('c-locked', ?, 'Locked Door Office', 'ACTIVE', 80, 37.22, -93.27, 'LOCKED_DOOR_PHONE_ONLY'),
      ('c-gated', ?, 'Gated Security Site', 'ACTIVE', 80, 37.23, -93.26, 'GATED_SECURITY'),
      ('c-appt', ?, 'Appointment Only CPA', 'ACTIVE', 80, 37.24, -93.25, 'APPOINTMENT_ONLY')
  `).run(TEST_EMAIL, TEST_EMAIL, TEST_EMAIL, TEST_EMAIL, TEST_EMAIL);

  const unvisited = await fetchUnvisitedCompanies(env.DB, TEST_EMAIL);
  const ids = unvisited.map(c => c.company_id);

  assert.ok(ids.includes('c-open'), 'Should include OPEN_COMMERCIAL');
  assert.ok(ids.includes('c-null'), 'Should include NULL access_type');
  assert.ok(!ids.includes('c-locked'), 'Should exclude LOCKED_DOOR_PHONE_ONLY');
  assert.ok(!ids.includes('c-gated'), 'Should exclude GATED_SECURITY');
  assert.ok(!ids.includes('c-appt'), 'Should exclude APPOINTMENT_ONLY');
});

test('generate_route_manifest MCP tool in FIELD mode excludes barrier access types', async () => {
  const env = { DB: createD1(tempDbPath()), MCP_SECRET_KEY: 'local_dev_key' };

  env.DB._raw.prepare(`
    INSERT INTO companies (company_id, agent_email, company_name, status, confidence_score, lat, long, access_type, employees)
    VALUES
      ('c-field-open', 'sean_deardorff@us.aflac.com', 'Open Field Stop', 'ACTIVE', 80, 37.2089, -93.2923, 'OPEN_COMMERCIAL', 10),
      ('c-field-locked', 'sean_deardorff@us.aflac.com', 'Locked Field Stop', 'ACTIVE', 80, 37.2090, -93.2924, 'LOCKED_DOOR_PHONE_ONLY', 10)
  `).run();

  const payload = {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'generate_route_manifest',
      arguments: {
        mode: 'FIELD',
        limit: 10
      }
    }
  };

  const res = await callMcp(env, payload);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Open Field Stop/);
  assert.doesNotMatch(text, /Locked Field Stop/);
});
