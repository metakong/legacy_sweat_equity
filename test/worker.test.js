/**
 * Zero-dependency tests for the Worker's validation, CRM enum, and timezone
 * logic. Run with: npm test   (node --test, built in — no packages)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanText,
  cleanCapped,
  matchEnum,
  toBool,
  asId,
  asIsoDate,
  asMoney,
  asCount,
  deriveDisposition,
  parseJsonLoose,
  likePattern,
  RATINGS,
  DISPOSITIONS,
  LEAD_SOURCES,
  PIPELINE_STAGES,
  STAGE_RANKS
} from '../src/lib/validate.js';

import {
  businessDate,
  businessDayRangeUtc,
  toSqlTimestamp,
  toLocalStamp,
  localHourOf
} from '../src/lib/time.js';

import {
  normalizeCompany,
  normalizeActivityLog,
  normalizeContact,
  calculateRenewalDate,
  inferTargetPipelineStage,
  autoAdvancePipelineStage,
  transitionPipelineStage,
  snoozeCompany,
  ValidationError
} from '../src/lib/db.js';
import { computeMetrics, fallbackReport } from '../src/routes/eod.js';
import { computeTelemetry, app } from '../src/index.js';

// Built from char codes so the literals below never contain a raw control byte.
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);
const C1 = String.fromCharCode(159);

// ---------------------------------------------------------------------
// cleanText — input normalization
// ---------------------------------------------------------------------
test('cleanText preserves characters that HTML-escaping used to corrupt', () => {
  // Regression: escape-on-write turned these into &#039; / &amp; in the CRM
  // clipboard handoff and in the LLM prompt.
  assert.equal(cleanText("O'Brien"), "O'Brien");
  assert.equal(cleanText('Smith & Sons'), 'Smith & Sons');
  assert.equal(cleanText('4 < 5 > 3'), '4 < 5 > 3');
  assert.equal(cleanText('say "hi"'), 'say "hi"');
});

test('cleanText keeps hyphens in company names and addresses', () => {
  // Regression: a bare '-' at the end of a character class is a literal
  // hyphen, which silently ate address punctuation.
  assert.equal(cleanText('Mercy-Springfield Rt 66-B'), 'Mercy-Springfield Rt 66-B');
  assert.equal(cleanText('1235 E Sunshine St-A'), '1235 E Sunshine St-A');
});

test('cleanText strips control characters', () => {
  assert.equal(cleanText(`bad${NUL}key`), 'badkey');
  assert.equal(cleanText(`bell${BEL}char`), 'bellchar');
  assert.equal(cleanText(`del${DEL}char`), 'delchar');
  assert.equal(cleanText(`c1${C1}char`), 'c1char');
});

test('cleanText keeps newlines only for transcripts', () => {
  assert.equal(cleanText('line1\nline2'), 'line1line2');
  assert.equal(cleanText('line1\nline2', { allowNewlines: true }), 'line1\nline2');
  assert.equal(cleanText('a\r\nb', { allowNewlines: true }), 'a\r\nb');
});

test('cleanText returns null for empty and non-string input', () => {
  for (const value of ['   ', '', undefined, null, 42, { a: 1 }, ['x']]) {
    assert.equal(cleanText(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test('cleanCapped truncates rather than rejecting', () => {
  assert.equal(cleanCapped('abcdef', 3), 'abc');
  assert.equal(cleanCapped('  ab  ', 10), 'ab');
  assert.equal(cleanCapped('', 10), null);
});

// ---------------------------------------------------------------------
// CRM enums
// ---------------------------------------------------------------------
test('matchEnum canonicalises case and rejects anything off the option set', () => {
  assert.equal(matchEnum('hot', RATINGS), 'Hot');
  assert.equal(matchEnum('  COLD ', RATINGS), 'Cold');
  assert.equal(matchEnum('lukewarm', RATINGS), null);
  assert.equal(matchEnum('walk-in', LEAD_SOURCES), 'Walk-In');
  assert.equal(matchEnum('presentation scheduled', DISPOSITIONS), 'Presentation Scheduled');
  assert.equal(matchEnum(null, RATINGS), null);
});

test('toBool accepts the shapes FormData, IndexedDB and D1 each produce', () => {
  for (const truthy of [true, 1, '1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(toBool(truthy), 1, `expected 1 for ${JSON.stringify(truthy)}`);
  }
  for (const falsy of [false, 0, '0', 'false', 'no', 'off']) {
    assert.equal(toBool(falsy), 0, `expected 0 for ${JSON.stringify(falsy)}`);
  }
  assert.equal(toBool(undefined), 0);
  assert.equal(toBool('garbage', 1), 1, 'unknown values fall back');
});

test('asId rejects anything unsafe to use as an R2 object key', () => {
  assert.equal(asId('demo-123_ABC.x'), 'demo-123_ABC.x');
  assert.equal(asId('../../etc/passwd'), null);
  assert.equal(asId('has space'), null);
  assert.equal(asId('a'.repeat(65)), null);
  assert.equal(asId(''), null);
});

test('asIsoDate accepts only YYYY-MM-DD', () => {
  assert.equal(asIsoDate('2026-09-04'), '2026-09-04');
  assert.equal(asIsoDate('09/04/2026'), null);
  assert.equal(asIsoDate('2026-13-45'), null);
  assert.equal(asIsoDate('next Tuesday'), null);
});

test('asMoney parses spoken/typed currency and refuses nonsense', () => {
  assert.equal(asMoney('$4,800.00'), 4800);
  assert.equal(asMoney(12600), 12600);
  assert.equal(asMoney('1234.567'), 1234.57);
  assert.equal(asMoney('abc'), null);
  assert.equal(asMoney(-5), null);
  assert.equal(asMoney(Infinity), null);
});

test('asCount takes whole headcounts only', () => {
  assert.equal(asCount(210), 210);
  assert.equal(asCount(0), 0);
  assert.equal(asCount(12.5), null);
  assert.equal(asCount(-3), null);
});

test('likePattern escapes LIKE metacharacters', () => {
  // Without this a typed '%' turns a prefix scan into a full table scan.
  assert.equal(likePattern('50%'), '%50\\%%');
  assert.equal(likePattern('a_b'), '%a\\_b%');
  assert.equal(likePattern('ozark'), '%ozark%');
});

// ---------------------------------------------------------------------
// 3-Tap Binary -> disposition
// ---------------------------------------------------------------------
test('deriveDisposition covers all eight binary combinations', () => {
  const d = (inPerson, initial, dm) => deriveDisposition({
    is_in_person: inPerson, is_initial: initial, is_dm_contact: dm
  });

  // No decision maker reached — the channel decides the wording.
  assert.equal(d(1, 1, 0), 'Gatekeeper Blocked');
  assert.equal(d(1, 0, 0), 'Gatekeeper Blocked');
  assert.equal(d(0, 1, 0), 'No Contact');
  assert.equal(d(0, 0, 0), 'No Contact');

  // Decision maker reached — the touch type decides.
  assert.equal(d(1, 1, 1), 'Information Left');
  assert.equal(d(0, 1, 1), 'Information Left');
  assert.equal(d(1, 0, 1), 'Follow-Up Scheduled');
  assert.equal(d(0, 0, 1), 'Follow-Up Scheduled');
});

test('deriveDisposition always returns a valid CRM option', () => {
  for (const inPerson of [0, 1]) {
    for (const initial of [0, 1]) {
      for (const dm of [0, 1]) {
        const result = deriveDisposition({ is_in_person: inPerson, is_initial: initial, is_dm_contact: dm });
        assert.ok(DISPOSITIONS.includes(result), `${result} is not a valid disposition`);
      }
    }
  }
});

test('deriveDisposition coerces string booleans from FormData', () => {
  assert.equal(
    deriveDisposition({ is_in_person: 'true', is_initial: 'false', is_dm_contact: '1' }),
    'Follow-Up Scheduled'
  );
});

// ---------------------------------------------------------------------
// Model output parsing
// ---------------------------------------------------------------------
test('parseJsonLoose survives fenced and prefixed model output', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":1} hope that helps'), { a: 1 });
  assert.equal(parseJsonLoose('not json at all'), null);
  assert.equal(parseJsonLoose(null), null);
});

// ---------------------------------------------------------------------
// Business-day / timezone logic
// ---------------------------------------------------------------------
test('nightly cron at 02:00 UTC targets the Springfield workday that just ended', () => {
  // At 02:00 UTC on the 22nd it is still 21:00 on the 21st in Springfield, so
  // a UTC-derived date would analyze a window missing the whole workday.
  const cronFire = new Date('2026-07-22T02:00:00Z');
  assert.equal(businessDate(cronFire), '2026-07-21');

  const { start, end } = businessDayRangeUtc(businessDate(cronFire));
  assert.equal(start, '2026-07-21 05:00:00');
  assert.equal(end, '2026-07-22 05:00:00');
});

test('business day range covers a full local day in both CST and CDT', () => {
  const summer = businessDayRangeUtc('2026-07-15'); // CDT, UTC-5
  assert.equal(summer.start, '2026-07-15 05:00:00');
  assert.equal(summer.end, '2026-07-16 05:00:00');

  const winter = businessDayRangeUtc('2026-01-15'); // CST, UTC-6
  assert.equal(winter.start, '2026-01-15 06:00:00');
  assert.equal(winter.end, '2026-01-16 06:00:00');
});

test('business day range handles DST transition days', () => {
  const hours = ({ start, end }) => (
    Date.parse(`${end.replace(' ', 'T')}Z`) - Date.parse(`${start.replace(' ', 'T')}Z`)
  ) / 3600000;

  assert.equal(hours(businessDayRangeUtc('2026-03-08')), 23, 'spring forward is a 23-hour day');
  assert.equal(hours(businessDayRangeUtc('2026-11-01')), 25, 'fall back is a 25-hour day');
});

test('an evening activity falls inside that Springfield business day', () => {
  // 19:00 CDT on the 21st is 00:00 UTC on the 22nd — the exact case a
  // UTC-based query drops.
  const { start, end } = businessDayRangeUtc('2026-07-21');
  const touch = '2026-07-22 00:00:00'; // stored by SQLite datetime('now')
  assert.ok(touch >= start && touch < end);
});

test('toSqlTimestamp normalises client ISO stamps into D1 format', () => {
  // Critical: every date filter is a lexicographic string comparison. An ISO
  // string stored verbatim sorts ABOVE the D1 format for the same instant
  // ('T' is 0x54, ' ' is 0x20), silently dropping rows from the daily view.
  assert.equal(toSqlTimestamp('2026-08-29T16:35:57.123Z'), '2026-08-29 16:35:57');
  assert.equal(toSqlTimestamp('2026-08-29 16:35:57'), '2026-08-29 16:35:57');
  assert.equal(toSqlTimestamp('2026-08-29T11:35:57-05:00'), '2026-08-29 16:35:57');
  assert.equal(toSqlTimestamp('garbage'), null);
  assert.equal(toSqlTimestamp(undefined), null);
});

test('a queued ISO timestamp lands in the same business day as the D1 format', () => {
  const { start, end } = businessDayRangeUtc('2026-07-21');
  const queuedOffline = toSqlTimestamp('2026-07-22T00:30:00.000Z'); // 7:30pm local
  assert.ok(queuedOffline >= start && queuedOffline < end);
});

test('toLocalStamp renders Springfield local time for the CRM paste', () => {
  // Pasting a UTC stamp into "Created On" misdates every evening activity.
  assert.equal(toLocalStamp('2026-08-29 16:35:00'), '2026-08-29 11:35');
  assert.equal(toLocalStamp('2026-07-22 00:30:00'), '2026-07-21 19:30');
  assert.equal(toLocalStamp('2026-07-22 05:00:00'), '2026-07-22 00:00', 'midnight is 00, not 24');
  assert.equal(toLocalStamp('nonsense'), '');
});

test('localHourOf reads the hour in Springfield, not UTC', () => {
  assert.equal(localHourOf('2026-07-22 00:30:00'), 19);
  assert.equal(localHourOf('2026-07-21 14:00:00'), 9);
  assert.equal(localHourOf('bad'), null);
});

// ---------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------
test('normalizeCompany requires a name and defaults the CRM option sets', () => {
  assert.throws(() => normalizeCompany({ company_name: '   ' }), ValidationError);

  const company = normalizeCompany({ company_name: 'Ozark Dental Group' });
  assert.equal(company.company_name, 'Ozark Dental Group');
  assert.equal(company.lead_source, null);
  assert.equal(company.rating, null);
  assert.equal(company.is_d365_synced, 0);
  assert.ok(company.company_id.length > 0);
});

test('normalizeCompany refuses to mark a record synced without a D365 identity', () => {
  // A client-set flag with no lead id is how net-new leads silently drop out
  // of the Tier 3 export.
  const lying = normalizeCompany({ company_name: 'X', is_d365_synced: true });
  assert.equal(lying.is_d365_synced, 0);

  const genuine = normalizeCompany({ company_name: 'X', is_d365_synced: true, d365_lead_id: 'LEAD-1' });
  assert.equal(genuine.is_d365_synced, 1);
});

test('normalizeCompany binds only primitives', () => {
  const company = normalizeCompany({
    company_name: 'Test Co',
    lat: 'not-a-number',
    long: { nested: true },
    employees: 'twelve',
    rating: 'scalding'
  });
  for (const [key, value] of Object.entries(company)) {
    assert.ok(
      value === null || typeof value === 'string' || typeof value === 'number',
      `${key} is a ${typeof value} — D1 would throw on bind`
    );
  }
  assert.equal(company.lat, null);
  assert.equal(company.long, null);
  assert.equal(company.employees, null);
  assert.equal(company.rating, null, 'an invalid rating remains null rather than persisting');
});

test('normalizeActivityLog fills a NOT NULL disposition from the binary toggles', () => {
  const log = normalizeActivityLog({
    company_id: 'abc',
    is_in_person: 1,
    is_initial: 1,
    is_dm_contact: 0
  });
  assert.equal(log.disposition, 'Gatekeeper Blocked');
  assert.equal(log.sync_tier_status, 'PENDING');
  assert.ok(DISPOSITIONS.includes(log.disposition));
});

test('normalizeActivityLog prefers a valid explicit disposition over the derived one', () => {
  const log = normalizeActivityLog({
    company_id: 'abc', is_in_person: 1, is_initial: 1, is_dm_contact: 0,
    disposition: 'enrolled'
  });
  assert.equal(log.disposition, 'Enrolled');
});

test('normalizeActivityLog discards a disposition the model invented', () => {
  const log = normalizeActivityLog({
    company_id: 'abc', is_in_person: 0, is_initial: 0, is_dm_contact: 1,
    disposition: 'Extremely Promising'
  });
  assert.equal(log.disposition, 'Follow-Up Scheduled');
});

test('normalizeActivityLog requires a company_id', () => {
  assert.throws(() => normalizeActivityLog({ is_in_person: 1, is_initial: 1, is_dm_contact: 1 }), ValidationError);
});

test('normalizeActivityLog serialises structured notes for storage', () => {
  const log = normalizeActivityLog({
    company_id: 'abc', is_in_person: 1, is_initial: 1, is_dm_contact: 1,
    ai_structured_notes: { summary: 'Met the owner.', objections: ['price'] }
  });
  assert.equal(typeof log.ai_structured_notes, 'string');
  assert.deepEqual(JSON.parse(log.ai_structured_notes).objections, ['price']);
});

test('normalizeContact drops a nameless, titleless record', () => {
  assert.equal(normalizeContact({ phone_number: '417-555-0100' }, 'co-1'), null);
  assert.ok(normalizeContact({ job_title: 'Office Manager' }, 'co-1'));
});

test('normalizeContact keeps only plausible email addresses', () => {
  const good = normalizeContact({ first_name: 'Dana', email_address: 'dana@example.com' }, 'co-1');
  assert.equal(good.email_address, 'dana@example.com');

  // A mis-transcribed address poisons a D365 import more expensively than a
  // blank does.
  const bad = normalizeContact({ first_name: 'Dana', email_address: 'dana at example dot com' }, 'co-1');
  assert.equal(bad.email_address, null);
});

// ---------------------------------------------------------------------
// EOD debrief metrics
//
// These are computed in code rather than by the model on purpose: a debrief
// that misreports the day's numbers is worse than no debrief at all.
// ---------------------------------------------------------------------
const eodRow = (over = {}) => ({
  company_id: 'co-1',
  is_in_person: 1,
  is_initial: 1,
  is_dm_contact: 0,
  disposition: 'Gatekeeper Blocked',
  presentation_date: null,
  enrollment_date: null,
  projected_ap: null,
  ...over
});

test('computeMetrics counts an empty day without dividing by zero', () => {
  const m = computeMetrics([]);
  assert.equal(m.total_doors, 0);
  assert.equal(m.dms_met, 0);
  assert.equal(m.appointments, 0);
  assert.equal(m.dm_contact_rate, '0%');
  assert.equal(m.projected_ap, 0);
});

test('computeMetrics counts doors, DMs and appointments', () => {
  const m = computeMetrics([
    eodRow(),
    eodRow({ is_dm_contact: 1, disposition: 'Information Left' }),
    eodRow({ is_dm_contact: 1, disposition: 'Presentation Scheduled', presentation_date: '2026-09-04' }),
    eodRow({ is_in_person: 0, is_initial: 0, disposition: 'No Contact' })
  ]);
  assert.equal(m.total_doors, 4);
  assert.equal(m.dms_met, 2);
  assert.equal(m.appointments, 1);
  assert.equal(m.in_person, 3);
  assert.equal(m.phone, 1);
  assert.equal(m.initial, 3);
  assert.equal(m.follow_up, 1);
  assert.equal(m.dm_contact_rate, '50%');
});

test('an appointment counts from either the date or the disposition', () => {
  // The AI sets a presentation_date; a manual 3-tap log only sets the
  // disposition. Both are real appointments.
  assert.equal(computeMetrics([eodRow({ presentation_date: '2026-09-04' })]).appointments, 1);
  assert.equal(computeMetrics([eodRow({ disposition: 'Presentation Scheduled' })]).appointments, 1);
  // Counted once, not twice, when both are present.
  assert.equal(
    computeMetrics([eodRow({ disposition: 'Presentation Scheduled', presentation_date: '2026-09-04' })]).appointments,
    1
  );
});

test('computeMetrics counts distinct accounts, not touches', () => {
  const m = computeMetrics([
    eodRow({ company_id: 'a' }),
    eodRow({ company_id: 'a' }),
    eodRow({ company_id: 'b' })
  ]);
  assert.equal(m.total_doors, 3);
  assert.equal(m.accounts, 2);
});

test('computeMetrics sums projected AP and ignores nulls', () => {
  const m = computeMetrics([
    eodRow({ projected_ap: 4800 }),
    eodRow({ projected_ap: 12600.55 }),
    eodRow({ projected_ap: null })
  ]);
  assert.equal(m.projected_ap, 17400.55);
});

test('fallbackReport produces a usable Markdown report with no model', () => {
  // A provider outage must cost the narrative, not the debrief.
  const metrics = computeMetrics([eodRow({ is_dm_contact: 1, disposition: 'Enrolled' })]);
  const report = fallbackReport('2026-08-29', metrics, [
    { company: 'Mercy Occupational Health', disposition: 'Enrolled', contact: 'Yvonne Castillo', next_action: 'Send forms' }
  ]);
  assert.ok(report.includes('| Total Doors | 1 |'));
  assert.ok(report.includes('| DMs Met | 1 |'));
  assert.ok(report.includes('Mercy Occupational Health'));
  assert.ok(report.includes('Yvonne Castillo'));
  assert.ok(report.includes('AI narrative unavailable'));
});

test('calculateRenewalDate projects exactly one year into the future', () => {
  assert.equal(calculateRenewalDate('2026-08-29'), '2027-08-29');
  assert.equal(calculateRenewalDate('2024-02-29'), '2025-02-28');
  assert.equal(calculateRenewalDate(null, '2026-09-15'), '2027-09-15');
});

// ---------------------------------------------------------------------
// D365 Import & Deduplication
// ---------------------------------------------------------------------
test('imported company normalizes with contacts array structure', () => {
  const raw = {
    company_name: 'Ozark Technical College',
    street_1: '1001 E Chestnut Expy',
    city: 'Springfield',
    state: 'MO',
    zip_code: '65802',
    rating: 'Hot',
    employees: 450,
    d365_lead_id: 'LEAD-9988'
  };

  const normalized = normalizeCompany(raw);
  assert.equal(normalized.company_name, 'Ozark Technical College');
  assert.equal(normalized.street_1, '1001 E Chestnut Expy');
  assert.equal(normalized.city, 'Springfield');
  assert.equal(normalized.state, 'MO');
  assert.equal(normalized.zip_code, '65802');
  assert.equal(normalized.rating, 'Hot');
  assert.equal(normalized.employees, 450);
  assert.equal(normalized.d365_lead_id, 'LEAD-9988');

  const contact1 = normalizeContact({ first_name: 'Hal', last_name: 'Higdon', job_title: 'Director' }, normalized.company_id);
  const contact2 = normalizeContact({ first_name: 'Sara', last_name: 'Connor', job_title: 'Benefits Manager' }, normalized.company_id);

  assert.ok(contact1);
  assert.ok(contact2);
  assert.equal(contact1.company_id, normalized.company_id);
  assert.equal(contact2.company_id, normalized.company_id);
  assert.equal(contact1.first_name, 'Hal');
  assert.equal(contact2.first_name, 'Sara');
});

// ---------------------------------------------------------------------
// 18-Bucket Industry Mapping
// ---------------------------------------------------------------------
test('mapIndustryCategory maps raw D365 industries into 18 standard buckets', async () => {
  const { mapIndustryCategory } = await import('../public/app/desktop.js');

  assert.equal(mapIndustryCategory('Poultry Farming & Crops'), 'Agriculture & Forestry');
  assert.equal(mapIndustryCategory('Oil & Gas Extraction'), 'Mining & Extraction');
  assert.equal(mapIndustryCategory('General Contractors & Roofing'), 'Construction & Trades');
  assert.equal(mapIndustryCategory('Precision Metal Machining'), 'Manufacturing');
  assert.equal(mapIndustryCategory('Freight Warehousing & Logistics'), 'Transportation & Logistics');
  assert.equal(mapIndustryCategory('Telecommunications & Broadcast Radio'), 'Utilities & Communications');
  assert.equal(mapIndustryCategory('Wholesale Food Distributors'), 'Wholesale & Distribution');
  assert.equal(mapIndustryCategory('Automotive Dealership and Repair'), 'Automotive & Dealerships');
  assert.equal(mapIndustryCategory('Hotel & Restaurant Lodging'), 'Hospitality & Food Service');
  assert.equal(mapIndustryCategory('Commercial Banking & Insurance Brokerage'), 'Finance & Insurance');
  assert.equal(mapIndustryCategory('Commercial Real Estate & Property Title'), 'Real Estate');
  assert.equal(mapIndustryCategory('Hospital, Clinic & Dentist Practice'), 'Healthcare & Medical');
  assert.equal(mapIndustryCategory('Legal Attorney & CPA Accounting Advisory'), 'Professional & Tech Services');
  assert.equal(mapIndustryCategory('Dry Cleaning & Hair Salon Services'), 'Personal & Consumer Services');
  assert.equal(mapIndustryCategory('Higher Education & University Academy'), 'Education & Schools');
  assert.equal(mapIndustryCategory('Theater, Golf Club & Sports Complex'), 'Entertainment & Recreation');
  assert.equal(mapIndustryCategory('Non-Profit Civic Association & Police Admin'), 'Civic & Public Admin');
  assert.equal(mapIndustryCategory('Retail Grocery Store & Merchandise Shop'), 'Retail Trade');
  assert.equal(mapIndustryCategory('Unknown Venture LLC'), 'Other Commercial');
  assert.equal(mapIndustryCategory(''), 'Other Commercial');
  assert.equal(mapIndustryCategory(null), 'Other Commercial');
});

// ---------------------------------------------------------------------
// AI Classifier & Municipal Guardrails
// ---------------------------------------------------------------------
test('classifyIndustry deterministic municipal guardrails enforce Civic & Public Admin', async () => {
  const { classifyIndustry } = await import('../src/lib/ai.js');

  const entities = [
    'City of Willard',
    'City of Lamar Missouri',
    'City of Monett MO',
    'Springfield Regional Arts Council',
    'Stone County Emergency Services',
    'Greene County Chamber of Commerce',
    'County of Greene',
    'Brookline Fire Department',
    'Ozark Police Department'
  ];

  for (const name of entities) {
    const category = await classifyIndustry(name, {});
    assert.equal(category, 'Civic & Public Admin', `Expected ${name} to be Civic & Public Admin`);
  }
});

test('classifyIndustry handles OpenRouter mock response and network fallback', async () => {
  const { classifyIndustry } = await import('../src/lib/ai.js');

  const originalFetch = globalThis.fetch;
  try {
    // Mock OpenRouter successful response
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ category: 'Manufacturing' })
            }
          }]
        }), { status: 200, headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026', 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, opts);
    };

    const category = await classifyIndustry('Acme Rocket Fuel', { OPENROUTER_API_KEY: 'test-key' });
    assert.equal(category, 'Manufacturing');

    // Mock OpenRouter failure — should gracefully fall back to rule-based category
    globalThis.fetch = async () => {
      throw new Error('Network timeout');
    };

    const fallbackCat = await classifyIndustry('Joe Plumbing & HVAC Services', { OPENROUTER_API_KEY: 'test-key' });
    assert.equal(fallbackCat, 'Construction & Trades');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyIndustry correctly categorizes tricky commercial and civic edge cases', async () => {
  const { classifyIndustry } = await import('../src/lib/ai.js');

  const testCases = [
    { input: 'Missouri Walnut', expected: 'Manufacturing' },
    { input: 'bk-dc.com', expected: 'Professional & Tech Services' },
    { input: 'City of Willard', expected: 'Civic & Public Admin' },
    { input: 'Triple P Recycling', expected: 'Utilities & Communications' },
    { input: 'LinkOne Ingredient Solutions', expected: 'Manufacturing' },
    { input: 'Summit Natural Gas', expected: 'Utilities & Communications' }
  ];

  for (const { input, expected } of testCases) {
    const category = await classifyIndustry(input, {});
    assert.equal(category, expected, `Failed for input: "${input}"`);
  }
});

test('calculateEpv weights high-risk industries and distance correctly', async () => {
  const { calculateEpv, getIndustryMultiplier } = await import('../src/routes/routing.js');

  // Construction (2.0x) with 20 employees at 0.5 mi
  // Score: (20 * 2.0) / (0.5 + 0.5) = 40.0
  const scoreConstruction = calculateEpv({ employees: 20, industry: 'Construction & Trades' }, 0.5);
  assert.equal(scoreConstruction, 40.0);

  // Professional Services (1.0x) with 20 employees at 0.5 mi
  // Score: (20 * 1.0) / (0.5 + 0.5) = 20.0
  const scoreProfessional = calculateEpv({ employees: 20, industry: 'Professional & Tech Services' }, 0.5);
  assert.equal(scoreProfessional, 20.0);

  // Default fallback employees (5) and distance (1.0 mi)
  // Score: (5 * 1.0) / (1.0 + 0.5) = 5 / 1.5 = 3.3
  const scoreDefault = calculateEpv({}, null);
  assert.equal(scoreDefault, 3.3);

  // High multiplier check
  assert.equal(getIndustryMultiplier('Construction & Trades'), 2.0);
  assert.equal(getIndustryMultiplier('Manufacturing'), 1.8);
  assert.equal(getIndustryMultiplier('Healthcare & Medical'), 1.6);
  assert.equal(getIndustryMultiplier('NonExistent'), 1.0);
});

test('getRecommendedProducts maps industry categories to primary Aflac products', async () => {
  const { getRecommendedProducts } = await import('../src/routes/enrich.js');

  assert.deepEqual(getRecommendedProducts('Construction & Trades'), ['Accident', 'Short-Term Disability', 'Life']);
  assert.deepEqual(getRecommendedProducts('Healthcare & Medical'), ['Hospital Indemnity', 'Critical Illness', 'Dental/Vision']);
  assert.deepEqual(getRecommendedProducts('Manufacturing'), ['Short-Term Disability', 'Critical Illness', 'Accident']);
  assert.deepEqual(getRecommendedProducts('Unknown Industry'), ['Accident', 'Short-Term Disability', 'Hospital Indemnity']);
});

test('findExistingContact and upsertContact deduplicate contacts on company_id and normalized names', async () => {
  const { findExistingContact, upsertContact } = await import('../src/lib/db.js');

  // Mock DB with prepare/bind/first/run
  const storedContacts = new Map();

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT contact_id FROM contacts')) {
                const [companyId, userEmail, fn, ln] = args;
                for (const [id, c] of storedContacts.entries()) {
                  if (c.company_id === companyId &&
                      (c.first_name || '').toLowerCase() === (fn || '').toLowerCase() &&
                      (c.last_name || '').toLowerCase() === (ln || '').toLowerCase()) {
                    return { contact_id: id };
                  }
                }
                return null;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO contacts')) {
                const [id, company_id, first_name, last_name, job_title, phone_number, email_address, is_primary_dm] = args;
                storedContacts.set(id, {
                  contact_id: id, company_id, first_name, last_name, job_title,
                  phone_number, email_address, is_primary_dm
                });
                return { success: true };
              }
              return { success: true };
            }
          };
        }
      };
    }
  };

  // 1. First insert creates contact-1
  const contact1 = {
    contact_id: 'contact-uuid-1',
    company_id: 'comp-100',
    first_name: 'John',
    last_name: 'Doe',
    job_title: 'Owner',
    phone_number: '417-555-0100',
    email_address: 'john@example.com',
    is_primary_dm: 1
  };
  const id1 = await upsertContact(mockDb, contact1, 'sean_deardorff@us.aflac.com');
  assert.equal(id1, 'contact-uuid-1');
  assert.equal(storedContacts.size, 1);

  // 2. Second insert with matching name but newly generated random UUID should reuse existing contact_id
  const contact2 = {
    contact_id: 'contact-uuid-2-random',
    company_id: 'comp-100',
    first_name: ' john ',
    last_name: 'DOE',
    job_title: 'Managing Director',
    phone_number: '417-555-0199',
    email_address: 'jdoe@example.com',
    is_primary_dm: 1
  };
  const id2 = await upsertContact(mockDb, contact2, 'sean_deardorff@us.aflac.com');
  assert.equal(id2, 'contact-uuid-1', 'Should reuse existing contact_id rather than duplicating');
  assert.equal(storedContacts.size, 1, 'Total contact count should remain 1');
});

// ---------------------------------------------------------------------
// computeTelemetry — Data Management & Telemetry Aggregates
// ---------------------------------------------------------------------
test('computeTelemetry aggregates database metrics and derives sync health accurately', async () => {
  const mockDb = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('FROM activity_logs')) {
                return {
                  total_activities: 48,
                  today_activities: 14,
                  pending_d365_sync: 6,
                  tier1_copied: 5,
                  tier2_exported: 2,
                  tier3_exported: 1
                };
              }
              return null;
            }
          };
        },
        async first() {
          if (sql.includes('FROM companies')) {
            return { total_companies: 201, d365_synced_companies: 180 };
          }
          if (sql.includes('FROM contacts')) {
            return { total_contacts: 154 };
          }
          return null;
        }
      };
    }
  };

  const env = {
    GROQ_API_KEY: 'g-key',
    OPENROUTER_API_KEY: 'or-key',
    TAVILY_API_KEY: 't-key'
  };

  const telemetry = await computeTelemetry(mockDb, env, '2026-08-30');
  assert.equal(telemetry.status, 'ok');
  assert.equal(telemetry.business_date, '2026-08-30');
  assert.equal(telemetry.sync_health, 'live');
  assert.equal(telemetry.metrics.total_companies, 201);
  assert.equal(telemetry.metrics.d365_synced_companies, 180);
  assert.equal(telemetry.metrics.total_contacts, 154);
  assert.equal(telemetry.metrics.total_activities, 48);
  assert.equal(telemetry.metrics.today_activities, 14);
  assert.equal(telemetry.metrics.pending_d365_sync, 6);
  assert.equal(telemetry.metrics.tier1_copied_count, 5);
  assert.equal(telemetry.metrics.tier2_exported_count, 2);
  assert.equal(telemetry.metrics.tier3_exported_count, 1);
  assert.equal(telemetry.providers.groq, true);
  assert.equal(telemetry.providers.openrouter, true);
  assert.equal(telemetry.providers.tavily, true);
  assert.equal(telemetry.providers.mapbox, false);
});

test('computeTelemetry sets sync_health to pending when backlog exceeds threshold', async () => {
  const mockDb = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              return {
                total_activities: 100,
                today_activities: 30,
                pending_d365_sync: 25,
                tier1_copied: 0,
                tier2_exported: 0,
                tier3_exported: 0
              };
            }
          };
        },
        async first() {
          if (sql.includes('FROM companies')) return { total_companies: 50, d365_synced_companies: 20 };
          if (sql.includes('FROM contacts')) return { total_contacts: 40 };
          return null;
        }
      };
    }
  };

  const telemetry = await computeTelemetry(mockDb, {}, '2026-08-30');
  assert.equal(telemetry.sync_health, 'pending');
  assert.equal(telemetry.metrics.pending_d365_sync, 25);
});

test('computeTelemetry handles null DB and empty environment gracefully', async () => {
  const telemetry = await computeTelemetry(null, null, '2026-08-30');
  assert.equal(telemetry.status, 'ok');
  assert.equal(telemetry.sync_health, 'live');
  assert.equal(telemetry.metrics.total_companies, 0);
  assert.equal(telemetry.metrics.total_activities, 0);
  assert.equal(telemetry.providers.groq, false);
});

// ---------------------------------------------------------------------
// PHASE P3: PIPELINE STAGES, AUTO-STAGE INFERENCE & APIS
// ---------------------------------------------------------------------

test('PIPELINE_STAGES and STAGE_RANKS enforce canonical values and ordering', () => {
  assert.deepEqual(PIPELINE_STAGES, [
    'PROSPECT',
    'ENGAGED',
    'QUALIFIED',
    'PROPOSAL',
    'CLOSED_WON',
    'CLOSED_LOST',
    'DISQUALIFIED'
  ]);

  assert.equal(matchEnum('engaged', PIPELINE_STAGES), 'ENGAGED');
  assert.equal(matchEnum('proposal', PIPELINE_STAGES), 'PROPOSAL');
  assert.equal(matchEnum('unknown_stage', PIPELINE_STAGES), null);

  assert.ok(STAGE_RANKS['PROSPECT'] < STAGE_RANKS['ENGAGED']);
  assert.ok(STAGE_RANKS['ENGAGED'] < STAGE_RANKS['QUALIFIED']);
  assert.ok(STAGE_RANKS['QUALIFIED'] < STAGE_RANKS['PROPOSAL']);
  assert.ok(STAGE_RANKS['PROPOSAL'] < STAGE_RANKS['CLOSED_WON']);
});

test('inferTargetPipelineStage enforces the 5 Opus forward-only rules', () => {
  // Rule 1: 'Information Left' or 'Gatekeeper Blocked' + PROSPECT -> ENGAGED
  assert.equal(inferTargetPipelineStage('PROSPECT', 'Information Left', 0), 'ENGAGED');
  assert.equal(inferTargetPipelineStage('PROSPECT', 'Gatekeeper Blocked', 0), 'ENGAGED');
  assert.equal(inferTargetPipelineStage('QUALIFIED', 'Information Left', 0), null); // No backward demotion

  // Rule 2: is_dm_contact = 1 + < QUALIFIED -> QUALIFIED
  assert.equal(inferTargetPipelineStage('PROSPECT', 'Follow-Up Scheduled', 1), 'QUALIFIED');
  assert.equal(inferTargetPipelineStage('ENGAGED', 'Follow-Up Scheduled', 1), 'QUALIFIED');
  assert.equal(inferTargetPipelineStage('QUALIFIED', 'Follow-Up Scheduled', 1), null);

  // Rule 3: Presentation Scheduled -> PROPOSAL
  assert.equal(inferTargetPipelineStage('PROSPECT', 'Presentation Scheduled', 0), 'PROPOSAL');
  assert.equal(inferTargetPipelineStage('QUALIFIED', 'Presentation Scheduled', 1), 'PROPOSAL');

  // Rule 4: Enrolled -> CLOSED_WON
  assert.equal(inferTargetPipelineStage('PROSPECT', 'Enrolled', 1), 'CLOSED_WON');
  assert.equal(inferTargetPipelineStage('PROPOSAL', 'Enrolled', 1), 'CLOSED_WON');

  // Rule 5: Not Interested -> CLOSED_LOST
  assert.equal(inferTargetPipelineStage('PROSPECT', 'Not Interested', 0), 'CLOSED_LOST');
  assert.equal(inferTargetPipelineStage('PROPOSAL', 'Not Interested', 1), 'CLOSED_LOST');
});

test('autoAdvancePipelineStage advances stage and records pipeline_events audit trail', async () => {
  let updatedStage = null;
  let insertedEvent = null;

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('pipeline_stage FROM companies')) {
                return { pipeline_stage: 'PROSPECT' };
              }
              return null;
            },
            async run() {
              if (sql.includes('UPDATE companies') && sql.includes('pipeline_stage')) {
                updatedStage = args[0];
              }
              if (sql.includes('pipeline_events')) {
                insertedEvent = {
                  event_id: args[0],
                  company_id: args[1],
                  from_stage: args[2],
                  to_stage: args[3],
                  trigger_log_id: args[4],
                  reason: args[5]
                };
              }
              return { success: true };
            }
          };
        }
      };
    }
  };

  const res = await autoAdvancePipelineStage(mockDb, 'comp-101', 'ENGAGED', 'sean_deardorff@us.aflac.com', 'log-999', 'First contact');
  assert.ok(res);
  assert.equal(res.from_stage, 'PROSPECT');
  assert.equal(res.to_stage, 'ENGAGED');
  assert.equal(updatedStage, 'ENGAGED');
  assert.ok(insertedEvent);
  assert.equal(insertedEvent.company_id, 'comp-101');
  assert.equal(insertedEvent.from_stage, 'PROSPECT');
  assert.equal(insertedEvent.to_stage, 'ENGAGED');
  assert.equal(insertedEvent.trigger_log_id, 'log-999');
});

test('transitionPipelineStage and snoozeCompany mutate state and validate inputs', async () => {
  let updatedCompany = {};
  let auditEvent = {};

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('pipeline_stage') && sql.includes('companies')) {
                return { pipeline_stage: 'ENGAGED', forecast_ap: null, forecast_confidence: null };
              }
              if (sql.includes('company_id FROM companies')) {
                return { company_id: 'comp-101' };
              }
              return null;
            },
            async run() {
              if (sql.includes('UPDATE companies') && sql.includes('pipeline_stage')) {
                updatedCompany.stage = args[0];
                updatedCompany.forecast_ap = args[1];
                updatedCompany.forecast_confidence = args[2];
                updatedCompany.disqualified_reason = args[3];
              }
              if (sql.includes('UPDATE companies') && sql.includes('snoozed_until')) {
                updatedCompany.snoozed_until = args[0];
              }
              if (sql.includes('pipeline_events')) {
                auditEvent = { from_stage: args[2], to_stage: args[3], reason: args[4] };
              }
              return { success: true };
            }
          };
        }
      };
    }
  };

  // Stage transition
  const stageRes = await transitionPipelineStage(mockDb, { 
    companyId: 'comp-101',
    toStage: 'PROPOSAL',
    reason: 'Executive agreed to quote',
    forecastAp: '$4,200',
    forecastConfidence: 75
  , userEmail: 'sean_deardorff@us.aflac.com' });

  assert.equal(stageRes.to_stage, 'PROPOSAL');
  assert.equal(stageRes.from_stage, 'ENGAGED');
  assert.equal(stageRes.forecast_ap, 4200);
  assert.equal(stageRes.forecast_confidence, 75);
  assert.equal(updatedCompany.stage, 'PROPOSAL');
  assert.equal(auditEvent.to_stage, 'PROPOSAL');

  // Snooze
  const snoozeRes = await snoozeCompany(mockDb, 'comp-101', '2026-09-15', 'sean_deardorff@us.aflac.com');
  assert.equal(snoozeRes.snoozed_until, '2026-09-15');
  assert.equal(updatedCompany.snoozed_until, '2026-09-15');
});

test('POST /api/pipeline/stage and /api/pipeline/snooze process valid JSON mutations', async () => {
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('pipeline_stage') && sql.includes('companies')) {
                return { pipeline_stage: 'ENGAGED', forecast_ap: null, forecast_confidence: null };
              }
              if (sql.includes('company_id FROM companies')) {
                return { company_id: 'comp-1' };
              }
              return null;
            },
            async run() {
              return { success: true };
            }
          };
        }
      };
    }
  };

  // POST /api/pipeline/stage
  const stageRes = await app.request('/api/pipeline/stage', {
    method: 'POST',
    headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026',
      'Content-Type': 'application/json',
      'x-api-key': 'LEGACY_EDGE_KEY_2026'
    },
    body: JSON.stringify({
      company_id: 'comp-1',
      to_stage: 'QUALIFIED',
      forecast_ap: 5000,
      forecast_confidence: 80
    })
  }, { DB: mockDb });

  assert.equal(stageRes.status, 200);
  const stageData = await stageRes.json();
  assert.equal(stageData.success, true);
  assert.equal(stageData.to_stage, 'QUALIFIED');

  // POST /api/pipeline/snooze
  const snoozeRes = await app.request('/api/pipeline/snooze', {
    method: 'POST',
    headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026',
      'Content-Type': 'application/json',
      'x-api-key': 'LEGACY_EDGE_KEY_2026'
    },
    body: JSON.stringify({
      company_id: 'comp-1',
      until: '2026-09-30'
    })
  }, { DB: mockDb });

  assert.equal(snoozeRes.status, 200);
  const snoozeData = await snoozeRes.json();
  assert.equal(snoozeData.success, true);
  assert.equal(snoozeData.snoozed_until, '2026-09-30');
});

test('POST /api/transcribe-and-log processes FormData with missing CRM optionals and manual_disposition without malformed company error', async () => {
  const insertedCompanies = [];
  const insertedLogs = [];

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT 1 AS ok FROM companies')) {
                return { ok: 1 };
              }
              if (sql.includes('SELECT pipeline_stage FROM companies')) {
                return { pipeline_stage: 'PROSPECT' };
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO companies')) {
                insertedCompanies.push(args);
              }
              if (sql.includes('INSERT INTO activity_logs')) {
                insertedLogs.push(args);
              }
              return { success: true };
            }
          };
        }
      };
    }
  };

  const form = new FormData();
  const audioBytes = new Uint8Array([1, 2, 3, 4]);
  const audioBlob = new Blob([audioBytes], { type: 'audio/webm' });
  form.append('audio', audioBlob, 'journal-test.webm');
  form.append('is_in_person', '1');
  form.append('is_initial', '1');
  form.append('is_dm_contact', '0');
  form.append('manual_disposition', 'Gatekeeper Blocked');
  form.append('company', JSON.stringify({
    company_name: 'Ozark Precision Machining',
    street_1: '456 Commercial Way'
  }));

  const res = await app.request('/api/transcribe-and-log', {
    method: 'POST',
    headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026'
    },
    body: form
  }, {
    DB: mockDb,
    STORE_AUDIO: '0'
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.disposition, 'Gatekeeper Blocked');
  assert.ok(data.company_id);
  assert.equal(insertedCompanies.length, 1);
  assert.equal(insertedLogs.length, 1);

  // Verify company parameters bound to DB contain null rather than undefined
  const companyBindings = insertedCompanies[0];
  assert.equal(companyBindings[4], 'Ozark Precision Machining'); // company_name
  assert.equal(companyBindings[5], '456 Commercial Way'); // street_1
  assert.equal(companyBindings[12], null); // lead_source is null
  assert.equal(companyBindings[13], null); // rating is null
  for (const b of companyBindings) {
    assert.notEqual(b, undefined, 'No undefined parameter should be bound to D1');
  }
});

test('chatCompletion routes semantic model tiers correctly', async () => {
  const { chatCompletion, DEFAULT_MODELS } = await import('../src/lib/ai.js');
  let capturedModel = null;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        const payload = JSON.parse(opts.body);
        capturedModel = payload.model;
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'test response' } }]
        }), { status: 200, headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026', 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, opts);
    };

    // Test simple tier routing
    await chatCompletion({ OPENROUTER_API_KEY: 'test-key' }, {
      taskTier: 'simple',
      system: 'sys',
      user: 'usr'
    });
    assert.equal(capturedModel, DEFAULT_MODELS.simple);

    // Test complex tier routing
    await chatCompletion({ OPENROUTER_API_KEY: 'test-key' }, {
      taskTier: 'complex',
      system: 'sys',
      user: 'usr'
    });
    assert.equal(capturedModel, DEFAULT_MODELS.complex);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/enrich constructs clean search query and injects CRM context', async () => {
  let capturedTavilyBody = null;
  let capturedOpenRouterPrompt = null;
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('tavily.com')) {
        capturedTavilyBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          answer: 'Acme Corp is a Springfield manufacturer.',
          results: [{
            title: 'Acme Corp Profile',
            url: 'https://sbj.net/acme',
            raw_content: 'Acme Corp has 45 employees and owner John Doe.'
          }]
        }), { status: 200, headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026', 'Content-Type': 'application/json' } });
      }
      if (typeof url === 'string' && url.includes('openrouter.ai')) {
        const payload = JSON.parse(opts.body);
        capturedOpenRouterPrompt = payload.messages;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: '- **Executives:** John Doe (Owner)\n- **Headcount:** 45 employees (clearly meets 3+ W-2 bar)\n- **Industry Hook:** Great target for voluntary disability coverage.'
            }
          }]
        }), { status: 200, headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026', 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, opts);
    };

    const res = await app.request('/api/enrich', {
      method: 'POST',
      headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026',
        'Content-Type': 'application/json',
        'x-api-key': 'LEGACY_EDGE_KEY_2026'
      },
      body: JSON.stringify({
        company_name: 'Acme Industrial',
        street_1: '100 Industrial Blvd',
        city: 'Springfield',
        state: 'MO',
        pipeline_stage: 'QUALIFIED',
        latest_disposition: 'Gatekeeper Blocked',
        touch_count: 3
      })
    }, {
      TAVILY_API_KEY: 'test-tavily-key',
      OPENROUTER_API_KEY: 'test-openrouter-key'
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.bullets.length, 3);

    // Verify Tavily query has NO hardcoded appending
    assert.equal(capturedTavilyBody.query, 'Acme Industrial, 100 Industrial Blvd, Springfield, MO');
    assert.equal(capturedTavilyBody.days, 90);
    assert.equal(capturedTavilyBody.include_raw_content, true);
    assert.equal(capturedTavilyBody.max_results, 5);

    // Verify CRM Context was injected into system prompt
    const systemPrompt = capturedOpenRouterPrompt.find((m) => m.role === 'system')?.content || '';
    assert.ok(systemPrompt.includes('Context: This prospect is currently in stage QUALIFIED. Previous disposition: Gatekeeper Blocked. Total touches: 3.'));
    assert.ok(systemPrompt.includes("Data stale. Dial main line to verify"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/companies parameter bindings align for all_active filter and default queries', async () => {
  let capturedBinds = null;
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          capturedBinds = args;
          return {
            async all() {
              return { results: [{ company_id: 'c1', company_name: 'Test Co' }] };
            }
          };
        }
      };
    }
  };

  const todayLocal = businessDate();

  // 1. filter=all_active binds userEmail twice: once in WHERE and once in ORDER BY subquery
  const resAllActive = await app.request('/api/companies?filter=all_active&limit=10&offset=5', {
    method: 'GET'
  }, { DB: mockDb });
  assert.equal(resAllActive.status, 200);
  assert.deepEqual(capturedBinds, ['sean_deardorff@us.aflac.com', 'sean_deardorff@us.aflac.com', todayLocal, 10, 5]);

  // 2. default / no filter
  const resDefault = await app.request('/api/companies?limit=25&offset=0', {
    method: 'GET'
  }, { DB: mockDb });
  assert.equal(resDefault.status, 200);
  assert.deepEqual(capturedBinds, ['sean_deardorff@us.aflac.com', 25, 0]);
});

test('GET /api/activity binds userEmail as first parameter along with limit and offset', async () => {
  let capturedBinds = null;
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          capturedBinds = args;
          return {
            async all() {
              return { results: [{ log_id: 'log-1', disposition: 'Enrolled' }] };
            }
          };
        }
      };
    }
  };

  const res = await app.request('/api/activity?all=1&limit=50&offset=10', {
    method: 'GET'
  }, { DB: mockDb });
  assert.equal(res.status, 200);
  assert.deepEqual(capturedBinds, ['sean_deardorff@us.aflac.com', 50, 10]);
});

test('GET /api/pipeline and GET /api/pipeline/events/:companyId bind userEmail correctly', async () => {
  let pipelineBinds = null;
  let eventBinds = null;

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          if (sql.includes('pipeline_events')) {
            eventBinds = args;
          } else {
            pipelineBinds = args;
          }
          return {
            async all() {
              return { results: [{ company_id: 'comp-1' }] };
            }
          };
        }
      };
    }
  };

  // GET /api/pipeline binds userEmail 3 times (latest CTE, agg CTE, main WHERE)
  const pipeRes = await app.request('/api/pipeline?include_snoozed=1&limit=100&offset=0', {
    method: 'GET'
  }, { DB: mockDb });
  assert.equal(pipeRes.status, 200);
  assert.deepEqual(pipelineBinds, ['sean_deardorff@us.aflac.com', 'sean_deardorff@us.aflac.com', 'sean_deardorff@us.aflac.com', 100, 0]);

  // GET /api/pipeline/events/:companyId
  const eventRes = await app.request('/api/pipeline/events/comp-1', {
    method: 'GET'
  }, { DB: mockDb });
  assert.equal(eventRes.status, 200);
  assert.deepEqual(eventBinds, ['comp-1', 'sean_deardorff@us.aflac.com']);
});

test('GET /api/exports/tier1 and /api/exports/tier2 bind userEmail correctly', async () => {
  let tier1Binds = null;
  let tier2Binds = null;

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          if (sql.includes('d365_lead_id IS NOT NULL')) {
            tier2Binds = args;
          } else {
            tier1Binds = args;
          }
          return {
            async all() {
              return { results: [] };
            }
          };
        }
      };
    }
  };

  const res1 = await app.request('/api/exports/tier1?all=1', {
    method: 'GET'
  }, { DB: mockDb });
  assert.equal(res1.status, 200);
  assert.deepEqual(tier1Binds, ['sean_deardorff@us.aflac.com']);

  const res2 = await app.request('/api/exports/tier2?all=1', {
    method: 'GET'
  }, { DB: mockDb });
  assert.equal(res2.status, 200);
  assert.deepEqual(tier2Binds, ['sean_deardorff@us.aflac.com']);
});

test('extractUserEmail safely traps invalid, malformed or missing JWT tokens and returns null', async () => {
  const { extractUserEmail } = await import('../src/lib/security.js');

  // Missing or non-object context
  assert.equal(extractUserEmail(null), null);
  assert.equal(extractUserEmail({}), null);
  assert.equal(extractUserEmail({ req: {} }), null);

  // Missing header
  assert.equal(extractUserEmail({ req: { header: () => null } }), null);

  // Malformed tokens
  assert.equal(extractUserEmail({ req: { header: () => 'not-a-jwt' } }), null);
  assert.equal(extractUserEmail({ req: { header: () => 'a.b' } }), null);
  assert.equal(extractUserEmail({ req: { header: () => 'a.b.c.d' } }), null);
  assert.equal(extractUserEmail({ req: { header: () => 'a.!!!invalid-base64!!!.c' } }), null);
  assert.equal(extractUserEmail({ req: { header: () => `header.${Buffer.from('not json').toString('base64')}.sig` } }), null);

  // Valid JWT payload
  const validPayload = Buffer.from(JSON.stringify({ email: 'sean_deardorff@us.aflac.com' })).toString('base64');
  assert.equal(extractUserEmail({ req: { header: () => `header.${validPayload}.sig` } }), 'sean_deardorff@us.aflac.com');
});

test('POST /api/companies/import successfully processes company_creation offline queue items', async () => {
  const inserted = [];
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO companies')) {
                inserted.push({ sql, args });
              }
              return { success: true };
            }
          };
        }
      };
    }
  };

  const payload = {
    companies: [{
      company_id: 'poi-comp-uuid-1',
      company_name: 'Downtown Diner',
      lat: 37.2089,
      lng: -93.2923
    }]
  };

  const res = await app.request('/api/companies/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, { DB: mockDb });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.imported, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].args[0], 'poi-comp-uuid-1');
  assert.equal(inserted[0].args[4], 'Downtown Diner');
  assert.equal(inserted[0].args[10], 37.2089);
  assert.equal(inserted[0].args[11], -93.2923);
});

test('GET /api/radar validates query parameters and handles Overpass responses', async () => {
  // 1. Missing parameters -> 400
  const badRes = await app.request('/api/radar', { method: 'GET' });
  assert.equal(badRes.status, 400);

  // 2. Mock Overpass API response
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('overpass-api.de')) {
        return new Response(JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 101,
              lat: 37.2091,
              lon: -93.2915,
              tags: {
                name: 'Springfield Law Office',
                office: 'lawyer',
                'addr:housenumber': '101',
                'addr:street': 'E Commercial St',
                'addr:city': 'Springfield',
                'addr:state': 'MO',
                'addr:postcode': '65803'
              }
            },
            {
              type: 'node',
              id: 102,
              lat: 37.2085,
              lon: -93.2930,
              tags: { name: 'Ozark Coffee Roasters', shop: 'coffee' }
            },
            {
              type: 'node',
              id: 103,
              lat: 37.2070,
              lon: -93.2940,
              tags: { amenity: 'bench' } // No name -> should be filtered out
            }
          ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const goodRes = await app.request('/api/radar?lat=37.2089&lng=-93.2923', { method: 'GET' });
    assert.equal(goodRes.status, 200);
    const data = await goodRes.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
    assert.equal(data[0].name, 'Springfield Law Office');
    assert.equal(data[0].street_1, '101 E Commercial St');
    assert.equal(data[0].city, 'Springfield');
    assert.equal(data[0].state, 'MO');
    assert.equal(data[0].zip_code, '65803');
    assert.equal(data[0].lat, 37.2091);
    assert.equal(data[0].lng, -93.2915);
    assert.equal(data[1].name, 'Ozark Coffee Roasters');
    assert.equal(data[1].street_1, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/radar gracefully fails over to secondary Overpass endpoint on primary failure', async () => {
  const attemptedUrls = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      attemptedUrls.push(url);
      if (typeof url === 'string' && url.startsWith('https://overpass-api.de')) {
        throw new Error('Primary connection dropped');
      }
      if (typeof url === 'string' && url.startsWith('https://lz4.overpass-api.de')) {
        return new Response(JSON.stringify({
          elements: [
            {
              type: 'way',
              id: 201,
              center: { lat: 37.2100, lon: -93.2900 },
              tags: { name: 'Ozark Precision Machining', industrial: 'factory' }
            }
          ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await app.request('/api/radar?lat=37.2089&lng=-93.2923', { method: 'GET' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].name, 'Ozark Precision Machining');
    assert.equal(data[0].lat, 37.2100);
    assert.equal(data[0].lng, -93.2900);
    assert.ok(attemptedUrls.length >= 2, 'Should attempt secondary server when primary fails');
  } finally {
    globalThis.fetch = originalFetch;
  }
});












