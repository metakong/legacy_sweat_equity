/**
 * The D365 projection layer is browser code, but it is pure — no DOM access at
 * module scope — so it can be imported and tested directly in Node.
 *
 * These are the tests that matter most commercially: a misaligned column here
 * silently writes a phone number into the Industry field of a real CRM.
 *
 * The expected column order is the actual Aflac "Open Leads" export sequence
 * supplied by the agent on 2026-08-29. It is pinned here on purpose — if
 * someone reorders the array, this fails loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  D365_OPEN_LEADS_COLUMNS,
  D365_TIER2_KEY_COLUMNS,
  AGENT_PROFILE,
  buildDescription,
  toTabDelimitedRow,
  toTabDelimited,
  toCsv,
  toMatrix,
  localStamp,
  parseNotes
} from '../public/app/d365.js';

/** The authoritative view order, exactly as exported from the CRM. */
const EXPECTED_COLUMNS = [
  '(Do Not Modify) Lead',
  '(Do Not Modify) Row Checksum',
  '(Do Not Modify) Modified On',
  'Created On',
  'Last Activity',
  'Business Name',
  'Lead Source',
  'First Name',
  'Last Name',
  'Lead Owner',
  'DSC User (Owning Team) (Team)',
  'Rating',
  'Phone Number',
  'Email Address',
  'Job Title',
  'Updated DM Presentation Date',
  'Employees',
  'Industry',
  'IR Number',
  'SIC Code',
  'Updated Enrollment Date',
  'Account Number',
  'Agent Projected AP',
  'Post Enrollment Date',
  'Street 1',
  'Street 2',
  'City',
  'State',
  'Zip Code',
  'Market (Owning Team) (Team)',
  'RSC User (Owning Team) (Team)'
];

const sampleRow = {
  log_id: 'log-1',
  company_id: 'co-1',
  company_name: "O'Brien & Sons Machining",
  street_1: '1235 E Sunshine St',
  street_2: 'Suite 200',
  city: 'Springfield',
  state: 'MO',
  zip_code: '65804',
  lead_source: 'Cold Call',
  rating: 'Hot',
  employees: 42,
  industry: 'Manufacturing',
  d365_lead_id: '{8F2A1C44-9B21-4E77-A9D2-77C1E4B03A19}',
  d365_checksum: 'wCg9E1oJ2rB7',
  d365_modified_on: '2026-08-27T19:41:08Z',
  company_created_at: '2026-08-20 14:02:00',
  first_name: 'Dana',
  last_name: 'Reed',
  job_title: 'HR Director',
  phone_number: '417-555-0182',
  email_address: 'dana@example.com',
  timestamp: '2026-08-29 16:35:00',
  disposition: 'Presentation Scheduled',
  is_in_person: 1,
  is_initial: 0,
  is_dm_contact: 1,
  presentation_date: '2026-09-04',
  enrollment_date: null,
  projected_ap: 4800,
  raw_audio_transcription: 'Met Dana in the front office.',
  ai_structured_notes: JSON.stringify({
    summary: 'Met Dana, the HR Director.',
    objections: ['Budget is set until Q1'],
    next_action: 'Send the Section 125 one-pager',
    next_action_date: '2026-08-31',
    key_facts: ['42 W-2 employees']
  })
};

const headerIndex = (name) => D365_OPEN_LEADS_COLUMNS.findIndex((c) => c.header === name);
const cellFor = (row, name) => toTabDelimitedRow(row).split('\t')[headerIndex(name)];

// ---------------------------------------------------------------------
// The view contract
// ---------------------------------------------------------------------
test('the column list matches the Aflac Open Leads view exactly', () => {
  assert.deepEqual(D365_OPEN_LEADS_COLUMNS.map((c) => c.header), EXPECTED_COLUMNS);
});

test('the three (Do Not Modify) columns lead the view', () => {
  // Dynamics rejects a re-import whose checksum columns are missing, moved, or
  // edited — this is what makes an update an update instead of a duplicate.
  assert.deepEqual(D365_TIER2_KEY_COLUMNS.map((c) => c.header), [
    '(Do Not Modify) Lead',
    '(Do Not Modify) Row Checksum',
    '(Do Not Modify) Modified On'
  ]);
  assert.equal(D365_TIER2_KEY_COLUMNS[0], D365_OPEN_LEADS_COLUMNS[0], 'derived, not duplicated');
});

test('every column has a getter', () => {
  for (const column of D365_OPEN_LEADS_COLUMNS) {
    assert.equal(typeof column.get, 'function', `${column.header} has no getter`);
  }
});

