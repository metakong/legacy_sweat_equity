#!/usr/bin/env node
/**
 * geocode-db-sync.js — database-native coordinate backfill for production D1.
 *
 * WHY THIS REPLACED geocode-backfill.js
 * The retired script was Excel-driven: it read an "All Open Leads (Editable)
 * ... .xlsx" export from disk and keyed its UPDATEs on `d365_lead_id`. The
 * spreadsheet is ignored by git (*.xlsx), so the script could not run from a
 * clean checkout at all, and it could not address rows the export did not
 * contain. This one is driven by the database: it consumes the Wrangler --json
 * dump and keys on `company_id`, the only column that identifies a row exactly
 * (the PK is company_id + agent_email, so one company_name can legitimately
 * appear more than once under different tenants).
 *
 * WHY IT IS TWO STEPS RATHER THAN ONE
 * D1 has no external socket interface, so a local process cannot connect to it.
 * The fetch therefore stays a visible shell command and this script is a pure
 * text transformation that cannot touch the database on its own:
 *
 *   1. Dump the rows that need coordinates
 *        node ./node_modules/wrangler/bin/wrangler.js d1 execute legacy-db \
 *          --remote --json \
 *          --command="SELECT company_id, company_name, street_1, city, state, zip_code
 *                     FROM companies WHERE lat IS NULL OR long IS NULL" \
 *          > temp-prod-rows.json
 *
 *   2. Generate the updates, review them, then apply them
 *        node scripts/geocode-db-sync.js
 *        npm run wrangler -- d1 execute legacy-db --remote --file=geocode-updates.sql
 *
 * The generated file is inert until Wrangler executes it, and the statement
 * count is printed so a surprising result is caught before it is applied.
 *
 * USAGE
 *   node scripts/geocode-db-sync.js [--input=FILE] [--output=FILE] [--self-test]
 *
 * The geocoding call is deliberately identical to the Worker's geocodeAddress()
 * in src/lib/ai.js — same Mapbox endpoint, same country/types filter, same
 * 6-decimal rounding — so a coordinate written here is the one a live enrich
 * would have written.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INPUT = 'temp-prod-rows.json';
const DEFAULT_OUTPUT = 'geocode-updates.sql';
const TOKEN_FILE = 'mapbox_token.txt';

/** Matches geocodeAddress() in src/lib/ai.js. */
const MAPBOX_TYPES = 'address,poi';
const REQUEST_DELAY_MS = 250;

/**
 * GUARDRAIL 1 — a real street address begins with a house number.
 *
 * Scraped rows put descriptive text in `street_1`: "Springfield Area.",
 * "Hollister Location", "Springfield". Because the geocoder asks for
 * types=address,poi, Mapbox will happily match the BUSINESS NAME instead and
 * return a location anywhere in the country. One real row doing exactly this
 * ("Deluxe Nail and Spa" / "Springfield Area.") resolved to Dayton, Ohio — 300
 * miles away — and the canvass router would then have sent the agent there.
 */
const STREET_ADDRESS = /^\d/;

/**
 * GUARDRAIL 2 — the Springfield metro box, drawn generously on purpose.
 *
 * A plausible-looking street can still resolve three states away, so the result
 * is validated independently of the query. The book is SW Missouri
 * (Springfield, Nixa, Ozark, Republic, Branson, Hollister, Joplin); this box is
 * wide enough that a legitimate customer is never rejected, and far too small to
 * admit an out-of-state hallucination.
 */
const REGION_BOX = { minLat: 36.2, maxLat: 38.2, minLong: -95.0, maxLong: -92.0 };

function inRegion(coords) {
  return coords.lat >= REGION_BOX.minLat && coords.lat <= REGION_BOX.maxLat
    && coords.long >= REGION_BOX.minLong && coords.long <= REGION_BOX.maxLong;
}

