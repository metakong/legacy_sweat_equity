/**
 * Sprint 4 — POST /api/activity quick drops.
 *
 * Real SQLite again, because the point of this route is the transaction: an
 * activity row, a compliance counter and an optional suppression have to move
 * together or not at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';
import { QUICK_DROP_DISPOSITIONS } from '../src/routes/activity.js';
import { businessDate } from '../src/lib/time.js';

const AGENT = 'sean_deardorff@us.aflac.com';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-quickdrop-')), 'test.sqlite');
}

function envWithCompany({ id = 'acct-1', confidence = 60, status = 'ACTIVE' } = {}) {
  const env = { DB: createD1(tempDbPath()) };
  env.DB._raw.prepare(`
    INSERT INTO companies (company_id, agent_email, company_name, confidence_score, status)
    VALUES (?, ?, 'Ozark Dental Group', ?, ?)
  `).run(id, AGENT, confidence, status);
  return env;
}

function postActivity(env, body) {
  return app.fetch(new Request('http://localhost/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env, { waitUntil() {} });
}

const activitiesOf = (env) => env.DB._raw.prepare('SELECT * FROM activities ORDER BY activity_id').all();
const aggregateOf = (env) => env.DB._raw.prepare('SELECT * FROM d365_daily_aggregates').get();
const companyOf = (env, id = 'acct-1') =>
  env.DB._raw.prepare('SELECT * FROM companies WHERE company_id = ?').get(id);

test('a voicemail logs the dial without touching the record', async () => {
  const env = envWithCompany({ confidence: 60 });

  const res = await postActivity(env, { company_id: 'acct-1', disposition: 'VM_NO_ANSWER', mode: 'PHONE' });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.activity_id, 1);
  assert.equal(body.disposition, 'VM_NO_ANSWER');
  assert.equal(body.activity_type, 'PHONE_DIAL');
  assert.equal(body.disqualified, false);

  const activity = activitiesOf(env)[0];
  assert.equal(activity.company_id, 'acct-1');
  assert.equal(activity.agent_email, AGENT);
  assert.equal(activity.mode, 'PHONE');
  assert.equal(activity.outcome, 'VM_NO_ANSWER');
  assert.equal(activity.next_action, 'NONE');
  assert.match(activity.notes, /Voicemail/);
  assert.match(activity.extracted_json, /"quick_drop":true/);

  const aggregate = aggregateOf(env);
  assert.equal(aggregate.business_date, businessDate());
  assert.equal(aggregate.phone_dials, 1);
  assert.equal(aggregate.dm_contacts, 0, 'a voicemail is not a decision-maker contact');
  assert.equal(aggregate.walk_ins, 0);

  const company = companyOf(env);
  assert.equal(company.status, 'ACTIVE', 'a no-answer must not suppress the account');
  assert.equal(company.confidence_score, 60, 'and must not damage its confidence');
});

test('a wrong number disqualifies the record and zeroes its confidence', async () => {
  const env = envWithCompany({ confidence: 60 });

  const res = await postActivity(env, { company_id: 'acct-1', disposition: 'WRONG_NUMBER', mode: 'PHONE' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.disqualified, true);

  const company = companyOf(env);
  assert.equal(company.status, 'DISQUALIFIED');
  assert.equal(company.verification_status, 'DISQUALIFIED');
  assert.equal(company.confidence_score, 0);

  // The dial still counts: the agent made it, and D365 compliance counts calls.
  assert.equal(aggregateOf(env).phone_dials, 1);
  assert.equal(activitiesOf(env).length, 1, 'the audit row is written either way');
});

test('a field drop counts a walk-in, not a dial', async () => {
  const env = envWithCompany({ confidence: 85 });

  const res = await postActivity(env, { company_id: 'acct-1', disposition: 'GATEKEEPER_BLOCK', mode: 'FIELD' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.activity_type, 'FIELD_WALK_IN');

  const aggregate = aggregateOf(env);
  assert.equal(aggregate.walk_ins, 1);
  assert.equal(aggregate.phone_dials, 0);
  assert.equal(activitiesOf(env)[0].mode, 'FIELD');
});

test('quick drops accumulate on the business date instead of overwriting', async () => {
  const env = envWithCompany({ confidence: 60 });

  for (let i = 0; i < 3; i += 1) {
    const res = await postActivity(env, { company_id: 'acct-1', disposition: 'VM_NO_ANSWER', mode: 'PHONE' });
    assert.equal(res.status, 200);
  }

  assert.equal(aggregateOf(env).phone_dials, 3);
  assert.equal(activitiesOf(env).length, 3);
  assert.deepEqual(activitiesOf(env).map((row) => row.activity_id), [1, 2, 3]);
});

test('a quick drop validates the account and the mode before writing anything', async () => {
  const env = envWithCompany({ confidence: 60 });

  const unknown = await postActivity(env, { company_id: 'nope', disposition: 'VM_NO_ANSWER', mode: 'PHONE' });
  assert.equal(unknown.status, 404, 'a stale dialer card must not 500 on the foreign key');

  const missingId = await postActivity(env, { disposition: 'VM_NO_ANSWER', mode: 'PHONE' });
  assert.equal(missingId.status, 400);

  const badMode = await postActivity(env, { company_id: 'acct-1', disposition: 'VM_NO_ANSWER', mode: 'CARRIER_PIGEON' });
  assert.equal(badMode.status, 400);

  assert.equal(activitiesOf(env).length, 0);
  assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM d365_daily_aggregates').get().n, 0);
});

test('the three dialer quick drops are the supported set', async () => {
  assert.deepEqual(QUICK_DROP_DISPOSITIONS, ['VM_NO_ANSWER', 'GATEKEEPER_BLOCK', 'WRONG_NUMBER']);

  const env = envWithCompany({ confidence: 60 });
  const res = await postActivity(env, { company_id: 'acct-1', disposition: 'GHOSTED', mode: 'PHONE' });

  // An Agency OS payload with a typo'd disposition is a client bug. Falling
  // through to the silent-log path would write an all-zeroes "No Contact" row
  // for what the agent meant as a one-tap outcome.
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /disposition must be one of/);
  assert.equal(activitiesOf(env).length, 0);
  assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM activity_logs').get().n, 0);
});

test('a failed counter write rolls the whole quick drop back', async () => {
  const env = envWithCompany({ confidence: 60 });

  // Remove the counter table so the second statement of the batch fails.
  env.DB._raw.exec('DROP TABLE d365_daily_aggregates');

  const res = await postActivity(env, { company_id: 'acct-1', disposition: 'WRONG_NUMBER', mode: 'PHONE' });
  assert.equal(res.status, 500);

  assert.equal(activitiesOf(env).length, 0, 'no orphan activity without its counter');
  const company = companyOf(env);
  assert.equal(company.status, 'ACTIVE', 'and no suppression either');
  assert.equal(company.confidence_score, 60);
});

test('a legacy silent log still works and does not become a quick drop', async () => {
  const env = envWithCompany({ confidence: 60 });

  // The pre-Sprint-4 payload shape: the 3-tap binary, no SCREAMING_SNAKE
  // disposition. It must keep writing activity_logs exactly as before.
  const res = await postActivity(env, {
    log_id: 'legacy-log-1',
    company_id: 'acct-1',
    is_in_person: 1,
    is_initial: 1,
    is_dm_contact: 0
  });

  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.disposition, 'Gatekeeper Blocked', 'derived from the 3-tap binary');

  assert.equal(activitiesOf(env).length, 0, 'the append-only voice table is untouched');
  assert.equal(
    env.DB._raw.prepare('SELECT COUNT(*) n FROM activity_logs').get().n,
    1,
    'the legacy path still writes activity_logs'
  );
});
