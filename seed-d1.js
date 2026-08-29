#!/usr/bin/env node
/**
 * seed-d1.js — Ingest a Dynamics 365 "Open Leads (Editable)" .xlsx export
 * into the Aflac Field Prospecting Assistant's D1 schema.
 *
 * Usage:
 *   node seed-d1.js                              # reads the default file
 *   node seed-d1.js "path/to/export.xlsx"        # reads a specific file
 *   node seed-d1.js --dry-run                    # prints SQL to stdout only
 *
 * What it does:
 *   1. Reads the first sheet of the .xlsx workbook
 *   2. Maps the 31 D365 columns → D1 `companies` + `contacts` tables
 *   3. Preserves (Do Not Modify) Lead GUID and Row Checksum for CRM sync
 *   4. Converts Excel serial dates → 'YYYY-MM-DD HH:MM:SS' UTC timestamps
 *   5. Generates a .sql file ready for: npm run wrangler -- d1 execute legacy-db --file=seed-output.sql
 *
 * Dependencies: xlsx (devDependency, already installed)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// xlsx ships a CommonJS build; import the ESM wrapper.
import XLSX from 'xlsx';

// ── Configuration ────────────────────────────────────────────────────
const DEFAULT_FILE = 'All Open Leads (Editable) 8-28-2026 6-56-18 PM.xlsx';
const OUTPUT_FILE = 'seed-output.sql';

// ── CLI parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inputFile = args.find((a) => !a.startsWith('--')) || DEFAULT_FILE;
const inputPath = resolve(inputFile);

console.log(`📂 Reading: ${basename(inputPath)}`);
console.log(`   Dry run: ${dryRun ? 'yes (stdout only)' : 'no'}`);

// ── Read workbook ────────────────────────────────────────────────────
let wb;
try {
  const buf = readFileSync(inputPath);
  wb = XLSX.read(buf, { type: 'buffer' });
} catch (err) {
  console.error(`❌ Could not read "${inputFile}": ${err.message}`);
  process.exit(1);
}

const sheetName = wb.SheetNames[0];
console.log(`   Sheet: "${sheetName}" (${wb.SheetNames.length} total)`);

const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
console.log(`   Records: ${rows.length}`);

if (rows.length === 0) {
  console.error('❌ No data rows found in the worksheet.');
  process.exit(1);
}

// ── Excel serial date → 'YYYY-MM-DD HH:MM:SS' UTC ───────────────────
// Excel epoch is 1900-01-01, but it incorrectly treats 1900 as a leap year
// (the Lotus 1-2-3 bug), so the JS epoch offset is 25569 days.
function excelDateToSql(serial) {
  if (serial === null || serial === undefined || serial === '') return null;
  if (typeof serial === 'string') {
    // Already a date string? Pass it through if it parses.
    const parsed = Date.parse(serial);
    if (!Number.isNaN(parsed)) {
      return sqlTimestamp(new Date(parsed));
    }
    return null;
  }
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;

  const MS_PER_DAY = 86400000;
  const EPOCH_OFFSET = 25569; // days between 1900-01-01 and 1970-01-01
  const utcMs = (serial - EPOCH_OFFSET) * MS_PER_DAY;
  return sqlTimestamp(new Date(utcMs));
}

function sqlTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

// ── SQL escaping ─────────────────────────────────────────────────────
// D1 uses SQLite, which escapes single quotes by doubling them.
function sqlStr(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const text = String(value).trim();
  if (!text) return 'NULL';
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlInt(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : 'NULL';
}

function sqlReal(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : 'NULL';
}

function sqlDate(value) {
  const ts = excelDateToSql(value);
  return ts ? `'${ts}'` : 'NULL';
}

// ── Map one D365 row → SQL statements ────────────────────────────────

function mapRow(row) {
  const companyId = randomUUID();
  const contactId = randomUUID();

  // D365 columns → D1 companies table
  const company = {
    company_id: sqlStr(companyId),
    d365_lead_id: sqlStr(row['(Do Not Modify) Lead']),
    d365_checksum: sqlStr(row['(Do Not Modify) Row Checksum']),
    d365_modified_on: sqlDate(row['(Do Not Modify) Modified On']),
    company_name: sqlStr(row['Business Name']),
    street_1: sqlStr(row['Street 1']),
    street_2: sqlStr(row['Street 2']),
    city: sqlStr(row['City']),
    state: sqlStr(row['State']),
    zip_code: sqlStr(row['Zip Code']),
    lat: 'NULL',   // geocoded later or by Mapbox
    long: 'NULL',
    lead_source: sqlStr(row['Lead Source'] || 'Cold Call'),
    rating: sqlStr(row['Rating'] || 'Cold'),
    employees: sqlInt(row['Employees']),
    industry: sqlStr(row['Industry']),
    is_d365_synced: 1,
    created_at: sqlDate(row['Created On']) || `'${sqlTimestamp(new Date())}'`,
  };

  const companyColumns = Object.keys(company).join(', ');
  const companyValues = Object.values(company).join(', ');
  const companyInsert = `INSERT OR IGNORE INTO companies (${companyColumns}) VALUES (${companyValues});`;

  // D365 columns → D1 contacts table (only if we have a name)
  const firstName = (row['First Name'] || '').trim();
  const lastName = (row['Last Name'] || '').trim();
  const hasContact = firstName || lastName;

  let contactInsert = null;
  if (hasContact) {
    const contact = {
      contact_id: sqlStr(contactId),
      company_id: sqlStr(companyId),
      first_name: sqlStr(firstName || null),
      last_name: sqlStr(lastName || null),
      job_title: sqlStr(row['Job Title']),
      phone_number: sqlStr(row['Phone Number']),
      email_address: sqlStr(row['Email Address']),
      is_primary_dm: 1,
    };

    const contactColumns = Object.keys(contact).join(', ');
    const contactValues = Object.values(contact).join(', ');
    contactInsert = `INSERT OR IGNORE INTO contacts (${contactColumns}) VALUES (${contactValues});`;
  }

  return { companyInsert, contactInsert, companyName: row['Business Name'] };
}

// ── Generate all SQL ─────────────────────────────────────────────────

const lines = [
  '-- =================================================================',
  '-- D365 Open Leads → D1 Seed Data',
  `-- Source: ${basename(inputPath)}`,
  `-- Generated: ${new Date().toISOString()}`,
  `-- Records: ${rows.length}`,
  '-- =================================================================',
  ''
];

let companyCount = 0;
let contactCount = 0;
const skipped = [];

for (const row of rows) {
  const name = row['Business Name'];
  if (!name || !String(name).trim()) {
    skipped.push(row['(Do Not Modify) Lead'] || '(no GUID)');
    continue;
  }

  const { companyInsert, contactInsert } = mapRow(row);
  lines.push(companyInsert);
  companyCount++;

  if (contactInsert) {
    lines.push(contactInsert);
    contactCount++;
  }
}



const sql = lines.join('\n');

// ── Output ───────────────────────────────────────────────────────────

if (dryRun) {
  // Print first 60 lines to avoid flooding the terminal
  const preview = sql.split('\n').slice(0, 60);
  console.log('\n' + preview.join('\n'));
  console.log(`\n... (${lines.length - 60} more lines)`);
} else {
  const outputPath = resolve(OUTPUT_FILE);
  writeFileSync(outputPath, sql, 'utf-8');
  console.log(`\n✅ Written: ${OUTPUT_FILE}`);
}

console.log(`\n📊 Summary:`);
console.log(`   Companies: ${companyCount}`);
console.log(`   Contacts:  ${contactCount}`);
if (skipped.length > 0) {
  console.log(`   Skipped (no Business Name): ${skipped.length}`);
  skipped.forEach((id) => console.log(`     - ${id}`));
}

console.log(`\n🚀 Next steps:`);
console.log(`   1. Review:  code ${OUTPUT_FILE}`);
console.log(`   2. Remote:  npm run wrangler -- d1 execute legacy-db --remote --file=${OUTPUT_FILE}`);
console.log(`   3. Verify:  npm run wrangler -- d1 execute legacy-db --remote --command="SELECT COUNT(*) FROM companies"`);
