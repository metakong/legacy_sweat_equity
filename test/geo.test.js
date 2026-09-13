import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  GEOHASH_BASE32,
  encodeGeohash,
  decodeGeohashBounds,
  getGeohashNeighbors,
  getGeohashQueryCells
} from '../src/lib/geo.js';

const AGENT = 'sean_deardorff@us.aflac.com';

const MIGRATION_SQL = fs.readFileSync(
  new URL('../migrations/0004_v2_agency_os.sql', import.meta.url),
  'utf8'
);

const FRESH_SCHEMA_SQL = fs.readFileSync(
  new URL('../schema.sql', import.meta.url),
  'utf8'
);

const V2_COLUMNS = [
  'current_voluntary_carrier',
  'major_medical_carrier',
  'is_hdhp',
  'estimated_w2_count',
  'confidence_score',
  'geohash',
  'status'
];

function createPreV2Database() {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE companies (
      company_id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      employees INTEGER,
      pipeline_stage TEXT DEFAULT 'PROSPECT',
      agent_email TEXT NOT NULL
          DEFAULT 'sean_deardorff@us.aflac.com'
    );

    INSERT INTO companies (
      company_id,
      company_name,
      employees,
      pipeline_stage,
      agent_email
    ) VALUES
      ('active-1', 'Active Company', 42, 'PROSPECT',
       'sean_deardorff@us.aflac.com'),
      ('disqualified-1', 'Disqualified Company', 18, 'DISQUALIFIED',
       'sean_deardorff@us.aflac.com');
  `);

  return db;
}

function columnNames(db) {
  return new Set(
    db.prepare(`SELECT name FROM pragma_table_info('companies')`)
      .all()
      .map((row) => row.name)
  );
}

test('Geohash encoder matches canonical public vectors', () => {
  assert.equal(encodeGeohash(42.6, -5.6, 5), 'ezs42');
  assert.equal(
    encodeGeohash(57.64911, 10.40744, 11),
    'u4pruydqqvj'
  );
  assert.equal(encodeGeohash(37.2089, -93.2923, 7), '9ytetjd');
});

test('Geohash encoder defaults to seven lowercase characters', () => {
  const geohash = encodeGeohash(37.2089, -93.2923);

  assert.equal(geohash, '9ytetjd');
  assert.equal(geohash.length, 7);
  assert.match(geohash, /^[0123456789bcdefghjkmnpqrstuvwxyz]+$/);
  assert.equal(GEOHASH_BASE32.length, 32);
});

test('Geohash inputs fail explicitly instead of returning corrupt hashes', () => {
  assert.throws(
    () => encodeGeohash('37.2', -93.2),
    { name: 'TypeError' }
  );
  assert.throws(
    () => encodeGeohash(Number.NaN, -93.2),
    { name: 'TypeError' }
  );
  assert.throws(
    () => encodeGeohash(91, -93.2),
    { name: 'RangeError' }
  );
  assert.throws(
    () => encodeGeohash(37.2, -181),
    { name: 'RangeError' }
  );
  assert.throws(
    () => encodeGeohash(37.2, -93.2, 0),
    { name: 'RangeError' }
  );
  assert.throws(
    () => encodeGeohash(37.2, -93.2, 13),
    { name: 'RangeError' }
  );
  assert.throws(
    () => encodeGeohash(37.2, -93.2, 6.5),
    { name: 'TypeError' }
  );
});

test('decoded bounds contain the encoded coordinate', () => {
  const latitude = 37.2089;
  const longitude = -93.2923;
  const geohash = encodeGeohash(latitude, longitude, 7);
  const bounds = decodeGeohashBounds(`  ${geohash.toUpperCase()}  `);

  assert.equal(bounds.geohash, geohash);
  assert.ok(latitude >= bounds.minLatitude);
  assert.ok(latitude <= bounds.maxLatitude);
  assert.ok(longitude >= bounds.minLongitude);
  assert.ok(longitude <= bounds.maxLongitude);
  assert.ok(bounds.latitudeSpan > 0);
  assert.ok(bounds.longitudeSpan > 0);

  assert.throws(
    () => decodeGeohashBounds('9ytetja'),
    { name: 'RangeError' }
  );
  assert.throws(
    () => decodeGeohashBounds(''),
    { name: 'RangeError' }
  );
  assert.throws(
    () => decodeGeohashBounds(null),
    { name: 'TypeError' }
  );
});

test('neighbor generator returns N, NE, E, SE, S, SW, W, NW', () => {
  assert.deepEqual(
    getGeohashNeighbors('9ytetj'),
    [
      '9ytetn',
      '9ytetq',
      '9ytetm',
      '9ytetk',
      '9yteth',
      '9ytesu',
      '9ytesv',
      '9ytesy'
    ]
  );
});

test('query-cell generator returns the center and eight unique neighbors', () => {
  const cells = getGeohashQueryCells(37.2089, -93.2923, 6);

  assert.equal(cells.length, 9);
  assert.equal(cells[0], '9ytetj');
  assert.equal(new Set(cells).size, 9);

  for (const cell of cells) {
    assert.equal(cell.length, 6);
    assert.match(cell, /^[0123456789bcdefghjkmnpqrstuvwxyz]{6}$/);
  }
});

test('eastward neighbors wrap safely across the antimeridian', () => {
  const center = encodeGeohash(0, 179.9999, 6);
  const neighbors = getGeohashNeighbors(center);

  assert.equal(center, 'xbpbpb');
  assert.equal(neighbors.length, 8);
  assert.equal(neighbors[2], '800000');

  for (const neighbor of neighbors) {
    assert.equal(neighbor.length, 6);
    assert.match(neighbor, /^[0123456789bcdefghjkmnpqrstuvwxyz]{6}$/);
  }
});

test('V2 migration adds constrained fields, defaults, and backfills', () => {
  const db = createPreV2Database();

  try {
    db.exec(MIGRATION_SQL);

    const columns = columnNames(db);
    for (const column of V2_COLUMNS) {
      assert.ok(columns.has(column), `migration omitted ${column}`);
    }

    const active = db.prepare(`
      SELECT
        estimated_w2_count,
        confidence_score,
        is_hdhp,
        status
      FROM companies
      WHERE company_id = 'active-1'
    `).get();

    assert.equal(active.estimated_w2_count, 42);
    assert.equal(active.confidence_score, 30);
    assert.equal(active.is_hdhp, 0);
    assert.equal(active.status, 'ACTIVE');

    const disqualified = db.prepare(`
      SELECT estimated_w2_count, status
      FROM companies
      WHERE company_id = 'disqualified-1'
    `).get();

    assert.equal(disqualified.estimated_w2_count, 18);
    assert.equal(disqualified.status, 'DISQUALIFIED');

    assert.throws(
      () => db.prepare(`
        UPDATE companies
        SET confidence_score = 101
        WHERE company_id = 'active-1'
      `).run(),
      /CHECK constraint failed/i
    );

    assert.throws(
      () => db.prepare(`
        UPDATE companies
        SET is_hdhp = 2
        WHERE company_id = 'active-1'
      `).run(),
      /CHECK constraint failed/i
    );

    assert.throws(
      () => db.prepare(`
        UPDATE companies
        SET estimated_w2_count = 2.5
        WHERE company_id = 'active-1'
      `).run(),
      /CHECK constraint failed/i
    );

    assert.throws(
      () => db.prepare(`
        UPDATE companies
        SET geohash = '9ytetj'
        WHERE company_id = 'active-1'
      `).run(),
      /CHECK constraint failed/i
    );

    assert.throws(
      () => db.prepare(`
        UPDATE companies
        SET geohash = '9ytetja'
        WHERE company_id = 'active-1'
      `).run(),
      /CHECK constraint failed/i
    );
  } finally {
    db.close();
  }
});

test('fresh schema mirrors all V2 fields and indexes', () => {
  const db = new DatabaseSync(':memory:');

  try {
    db.exec(FRESH_SCHEMA_SQL);

    const columns = columnNames(db);
    for (const column of V2_COLUMNS) {
      assert.ok(columns.has(column), `fresh schema omitted ${column}`);
    }

    const indexes = new Map(
      db.prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
      `).all().map((row) => [row.name, row.sql])
    );

    assert.ok(indexes.has('idx_companies_agent_geohash6'));
    assert.ok(indexes.has('idx_companies_agent_confidence'));

    const spatialSql = String(
      indexes.get('idx_companies_agent_geohash6')
    ).replace(/\s+/g, ' ');

    assert.match(
      spatialSql,
      /SUBSTR\s*\(\s*geohash\s*,\s*1\s*,\s*6\s*\)/i
    );
  } finally {
    db.close();
  }
});

