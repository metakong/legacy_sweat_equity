/**
 * Sprint 5 — GET /api/eod-aggregates.
 *
 * The point of this endpoint is the merge. The Agency OS counters and the legacy
 * activity_logs derive from disjoint write paths, and a day split across both —
 * forty dials in the dialer plus three doors logged in the old field shell —
 * must total correctly rather than silently reporting half the day.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';
import { businessDate } from '../src/lib/time.js';

const AGENT = 'sean_deardorff@us.aflac.com';
const OTHER_AGENT = 'someone_else@us.aflac.com';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-eod-')), 'test.sqlite');
}

const call = (env, url) =>
  app.fetch(new Request(`http://localhost${url}`), env, { waitUntil() {} });

async function aggregatesFor(url, env) {
  const res = await call(env, url);
  return { status: res.status, body: await res.json() };
}

/** The D1 timestamp format. 'now' always falls inside today's business day. */
function nowStamp(offsetDays = 0) {
  const instant = new Date(Date.now() - offsetDays * 86_400_000);
  return instant.toISOString().slice(0, 19).replace('T', ' ');
}

/** activity_logs has an FK to companies, so the account must exist first. */
function seedCompany(db, id = 'acct-1', agent = AGENT) {
  db._raw.prepare('INSERT INTO companies (company_id, agent_email, company_name) VALUES (?, ?, ?)')
    .run(id, agent, `Company ${id}`);
}

function seedCounterRow(db, { date, agent = AGENT, phone = 0, dm = 0, walk = 0, appts = 0 }) {
  db._raw.prepare(`
    INSERT INTO d365_daily_aggregates (business_date, agent_email, phone_dials, dm_contacts, walk_ins, appointments_set)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(date, agent, phone, dm, walk, appts);
}

function seedLegacyLog(db, {
  logId,
  companyId = 'acct-1',
  agent = AGENT,
  timestamp = nowStamp(),
  inPerson = 0,
  dm = 0,
  disposition = 'No Contact',
  presentation = null
} = {}) {
  db._raw.prepare(`
    INSERT INTO activity_logs (
      log_id, company_id, agent_email, timestamp,
      is_in_person, is_initial, is_dm_contact, disposition, presentation_date
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(logId, companyId, agent, timestamp, inPerson, dm, disposition, presentation);
}

test('the merged block totals the Agency counters and the legacy log', async () => {
  const env = { DB: createD1(tempDbPath()) };
  const today = businessDate();

  seedCompany(env.DB);
  seedCounterRow(env.DB, { date: today, phone: 40, dm: 2, walk: 3, appts: 1 });

  seedLegacyLog(env.DB, { logId: 'l1', inPerson: 1, dm: 1, disposition: 'Met Decision Maker' });
  seedLegacyLog(env.DB, { logId: 'l2', disposition: 'No Contact' });
  seedLegacyLog(env.DB, { logId: 'l3', dm: 1, disposition: 'Presentation Scheduled', presentation: today });

  const { status, body } = await aggregatesFor('/api/eod-aggregates', env);

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.date, today);

  // Legacy: one door, two DM contacts, the two non-in-person touches are dials,
  // and the presentation counts as an appointment.
  assert.deepEqual(body.sources.legacy_shell, {
    walk_ins: 1,
    dm_contacts: 2,
    phone_dials: 2,
    appointments_set: 1
  });
  assert.deepEqual(body.sources.voice_and_quick_drops, {
    walk_ins: 3,
    dm_contacts: 2,
    phone_dials: 40,
    appointments_set: 1
  });

  assert.equal(body.walk_ins, 4);
  assert.equal(body.dm_contacts, 4);
  assert.equal(body.phone_dials, 42);
  assert.equal(body.appointments_set, 2);
  assert.deepEqual(body.sources.degraded, []);
});

test('a day with nothing logged is all zeros, not an error', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const { status, body } = await aggregatesFor('/api/eod-aggregates', env);

  assert.equal(status, 200);
  assert.equal(body.walk_ins, 0);
  assert.equal(body.dm_contacts, 0);
  assert.equal(body.phone_dials, 0);
  assert.equal(body.appointments_set, 0);
  assert.deepEqual(body.sources.degraded, []);
});

