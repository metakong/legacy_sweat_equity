#!/usr/bin/env node
/**
 * backfill-geohashes.cjs — one-time Geohash backfill for accounts that
 * predate the V2 schema.
 *
 * Migrations/0004_v2_agency_os.sql deliberately does NOT derive hashes from
 * existing coordinates: a migration that computes values in SQL would need a
 * second implementation of the encoder, and two encoders that disagree file
 * accounts into cells the radar never queries. This script imports the SAME
 * `encodeGeohash` the Worker uses, so a backfilled row is byte-identical to a
 * row written by the application.
 *
 * Until this runs, every pre-V2 account is invisible to field radar: the
 * indexed lookup matches on `SUBSTR(geohash, 1, 6)`, and NULL never matches.
 *
 * USAGE
 *   node scripts/backfill-geohashes.cjs                        (.local_db.sqlite)
 *   node scripts/backfill-geohashes.cjs path\to\db.sqlite
 *
 * Local only. There is no remote mode on purpose: production backfill is a
 * wrangler d1 execute concern with its own review step.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = path.join(__dirname, '..', '.local_db.sqlite');

async function main() {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB;

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error('Pass an explicit path: node scripts/backfill-geohashes.cjs <path-to.sqlite>');
    process.exitCode = 1;
    return;
  }

  const { encodeGeohash } = await import('../src/lib/geo.js');
  const db = new DatabaseSync(dbPath);

  try {
    const columns = new Set(
      db.prepare(`SELECT name FROM pragma_table_info('companies')`).all().map((row) => row.name)
    );

    if (!columns.has('geohash')) {
      console.error('companies.geohash does not exist.');
      console.error('Apply migrations/0004_v2_agency_os.sql first, then re-run this script.');
      process.exitCode = 1;
      return;
    }

    const rows = db.prepare(`
      SELECT company_id, agent_email, lat, long
      FROM companies
      WHERE lat IS NOT NULL
        AND long IS NOT NULL
        AND geohash IS NULL
    `).all();

    console.log(`Geohash backfill — ${dbPath}`);
    console.log(`  Candidate rows: ${rows.length}`);

    if (rows.length === 0) {
      console.log('  Nothing to do.');
      return;
    }

    const update = db.prepare(`
      UPDATE companies SET geohash = ?
      WHERE company_id = ? AND agent_email = ?
    `);

    let updated = 0;
    let skipped = 0;

    // One transaction: a partial backfill leaves the radar half-populated,
    // which is harder to reason about than none at all.
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const lat = Number(row.lat);
        const long = Number(row.long);

        if (
          !Number.isFinite(lat) || !Number.isFinite(long)
          || lat < -90 || lat > 90
          || long < -180 || long > 180
        ) {
          skipped += 1;
          console.warn(`  skipped ${row.company_id}: unusable coordinates (${row.lat}, ${row.long})`);
          continue;
        }

        update.run(encodeGeohash(lat, long, 7), row.company_id, row.agent_email);
        updated += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    console.log(`Backfilled ${updated} row(s); skipped ${skipped}.`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});