// ---------------------------------------------------------------------
// Column alignment — the expensive failure mode
// ---------------------------------------------------------------------
test('a projected row has exactly one cell per column', () => {
  const cells = toTabDelimitedRow(sampleRow).split('\t');
  assert.equal(cells.length, EXPECTED_COLUMNS.length);
});

test('a sparse row still produces every column', () => {
  // Only company_name is guaranteed; everything else can be absent.
  const cells = toTabDelimitedRow({ company_name: 'Bare Co', disposition: 'No Contact' }).split('\t');
  assert.equal(cells.length, EXPECTED_COLUMNS.length);
});

test('an empty row does not throw and still aligns', () => {
  const cells = toTabDelimitedRow({}).split('\t');
  assert.equal(cells.length, EXPECTED_COLUMNS.length);
});

test('values land under the right headers', () => {
  assert.equal(cellFor(sampleRow, '(Do Not Modify) Lead'), sampleRow.d365_lead_id);
  assert.equal(cellFor(sampleRow, '(Do Not Modify) Row Checksum'), 'wCg9E1oJ2rB7');
  assert.equal(cellFor(sampleRow, 'Business Name'), "O'Brien & Sons Machining");
  assert.equal(cellFor(sampleRow, 'First Name'), 'Dana');
  assert.equal(cellFor(sampleRow, 'Last Name'), 'Reed');
  assert.equal(cellFor(sampleRow, 'Job Title'), 'HR Director');
  assert.equal(cellFor(sampleRow, 'Phone Number'), '417-555-0182');
  assert.equal(cellFor(sampleRow, 'Email Address'), 'dana@example.com');
  assert.equal(cellFor(sampleRow, 'Street 1'), '1235 E Sunshine St');
  assert.equal(cellFor(sampleRow, 'Street 2'), 'Suite 200');
  assert.equal(cellFor(sampleRow, 'City'), 'Springfield');
  assert.equal(cellFor(sampleRow, 'State'), 'MO');
  assert.equal(cellFor(sampleRow, 'Zip Code'), '65804');
  assert.equal(cellFor(sampleRow, 'Lead Source'), 'Cold Call');
  assert.equal(cellFor(sampleRow, 'Rating'), 'Hot');
  assert.equal(cellFor(sampleRow, 'Employees'), '42');
  assert.equal(cellFor(sampleRow, 'Industry'), 'Manufacturing');
  assert.equal(cellFor(sampleRow, 'Agent Projected AP'), '4800');
  assert.equal(cellFor(sampleRow, 'Updated DM Presentation Date'), '2026-09-04');
});

test('the two date columns are distinct: lead creation vs last touch', () => {
  // Collapsing these would date every lead to the day of its most recent call.
  assert.equal(cellFor(sampleRow, 'Created On'), '2026-08-20 09:02');
  assert.equal(cellFor(sampleRow, 'Last Activity'), '2026-08-29 11:35');
});

test('Created On falls back to the touch when the company date is absent', () => {
  const noCompanyDate = { ...sampleRow, company_created_at: undefined };
  assert.equal(cellFor(noCompanyDate, 'Created On'), '2026-08-29 11:35');
});

test('apostrophes and ampersands survive the projection intact', () => {
  // Regression: escaping on write corrupted these before they ever reached a
  // clipboard. Validate on write, escape on output.
  assert.ok(toTabDelimitedRow(sampleRow).includes("O'Brien & Sons Machining"));
});

// ---------------------------------------------------------------------
// Agent constants and unsourced columns
// ---------------------------------------------------------------------
test('the configured agent profile lands in every ownership column', () => {
  // These route the lead to the right team the moment it hits Dynamics; a
  // silent typo here misroutes every record the app ever produces.
  assert.equal(cellFor(sampleRow, 'Lead Owner'), 'SEAN DEARDORFF (CO-AD1LF-0-L1)');
  assert.equal(cellFor(sampleRow, 'DSC User (Owning Team) (Team)'), 'GINA GRISSOM');
  assert.equal(cellFor(sampleRow, 'RSC User (Owning Team) (Team)'), 'ZACK SMITH');
  assert.equal(cellFor(sampleRow, 'Market (Owning Team) (Team)'), 'MO-W');
});

test('ownership columns are agent constants, not prospect data', () => {
  // They must be identical across every row regardless of the record, and must
  // survive a row that carries no company data at all.
  assert.equal(cellFor({}, 'Lead Owner'), 'SEAN DEARDORFF (CO-AD1LF-0-L1)');
  assert.equal(cellFor({}, 'Market (Owning Team) (Team)'), 'MO-W');
});