test('a missing counters table degrades to the legacy half instead of a 500', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seedCompany(env.DB);
  seedLegacyLog(env.DB, { logId: 'l1', inPerson: 1, dm: 1 });

  // Exactly the production state before migrations/0005 is applied.
  env.DB._raw.exec('DROP TABLE d365_daily_aggregates');

  const { status, body } = await aggregatesFor('/api/eod-aggregates', env);

  assert.equal(status, 200, 'the legacy half is still true, so it is still served');
  assert.equal(body.walk_ins, 1);
  assert.equal(body.dm_contacts, 1);
  assert.equal(body.phone_dials, 0);
  assert.deepEqual(body.sources.degraded, ['d365_daily_aggregates']);
});

test('both halves are tenant-scoped to the signed-in agent', async () => {
  const env = { DB: createD1(tempDbPath()) };
  const today = businessDate();

  seedCompany(env.DB, 'mine', AGENT);
  seedCompany(env.DB, 'theirs', OTHER_AGENT);

  seedCounterRow(env.DB, { date: today, agent: OTHER_AGENT, phone: 99, walk: 9 });
  seedLegacyLog(env.DB, { logId: 'foreign', companyId: 'theirs', agent: OTHER_AGENT, inPerson: 1, dm: 1 });

  const { body } = await aggregatesFor('/api/eod-aggregates', env);

  assert.equal(body.phone_dials, 0, "another agent's dials must not appear on this report");
  assert.equal(body.walk_ins, 0);
  assert.equal(body.dm_contacts, 0);
});

test('an activity outside the business day is excluded from the totals', async () => {
  const env = { DB: createD1(tempDbPath()) };

  seedCompany(env.DB);
  seedLegacyLog(env.DB, { logId: 'today', inPerson: 1 });
  seedLegacyLog(env.DB, { logId: 'three-days-ago', inPerson: 1, timestamp: nowStamp(3) });

  const { body } = await aggregatesFor('/api/eod-aggregates', env);

  assert.equal(body.walk_ins, 1, 'only the touch inside the Springfield day counts');
});

test('an explicit business date is honoured, and a bad one is rejected', async () => {
  const env = { DB: createD1(tempDbPath()) };
  const today = businessDate();

  seedCompany(env.DB);
  seedCounterRow(env.DB, { date: today, phone: 7 });

  // A date that cannot be today, so the seeded counters must not match it.
  const other = await aggregatesFor('/api/eod-aggregates?date=2026-01-15', env);
  assert.equal(other.status, 200);
  assert.equal(other.body.date, '2026-01-15');
  assert.equal(other.body.phone_dials, 0);

  const bad = await aggregatesFor('/api/eod-aggregates?date=last-friday', env);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Invalid date format/);

  const impossible = await aggregatesFor('/api/eod-aggregates?date=2026-02-31', env);
  assert.equal(impossible.status, 400, 'a date that does not exist is not a business day');
});

test('the Sprint 2 debrief still answers alongside the new aggregate route', async () => {
  const env = { DB: createD1(tempDbPath()) };

  const debrief = await aggregatesFor('/api/eod-debrief', env);
  assert.equal(debrief.status, 200);
  assert.equal(typeof debrief.body.report, 'string', 'the debrief route is untouched');
  assert.ok('metrics' in debrief.body);

  // The same handler is also reachable through the debrief namespace, which is
  // what mounting one router at two paths buys.
  const nested = await aggregatesFor('/api/eod-debrief/aggregates', env);
  assert.equal(nested.status, 200);
  assert.equal(nested.body.success, true);
});
