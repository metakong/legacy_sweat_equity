import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDoorKey, normalizeName, normalizeStreet, CompanyMatcher } from '../src/lib/match.js';
import { normalizeCompany, buildCompanyStatement, upsertCompany } from '../src/lib/db.js';
import { createD1 } from '../mockEnv.js';

test('getDoorKey produces canonical keys and returns null for invalid addresses', () => {
  // Canonical folding
  assert.equal(
    getDoorKey('The Acme Corporation, Inc.', '123 E. Main Street, Suite 200'),
    'acme 123 e main'
  );
  assert.equal(
    getDoorKey('Acme', '123 E Main St'),
    'acme 123 e main'
  );

  // Missing or non-address street returns null
  assert.equal(getDoorKey('Acme', null), null);
  assert.equal(getDoorKey('Acme', ''), null);
  assert.equal(getDoorKey('Acme', 'Springfield Area'), null);
  assert.equal(getDoorKey('Acme', 'Springfield, MO'), null);
  assert.equal(getDoorKey('', '123 Main St'), null);
});

test('normalizeCompany generates door_key and maintains primitives-only contract', () => {
  const norm = normalizeCompany({
    company_name: 'Ozark Precision Tool LLC',
    street_1: '4560 S. Campbell Ave. Ste B'
  });

  assert.equal(norm.door_key, 'ozark precision tool 4560 s campbell');
  assert.equal(typeof norm.door_key, 'string');

  const normNull = normalizeCompany({
    company_name: 'No Address Co'
  });
  assert.equal(normNull.door_key, null);

  for (const [k, v] of Object.entries(norm)) {
    assert.ok(
      v === null || typeof v === 'string' || typeof v === 'number',
      `Field ${k} must be primitive`
    );
  }
});

test('D1 UPSERT intercepts duplicate physical doors with different company_id', async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-door-test-')), 'test.sqlite');
  const d1 = createD1(tmp);

  const comp1 = normalizeCompany({
    company_name: 'Queen City Dental',
    street_1: '1400 E Sunshine St',
    notes: 'First visit note'
  });
  const id1 = await upsertCompany(d1, comp1);

  // Verify inserted
  const row1 = await d1.prepare('SELECT company_id, company_name, door_key, notes FROM companies WHERE company_id = ?')
    .bind(id1).first();
  assert.ok(row1);
  assert.equal(row1.door_key, 'queen city dental 1400 e sunshine');
  assert.equal(row1.notes, 'First visit note');

  // Attempt to insert duplicate company with NEW company_id (e.g. from naive ingest or field typo)
  const comp2 = normalizeCompany({
    company_name: 'Queen City Dental, LLC',
    street_1: '1400 E. Sunshine Street Ste 100',
    notes: 'Second visit note'
  });
  assert.notEqual(comp2.company_id, id1);

  const id2 = await upsertCompany(d1, comp2);

  // Total rows in companies with this door must be EXACTLY 1
  const count = await d1.prepare("SELECT count(*) as total FROM companies WHERE door_key = 'queen city dental 1400 e sunshine'").first();
  assert.equal(count.total, 1);

  // Notes should be combined, and door_key maintained
  const updatedRow = await d1.prepare("SELECT company_id, company_name, door_key, notes FROM companies WHERE door_key = 'queen city dental 1400 e sunshine'").first();
  assert.ok(updatedRow.notes.includes('First visit note'));
  assert.ok(updatedRow.notes.includes('Second visit note'));

  d1._raw?.close?.();
});

test('Accounts without street addresses do not conflict with each other', async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-door-test-2-')), 'test.sqlite');
  const d1 = createD1(tmp);

  const c1 = normalizeCompany({ company_name: 'Phone Prospect A' });
  const c2 = normalizeCompany({ company_name: 'Phone Prospect B' });

  const id1 = await upsertCompany(d1, c1);
  const id2 = await upsertCompany(d1, c2);

  assert.notEqual(id1, id2);

  const rows = await d1.prepare('SELECT count(*) as total FROM companies WHERE door_key IS NULL').first();
  assert.equal(rows.total, 2);

  d1._raw?.close?.();
});
