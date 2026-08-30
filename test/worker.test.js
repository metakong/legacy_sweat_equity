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
  LEAD_SOURCES
} from '../src/lib/validate.js';

import {
  businessDate,
  businessDayRangeUtc,
  toSqlTimestamp,
  toLocalStamp,
  localHourOf
} from '../src/lib/time.js';

import { normalizeCompany, normalizeActivityLog, normalizeContact, calculateRenewalDate, ValidationError } from '../src/lib/db.js';
import { computeMetrics, fallbackReport } from '../src/routes/eod.js';

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
  assert.equal(company.lead_source, 'Cold Call');
  assert.equal(company.rating, 'Cold');
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
  assert.equal(company.rating, 'Cold', 'an invalid rating falls back rather than persisting');
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
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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




