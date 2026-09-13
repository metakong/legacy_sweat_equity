/**
 * Zero-dependency tests for the Worker's validation, CRM enum, and timezone
 * logic. Run with: npm test   (node --test, built in â€” no packages)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createD1 } from '../mockEnv.js';

import {
  cleanText,
  cleanCapped,
  matchEnum,
  toBool,
  asId,
  asIsoDate,
  asMoney,
  asCount,
  asLatitude,
  asLongitude,
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
import { AUTH_HEADERS } from './test-auth.js';

const origRequest = app.request.bind(app);
app.request = (input, init = {}, env, executionCtx) => {
  if (typeof input === 'string') {
    const headers = new Headers(init.headers || {});
    if (!headers.has('cf-access-jwt-assertion')) {
      headers.set('cf-access-jwt-assertion', AUTH_HEADERS['cf-access-jwt-assertion']);
    }
    return origRequest(input, { ...init, headers }, env, executionCtx);
  } else if (input instanceof Request) {
    if (!input.headers.has('cf-access-jwt-assertion')) {
      const headers = new Headers(input.headers);
      headers.set('cf-access-jwt-assertion', AUTH_HEADERS['cf-access-jwt-assertion']);
      const modifiedReq = new Request(input, { headers });
      return origRequest(modifiedReq, init, env, executionCtx);
    }
    return origRequest(input, init, env, executionCtx);
  }
  return origRequest(input, init, env, executionCtx);
};

// Built from char codes so the literals below never contain a raw control byte.
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);
const C1 = String.fromCharCode(159);

// ---------------------------------------------------------------------
// cleanText â€” input normalization
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

test('coordinate coercers treat a missing value as missing, not as zero', () => {
  // Regression: Number(null) and Number('') are both 0, which made an
  // ungeocoded account a real 0,0 pin and let `?lat=&lng=` scan the Gulf of
  // Guinea. A genuine numeric zero is still a real coordinate.
  assert.equal(asLatitude(null), null);
  assert.equal(asLatitude(undefined), null);
  assert.equal(asLatitude(''), null);
  assert.equal(asLatitude('   '), null);
  assert.equal(asLatitude(0), 0);
  assert.equal(asLatitude('0'), 0);
  assert.equal(asLatitude('37.2089'), 37.2089);
  assert.equal(asLatitude(91), null);
  assert.equal(asLatitude('north'), null);

  assert.equal(asLongitude(null), null);
  assert.equal(asLongitude(''), null);
  assert.equal(asLongitude(0), 0);
  assert.equal(asLongitude(-93.2923), -93.2923);
  assert.equal(asLongitude(-181), null);
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

  // No decision maker reached â€” the channel decides the wording.
  assert.equal(d(1, 1, 0), 'Gatekeeper Blocked');
  assert.equal(d(1, 0, 0), 'Gatekeeper Blocked');
  assert.equal(d(0, 1, 0), 'No Contact');
  assert.equal(d(0, 0, 0), 'No Contact');

  // Decision maker reached â€” the touch type decides.
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
  // 19:00 CDT on the 21st is 00:00 UTC on the 22nd â€” the exact case a
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
      `${key} is a ${typeof value} â€” D1 would throw on bind`
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

    // Mock OpenRouter failure â€” should gracefully fall back to rule-based category
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
// computeTelemetry â€” Data Management & Telemetry Aggregates
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

// ---------------------------------------------------------------------
// FIELD VIEW HELPERS â€” account intel rendering
// ---------------------------------------------------------------------

test('relativeDay reads D1 timestamps as UTC, not local', async () => {
  const { relativeDay } = await import('../public/app/field.js');

  // D1 stores 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker. Parsing that
  // as local time shifts every evening Springfield touch by five hours and
  // reports yesterday's visit as today's.
  const now = Date.parse('2026-09-02T15:00:00Z');
  assert.equal(relativeDay('2026-09-02 09:00:00', now), 'today');
  assert.equal(relativeDay('2026-09-01 09:00:00', now), 'yesterday');
  assert.equal(relativeDay('2026-08-30 09:00:00', now), '3 days ago');
  assert.equal(relativeDay('2026-08-20 09:00:00', now), 'last week');
  assert.equal(relativeDay('2026-07-01 09:00:00', now), '2 months ago');

  // An explicit zone is respected rather than double-suffixed.
  assert.equal(relativeDay('2026-09-02T09:00:00Z', now), 'today');

  assert.equal(relativeDay(null), null);
  assert.equal(relativeDay('not a date'), null);
  assert.equal(relativeDay('2026-09-05 09:00:00', now), null, 'a future stamp is not a recency');
});

test('telHref builds a dialable number and never glues an extension on', async () => {
  const { telHref } = await import('../public/app/field.js');

  assert.equal(telHref('(417) 831-0048'), 'tel:4178310048');
  assert.equal(telHref('417.869.7200'), 'tel:4178697200');
  assert.equal(telHref('1-417-868-8002'), 'tel:+14178688002');

  // Regression: the agent's list contains "417-868-8002 (Ext 1456)". Stripping
  // non-digits dials 41786880021456 â€” a wrong number, tapped one-handed on a
  // doorstep.
  assert.equal(telHref('417-868-8002 (Ext 1456)'), 'tel:4178688002;ext=1456');
  assert.equal(telHref('417-555-1212 x99'), 'tel:4175551212;ext=99');

  // Two numbers in one field: dial the first, never a 20-digit concatenation.
  assert.equal(telHref('417-831-0048 / 417-555-1212'), 'tel:4178310048');

  // Anything that is not a phone number yields no href at all.
  assert.equal(telHref('123'), null);
  assert.equal(telHref('In-person drop-in.'), null);
  assert.equal(telHref(''), null);
  assert.equal(telHref(null), null);
  assert.equal(telHref(undefined), null);
});

test('telHref output is always safe to place in an href', async () => {
  const { telHref } = await import('../public/app/field.js');

  // The value comes from the CRM, so it is never trusted verbatim. Whatever
  // goes in, what comes out is tel: plus digits, an optional +, and ;ext=.
  for (const hostile of [
    'javascript:alert(1)',
    '417-831-0048"><script>alert(1)</script>',
    "417-831-0048' onclick='alert(1)",
    '4178310048 <img src=x onerror=alert(1)>'
  ]) {
    const href = telHref(hostile);
    if (href !== null) {
      assert.match(href, /^tel:\+?\d+(;ext=\d+)?$/, `unsafe href from ${hostile}`);
    }
  }
});

test('GET /api/radar rejects missing, empty and out-of-range coordinates', async () => {
  // The DB binding is deliberately hostile: an invalid request must be refused
  // before any read is attempted.
  const env = {
    DB: {
      prepare() {
        throw new Error('D1 must not be touched for an invalid radar request');
      }
    }
  };

  for (const query of [
    '',
    '?lat=37.2089',
    '?lng=-93.2923',
    '?lat=&lng=',
    '?lat=abc&lng=abc',
    '?lat=91&lng=-93.2923',
    '?lat=37.2089&lng=-181'
  ]) {
    const res = await app.request(`/api/radar${query}`, { method: 'GET' }, env);
    assert.equal(res.status, 400, `expected 400 for "${query}"`);
  }
});

test('GET /api/radar reads the tenant-scoped geohash cells from D1 with no network call', async () => {
  const calls = [];
  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              calls.push({ sql, args });
              return {
                results: [
                  {
                    id: 'far', name: 'Far Account', address: '9 Elm St',
                    city: 'Springfield', state: 'MO', zip: '65801',
                    phone: null, website: null, latitude: 37.2405, longitude: -93.3210,
                    geohash: '9ytetj0', pipeline_stage: 'PROSPECT', status: 'ACTIVE',
                    current_voluntary_carrier: 'Aflac', major_medical_carrier: null,
                    is_hdhp: 0, estimated_w2_count: 12, confidence_score: 85,
                    updated_at: '2026-08-30 12:00:00'
                  },
                  {
                    id: 'near', name: 'Near Account', address: '101 E Commercial St',
                    city: 'Springfield', state: 'MO', zip: '65803',
                    phone: '417-831-0048', website: null, latitude: 37.2091, longitude: -93.2915,
                    geohash: '9ytetj1', pipeline_stage: 'ENGAGED', status: 'ACTIVE',
                    current_voluntary_carrier: 'None', major_medical_carrier: 'CoxHealth',
                    is_hdhp: 1, estimated_w2_count: 25, confidence_score: 85,
                    updated_at: '2026-09-01 12:00:00'
                  },
                  {
                    id: 'nowhere', name: 'Ungeocoded Account', address: null,
                    city: null, state: null, zip: null, phone: null, website: null,
                    latitude: null, longitude: null, geohash: null,
                    pipeline_stage: 'PROSPECT', status: 'ACTIVE',
                    current_voluntary_carrier: 'None', major_medical_carrier: null,
                    is_hdhp: 0, estimated_w2_count: 0, confidence_score: 30,
                    updated_at: null
                  }
                ]
              };
            }
          };
        }
      };
    }
  };

  // The old implementation called the public Overpass API. Any outbound
  // request from this route is a regression.
  const originalFetch = globalThis.fetch;
  const networkCalls = [];
  globalThis.fetch = async (url) => {
    networkCalls.push(url);
    throw new Error('radar must not reach the network');
  };

  try {
    const res = await app.request(
      '/api/radar?lat=37.2089&lng=-93.2923&limit=500',
      { method: 'GET' },
      { DB: mockDb }
    );
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.count, 2, 'the row with no coordinates must be dropped');
    assert.deepEqual(body.data.map((row) => row.id), ['near', 'far'], 'closest account must be index 0');
    assert.ok(body.data[0].distance_meters < body.data[1].distance_meters);
    assert.equal(body.data[0].distance_miles, body.data[0].distance_meters / 1609.344);

    // Canonical aliases keep the field PWA able to select, enrich and log
    // against the stored account rather than minting a duplicate.
    assert.equal(body.data[0].company_id, 'near');
    assert.equal(body.data[0].company_name, 'Near Account');
    assert.equal(body.data[0].street_1, '101 E Commercial St');
    assert.equal(body.data[0].zip_code, '65803');
    assert.equal(body.data[0].company_phone, '417-831-0048');
    assert.equal(body.data[0].lat, 37.2091);
    assert.equal(body.data[0].lng, -93.2915);
    assert.equal(body.data[0].status, 'ACTIVE');
    assert.equal(body.data[0].is_hdhp, 1);
    assert.equal(body.data[0].estimated_w2_count, 25);
    assert.equal(body.data[0].updated_at, '2026-09-01 12:00:00');

    assert.equal(calls.length, 1, 'exactly one D1 read, no N+1');
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    assert.match(sql, /SUBSTR\(geohash, 1, 6\) IN \(\?, \?, \?, \?, \?, \?, \?, \?, \?\)/i);
    assert.match(sql, /status NOT IN \('DISQUALIFIED', 'DO_NOT_CONTACT'\)/i);
    assert.match(sql, /agent_email = \?/i);

    assert.equal(calls[0].args[0], 'sean_deardorff@us.aflac.com', 'tenant predicate binds first');
    assert.deepEqual(
      calls[0].args.slice(1, 10),
      ['9ytetj', '9ytetn', '9ytetq', '9ytetm', '9ytetk', '9yteth', '9ytesu', '9ytesv', '9ytesy'],
      'center cell followed by the eight cardinal neighbours'
    );
    assert.equal(calls[0].args[10], 50, 'a limit above the ceiling is capped');
    assert.equal(calls[0].args.length, 11);
    assert.equal(networkCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Zero Trust: API auth middleware rejects missing or invalid cf-access-jwt-assertion', async () => {
  // 1. Missing JWT assertion header
  const resNoAuth = await origRequest('/api/companies?limit=10', { method: 'GET' });
  assert.equal(resNoAuth.status, 401);
  const jsonNoAuth = await resNoAuth.json();
  assert.equal(jsonNoAuth.error, 'Unauthorized');

  // 2. Untrusted email in JWT assertion
  const badJwt = 'header.' + Buffer.from(JSON.stringify({ email: 'unauthorized_attacker@external.com' })).toString('base64') + '.sig';
  const resBadAuth = await origRequest('/api/companies?limit=10', {
    method: 'GET',
    headers: { 'cf-access-jwt-assertion': badJwt }
  });
  assert.equal(resBadAuth.status, 401);
  const jsonBadAuth = await resBadAuth.json();
  assert.equal(jsonBadAuth.error, 'Unauthorized');

  // 3. Health check is public / exempted
  const resHealth = await origRequest('/api/health', { method: 'GET' });
  assert.equal(resHealth.status, 200);
});

test('POST /api/admin/reclassify-industries enforces keyset pagination and filters correctly', async () => {
  const tempDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-reclassify-')), 'test.sqlite');
  const d1 = createD1(tempDb);

  try {
    // 1. Missing OPENROUTER_API_KEY returns 503
    const resNoKey = await app.request('/api/admin/reclassify-industries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }, { DB: d1, OPENROUTER_API_KEY: '' });
    assert.equal(resNoKey.status, 503);
    const jsonNoKey = await resNoKey.json();
    assert.equal(jsonNoKey.error, 'OPENROUTER_API_KEY is not configured');

    // 2. Seed test companies: 5 unclassified + 1 already classified
    // These names match deterministic rules in classifyIndustry so no network calls are needed
    const insert = d1._raw.prepare(`
      INSERT INTO companies (company_id, agent_email, company_name, industry)
      VALUES (?, ?, ?, ?)
    `);
    insert.run('c01', 'sean_deardorff@us.aflac.com', 'City of Willard', null);
    insert.run('c02', 'sean_deardorff@us.aflac.com', 'Missouri Walnut', '');
    insert.run('c03', 'sean_deardorff@us.aflac.com', 'LinkOne Ingredient Solutions', 'Other Commercial');
    insert.run('c04', 'sean_deardorff@us.aflac.com', 'Triple P Recycling', 'Commercial / Other');
    insert.run('c05', 'sean_deardorff@us.aflac.com', 'Summit Natural Gas', null);
    insert.run('c99', 'sean_deardorff@us.aflac.com', 'Existing Enterprise', 'Healthcare');

    const env = {
      DB: d1,
      OPENROUTER_API_KEY: 'test-key-deterministic'
    };

    // 3. First page (limit: 2, cursor: '')
    const page1Res = await app.request('/api/admin/reclassify-industries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2, cursor: '', only_unclassified: true })
    }, env);
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.equal(page1.status, 'success');
    assert.equal(page1.total_scanned, 2);
    assert.equal(page1.has_more, true);
    assert.equal(page1.next_cursor, 'c02');
    assert.equal(page1.limit, 2);
    assert.equal(page1.classifications.length, 2);
    assert.equal(page1.classifications[0].company_id, 'c01');
    assert.equal(page1.classifications[0].category, 'Civic & Public Admin');
    assert.equal(page1.classifications[1].company_id, 'c02');
    assert.equal(page1.classifications[1].category, 'Manufacturing');

    // 4. Second page (limit: 2, cursor: 'c02')
    const page2Res = await app.request('/api/admin/reclassify-industries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2, cursor: 'c02', only_unclassified: true })
    }, env);
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.equal(page2.total_scanned, 2);
    assert.equal(page2.has_more, true);
    assert.equal(page2.next_cursor, 'c04');
    assert.equal(page2.classifications[0].company_id, 'c03');
    assert.equal(page2.classifications[0].category, 'Manufacturing');
    assert.equal(page2.classifications[1].company_id, 'c04');
    assert.equal(page2.classifications[1].category, 'Utilities & Communications');

    // 5. Third page (limit: 2, cursor: 'c04')
    const page3Res = await app.request('/api/admin/reclassify-industries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 2, cursor: 'c04', only_unclassified: true })
    }, env);
    assert.equal(page3Res.status, 200);
    const page3 = await page3Res.json();
    assert.equal(page3.total_scanned, 1);
    assert.equal(page3.has_more, false);
    assert.equal(page3.next_cursor, null);
    assert.equal(page3.classifications[0].company_id, 'c05');
    assert.equal(page3.classifications[0].category, 'Utilities & Communications');

    // 6. Verify c99 was untouched and remains 'Healthcare'
    const c99Row = d1._raw.prepare('SELECT industry FROM companies WHERE company_id = ?').get('c99');
    assert.equal(c99Row.industry, 'Healthcare');

    // 7. Verify limit clamping: limit: 100 clamped to 25
    const clampedRes = await app.request('/api/admin/reclassify-industries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 100, cursor: '' })
    }, env);
    assert.equal(clampedRes.status, 200);
    const clampedJson = await clampedRes.json();
    assert.equal(clampedJson.limit, 25);
  } finally {
    try {
      fs.rmSync(path.dirname(tempDb), { recursive: true, force: true });
    } catch (_) {}
  }
});

test('Stream 3: voice extraction normalizes composite actions and executes D1 mutations', async () => {
  const tempDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-voice-actions-')), 'test.sqlite');
  const d1 = createD1(tempDb);

  try {
    // Insert test company
    d1._raw.prepare(`
      INSERT INTO companies (company_id, agent_email, company_name, pipeline_stage, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run('comp_act_1', 'sean_deardorff@us.aflac.com', 'Acme Corp', 'PROSPECT', 'Initial notes.');

    const mockExtracted = {
      disposition: 'DM_TOUCH',
      contact_made: true,
      summary_notes: 'Spoke with DM, presentation scheduled.',
      confidence_score: 85,
      verification_status: 'PHONE_VERIFIED',
      d365_counters: { phone_dials: 1, dm_contacts: 1, walk_ins: 0, appointments_set: 1 },
      actions: [
        { type: 'UPDATE_STAGE', to_stage: 'QUALIFIED' },
        { type: 'SCHEDULE_CALLBACK', date: '2026-09-20', text: 'Follow up on Section 125 flyer' },
        { type: 'ADD_NOTE', text: 'Decision maker requested quote.' }
      ]
    };

    const form = new FormData();
    const audioBlob = new Blob(['mock-audio'], { type: 'audio/webm' });
    form.append('audio', audioBlob, 'test.webm');
    form.append('company_id', 'comp_act_1');

    const env = {
      DB: d1,
      GROQ_API_KEY: 'mock-groq-key',
      OPENROUTER_API_KEY: 'mock-openrouter-key',
      VOICE_INTELLIGENCE_MOCK: mockExtracted,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ text: 'Spoke with Sarah at Acme Corp.' })
      })
    };

    const res = await app.request('/api/voice-debrief', {
      method: 'POST',
      body: form
    }, env);

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.extracted.actions.length, 3);

    // Verify company state updated
    const updatedComp = d1._raw.prepare('SELECT pipeline_stage, next_action_date, next_action, notes FROM companies WHERE company_id = ?').get('comp_act_1');
    assert.equal(updatedComp.pipeline_stage, 'QUALIFIED');
    assert.equal(updatedComp.next_action_date, '2026-09-20');
    assert.equal(updatedComp.next_action, 'Follow up on Section 125 flyer');
    assert.ok(updatedComp.notes.includes('Decision maker requested quote.'));

    // Verify audit event tagged with reason
    const event = d1._raw.prepare('SELECT * FROM pipeline_events WHERE company_id = ?').get('comp_act_1');
    assert.equal(event.to_stage, 'QUALIFIED');
    assert.equal(event.reason, 'Triggered via Agentic Voice Command');
  } finally {
    try { fs.rmSync(path.dirname(tempDb), { recursive: true, force: true }); } catch (_) {}
  }
});

test('Stream 2: GET /api/pipeline/forecast computes velocity, win rates, and weighted EV with baseline confidence', async () => {
  const tempDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aflac-forecast-')), 'test.sqlite');
  const d1 = createD1(tempDb);

  try {
    // Seed companies with different stages, industries, employees, and confidence scores
    const stmt = d1._raw.prepare(`
      INSERT INTO companies (company_id, agent_email, company_name, pipeline_stage, industry, estimated_w2_count, forecast_ap, forecast_confidence, confidence_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('f1', 'sean_deardorff@us.aflac.com', 'Tech Corp', 'QUALIFIED', 'Professional & Tech Services', 20, 5000, 80, 80);
    stmt.run('f2', 'sean_deardorff@us.aflac.com', 'Build Co', 'PROPOSAL', 'Construction & Trades', 10, null, null, 30); // uses baseline confidence 30 and 10*250 = 2500 AP
    stmt.run('f3', 'sean_deardorff@us.aflac.com', 'Won Shop', 'CLOSED_WON', 'Construction & Trades', 5, 2000, 100, 100);

    // Seed pipeline events for velocity calculation
    const evtStmt = d1._raw.prepare(`
      INSERT INTO pipeline_events (event_id, company_id, from_stage, to_stage, changed_at, agent_email)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    evtStmt.run('e1', 'f1', 'PROSPECT', 'ENGAGED', '2026-09-01 10:00:00', 'sean_deardorff@us.aflac.com');
    evtStmt.run('e2', 'f1', 'ENGAGED', 'QUALIFIED', '2026-09-05 10:00:00', 'sean_deardorff@us.aflac.com'); // 4 days

    const res = await app.request('/api/pipeline/forecast', {
      method: 'GET'
    }, { DB: d1 });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    // Velocity assertions
    assert.ok(Array.isArray(json.velocity));
    const engagedVel = json.velocity.find(v => v.stage === 'ENGAGED');
    assert.equal(engagedVel.avg_days, 4);

    // Industry win-rates assertions
    assert.ok(Array.isArray(json.industry_win_rates));
    const constWin = json.industry_win_rates.find(w => w.industry === 'Construction & Trades');
    assert.equal(constWin.total_count, 2);
    assert.equal(constWin.won_count, 1);
    assert.equal(constWin.win_rate, 50);

    // Forecast EV assertions
    // f1: 5000 * 0.8 = 4000
    // f2: 2500 * 0.3 (default baseline confidence) = 750
    // f3: 2000 * 1.0 = 2000
    // Total weighted EV = 4000 + 750 + 2000 = 6750
    assert.equal(json.total_weighted_ev, 6750);
    assert.equal(json.total_unweighted_ap, 9500);
  } finally {
    try { fs.rmSync(path.dirname(tempDb), { recursive: true, force: true }); } catch (_) {}
  }
});