test('nine-cell SQL lookup is tenant-scoped and suppresses terminal statuses', () => {
  const db = createPreV2Database();

  try {
    db.exec(MIGRATION_SQL);

    const centerHash = encodeGeohash(37.2089, -93.2923, 7);
    const cells = getGeohashQueryCells(37.2089, -93.2923, 6);
    const neighborHash = `${cells[1]}0`;

    db.prepare(`
      UPDATE companies
      SET geohash = ?, status = 'ACTIVE'
      WHERE company_id = 'active-1'
    `).run(centerHash);

    db.prepare(`
      UPDATE companies
      SET geohash = ?, status = 'DISQUALIFIED'
      WHERE company_id = 'disqualified-1'
    `).run(centerHash);

    db.prepare(`
      INSERT INTO companies (
        company_id,
        company_name,
        agent_email,
        geohash,
        status
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      'neighbor-active',
      'Neighbor Active',
      AGENT,
      neighborHash,
      'ACTIVE'
    );

    db.prepare(`
      INSERT INTO companies (
        company_id,
        company_name,
        agent_email,
        geohash,
        status
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      'do-not-contact',
      'Do Not Contact',
      AGENT,
      centerHash,
      'DO_NOT_CONTACT'
    );

    db.prepare(`
      INSERT INTO companies (
        company_id,
        company_name,
        agent_email,
        geohash,
        status
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      'other-agent',
      'Other Agent Company',
      'other@example.com',
      centerHash,
      'ACTIVE'
    );

    const sql = `
      SELECT company_id
      FROM companies
      WHERE agent_email = ?
        AND SUBSTR(geohash, 1, 6) IN (?, ?, ?, ?, ?, ?, ?, ?, ?)
        AND status NOT IN ('DISQUALIFIED', 'DO_NOT_CONTACT')
      LIMIT 30
    `;

    const rows = db.prepare(sql).all(AGENT, ...cells);
    const ids = rows.map((row) => row.company_id).sort();

    assert.deepEqual(ids, ['active-1', 'neighbor-active']);

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(AGENT, ...cells)
      .map((row) => row.detail)
      .join('\n');

    assert.match(plan, /idx_companies_agent_geohash6/i);
  } finally {
    db.close();
  }
});