/**
 * Sprint 4 — /api/leads.
 *
 * Real SQLite, real SQL: the confidence bands and the tenant predicate are the
 * whole contract of this route, and a mock that answers whatever it is asked
 * could not tell a correct BETWEEN from an off-by-one one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';
import { LEAD_LIMITS, CONFIDENCE_BANDS, LEAD_MODES, TRIAGE_MAX_CONFIDENCE, IMPORT_CONFIDENCE_SCORE, MAX_IMPORT_ROWS } from '../src/routes/leads.js';

const AGENT = 'sean_deardorff@us.aflac.com';
const OTHER_AGENT = 'someone_else@us.aflac.com';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-leads-')), 'test.sqlite');
}

const call = (env, url, init) =>
  app.fetch(new Request(`http://localhost${url}`, init), env, { waitUntil() {} });

function postJson(env, url, payload) {
  return call(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function seed(db, rows) {
  const insert = db._raw.prepare(`
    INSERT INTO companies (
      company_id, agent_email, company_name, company_phone, decision_maker,
      confidence_score, status, street_1, city, state, lat, long,
      current_voluntary_carrier, estimated_w2_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '100 Main St', 'Springfield', 'MO', 37.2, -93.29, 'None', 12)
  `);

  for (const row of rows) {
    insert.run(
      row.id,
      row.agent ?? AGENT,
      row.name,
      row.phone ?? null,
      row.dm ?? null,
      row.confidence ?? 30,
      row.status ?? 'ACTIVE'
    );
  }
}

async function leadsFor(url, env) {
  const res = await call(env, url);
  return { status: res.status, body: await res.json() };
}

test('the PHONE queue is exactly the 30-79 confidence band', async () => {
  const env = { DB: createD1(tempDbPath()) };
  const band = CONFIDENCE_BANDS.PHONE;

  seed(env.DB, [
    { id: 'low', name: 'Too Cold', confidence: 29 },
    { id: 'floor', name: 'At The Floor', confidence: band.min },
    { id: 'mid', name: 'Dialable', confidence: 55 },
    { id: 'ceiling', name: 'At The Ceiling', confidence: band.max },
    { id: 'high', name: 'Belongs To Field', confidence: 80 }
  ]);

  const { status, body } = await leadsFor('/api/leads?mode=PHONE', env);

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.mode, 'PHONE');
  assert.deepEqual(
    body.data.map((row) => row.company_id).sort(),
    ['ceiling', 'floor', 'mid'],
    'the band is inclusive at both ends and excludes 29 and 80'
  );
});

test('the FIELD queue is the 80+ band and is capped at 30', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seed(env.DB, [
    { id: 'seventy', name: 'Not Verified', confidence: 79 },
    { id: 'eighty', name: 'Verified', confidence: 80 }
  ]);

  // Fill well past the cap so the LIMIT is what trims the list.
  seed(env.DB, Array.from({ length: 40 }, (_, i) => ({
    id: `filler-${i}`,
    name: `Filler ${i}`,
    confidence: 90
  })));

  const { body } = await leadsFor('/api/leads?mode=FIELD', env);

  assert.equal(body.data.length, LEAD_LIMITS.FIELD);
  assert.ok(body.data.every((row) => row.confidence_score >= 80));
  assert.ok(!body.data.some((row) => row.company_id === 'seventy'));
  assert.equal(body.count, LEAD_LIMITS.FIELD, 'count reflects the trimmed list, not the table');
});

test('the PHONE queue caps at 100', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seed(env.DB, Array.from({ length: 130 }, (_, i) => ({
    id: `dial-${i}`,
    name: `Dial ${i}`,
    confidence: 50
  })));

  const { body } = await leadsFor('/api/leads?mode=PHONE', env);
  assert.equal(body.data.length, LEAD_LIMITS.PHONE);
  assert.equal(body.count, LEAD_LIMITS.PHONE);
});

test('suppressed records and other agents never enter a queue', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seed(env.DB, [
    { id: 'active', name: 'Live Account', confidence: 60 },
    { id: 'dq', name: 'Disqualified', confidence: 60, status: 'DISQUALIFIED' },
    { id: 'dnc', name: 'Do Not Contact', confidence: 60, status: 'DO_NOT_CONTACT' },
    { id: 'foreign', name: 'Someone Else', confidence: 60, agent: OTHER_AGENT }
  ]);

  const { body } = await leadsFor('/api/leads?mode=PHONE', env);

  assert.deepEqual(body.data.map((row) => row.company_id), ['active']);
});

test('queues are ordered by confidence, then name, so the sequence is stable', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seed(env.DB, [
    { id: 'b', name: 'Bravo Logistics', confidence: 60 },
    { id: 'a', name: 'Alpha Dental', confidence: 60 },
    { id: 'top', name: 'Zulu Manufacturing', confidence: 75 }
  ]);

  const { body } = await leadsFor('/api/leads?mode=PHONE', env);

  assert.deepEqual(
    body.data.map((row) => row.company_id),
    ['top', 'a', 'b'],
    'highest confidence first; ties broken by name, not by insertion order'
  );
});

test('leads carry what the views render, including the decision-maker alias', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seed(env.DB, [
    { id: 'acct-1', name: 'Ozark Dental Group', phone: '417-831-0048', dm: 'Dana Whitfield', confidence: 85 }
  ]);

  const { body } = await leadsFor('/api/leads?mode=FIELD', env);
  const lead = body.data[0];

  assert.equal(lead.company_name, 'Ozark Dental Group');
  assert.equal(lead.company_phone, '417-831-0048');
  assert.equal(lead.decision_maker, 'Dana Whitfield');
  // The voice extractor and the views both say decision_maker_name; the route
  // keeps the two spellings in sync rather than making every caller remember
  // which one the database happens to use.
  assert.equal(lead.decision_maker_name, 'Dana Whitfield');
  assert.equal(lead.confidence_score, 85);
  assert.equal(lead.status, 'ACTIVE');
  assert.equal(lead.current_voluntary_carrier, 'None');
  assert.equal(lead.estimated_w2_count, 12);
  assert.ok('lat' in lead && 'long' in lead, 'the TSP pass needs coordinates');
});

test('mode defaults to PHONE and an unknown mode is rejected', async () => {
  const env = { DB: createD1(tempDbPath()) };
  seed(env.DB, [{ id: 'only', name: 'Only Account', confidence: 50 }]);

  const defaulted = await leadsFor('/api/leads', env);
  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.body.mode, 'PHONE');
  assert.deepEqual(defaulted.body.data.map((row) => row.company_id), ['only']);

  // Lowercase is accepted and canonicalised.
  const lower = await leadsFor('/api/leads?mode=phone', env);
  assert.equal(lower.body.mode, 'PHONE');

  const bogus = await leadsFor('/api/leads?mode=EMAIL', env);
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /mode must be one of/);
  assert.deepEqual(LEAD_MODES, ['PHONE', 'FIELD', 'TRIAGE']);
});

test('an empty queue is a success, not an error', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const { status, body } = await leadsFor('/api/leads?mode=FIELD', env);

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.count, 0);
  assert.deepEqual(body.data, []);
});

// ---------------------------------------------------------------------
// TRIAGE BAND (Sprint 5)
// ---------------------------------------------------------------------

test('the TRIAGE queue is everything below 40', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seed(env.DB, [
    { id: 'junk', name: 'No Name Junk', confidence: 0 },
    { id: 'thin', name: 'Thin Record', confidence: 12 },
    { id: 'edge', name: 'Just Under', confidence: TRIAGE_MAX_CONFIDENCE },
    { id: 'phone', name: 'Phoneable', confidence: 40 }
  ]);

  const { status, body } = await leadsFor('/api/leads?mode=TRIAGE', env);

  assert.equal(status, 200);
  assert.equal(body.mode, 'TRIAGE');
  assert.deepEqual(body.data.map((row) => row.company_id).sort(), ['edge', 'junk', 'thin']);
  assert.equal(CONFIDENCE_BANDS.TRIAGE.max, TRIAGE_MAX_CONFIDENCE);
  assert.equal(LEAD_LIMITS.TRIAGE, 200);
});

test('a suppressed record leaves the triage queue instead of returning every week', async () => {
  const env = { DB: createD1(tempDbPath()) };
  seed(env.DB, [
    { id: 'dq', name: 'Already Gone', confidence: 10, status: 'DISQUALIFIED' },
    { id: 'live', name: 'Still To Clean', confidence: 10 }
  ]);

  const { body } = await leadsFor('/api/leads?mode=TRIAGE', env);
  assert.deepEqual(body.data.map((row) => row.company_id), ['live']);
});

// ---------------------------------------------------------------------
// POST /api/leads/import (Sprint 5)
// ---------------------------------------------------------------------

test('an Apify batch lands every usable row at confidence 30 / ACTIVE', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const res = await postJson(env, '/api/leads/import', {
    leads: [
      {
        company_name: 'Ozark Machining, LLC',
        company_phone: '417-555-0001',
        street_1: '1 Mill St',
        city: 'Springfield',
        state: 'MO',
        zip_code: '65806',
        lat: 37.208957,
        long: -93.292298
      },
      { company_name: 'Nixa Dental', city: 'Nixa', state: 'MO' }
    ]
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.imported, 2);
  assert.equal(body.created, 2);
  assert.equal(body.rejected, 0);

  const rows = env.DB._raw.prepare('SELECT * FROM companies ORDER BY company_name').all();
  assert.equal(rows.length, 2);

  for (const row of rows) {
    assert.equal(row.confidence_score, IMPORT_CONFIDENCE_SCORE, 'a new lead enters the triage band');
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.agent_email, AGENT);
  }

  const ozark = rows.find((row) => row.company_name === 'Ozark Machining, LLC');
  assert.equal(ozark.lat, 37.208957);
  assert.equal(ozark.long, -93.292298);
  assert.ok(ozark.geohash, 'a coordinate pair derives a geohash for the radar');
});

test('a bare array is accepted as well as { leads: [...] }', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const res = await postJson(env, '/api/leads/import', [{ company_name: 'Bare Array Co' }]);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.imported, 1);
  assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM companies').get().n, 1);
});

test('a nameless row is rejected without discarding the rest of the batch', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const res = await postJson(env, '/api/leads/import', {
    leads: [
      { company_name: 'Good Co', city: 'Ozark' },
      { company_name: '   ' },
      {}
    ]
  });
  const body = await res.json();

  assert.equal(body.success, true);
  assert.equal(body.imported, 1);
  assert.equal(body.rejected, 2);
  assert.deepEqual(body.errors.map((entry) => entry.row), [1, 2], 'rejections are reported by index');
  assert.match(body.errors[0].error, /company_name is required/);
  assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM companies').get().n, 1);
});

test('garbage coordinates are dropped rather than stored as 0,0', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const res = await postJson(env, '/api/leads/import', {
    leads: [{ company_name: 'Bad Geo Co', lat: 'north', long: 'west' }]
  });
  assert.equal(res.status, 200);

  const row = env.DB._raw.prepare('SELECT * FROM companies').get();
  assert.equal(row.lat, null, 'a missing coordinate must not become a real pin');
  assert.equal(row.long, null);
  assert.equal(row.geohash, null);
});

test('re-importing a file does not reset a verified account back to 30', async () => {
  const env = { DB: createD1(tempDbPath()) };

  await postJson(env, '/api/leads/import', {
    leads: [{ company_name: 'Verified Dental', company_phone: '417-555-0100' }]
  });

  const created = env.DB._raw.prepare('SELECT * FROM companies').get();
  assert.equal(created.confidence_score, IMPORT_CONFIDENCE_SCORE);

  // The agent confirms the decision maker on the phone, and the score rises.
  env.DB._raw.prepare('UPDATE companies SET confidence_score = 88 WHERE company_id = ?')
    .run(created.company_id);

  // Next Friday the same export is uploaded again.
  const again = await postJson(env, '/api/leads/import', {
    leads: [{
      company_id: created.company_id,
      company_name: 'Verified Dental',
      company_phone: '417-555-0100',
      city: 'Springfield'
    }]
  });
  const body = await again.json();

  assert.equal(body.imported, 1);
  assert.equal(body.created, 0, 'an existing record is an update, not a new lead');

  const after = env.DB._raw.prepare('SELECT * FROM companies WHERE company_id = ?').get(created.company_id);
  assert.equal(after.confidence_score, 88, 'a re-import must not destroy verified work');
  assert.equal(after.company_name, 'Verified Dental');
  assert.equal(after.city, 'Springfield', 'but supplied fields still merge in');
});

test('the import endpoint validates its envelope before writing', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const notAnArray = await postJson(env, '/api/leads/import', { rows: [] });
  assert.equal(notAnArray.status, 400);
  assert.match((await notAnArray.json()).error, /Expected a JSON array/);

  const empty = await postJson(env, '/api/leads/import', { leads: [] });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).imported, 0);

  const tooBig = await postJson(env, '/api/leads/import', {
    leads: Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ company_name: `Co ${i}` }))
  });
  assert.equal(tooBig.status, 400);
  assert.match((await tooBig.json()).error, /Import batch too large/);

  assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM companies').get().n, 0, 'nothing was written');
});

// ---------------------------------------------------------------------
// POST /api/leads/disqualify (Sprint 5)
// ---------------------------------------------------------------------

test('disqualify suppresses the record and zeroes its confidence', async () => {
  const env = { DB: createD1(tempDbPath()) };
  seed(env.DB, [{ id: 'acct-1', name: 'Shady LLC', confidence: 12 }]);

  const res = await postJson(env, '/api/leads/disqualify', { company_id: 'acct-1', reason: 'no such business' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.status, 'DISQUALIFIED');
  assert.equal(body.confidence_score, 0);

  const row = env.DB._raw.prepare('SELECT * FROM companies WHERE company_id = ?').get('acct-1');
  assert.equal(row.status, 'DISQUALIFIED');
  assert.equal(row.verification_status, 'DISQUALIFIED');
  assert.equal(row.confidence_score, 0);
  assert.equal(row.disqualified_reason, 'no such business');
});

test('disqualify is tenant-scoped and needs a real company_id', async () => {
  const env = { DB: createD1(tempDbPath()) };
  seed(env.DB, [
    { id: 'mine', name: 'Mine', confidence: 12 },
    { id: 'theirs', name: 'Theirs', confidence: 12, agent: OTHER_AGENT }
  ]);

  const foreign = await postJson(env, '/api/leads/disqualify', { company_id: 'theirs' });
  assert.equal(foreign.status, 404, "another agent's record must not be reachable");

  const untouched = env.DB._raw.prepare('SELECT status FROM companies WHERE company_id = ?').get('theirs');
  assert.equal(untouched.status, 'ACTIVE');

  const unknown = await postJson(env, '/api/leads/disqualify', { company_id: 'nope' });
  assert.equal(unknown.status, 404);

  const missing = await postJson(env, '/api/leads/disqualify', {});
  assert.equal(missing.status, 400);
});

test('disqualifying also removes the record from the phone queue', async () => {
  const env = { DB: createD1(tempDbPath()) };
  seed(env.DB, [{ id: 'acct-1', name: 'Dialable', confidence: 60 }]);

  const before = await leadsFor('/api/leads?mode=PHONE', env);
  assert.equal(before.body.data.length, 1);

  await postJson(env, '/api/leads/disqualify', { company_id: 'acct-1' });

  const after = await leadsFor('/api/leads?mode=PHONE', env);
  assert.equal(after.body.data.length, 0, 'a wrong number must never be dialed twice');
});
