/**
 * Sprint 1B — persistence wiring and the indexed Geohash radar.
 *
 * These run the real route handler and the real upsert SQL against real
 * SQLite. The point is to catch the class of bug a hand-written mock cannot:
 * a widened INSERT whose bind order does not match its placeholders, a NOT NULL
 * column that normalization forgot to default, or a Geohash that is written to
 * a column the radar query cannot actually match on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';
import { normalizeCompany, upsertCompany } from '../src/lib/db.js';
import { encodeGeohash, decodeGeohashBounds, getGeohashQueryCells } from '../src/lib/geo.js';
import { haversineDistanceMeters, normalizeRadarLimit } from '../src/routes/radar.js';
import { AUTH_HEADERS } from './test-auth.js';

const AGENT = 'sean_deardorff@us.aflac.com';
const ORIGIN = { lat: 37.2089, lng: -93.2923 };

function tempDbPath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-radar-')),
    'test.sqlite'
  );
}

function envFor() {
  return {
    DB: createD1(tempDbPath()),
    BUCKET: { get: async () => null, put: async () => {}, delete: async () => {} },
    STORE_AUDIO: '0'
  };
}

const call = (env, url) =>
  app.fetch(new Request(`http://localhost${url}`, { headers: AUTH_HEADERS }), env, { waitUntil() {} });

async function seedCompany(env, raw) {
  const company = normalizeCompany(raw);
  await upsertCompany(env.DB, company, AGENT);
  return company;
}

function rowOf(env, companyId) {
  return env.DB._raw
    .prepare('SELECT * FROM companies WHERE company_id = ?')
    .get(companyId);
}

// ---------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------

test('normalizeCompany derives a seven-character geohash and the V2 defaults', () => {
  const company = normalizeCompany({
    company_name: 'Ozark Dental Group',
    lat: 37.2089,
    lng: -93.2923
  });

  assert.equal(company.geohash, encodeGeohash(37.2089, -93.2923, 7));
  assert.equal(company.geohash.length, 7);
  assert.equal(company.lat, 37.2089);
  assert.equal(company.long, -93.2923);

  assert.equal(company.current_voluntary_carrier, 'None');
  assert.equal(company.major_medical_carrier, null);
  assert.equal(company.is_hdhp, 0);
  assert.equal(company.estimated_w2_count, 0);
  assert.equal(company.confidence_score, 30);
  assert.equal(company.status, 'ACTIVE');

  // Nothing was supplied, so nothing may overwrite an existing row.
  assert.equal(company.__has_status, 0);
  assert.equal(company.__has_confidence_score, 0);
  assert.equal(company.__has_current_voluntary_carrier, 0);
});

test('normalizeCompany accepts descriptive coordinate aliases and refuses junk', () => {
  const terse = normalizeCompany({ company_name: 'A', lat: 37.2089, long: -93.2923 });
  const verbose = normalizeCompany({ company_name: 'B', latitude: '37.2089', longitude: '-93.2923' });
  assert.equal(verbose.geohash, terse.geohash);
  assert.equal(verbose.long, -93.2923);

  // No coordinates -> no hash. A 0,0 hash would silently pin the account in
  // the Gulf of Guinea and let radar match it from anywhere near the equator.
  const blank = normalizeCompany({ company_name: 'C' });
  assert.equal(blank.geohash, null);

  // Half a pair is not a location either.
  assert.equal(normalizeCompany({ company_name: 'D', lat: 37.2 }).geohash, null);

  // Out of range is rejected, never clamped into a neighbouring cell.
  const bad = normalizeCompany({ company_name: 'E', lat: 91, lng: -93.2923 });
  assert.equal(bad.lat, null);
  assert.equal(bad.geohash, null);
});

test('normalizeCompany upper-cases status and records that the caller supplied it', () => {
  const company = normalizeCompany({
    company_name: 'Suppressed Co',
    status: 'do_not_contact'
  });

  assert.equal(company.status, 'DO_NOT_CONTACT');
  assert.equal(company.__has_status, 1);
});

// ---------------------------------------------------------------------
// Upsert persistence
// ---------------------------------------------------------------------

test('upsertCompany persists the geohash and every V2 field', async () => {
  const env = envFor();

  await seedCompany(env, {
    company_id: 'acct-1',
    company_name: 'Ozark Dental Group',
    street_1: '1200 E Sunshine St',
    lat: 37.2089,
    lng: -93.2923,
    current_voluntary_carrier: 'Colonial',
    major_medical_carrier: 'CoxHealth',
    is_hdhp: 1,
    estimated_w2_count: 42,
    confidence_score: 85,
    status: 'ACTIVE'
  });

  const row = rowOf(env, 'acct-1');
  assert.equal(row.geohash, encodeGeohash(37.2089, -93.2923, 7));
  assert.equal(row.current_voluntary_carrier, 'Colonial');
  assert.equal(row.major_medical_carrier, 'CoxHealth');
  assert.equal(row.is_hdhp, 1);
  assert.equal(row.estimated_w2_count, 42);
  assert.equal(row.confidence_score, 85);
  assert.equal(row.status, 'ACTIVE');
});

test('upsertCompany preserves V2 values across an unrelated re-log', async () => {
  const env = envFor();

  await seedCompany(env, {
    company_id: 'acct-2',
    company_name: 'Queen City Manufacturing',
    lat: 37.2405,
    long: -93.3210,
    current_voluntary_carrier: 'Aflac',
    is_hdhp: 1,
    estimated_w2_count: 120,
    confidence_score: 90
  });
  const before = rowOf(env, 'acct-2');

  // A quick door log names only the account. Nothing else was supplied, so
  // nothing else may change — least of all the confidence score, which is what
  // decides whether the account is eligible for field canvassing at all.
  await seedCompany(env, {
    company_id: 'acct-2',
    company_name: 'Queen City Manufacturing',
    employees: 130
  });

  const after = rowOf(env, 'acct-2');
  assert.equal(after.confidence_score, 90, 'a partial re-log must not reset confidence');
  assert.equal(after.current_voluntary_carrier, 'Aflac');
  assert.equal(after.is_hdhp, 1);
  assert.equal(after.estimated_w2_count, 120);
  assert.equal(after.geohash, before.geohash, 'a partial re-log must not drop the geohash');
  assert.equal(after.employees, 130, 'the field that WAS supplied must still update');

  // An explicit suppression still lands.
  await seedCompany(env, {
    company_id: 'acct-2',
    company_name: 'Queen City Manufacturing',
    status: 'do_not_contact'
  });
  assert.equal(rowOf(env, 'acct-2').status, 'DO_NOT_CONTACT');
});

test('upsertCompany re-derives the geohash when new coordinates arrive', async () => {
  const env = envFor();

  await seedCompany(env, { company_id: 'acct-3', company_name: 'Mover Co', lat: 37.2089, lng: -93.2923 });
  assert.equal(rowOf(env, 'acct-3').geohash, encodeGeohash(37.2089, -93.2923, 7));

  await seedCompany(env, { company_id: 'acct-3', company_name: 'Mover Co', lat: 37.2405, lng: -93.3210 });
  assert.equal(rowOf(env, 'acct-3').geohash, encodeGeohash(37.2405, -93.3210, 7));
});

// ---------------------------------------------------------------------
// Distance + limit helpers
// ---------------------------------------------------------------------

test('haversineDistanceMeters measures a known separation and is symmetric', () => {
  // Springfield, MO to a point 0.01 degrees of latitude due north.
  const metres = haversineDistanceMeters(37.2089, -93.2923, 37.2189, -93.2923);
  assert.ok(Math.abs(metres - 1112) < 5, `expected ~1112 m, got ${metres}`);

  assert.equal(haversineDistanceMeters(37.2, -93.2, 37.2, -93.2), 0);
  assert.equal(
    Math.round(haversineDistanceMeters(37.2, -93.2, 37.3, -93.4)),
    Math.round(haversineDistanceMeters(37.3, -93.4, 37.2, -93.2))
  );
});

test('normalizeRadarLimit defaults, passes through, and caps', () => {
  assert.equal(normalizeRadarLimit(null), 30);
  assert.equal(normalizeRadarLimit(''), 30);
  assert.equal(normalizeRadarLimit('abc'), 30);
  assert.equal(normalizeRadarLimit('0'), 30);
  assert.equal(normalizeRadarLimit('-5'), 30);
  assert.equal(normalizeRadarLimit('7.5'), 30);
  assert.equal(normalizeRadarLimit('12'), 12);
  assert.equal(normalizeRadarLimit('50'), 50);
  assert.equal(normalizeRadarLimit('500'), 50);
});

// ---------------------------------------------------------------------
// Radar route against real SQLite
// ---------------------------------------------------------------------

test('GET /api/radar returns nearby accounts ordered by exact distance', async () => {
  const env = envFor();

  // Derive the due-north neighbour's centre so the fixture provably lands in
  // one of the nine cells rather than in whatever the cell size happens to be.
  const cells = getGeohashQueryCells(ORIGIN.lat, ORIGIN.lng, 6);
  const neighbour = decodeGeohashBounds(cells[1]);

  await seedCompany(env, {
    company_id: 'near', company_name: 'Near Account',
    lat: 37.2091, lng: -93.2915, confidence_score: 85
  });
  await seedCompany(env, {
    company_id: 'neighbour', company_name: 'Neighbour Cell Account',
    lat: neighbour.centerLatitude, lng: neighbour.centerLongitude, confidence_score: 85
  });
  // One degree away: in D1, reachable by search, but not in the nine cells.
  await seedCompany(env, {
    company_id: 'distant', company_name: 'Distant Account',
    lat: 38.2089, lng: -93.2923, confidence_score: 85
  });

  const res = await call(env, `/api/radar?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.count, 2, 'the account outside the nine cells must not be returned');
  assert.deepEqual(body.data.map((row) => row.id), ['near', 'neighbour'], 'closest account first');

  const [near, neighbourRow] = body.data;
  assert.ok(near.distance_meters < neighbourRow.distance_meters);
  assert.ok(near.distance_meters < 200, 'the near account is on the same block');
  assert.equal(near.distance_miles, near.distance_meters / 1609.344);
  assert.equal(near.company_id, 'near');
  assert.equal(near.company_name, 'Near Account');
  assert.equal(near.geohash, encodeGeohash(37.2091, -93.2915, 7));
  assert.equal(near.status, 'ACTIVE');
  assert.equal(near.confidence_score, 85);

  // The limit is applied by D1, not after the fact.
  const capped = await (await call(env, `/api/radar?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&limit=1`)).json();
  assert.equal(capped.count, 1);
  assert.equal(capped.data[0].id, 'near');
});

test('GET /api/radar omits suppressed accounts and other agents', async () => {
  const env = envFor();

  await seedCompany(env, { company_id: 'live', company_name: 'Live Co', lat: 37.2089, lng: -93.2923 });
  await seedCompany(env, {
    company_id: 'dq', company_name: 'Disqualified Co',
    lat: 37.2091, lng: -93.2915, status: 'DISQUALIFIED'
  });
  await seedCompany(env, {
    company_id: 'dnc', company_name: 'Do Not Contact Co',
    lat: 37.2092, lng: -93.2916, status: 'DO_NOT_CONTACT'
  });

  // Same cell as `live`, different tenant. Written directly because
  // upsertCompany is always scoped to the acting agent.
  env.DB._raw.prepare(
    `INSERT INTO companies
       (company_id, company_name, agent_email, lat, long, geohash, status, confidence_score)
     VALUES ('other', 'Other Agent Co', 'other@example.com', 37.2089, -93.2923, ?, 'ACTIVE', 85)`
  ).run(encodeGeohash(37.2089, -93.2923, 7));

  const res = await call(env, `/api/radar?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
  const body = await res.json();

  assert.deepEqual(body.data.map((row) => row.id), ['live']);
  assert.equal(body.count, 1);
});

test('GET /api/radar returns 400 for missing or invalid coordinates', async () => {
  const env = envFor();

  for (const query of [
    '',
    '?lat=37.2089',
    '?lng=-93.2923',
    '?lat=&lng=',
    '?lat=abc&lng=abc',
    '?lat=91&lng=-93.2923',
    '?lat=37.2089&lng=-181'
  ]) {
    const res = await call(env, `/api/radar${query}`);
    assert.equal(res.status, 400, `expected 400 for "${query}"`);

    const body = await res.json();
    assert.ok(body.error, 'a 4xx must explain itself');
  }
});
