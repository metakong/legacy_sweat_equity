/**
 * End-to-end schema tests — the real Worker, the real SQL, real SQLite.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other suite binds the Worker to a hand-written mock that matches on
 * SQL substrings. That mock answers whatever the code asks for, so it cannot
 * tell a valid query from one referencing a column that does not exist.
 *
 * On 2026-08-31 the multi-tenant refactor added `agent_email` to every query
 * while the live D1 database never got the column (migration 0002 stalled).
 * All 114 mocked tests passed and every screen in the app returned
 * "Could not load targets: Internal Server Error".
 *
 * These tests run the actual route handlers against actual SQLite in both
 * shapes the schema can legitimately take:
 *
 *   "fresh"    — a database built from schema.sql (composite PRIMARY KEY)
 *   "migrated" — the pre-multi-tenant production schema with
 *                migrations/0003_add_agent_email.sql applied (single-column
 *                PRIMARY KEY plus a UNIQUE index on the tenant tuple)
 *
 * Production is the "migrated" shape, so it is not enough to test the fresh
 * one. If a query or an ON CONFLICT target ever stops working against either,
 * this fails here rather than in the field.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';

const AGENT = 'sean_deardorff@us.aflac.com';
const ROOT = process.cwd();

/** The exact production table definitions as they existed before 0003. */
const LEGACY_PRODUCTION_SCHEMA = `
CREATE TABLE companies (
    company_id TEXT PRIMARY KEY,
    d365_lead_id TEXT,
    d365_checksum TEXT,
    d365_modified_on TEXT,
    company_name TEXT NOT NULL,
    street_1 TEXT, street_2 TEXT, city TEXT, state TEXT, zip_code TEXT,
    lat REAL, long REAL,
    lead_source TEXT DEFAULT 'Cold Call',
    rating TEXT DEFAULT 'Cold',
    employees INTEGER, industry TEXT,
    is_d365_synced BOOLEAN DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
, renewal_date TEXT, sic_code TEXT, account_number TEXT, post_enrollment_date TEXT,
  pipeline_stage TEXT DEFAULT 'PROSPECT', stage_entered_at TEXT, snoozed_until TEXT,
  disqualified_reason TEXT, forecast_ap REAL, forecast_confidence INTEGER);
CREATE TABLE contacts (
    contact_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    first_name TEXT, last_name TEXT, job_title TEXT,
    phone_number TEXT, email_address TEXT,
    is_primary_dm BOOLEAN DEFAULT 1,
    FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE);
CREATE TABLE activity_logs (
    log_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    contact_id TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    is_in_person BOOLEAN NOT NULL,
    is_initial BOOLEAN NOT NULL,
    is_dm_contact BOOLEAN NOT NULL,
    disposition TEXT NOT NULL,
    presentation_date TEXT, enrollment_date TEXT, projected_ap REAL,
    raw_audio_transcription TEXT,
    ai_structured_notes TEXT,
    sync_tier_status TEXT DEFAULT 'PENDING', next_action_date TEXT, next_action_text TEXT,
    FOREIGN KEY (company_id) REFERENCES companies(company_id));
CREATE TABLE pipeline_events (
    event_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, from_stage TEXT,
    to_stage TEXT NOT NULL, changed_at TEXT DEFAULT (datetime('now')),
    trigger_log_id TEXT, reason TEXT,
    FOREIGN KEY (company_id) REFERENCES companies(company_id));
`;

/** Split a .sql file into individual statements, dropping comment lines. */
function statementsOf(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function tempDbPath(label) {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `aflac-${label}-`)),
    'test.sqlite'
  );
}

/** A database in the shape production actually has: legacy tables + 0003. */
function buildMigratedDb() {
  const file = tempDbPath('migrated');
  const raw = new DatabaseSync(file);
  raw.exec(LEGACY_PRODUCTION_SCHEMA);
  // The orphan the failed 0002 run left behind; 0003 must clear it.
  raw.exec(`CREATE TABLE new_companies (company_id TEXT, agent_email TEXT NOT NULL DEFAULT 'x', PRIMARY KEY (company_id, agent_email))`);
  for (const statement of statementsOf('migrations/0003_add_agent_email.sql')) {
    raw.exec(statement);
  }
  raw.close();
  return file;
}

/** A database built the way a brand-new environment would build it. */
function buildFreshDb() {
  return tempDbPath('fresh'); // createD1 applies schema.sql when the file is absent
}