function mapboxToken() {
  const fromEnv = process.env.MAPBOX_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  try {
    return fs.readFileSync(path.join(process.cwd(), TOKEN_FILE), 'utf8').trim();
  } catch {
    console.error('MAPBOX_TOKEN is not in the environment and mapbox_token.txt is unreadable.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------
// INPUT
// ---------------------------------------------------------------------

/** Windows PowerShell's `>` writes UTF-16LE; Out-File -Encoding utf8 writes a BOM. */
function readText(file) {
  const buffer = fs.readFileSync(file);

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node cannot decode big-endian UTF-16 directly; swap the byte pairs.
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8');
}

function readRows(file) {
  const raw = readText(file);

  // A `npm run` banner or a BOM can precede the payload, so anything ahead of
  // the first bracket is discarded rather than assumed absent.
  const start = raw.indexOf('[');
  if (start === -1) throw new Error('No JSON array found in the Wrangler output.');

  const parsed = JSON.parse(raw.slice(start));

  // Shape: [ { results: [...], success: true, meta: {...} } ]
  const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
  if (!Array.isArray(results)) throw new Error('Wrangler output had no results array.');

  return results;
}

// ---------------------------------------------------------------------
// ADDRESSES
// ---------------------------------------------------------------------

/** SQL string literal escaping: one apostrophe in an id would break the UPDATE. */
function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Same defaults the retired Excel script used: a missing city is Springfield, MO. */
function addressOf(row) {
  const street = String(row?.street_1 ?? '').trim();
  if (!street) return null;

  const city = String(row?.city ?? '').trim() || 'Springfield';
  const state = String(row?.state ?? '').trim() || 'MO';
  const zip = String(row?.zip_code ?? '').trim();

  return `${street}, ${city}, ${state}${zip ? ` ${zip}` : ''}`;
}

async function geocode(address, token) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`
    + `?access_token=${token}&country=US&types=${MAPBOX_TYPES}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { coords: null, reason: `http_${res.status}` };

    const data = await res.json();
    const center = data?.features?.[0]?.center;
    if (!Array.isArray(center)) return { coords: null, reason: 'no_feature' };

    const [long, lat] = center;
    if (!Number.isFinite(lat) || !Number.isFinite(long)) return { coords: null, reason: 'bad_center' };

    return { coords: { lat: Math.round(lat * 1e6) / 1e6, long: Math.round(long * 1e6) / 1e6 } };
  } catch (err) {
    return { coords: null, reason: `fetch_${err.name}` };
  }
}

// ---------------------------------------------------------------------
// GUARDRAIL SELF-TEST
// ---------------------------------------------------------------------

/**
 * The two guardrails exist to stop a specific 300-mile failure, and both are
 * pure predicates — so they can be proved at any time without touching the
 * network or the database.
 */
function selfTest() {
  const cases = [
    // [description, predicate, expected]
    ['real house number', STREET_ADDRESS.test('3340 E Cherry St'), true],
    ['real house number, Nixa', STREET_ADDRESS.test('1241 N Kinder St'), true],
    ['scrape placeholder', STREET_ADDRESS.test('Springfield Area.'), false],
    ['city only', STREET_ADDRESS.test('Springfield'), false],
    ['service-area note', STREET_ADDRESS.test('Hollister Location'), false],
    ['empty', STREET_ADDRESS.test(''), false],
    ['Springfield sample accepted', inRegion({ lat: 37.208957, long: -93.292298 }), true],
    ['Branson accepted', inRegion({ lat: 36.6437, long: -93.2185 }), true],
    ['Joplin accepted', inRegion({ lat: 37.0842, long: -94.5133 }), true],
    // The actual regression: "Deluxe Nail and Spa" / "Springfield Area."
    ['Dayton OH rejected', inRegion({ lat: 39.771964, long: -84.149968 }), false],
    ['Denver rejected', inRegion({ lat: 39.7392, long: -104.9903 }), false],
    ['Gulf of Guinea (0,0) rejected', inRegion({ lat: 0, long: 0 }), false]
  ];

  let failed = 0;
  for (const [label, actual, expected] of cases) {
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (expected ${expected}, got ${actual})`);
  }

  console.log('');
  console.log(failed === 0 ? `All ${cases.length} guardrail assertions passed.` : `${failed} guardrail assertion(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, selfTest: false };

  for (const arg of argv) {
    if (arg === '--self-test') options.selfTest = true;
    else if (arg.startsWith('--input=')) options.input = arg.slice('--input='.length);
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();

  const inputPath = path.resolve(process.cwd(), options.input);
  const outputPath = path.resolve(process.cwd(), options.output);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input dump not found: ${inputPath}`);
    console.error('');
    console.error('Fetch it first (Wrangler -> JSON, then run this):');
    console.error('  node ./node_modules/wrangler/bin/wrangler.js d1 execute legacy-db \\');
    console.error('    --remote --json --command="SELECT company_id, company_name, street_1,');
    console.error('      city, state, zip_code FROM companies WHERE lat IS NULL OR long IS NULL" \\');
    console.error(`    > ${options.input}`);
    process.exit(1);
  }

  const token = mapboxToken();
  const rows = readRows(inputPath);

  // Two independent rejections, counted separately, so the report says WHY a row
  // was skipped instead of lumping every reason into "skipped".
  const geocodable = [];
  const noAddress = [];
  const badAddress = [];

  for (const row of rows) {
    const address = addressOf(row);
    const street = String(row?.street_1 ?? '').trim();

    if (!address || !row?.company_id) noAddress.push(row);
    else if (!STREET_ADDRESS.test(street)) badAddress.push({ row, street });
    else geocodable.push({ row, address });
  }

  // One API call per distinct address; several tenant rows can share a location.
  const uniqueAddresses = [...new Set(geocodable.map((entry) => entry.address))];

  console.log(`Input dump                : ${inputPath}`);
  console.log(`Rows needing coordinates  : ${rows.length}`);
  console.log(`With a real street address: ${geocodable.length}`);
  console.log(`No address at all         : ${noAddress.length}`);
  console.log(`Not an address (guardrail): ${badAddress.length}`);
  for (const entry of badAddress) {
    console.log(`   - rejected: "${entry.street}" (${entry.row.company_name})`);
  }
  console.log(`Distinct addresses        : ${uniqueAddresses.length}`);
  console.log('');

  const cache = new Map();
  let failures = 0;

  // Serial with a small delay: this is a handful of calls, and hammering a
  // geocoder is how a key gets rate-limited halfway through a backfill.
  for (const address of uniqueAddresses) {
    const { coords, reason } = await geocode(address, token);
    if (coords) cache.set(address, coords);
    else {
      failures += 1;
      console.log(`   - no result (${reason}): ${address}`);
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  const statements = [];
  const outOfRegion = [];

  for (const { row, address } of geocodable) {
    const coords = cache.get(address);
    if (!coords) continue;

    // A plausible-looking street can still resolve three states away.
    if (!inRegion(coords)) {
      outOfRegion.push({ row, address, coords });
      continue;
    }

    statements.push(
      `UPDATE companies SET lat = ${coords.lat}, long = ${coords.long} WHERE company_id = ${sqlLiteral(row.company_id)};`
    );
  }

  const header = [
    '-- Generated by scripts/geocode-db-sync.js — do not commit.',
    `-- ${statements.length} rows resolved from ${uniqueAddresses.length} distinct addresses.`,
    `-- Apply with: npm run wrangler -- d1 execute legacy-db --remote --file=${options.output}`,
    ''
  ].join('\n');

  fs.writeFileSync(outputPath, `${header}${statements.join('\n')}\n`, 'utf8');

  console.log('');
  console.log(`Geocode calls succeeded   : ${cache.size}`);
  console.log(`Geocode calls failed      : ${failures}`);
  console.log(`Rejected, outside region  : ${outOfRegion.length}`);
  for (const entry of outOfRegion) {
    console.log(`   - ${entry.coords.lat},${entry.coords.long} <- "${entry.address}" (${entry.row.company_name})`);
  }
  console.log(`Rows resolved to coords   : ${statements.length}`);
  console.log(`Rows still unroutable     : ${noAddress.length + badAddress.length + outOfRegion.length}`);
  console.log(`Output                    : ${outputPath}`);
  console.log('');
  console.log('Review the statements, then apply them:');
  console.log(`  npm run wrangler -- d1 execute legacy-db --remote --file=${options.output}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

