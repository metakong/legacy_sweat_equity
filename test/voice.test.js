/**
 * Sprint 2 — edge voice ingestion.
 *
 * Two halves:
 *   - the provider layer (Groq transcript, OpenRouter strict extraction) with an
 *     injected transport, so the request shape and the validation contract are
 *     asserted without a network;
 *   - the route, against real SQLite, so the atomic commit is real. A mock D1
 *     would happily "commit" three statements that a real transaction rolls
 *     back, which is exactly the bug this endpoint exists to avoid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';
import { normalizeCompany, upsertCompany } from '../src/lib/db.js';
import { encodeGeohash } from '../src/lib/geo.js';
import {
  ProviderError,
  transcribeAudio,
  extractVoiceIntelligence,
  VOICE_DISPOSITIONS,
  VOICE_NEXT_ACTIONS
} from '../src/lib/ai.js';
import { mapVoiceActivityType } from '../src/routes/voice.js';
import { businessDate } from '../src/lib/time.js';

const AGENT = 'sean_deardorff@us.aflac.com';
const TRANSCRIPT = 'Spoke with Dana Whitfield, the office manager. They carry Colonial today.';

const EXTRACTION = {
  disposition: 'DM_TOUCH',
  contact_made: true,
  decision_maker_name: 'Dana Whitfield',
  decision_maker_title: 'Office Manager',
  current_voluntary_carrier: 'Colonial',
  major_medical_carrier: 'CoxHealth',
  is_hdhp: true,
  estimated_w2_count: 18,
  summary_notes: 'Spoke with the office manager about voluntary benefits and Section 125 payroll savings.',
  next_action: 'SEND_POP_DOCUMENT',
  next_action_date: '2026-09-18',
  confidence_score: 85,
  verification_status: 'PHONE_VERIFIED',
  d365_counters: { phone_dials: 1, dm_contacts: 1, walk_ins: 0, appointments_set: 0 }
};

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-voice-')), 'test.sqlite');
}

function envFor() {
  return {
    DB: createD1(tempDbPath()),
    BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} },
    // Keep the optional R2 archive out of the way; it is not what is under test.
    STORE_AUDIO: '0',
    // Shape-only keys: the provider transport is stubbed in every route test, so
    // these exist to satisfy the "is this deployment configured?" guards. The
    // missing-credential behaviour has its own tests at the provider layer.
    GROQ_API_KEY: 'gsk_shape_only',
    OPENROUTER_API_KEY: 'sk_or_shape_only'
  };
}

async function seedCompany(env, raw) {
  const company = normalizeCompany(raw);
  await upsertCompany(env.DB, company, AGENT);
  return company;
}

function postVoice(env, form) {
  return app.fetch(
    new Request('http://localhost/api/voice-debrief', { method: 'POST', body: form }),
    env,
    { waitUntil() {} }
  );
}

function audioForm({ audio = true, companyId = null, mode = null } = {}) {
  const form = new FormData();
  if (audio) {
    form.append('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'debrief.webm');
  }
  if (companyId !== null) form.append('company_id', companyId);
  if (mode !== null) form.append('mode', mode);
  return form;
}

/** Provider stub that answers Groq and OpenRouter and refuses anything else. */
function stubProviders(extraction = EXTRACTION, transcript = TRANSCRIPT) {
  const calls = [];
  const impl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('api.groq.com')) {
      return new Response(JSON.stringify({ text: transcript }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(extraction) } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected outbound request: ${target}`);
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------
// transcribeAudio
// ---------------------------------------------------------------------

test('transcribeAudio posts the capture to Groq and returns a transcript envelope', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ text: '  Hello world  ' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };

  const result = await transcribeAudio(
    new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
    { env: { GROQ_API_KEY: 'gsk_test' }, filename: 'journal.webm', fetchImpl }
  );

  assert.deepEqual(result, { success: true, text: 'Hello world' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gsk_test');

  const form = calls[0].init.body;
  assert.equal(form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(form.get('response_format'), 'json');
  assert.equal(form.get('temperature'), '0');
  assert.match(form.get('prompt'), /Section 125/);
  assert.ok(form.get('file'), 'the audio must ride along as a file part');
});

test('transcribeAudio accepts a raw buffer and names the upload from its MIME type', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
  };

  const result = await transcribeAudio(new Uint8Array([9, 9]).buffer, {
    env: { GROQ_API_KEY: 'k' }, mimeType: 'audio/ogg', fetchImpl
  });

  assert.equal(result.text, 'ok');
  const file = calls[0].body.get('file');
  assert.equal(file.name, 'journal.ogg');
  assert.equal(file.type, 'audio/ogg');
});

test('transcribeAudio fails loudly instead of inventing a transcript', async () => {
  // Unconfigured provider.
  await assert.rejects(
    () => transcribeAudio(new Blob([new Uint8Array([1])]), { env: {} }),
    (err) => err instanceof ProviderError && err.status === 503
  );

  // Empty payload never reaches the network.
  await assert.rejects(
    () => transcribeAudio(new Uint8Array([]), { env: { GROQ_API_KEY: 'k' } }),
    (err) => err instanceof ProviderError && err.status === 400
  );

  // Upstream failure surfaces its own status.
  await assert.rejects(
    () => transcribeAudio(new Blob([new Uint8Array([1])]), {
      env: { GROQ_API_KEY: 'k' },
      fetchImpl: async () => new Response('boom', { status: 500 })
    }),
    (err) => err instanceof ProviderError && err.status === 500
  );

  // A 200 with no text is a failure, not an empty CRM note.
  await assert.rejects(
    () => transcribeAudio(new Blob([new Uint8Array([1])]), {
      env: { GROQ_API_KEY: 'k' },
      fetchImpl: async () => new Response(JSON.stringify({ text: '   ' }), { status: 200 })
    }),
    (err) => err instanceof ProviderError && err.status === 502
  );

  // Explicit injection is the only way a deterministic transcript is produced.
  const mocked = await transcribeAudio(new Blob([new Uint8Array([1])]), {
    env: {}, mockText: '  deterministic  '
  });
  assert.deepEqual(mocked, { success: true, text: 'deterministic' });
});

// ---------------------------------------------------------------------
// extractVoiceIntelligence
// ---------------------------------------------------------------------

test('extractVoiceIntelligence enforces the strict JSON contract through OpenRouter', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(EXTRACTION) } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const extracted = await extractVoiceIntelligence(
    TRANSCRIPT,
    { mode: 'PHONE', company_id: 'co-1', company_name: 'Ozark Dental Group' },
    { OPENROUTER_API_KEY: 'sk-or', fetchImpl }
  );

  assert.deepEqual(extracted, EXTRACTION, 'a valid extraction survives normalization unchanged');

  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or');
  assert.equal(calls[0].body.model, 'anthropic/claude-3.5-sonnet');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.temperature, 0);

  const system = calls[0].body.messages.find((m) => m.role === 'system').content;
  for (const value of VOICE_DISPOSITIONS) assert.match(system, new RegExp(value));
  for (const value of VOICE_NEXT_ACTIONS) assert.match(system, new RegExp(value));
  assert.match(system, /d365_counters/);
  assert.match(system, /PHI/);

  const user = calls[0].body.messages.find((m) => m.role === 'user').content;
  assert.match(user, /Interaction mode: phone call/);
  assert.match(user, /Ozark Dental Group/);
  assert.match(user, /America\/Chicago/);
});

test('extractVoiceIntelligence honours a pinned model override', async () => {
  let model = null;
  const fetchImpl = async (url, init) => {
    model = JSON.parse(init.body).model;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(EXTRACTION) } }]
    }), { status: 200 });
  };

  await extractVoiceIntelligence(TRANSCRIPT, {}, {
    OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'openai/gpt-5-mini', fetchImpl
  });
  assert.equal(model, 'openai/gpt-5-mini');
});

test('extractVoiceIntelligence rejects an extraction that breaks the contract', async () => {
  const without = (key) => {
    const clone = { ...EXTRACTION };
    delete clone[key];
    return clone;
  };

  const violations = [
    ['an invented disposition', { ...EXTRACTION, disposition: 'MAYBE_LATER' }],
    ['a missing contact_made', without('contact_made')],
    ['a non-boolean contact_made', { ...EXTRACTION, contact_made: 'sometimes' }],
    ['an empty summary', { ...EXTRACTION, summary_notes: '   ' }],
    ['a missing summary', without('summary_notes')],
    ['confidence above 100', { ...EXTRACTION, confidence_score: 101 }],
    ['a fractional confidence', { ...EXTRACTION, confidence_score: 88.5 }],
    ['a missing confidence', without('confidence_score')]
  ];

  for (const [label, mock] of violations) {
    await assert.rejects(
      () => extractVoiceIntelligence(TRANSCRIPT, {}, { VOICE_INTELLIGENCE_MOCK: mock }),
      (err) => err instanceof ProviderError && err.provider === 'openrouter',
      `expected ${label} to be rejected`
    );
  }

  // A date that is merely unparseable is legitimately unknown, not a violation.
  const noDate = await extractVoiceIntelligence(TRANSCRIPT, {}, {
    VOICE_INTELLIGENCE_MOCK: { ...EXTRACTION, next_action_date: 'not a date' }
  });
  assert.equal(noDate.next_action_date, null);
});

test('extractVoiceIntelligence coerces the descriptive fields instead of trusting them', async () => {
  const extracted = await extractVoiceIntelligence(TRANSCRIPT, {}, {
    VOICE_INTELLIGENCE_MOCK: {
      ...EXTRACTION,
      next_action: 'CALL_THE_SPOUSE',
      verification_status: 'PROBABLY_FINE',
      is_hdhp: null,
      estimated_w2_count: 'many',
      current_voluntary_carrier: '   ',
      major_medical_carrier: null,
      d365_counters: { phone_dials: '1', dm_contacts: -3 }
    }
  });

  assert.equal(extracted.next_action, 'NONE', 'an unknown next action falls back to NONE');
  assert.equal(extracted.verification_status, 'UNVERIFIED');
  assert.equal(extracted.is_hdhp, null);
  assert.equal(extracted.estimated_w2_count, null);
  assert.equal(extracted.current_voluntary_carrier, null);
  assert.equal(extracted.major_medical_carrier, null);
  assert.deepEqual(extracted.d365_counters, {
    phone_dials: 1, dm_contacts: 0, walk_ins: 0, appointments_set: 0
  });
});

test('a disqualified extraction is disqualified in both status fields', async () => {
  const extracted = await extractVoiceIntelligence(TRANSCRIPT, {}, {
    VOICE_INTELLIGENCE_MOCK: {
      ...EXTRACTION,
      disposition: 'DISQUALIFIED',
      verification_status: 'UNVERIFIED',
      d365_counters: { phone_dials: 1, dm_contacts: 0, walk_ins: 0, appointments_set: 0 }
    }
  });

  assert.equal(extracted.verification_status, 'DISQUALIFIED');
});

test('extractVoiceIntelligence degrades conservatively when OpenRouter is unconfigured', async () => {
  const field = await extractVoiceIntelligence('Walked in and left a card with the receptionist.', { mode: 'FIELD' }, {});

  assert.equal(field.disposition, 'GATEKEEPER_BLOCK');
  assert.equal(field.contact_made, false);
  assert.equal(field.verification_status, 'UNVERIFIED');
  assert.equal(field.confidence_score, 30);
  // It never invents intelligence it does not have...
  assert.equal(field.current_voluntary_carrier, null);
  assert.equal(field.major_medical_carrier, null);
  assert.equal(field.is_hdhp, null);
  assert.equal(field.estimated_w2_count, null);
  // ...but it does record the physical action that actually happened.
  assert.deepEqual(field.d365_counters, {
    phone_dials: 0, dm_contacts: 0, walk_ins: 1, appointments_set: 0
  });
  assert.match(field.summary_notes, /left a card/);

  const phone = await extractVoiceIntelligence('Voicemail box.', { mode: 'PHONE' }, {});
  assert.equal(phone.disposition, 'VM_NO_ANSWER');
  assert.deepEqual(phone.d365_counters, {
    phone_dials: 1, dm_contacts: 0, walk_ins: 0, appointments_set: 0
  });

  // An empty transcript is a caller error, not an empty CRM row.
  await assert.rejects(
    () => extractVoiceIntelligence('   ', {}, {}),
    (err) => err instanceof ProviderError && err.status === 400
  );
});

test('mapVoiceActivityType separates the physical verb from the DM outcome', () => {
  assert.equal(mapVoiceActivityType('PHONE', 'VM_NO_ANSWER'), 'PHONE_DIAL');
  assert.equal(mapVoiceActivityType('PHONE', 'GATEKEEPER_BLOCK'), 'PHONE_DIAL');
  assert.equal(mapVoiceActivityType('PHONE', 'DM_TOUCH'), 'PHONE_DM_TOUCH');
  assert.equal(mapVoiceActivityType('FIELD', 'GATEKEEPER_BLOCK'), 'FIELD_WALK_IN');
  assert.equal(mapVoiceActivityType('FIELD', 'GATEKEEPER_CLEARED'), 'FIELD_WALK_IN');
  assert.equal(mapVoiceActivityType('FIELD', 'DM_TOUCH'), 'FIELD_DM_TOUCH');
  assert.equal(mapVoiceActivityType('FIELD', 'PRESENTATION'), 'PRESENTATION');
  assert.equal(mapVoiceActivityType('PHONE', 'CLOSED_WON'), 'CLOSED_WON');
  assert.equal(mapVoiceActivityType('FIELD', 'DISQUALIFIED'), 'DISQUALIFIED');
});

// ---------------------------------------------------------------------
// POST /api/voice-debrief — real SQLite, real transaction
// ---------------------------------------------------------------------

test('POST /api/voice-debrief commits the company, the activity and the counters together', async () => {
  const env = envFor();
  await seedCompany(env, { company_id: 'acct-1', company_name: 'Ozark Dental Group', confidence_score: 40 });

  const { impl } = stubProviders();
  const original = globalThis.fetch;
  globalThis.fetch = impl;

  try {
    const res = await postVoice(env, audioForm({ companyId: 'acct-1', mode: 'PHONE' }));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    // --- response envelope ---
    assert.equal(body.success, true);
    assert.equal(body.degraded, null);
    assert.equal(body.transcript, TRANSCRIPT);
    assert.equal(body.company_id, 'acct-1');
    assert.equal(body.activity_id, 1);
    assert.equal(body.activity_type, 'PHONE_DM_TOUCH');
    assert.equal(body.extracted.confidence_score, 85);

    // --- the account picked up the Section 125 intel ---
    const company = env.DB._raw.prepare('SELECT * FROM companies WHERE company_id = ?').get('acct-1');
    assert.equal(company.confidence_score, 85);
    assert.equal(company.verification_status, 'PHONE_VERIFIED');
    assert.equal(company.decision_maker, 'Dana Whitfield');
    assert.equal(company.current_voluntary_carrier, 'Colonial');
    assert.equal(company.major_medical_carrier, 'CoxHealth');
    assert.equal(company.is_hdhp, 1);
    assert.equal(company.estimated_w2_count, 18);
    assert.equal(company.status, 'ACTIVE');

    // --- one append-only activity row, with the raw model output preserved ---
    const activities = env.DB._raw.prepare('SELECT * FROM activities').all();
    assert.equal(activities.length, 1);
    assert.equal(activities[0].company_id, 'acct-1');
    assert.equal(activities[0].agent_email, AGENT);
    assert.equal(activities[0].activity_type, 'PHONE_DM_TOUCH');
    assert.equal(activities[0].mode, 'PHONE');
    assert.equal(activities[0].outcome, 'DM_TOUCH');
    assert.equal(activities[0].next_action, 'SEND_POP_DOCUMENT');
    assert.equal(activities[0].next_action_date, '2026-09-18');
    assert.match(activities[0].notes, /Section 125/);
    assert.equal(activities[0].raw_transcript, TRANSCRIPT);
    // decision_maker_title has no company column; extracted_json is where it lives.
    assert.match(activities[0].extracted_json, /"decision_maker_title":"Office Manager"/);

    // --- the compliance counters landed on the Springfield business date ---
    const aggregate = env.DB._raw.prepare('SELECT * FROM d365_daily_aggregates').get();
    assert.equal(aggregate.business_date, businessDate());
    assert.equal(aggregate.phone_dials, 1);
    assert.equal(aggregate.dm_contacts, 1);
    assert.equal(aggregate.walk_ins, 0);
    assert.equal(aggregate.appointments_set, 0);

    // A second debrief the same day ACCUMULATES rather than overwriting.
    const second = await postVoice(env, audioForm({ companyId: 'acct-1', mode: 'PHONE' }));
    assert.equal(second.status, 200);
    const after = env.DB._raw.prepare('SELECT * FROM d365_daily_aggregates').get();
    assert.equal(after.phone_dials, 2);
    assert.equal(after.dm_contacts, 2);
    assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM activities').get().n, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('POST /api/voice-debrief rejects bad input before it pays for a model call', async () => {
  const env = envFor();
  await seedCompany(env, { company_id: 'acct-1', company_name: 'Ozark Dental Group' });

  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('no provider may be contacted for an invalid request');
  };

  try {
    // No audio part at all.
    const missing = await postVoice(env, audioForm({ audio: false, companyId: 'acct-1' }));
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /audio/i);

    // Unknown account: one indexed read, then stop.
    const unknown = await postVoice(env, audioForm({ companyId: 'does-not-exist' }));
    assert.equal(unknown.status, 404);

    // Structurally invalid id (spaces are not a valid opaque id).
    const malformed = await postVoice(env, audioForm({ companyId: 'bad id with spaces' }));
    assert.equal(malformed.status, 400);

    assert.equal(providerCalls, 0, 'an invalid request must not cost a transcription or a completion');
    assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM activities').get().n, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a DISQUALIFIED debrief suppresses the account as well as flagging it', async () => {
  const env = envFor();
  await seedCompany(env, { company_id: 'acct-dq', company_name: 'Closed Shop LLC' });

  const { impl } = stubProviders({
    ...EXTRACTION,
    disposition: 'DISQUALIFIED',
    contact_made: false,
    next_action: 'NONE',
    next_action_date: null,
    verification_status: 'UNVERIFIED',
    d365_counters: { phone_dials: 1, dm_contacts: 0, walk_ins: 0, appointments_set: 0 }
  });

  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const res = await postVoice(env, audioForm({ companyId: 'acct-dq' }));
    assert.equal(res.status, 200);

    const company = env.DB._raw.prepare('SELECT status, verification_status FROM companies WHERE company_id = ?').get('acct-dq');
    assert.equal(company.status, 'DISQUALIFIED');
    assert.equal(company.verification_status, 'DISQUALIFIED');

    const activity = env.DB._raw.prepare('SELECT activity_type, outcome FROM activities').get();
    assert.equal(activity.activity_type, 'DISQUALIFIED');
    assert.equal(activity.outcome, 'DISQUALIFIED');
  } finally {
    globalThis.fetch = original;
  }
});

test('a debrief with no account still records the touch and the dial', async () => {
  const env = envFor();

  const { impl } = stubProviders({
    ...EXTRACTION,
    disposition: 'GATEKEEPER_BLOCK',
    contact_made: false,
    decision_maker_name: null,
    decision_maker_title: null,
    current_voluntary_carrier: null,
    major_medical_carrier: null,
    is_hdhp: null,
    estimated_w2_count: null,
    verification_status: 'UNVERIFIED',
    d365_counters: { phone_dials: 1, dm_contacts: 0, walk_ins: 0, appointments_set: 0 }
  });

  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const res = await postVoice(env, audioForm({ mode: 'PHONE' }));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.company_id, null);
    assert.equal(body.activity_id, 1);
    assert.equal(body.company_updated, false);

    const activity = env.DB._raw.prepare('SELECT * FROM activities').get();
    assert.equal(activity.company_id, null);
    assert.equal(activity.activity_type, 'PHONE_DIAL');

    assert.equal(env.DB._raw.prepare('SELECT phone_dials FROM d365_daily_aggregates').get().phone_dials, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed counter write rolls the entire voice commit back', async () => {
  const env = envFor();
  await seedCompany(env, { company_id: 'acct-rb', company_name: 'Rollback Co', confidence_score: 40 });

  // Remove the third statement's target so the batch fails AFTER the company
  // update and the activity insert have been prepared against it.
  env.DB._raw.exec('DROP TABLE d365_daily_aggregates');

  const { impl } = stubProviders();
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const res = await postVoice(env, audioForm({ companyId: 'acct-rb' }));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).stage, 'commit');

    // Nothing may have landed: a half-written touch is worse than none.
    assert.equal(env.DB._raw.prepare('SELECT COUNT(*) n FROM activities').get().n, 0);
    const company = env.DB._raw.prepare('SELECT confidence_score FROM companies WHERE company_id = ?').get('acct-rb');
    assert.equal(company.confidence_score, 40, 'the company update must roll back with the rest');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------
// scripts/backfill-geohashes.cjs
// ---------------------------------------------------------------------

test('the backfill script fills only the rows that need a geohash', () => {
  const file = tempDbPath();
  const seed = new DatabaseSync(file);
  seed.exec(fs.readFileSync(path.join(process.cwd(), 'schema.sql'), 'utf8'));
  seed.prepare(`
    INSERT INTO companies (company_id, company_name, agent_email, lat, long, geohash)
    VALUES ('g1', 'Needs Hash', ?, 37.2089, -93.2923, NULL)
  `).run(AGENT);
  seed.prepare(`
    INSERT INTO companies (company_id, company_name, agent_email, lat, long, geohash)
    VALUES ('g2', 'No Coordinates', ?, NULL, NULL, NULL)
  `).run(AGENT);
  seed.prepare(`
    INSERT INTO companies (company_id, company_name, agent_email, lat, long, geohash)
    VALUES ('g3', 'Already Hashed', ?, 37.2, -93.2, '9ytetjd')
  `).run(AGENT);
  seed.close();

  const script = path.join(process.cwd(), 'scripts', 'backfill-geohashes.cjs');
  const output = execFileSync(process.execPath, [script, file], { encoding: 'utf8' });

  const check = new DatabaseSync(file);
  try {
    assert.equal(
      check.prepare(`SELECT geohash FROM companies WHERE company_id = 'g1'`).get().geohash,
      encodeGeohash(37.2089, -93.2923, 7)
    );
    assert.equal(
      check.prepare(`SELECT geohash FROM companies WHERE company_id = 'g2'`).get().geohash,
      null,
      'a row with no coordinates must not be given a hash'
    );
    assert.equal(
      check.prepare(`SELECT geohash FROM companies WHERE company_id = 'g3'`).get().geohash,
      '9ytetjd',
      'an existing hash must not be rewritten'
    );
  } finally {
    check.close();
  }

  assert.match(output, /Backfilled 1 row/);
});