function seed(db) {
  const rows = [
    ['s1', 'Ozark Dental Group', '1200 E Sunshine St', 37.1795, -93.2705, 'Hot', 'Healthcare', 1, 'd365-1'],
    ['s2', 'Queen City Manufacturing', '2500 W Kearney St', 37.2405, -93.3210, 'Warm', 'Manufacturing', 0, null],
    ['s3', 'Table Rock Logistics', '900 N Glenstone Ave', 37.2200, -93.2610, 'Cold', 'Transportation', 1, 'd365-3']
  ];
  for (const [id, name, street, lat, long, rating, industry, synced, leadId] of rows) {
    db._raw.prepare(
      `INSERT INTO companies (company_id, company_name, street_1, city, state, zip_code,
         lat, long, lead_source, rating, employees, industry, is_d365_synced,
         created_at, pipeline_stage, d365_lead_id, agent_email)
       VALUES (?,?,?,'Springfield','MO','65804',?,?,'Cold Call',?,25,?,?,'2026-08-01 12:00:00','PROSPECT',?,?)`
    ).run(id, name, street, lat, long, rating, industry, synced, leadId, AGENT);
  }

  db._raw.prepare(
    `INSERT INTO contacts (contact_id, company_id, first_name, last_name, job_title, is_primary_dm, agent_email)
     VALUES ('sct1','s1','Dana','Whitfield','Office Manager',1,?)`
  ).run(AGENT);

  db._raw.prepare(
    `INSERT INTO activity_logs (log_id, company_id, contact_id, timestamp, is_in_person,
       is_initial, is_dm_contact, disposition, projected_ap, ai_structured_notes,
       sync_tier_status, agent_email)
     VALUES ('sa1','s1','sct1','2026-08-30 15:00:00',1,1,1,'Interested',4200,
       '{"summary":"Warm DM","next_action":"Send summary","product_interests":["Accident"],"objections":[]}',
       'PENDING',?)`
  ).run(AGENT);

  db._raw.prepare(
    `INSERT INTO activity_logs (log_id, company_id, timestamp, is_in_person, is_initial,
       is_dm_contact, disposition, sync_tier_status, agent_email)
     VALUES ('sa2','s3','2026-08-29 15:00:00',1,1,0,'Not Interested','TIER2_EXPORTED',?)`
  ).run(AGENT);

  db._raw.prepare(
    `INSERT INTO pipeline_events (event_id, company_id, from_stage, to_stage, changed_at, agent_email)
     VALUES ('se1','s1','PROSPECT','ENGAGED','2026-08-30 15:00:00',?)`
  ).run(AGENT);
}

function envFor(file) {
  const db = createD1(file);
  seed(db);
  return {
    DB: db,
    BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} },
    STORE_AUDIO: '0'
  };
}

const call = (env, url, init) =>
  app.fetch(new Request(`http://localhost${url}`, init), env, { waitUntil() {} });

/** Endpoints the UI hits on load. A 500 in any of them blanks a screen. */
const READ_ENDPOINTS = [
  '/api/companies?filter=all_active&limit=1000',
  '/api/companies?filter=untouched&limit=500',
  '/api/companies?filter=follow_ups&limit=500',
  '/api/companies?q=ozark&limit=8',
  '/api/companies?rating=Hot',
  '/api/companies?limit=50',
  '/api/companies/s1',
  '/api/activity?date=2026-08-30&limit=500',
  '/api/metrics/today',
  '/api/pipeline?limit=500',
  '/api/pipeline?stage=PROSPECT',
  '/api/pipeline?include_snoozed=1',
  '/api/pipeline/events/s1',
  '/api/export/d365?date=2026-08-30',
  '/api/export/d365?all=1',
  '/api/export/tier1',
  '/api/export/tier2',
  '/api/telemetry',
  '/api/enums',
  '/api/health'
];

