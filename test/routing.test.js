/**
 * Test suite for Autonomous Dynamic Routing & Spatial EPV Engine (Phase 3)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from '../src/index.js';
import { createD1 } from '../mockEnv.js';
import { calculateEpv, getIndustryMultiplier, buildIndustryHook } from '../src/routes/routing.js';
import { AUTH_HEADERS } from './test-auth.js';

const AGENT = 'sean_deardorff@us.aflac.com';

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-routing-')), 'test.sqlite');
}

const call = (env, url, init = {}) => {
  const headers = { ...AUTH_HEADERS, ...(init.headers || {}) };
  return app.fetch(new Request(`http://localhost${url}`, { ...init, headers }), env, { waitUntil() {} });
};

function postJson(env, url, payload) {
  return call(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

test('getIndustryMultiplier covers all Phase 3 commercial risk verticals', () => {
  assert.equal(getIndustryMultiplier('Construction & Trades'), 2.0);
  assert.equal(getIndustryMultiplier('Commercial Roofing & Sheet Metal'), 2.0);
  assert.equal(getIndustryMultiplier('Manufacturing'), 1.8);
  assert.equal(getIndustryMultiplier('Tool & Die Machine Shop'), 1.8);
  assert.equal(getIndustryMultiplier('Metal Fab & Welding'), 1.8);
  assert.equal(getIndustryMultiplier('Transportation & Logistics'), 1.7);
  assert.equal(getIndustryMultiplier('Warehousing & Freight Logistics'), 1.7);
  assert.equal(getIndustryMultiplier('Healthcare & Medical'), 1.6);
  assert.equal(getIndustryMultiplier('Dental Clinic Associates'), 1.6);
  assert.equal(getIndustryMultiplier('Veterinary Hospital'), 1.6);
  assert.equal(getIndustryMultiplier('Automotive & Dealerships'), 1.5);
  assert.equal(getIndustryMultiplier('Body Shop & Collision Repair'), 1.5);
  assert.equal(getIndustryMultiplier('Agriculture & Forestry'), 1.5);
  assert.equal(getIndustryMultiplier('Hospitality & Food Service'), 1.3);
  assert.equal(getIndustryMultiplier('Retail Trade'), 1.1);
  assert.equal(getIndustryMultiplier('Professional & Tech Services'), 1.0);
  assert.equal(getIndustryMultiplier('Unknown Entity'), 1.0);
});

test('calculateEpv adheres to EPV formula and coalesces headcounts safely', () => {
  // EPV = max(count, 3) * mult / (dist + 0.5)
  
  // 1. Explicit employees
  const epvConstruction = calculateEpv({ employees: 20, industry: 'Construction & Trades' }, 0.5);
  assert.equal(epvConstruction, 40.0); // 20 * 2.0 / (0.5 + 0.5) = 40.0

  // 2. Coalesce from estimated_w2_count when employees is null
  const epvW2 = calculateEpv({ employees: null, estimated_w2_count: 10, industry: 'Manufacturing' }, 0.5);
  assert.equal(epvW2, 18.0); // 10 * 1.8 / (0.5 + 0.5) = 18.0

  // 3. Coalesce to baseline 3 when both are null or under 3
  const epvMin = calculateEpv({ employees: 1, industry: 'Automotive & Dealerships' }, 0.5);
  assert.equal(epvMin, 4.5); // max(1, 3) * 1.5 / 1.0 = 4.5

  const epvNulls = calculateEpv({ employees: null, estimated_w2_count: null, industry: 'Healthcare & Medical' }, 0.5);
  assert.equal(epvNulls, 4.8); // 3 * 1.6 / 1.0 = 4.8

  // 4. Fallback when target is empty object
  const epvEmpty = calculateEpv({}, null);
  assert.equal(epvEmpty, 3.3); // 5 * 1.0 / 1.5 = 3.3

  // 5. Zero distance safe from division by zero
  const epvZeroDist = calculateEpv({ employees: 10, industry: 'Other Commercial' }, 0.0);
  assert.equal(epvZeroDist, 20.0); // 10 * 1.0 / 0.5 = 20.0
});

test('buildIndustryHook creates industry-specific Section 125 pitch hooks', () => {
  assert.match(buildIndustryHook('Construction & Trades'), /Construction & High-Risk Trades/);
  assert.match(buildIndustryHook('Tool & Die Manufacturing'), /Fabrication & Manufacturing/);
  assert.match(buildIndustryHook('Trucking & Freight Logistics'), /Transport & Warehousing/);
  assert.match(buildIndustryHook('Dental Surgery Associates'), /Healthcare & Clinical Staff/);
  assert.match(buildIndustryHook('Auto Body Repair'), /Auto Dealerships & Technicians/);
  assert.match(buildIndustryHook('General Commercial Corp'), /General Commercial Corp/);
});

test('POST /api/route/optimize executes autonomous dynamic routing with zero IDs', async () => {
  const env = { DB: createD1(tempDbPath()) };

  // Seed sample prospects around Springfield, MO
  // Springfield center: 37.2089, -93.2923
  await env.DB._raw.prepare(`
    INSERT INTO companies (
      company_id, company_name, street_1, city, state, zip_code, lat, long,
      employees, estimated_w2_count, industry, status, pipeline_stage, agent_email
    ) VALUES 
    ('c1', 'Ozark Tool & Die', '1500 E Trafficway St', 'Springfield', 'MO', '65802', 37.2100, -93.2800, 25, 25, 'Manufacturing', 'ACTIVE', 'PROSPECT', ?),
    ('c2', 'Springfield Commercial Roofing', '2000 W Division St', 'Springfield', 'MO', '65803', 37.2250, -93.3100, 18, 18, 'Construction & Trades', 'ACTIVE', 'PROSPECT', ?),
    ('c3', 'Queen City Dental Group', '1200 S Glenstone Ave', 'Springfield', 'MO', '65804', 37.1950, -93.2650, 12, 12, 'Healthcare & Medical', 'ACTIVE', 'PROSPECT', ?),
    ('c4', 'Midwest Logistics Depot', '3200 N Mulroy Rd', 'Springfield', 'MO', '65802', 37.2500, -93.2200, 40, 40, 'Transportation & Logistics', 'ACTIVE', 'PROSPECT', ?),
    ('c5', 'Far Off Corp (Beyond 15mi)', '100 County Line Rd', 'Bolivar', 'MO', '65613', 37.6000, -93.4000, 50, 50, 'Manufacturing', 'ACTIVE', 'PROSPECT', ?),
    ('c6', 'Disqualified Company', '500 W Kearney St', 'Springfield', 'MO', '65803', 37.2300, -93.2950, 30, 30, 'Manufacturing', 'DISQUALIFIED', 'DISQUALIFIED', ?)
  `).run(AGENT, AGENT, AGENT, AGENT, AGENT, AGENT);

  // Call /api/route/optimize autonomously (no company_ids, no stops)
  const res = await postJson(env, '/api/route/optimize', {
    start: { lat: 37.2089, long: -93.2923 },
    radius_miles: 8.0,
    limit: 10
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.success, true);
  assert.equal(data.provider, 'autonomous-epv');
  // Disqualified (c6) and Out of range (c5) must be excluded
  assert.equal(data.total_stops, 4);
  assert.ok(data.total_estimated_miles > 0);
  assert.ok(data.cumulative_epv > 0);
  assert.equal(data.ordered_stops.length, 4);

  // Verify fields in ordered_stops
  const firstStop = data.ordered_stops[0];
  assert.equal(firstStop.sequence_rank, 1);
  assert.ok(firstStop.company_name);
  assert.ok(firstStop.address);
  assert.ok(firstStop.employees >= 3);
  assert.ok(firstStop.epv_score > 0);
  assert.ok(firstStop.industry_hook.startsWith('Section 125 FICA Tax Offset'));
  assert.ok(Number.isFinite(firstStop.leg_miles));
  assert.ok(Number.isFinite(firstStop.lat));
  assert.ok(Number.isFinite(firstStop.long));
});