test('IR Number is deliberately blank until the writing number is supplied', () => {
  assert.equal(AGENT_PROFILE.IR_NUMBER, '');
  assert.equal(cellFor(sampleRow, 'IR Number'), '');
});

test('the agent profile reaches the Tier 2 .xlsx matrix, not just the clipboard', () => {
  const [headers, row] = toMatrix([sampleRow], D365_OPEN_LEADS_COLUMNS);
  assert.equal(row[headers.indexOf('Lead Owner')], 'SEAN DEARDORFF (CO-AD1LF-0-L1)');
  assert.equal(row[headers.indexOf('DSC User (Owning Team) (Team)')], 'GINA GRISSOM');
  assert.equal(row[headers.indexOf('RSC User (Owning Team) (Team)')], 'ZACK SMITH');
  assert.equal(row[headers.indexOf('Market (Owning Team) (Team)')], 'MO-W');
});

test('the agent profile reaches the Tier 3 .csv export', () => {
  const csv = toCsv([sampleRow]);
  const [headerLine, dataLine] = csv.split('\r\n');
  const idx = headerLine.split(',').indexOf('Lead Owner');
  // The value contains parentheses but no comma, so it stays unquoted.
  assert.equal(dataLine.split(',')[idx], 'SEAN DEARDORFF (CO-AD1LF-0-L1)');
});

test('columns with no data source export blank rather than a guess', () => {
  for (const header of ['SIC Code', 'Account Number', 'Post Enrollment Date']) {
    assert.equal(cellFor(sampleRow, header), '', `${header} should be blank`);
  }
});

test('unsourced columns populate automatically if the field is ever added', () => {
  // `passthrough` reads row.<field> first, so extending D1 needs no change here.
  const enriched = { ...sampleRow, sic_code: '3599', account_number: 'ACCT-4471' };
  assert.equal(cellFor(enriched, 'SIC Code'), '3599');
  assert.equal(cellFor(enriched, 'Account Number'), 'ACCT-4471');
});

// ---------------------------------------------------------------------
// Delimiter safety
// ---------------------------------------------------------------------
test('embedded tabs and newlines are flattened out of TSV cells', () => {
  // A tab inside a cell terminates it on paste and shifts every later column;
  // a newline terminates the whole row.
  const dirty = { ...sampleRow, company_name: 'Tab\tCo', job_title: 'Line one\nLine two' };
  const tsv = toTabDelimitedRow(dirty);
  assert.equal(tsv.split('\t').length, EXPECTED_COLUMNS.length);
  assert.ok(!tsv.includes('\n'), 'no newline may survive inside a row');
  assert.ok(tsv.includes('Tab Co'), 'the tab becomes a space rather than a column break');
});

test('multi-row TSV emits one line per row and no headers by default', () => {
  const tsv = toTabDelimited([sampleRow, sampleRow]);
  assert.equal(tsv.split('\n').length, 2);

  const withHeaders = toTabDelimited([sampleRow], { includeHeaders: true });
  const lines = withHeaders.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].split('\t')[0], '(Do Not Modify) Lead');
});

// ---------------------------------------------------------------------
// CSV (Tier 3 — the D365 Import Data wizard)
// ---------------------------------------------------------------------
test('CSV quotes commas, quotes and newlines per RFC 4180', () => {
  const dirty = {
    ...sampleRow,
    company_name: 'Reed, Dana & Co',
    job_title: 'The "Boss"',
    street_1: 'Line one\nLine two'
  };
  const [, dataLine] = toCsv([dirty]).split('\r\n');
  assert.ok(dataLine.includes('"Reed, Dana & Co"'));
  assert.ok(dataLine.includes('"The ""Boss"""'), 'inner quotes are doubled');
  assert.ok(dataLine.includes('"Line one\nLine two"'), 'a newline is legal inside quotes');
});

test('CSV uses CRLF and leads with the header row', () => {
  const csv = toCsv([sampleRow]);
  assert.ok(csv.includes('\r\n'));
  assert.equal(csv.split('\r\n')[0].split(',')[0], '(Do Not Modify) Lead');
});

test('a Tier 3 net-new row leaves the checksum columns empty', () => {
  // Net-new leads have no Dynamics identity; blanks are what the Import Data
  // wizard expects, and a fabricated checksum would fail validation.
  const netNew = {
    ...sampleRow, d365_lead_id: null, d365_checksum: null, d365_modified_on: null
  };
  const [, dataLine] = toCsv([netNew]).split('\r\n');
  assert.ok(dataLine.startsWith(',,,'), 'first three cells are empty');
});