for (const shape of ['fresh', 'migrated']) {
  test(`[${shape} schema] every read endpoint the UI loads returns 2xx`, async () => {
    const env = envFor(shape === 'fresh' ? buildFreshDb() : buildMigratedDb());

    for (const endpoint of READ_ENDPOINTS) {
      const res = await call(env, endpoint);
      const body = await res.text();
      assert.ok(
        res.status >= 200 && res.status < 300,
        `${endpoint} returned ${res.status}: ${body.slice(0, 200)}`
      );
    }
  });

  test(`[${shape} schema] route planner returns the agent's active accounts`, async () => {
    const env = envFor(shape === 'fresh' ? buildFreshDb() : buildMigratedDb());

    const res = await call(env, '/api/companies?filter=all_active&limit=1000');
    assert.equal(res.status, 200);

    const { companies } = await res.json();
    // s1 is active, s2 is untouched (counts as active), s3's latest
    // disposition is terminal and must be filtered out.
    const ids = companies.map((c) => c.company_id).sort();
    assert.deepEqual(ids, ['s1', 's2']);

    const s1 = companies.find((c) => c.company_id === 's1');
    assert.equal(s1.touch_count, 1);
    assert.equal(s1.latest_disposition, 'Interested');
    assert.equal(s1.latest_next_action, 'Send summary');
  });

  test(`[${shape} schema] upserts merge on the tenant tuple instead of duplicating`, async () => {
    const env = envFor(shape === 'fresh' ? buildFreshDb() : buildMigratedDb());
    const post = (url, body) => call(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // Same company_id twice — must UPDATE, never insert a second row.
    for (const employees of [10, 99]) {
      const res = await post('/api/companies/import', {
        companies: [{ company_id: 's1', company_name: 'Ozark Dental Group', employees }]
      });
      assert.equal(res.status, 200, await res.text());
    }
    assert.equal(
      env.DB._raw.prepare(`SELECT COUNT(*) n FROM companies WHERE company_id='s1'`).get().n,
      1
    );
    assert.equal(
      env.DB._raw.prepare(`SELECT employees e FROM companies WHERE company_id='s1'`).get().e,
      99
    );

    // Same log_id twice — the offline queue retries, and must not double-log.
    for (let i = 0; i < 2; i += 1) {
      const res = await post('/api/sync', {
        logs: [{
          log_id: 'dup-log',
          company_id: 's1',
          is_in_person: true,
          is_initial: false,
          is_dm_contact: true,
          timestamp: '2026-08-30 16:00:00'
        }]
      });
      assert.equal(res.status, 200, await res.text());
    }
    assert.equal(
      env.DB._raw.prepare(`SELECT COUNT(*) n FROM activity_logs WHERE log_id='dup-log'`).get().n,
      1
    );

    // Same contact_id twice — must merge the new job title in.
    for (const title of ['Office Manager', 'VP Operations']) {
      const res = await post('/api/contacts', {
        contact_id: 'sct1', company_id: 's1', first_name: 'Dana', last_name: 'Whitfield', job_title: title
      });
      assert.equal(res.status, 200, await res.text());
    }
    assert.equal(
      env.DB._raw.prepare(`SELECT COUNT(*) n FROM contacts WHERE contact_id='sct1'`).get().n,
      1
    );
    assert.equal(
      env.DB._raw.prepare(`SELECT job_title t FROM contacts WHERE contact_id='sct1'`).get().t,
      'VP Operations'
    );
  });

  test(`[${shape} schema] pipeline stage + snooze mutations persist`, async () => {
    const env = envFor(shape === 'fresh' ? buildFreshDb() : buildMigratedDb());
    const post = (url, body) => call(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const staged = await post('/api/pipeline/stage', {
      company_id: 's2', to_stage: 'ENGAGED', reason: 'Stage moved via Kanban board'
    });
    assert.equal(staged.status, 200, await staged.text());
    assert.equal(
      env.DB._raw.prepare(`SELECT pipeline_stage s FROM companies WHERE company_id='s2'`).get().s,
      'ENGAGED'
    );

    const snoozed = await post('/api/pipeline/snooze', { company_id: 's2', until: '2026-09-15' });
    assert.equal(snoozed.status, 200, await snoozed.text());
    assert.equal(
      env.DB._raw.prepare(`SELECT snoozed_until u FROM companies WHERE company_id='s2'`).get().u,
      '2026-09-15'
    );
  });
}

test('migration 0003 preserves column values and removes the corrupt orphan', () => {
  const file = tempDbPath('integrity');
  const raw = new DatabaseSync(file);
  raw.exec(LEGACY_PRODUCTION_SCHEMA);
  raw.exec(`CREATE TABLE new_companies (company_id TEXT, agent_email TEXT NOT NULL DEFAULT 'x', PRIMARY KEY (company_id, agent_email))`);

  // Values chosen so that any positional shift is visible.
  raw.prepare(
    `INSERT INTO companies (company_id, company_name, is_d365_synced, created_at,
       sic_code, account_number, renewal_date, post_enrollment_date, pipeline_stage)
     VALUES ('m1','Marker Co',1,'2026-08-01 12:00:00','8021','ACCT-1','2026-12-01','2026-11-01','ENGAGED')`
  ).run();

  for (const statement of statementsOf('migrations/0003_add_agent_email.sql')) {
    raw.exec(statement);
  }

  const row = raw.prepare(`SELECT * FROM companies WHERE company_id='m1'`).get();
  assert.equal(row.is_d365_synced, 1, 'is_d365_synced must not shift into another column');
  assert.equal(row.created_at, '2026-08-01 12:00:00');
  assert.equal(row.sic_code, '8021');
  assert.equal(row.account_number, 'ACCT-1');
  assert.equal(row.renewal_date, '2026-12-01');
  assert.equal(row.post_enrollment_date, '2026-11-01');
  assert.equal(row.pipeline_stage, 'ENGAGED');
  assert.equal(row.agent_email, AGENT, 'existing rows must be backfilled with the agent');

  const orphans = raw.prepare(
    `SELECT COUNT(*) n FROM sqlite_master WHERE name='new_companies'`
  ).get().n;
  assert.equal(orphans, 0, 'the corrupt new_companies table must be dropped');

  raw.close();
});

test('every service-worker precached module exists on disk', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const listed = [...sw.matchAll(/'(\/app\/[\w.-]+\.js)'/g)].map((m) => m[1]);

  const onDisk = fs.readdirSync(path.join(ROOT, 'public/app'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `/app/${f}`);

  // A module missing from CORE_ASSETS is not a partial outage: app.js imports
  // them statically, so one uncached module stops the whole PWA from booting
  // offline.
  for (const module of onDisk) {
    assert.ok(listed.includes(module), `${module} is missing from sw.js CORE_ASSETS`);
  }
  for (const module of listed) {
    assert.ok(onDisk.includes(module), `${module} is precached but does not exist`);
  }
});