// ---------------------------------------------------------------------
// Tier 2 — the checksum round trip
// ---------------------------------------------------------------------
test('the Tier 2 matrix round-trips the D365 identity byte for byte', () => {
  const [headers, row] = toMatrix([sampleRow], D365_OPEN_LEADS_COLUMNS);

  assert.equal(headers[0], '(Do Not Modify) Lead');
  assert.equal(row[0], sampleRow.d365_lead_id);
  assert.equal(row[1], sampleRow.d365_checksum);
  assert.equal(row[2], sampleRow.d365_modified_on);
  assert.equal(row.length, EXPECTED_COLUMNS.length);
  assert.equal(headers.length, EXPECTED_COLUMNS.length);
});

test('the Tier 2 matrix keeps numbers as numbers for Excel', () => {
  const [headers, row] = toMatrix([sampleRow], D365_OPEN_LEADS_COLUMNS);
  assert.equal(typeof row[headers.indexOf('Employees')], 'number');
  assert.equal(typeof row[headers.indexOf('Agent Projected AP')], 'number');
});

// ---------------------------------------------------------------------
// Voice-journal notes
// ---------------------------------------------------------------------
test('the Open Leads view has no destination for the voice journal', () => {
  // Documenting a known gap, not asserting it is desirable: this view carries
  // no Description/Notes column, so AI notes stay in the app. buildDescription
  // is kept ready to splice in if a notes column is ever added.
  const headers = D365_OPEN_LEADS_COLUMNS.map((c) => c.header);
  assert.ok(!headers.includes('Description'));
  assert.ok(!headers.includes('Notes'));
});

test('buildDescription still composes a complete note block', () => {
  const description = buildDescription(sampleRow);
  assert.ok(description.includes('Met Dana, the HR Director.'));
  assert.ok(description.includes('Objections: Budget is set until Q1'));
  assert.ok(description.includes('Next: Send the Section 125 one-pager (2026-08-31)'));
  assert.ok(description.includes('Facts: 42 W-2 employees'));
  assert.ok(description.includes('[In person · Follow-up · DM reached]'));
});

test('buildDescription falls back to the raw transcript when the AI pass degraded', () => {
  const degraded = { ...sampleRow, ai_structured_notes: null };
  const description = buildDescription(degraded);
  assert.ok(description.includes('Met Dana in the front office.'));
});

test('buildDescription still records the touch when there is no note at all', () => {
  const silent = { ...sampleRow, ai_structured_notes: null, raw_audio_transcription: null };
  assert.equal(buildDescription(silent), '[In person · Follow-up · DM reached]');
});

test('parseNotes tolerates JSON, plain text, and nothing', () => {
  assert.deepEqual(parseNotes('{"summary":"ok"}'), { summary: 'ok' });
  assert.deepEqual(parseNotes('just a sentence'), { summary: 'just a sentence' });
  assert.deepEqual(parseNotes(null), {});
  assert.deepEqual(parseNotes({ summary: 'obj' }), { summary: 'obj' });
});

// ---------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------
test('dates are Springfield local time, not UTC', () => {
  // 16:35 UTC is 11:35 in Springfield. Pasting the UTC value would put every
  // evening activity on the following day in D365.
  assert.equal(cellFor(sampleRow, 'Last Activity'), '2026-08-29 11:35');
});

test('localStamp handles both stored formats and rejects junk', () => {
  assert.equal(localStamp('2026-08-29 16:35:00'), '2026-08-29 11:35');
  assert.equal(localStamp('2026-08-29T16:35:00.000Z'), '2026-08-29 11:35');
  assert.equal(localStamp('2026-07-22 05:00:00'), '2026-07-22 00:00');
  assert.equal(localStamp(''), '');
  assert.equal(localStamp('nonsense'), '');
});

test('enrollment and presentation dates stay in separate columns', () => {
  // They are distinct milestones in this view; collapsing them into one
  // "close date" would lose the pipeline stage.
  const enrolled = { ...sampleRow, enrollment_date: '2026-10-01' };
  assert.equal(cellFor(enrolled, 'Updated DM Presentation Date'), '2026-09-04');
  assert.equal(cellFor(enrolled, 'Updated Enrollment Date'), '2026-10-01');
  assert.equal(cellFor(sampleRow, 'Updated Enrollment Date'), '');
});
