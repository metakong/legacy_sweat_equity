/**
 * Test suite for 21-Day 12-Touch Cadence Engine & Section 125 Tax Offset Calculator
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CADENCE_TOUCHES, advanceCadence, addDaysToIso } from '../src/lib/cadence.js';
import { calculateFicaSavings, numberToWords, generateTeaserCheckPayload, FICA_RATE } from '../src/lib/tax.js';

test('CADENCE_TOUCHES defines exact 12-touch multi-channel sequence matrix', () => {
  assert.equal(CADENCE_TOUCHES.length, 12);

  // Step 1 (Day 1): DIMENSIONAL_MAIL
  assert.equal(CADENCE_TOUCHES[0].step, 1);
  assert.equal(CADENCE_TOUCHES[0].day, 1);
  assert.equal(CADENCE_TOUCHES[0].channel, 'DIMENSIONAL_MAIL');
  assert.match(CADENCE_TOUCHES[0].title, /Mock FICA Savings Check/);

  // Step 2 (Day 3): FIELD_DROP
  assert.equal(CADENCE_TOUCHES[1].step, 2);
  assert.equal(CADENCE_TOUCHES[1].day, 3);
  assert.equal(CADENCE_TOUCHES[1].channel, 'FIELD_DROP');
  assert.match(CADENCE_TOUCHES[1].title, /Drop 1: Check Arrival/);

  // Step 3 (Day 4): PHONE
  assert.equal(CADENCE_TOUCHES[2].step, 3);
  assert.equal(CADENCE_TOUCHES[2].day, 4);
  assert.equal(CADENCE_TOUCHES[2].channel, 'PHONE');
  assert.match(CADENCE_TOUCHES[2].title, /Pattern Interrupt/);

  // Step 4 (Day 4): EMAIL
  assert.equal(CADENCE_TOUCHES[3].step, 4);
  assert.equal(CADENCE_TOUCHES[3].day, 4);
  assert.equal(CADENCE_TOUCHES[3].channel, 'EMAIL');
  assert.match(CADENCE_TOUCHES[3].title, /Section 125 Mechanics/);

  // Step 8 (Day 14): FIELD_DROP
  assert.equal(CADENCE_TOUCHES[7].step, 8);
  assert.equal(CADENCE_TOUCHES[7].day, 14);
  assert.equal(CADENCE_TOUCHES[7].channel, 'FIELD_DROP');
  assert.match(CADENCE_TOUCHES[7].title, /Drop 2: Hand-deliver/);

  // Step 12 (Day 21): EMAIL Breakup
  assert.equal(CADENCE_TOUCHES[11].step, 12);
  assert.equal(CADENCE_TOUCHES[11].day, 21);
  assert.equal(CADENCE_TOUCHES[11].channel, 'EMAIL');
  assert.match(CADENCE_TOUCHES[11].title, /Polite Breakup/);
});

test('advanceCadence advances steps and calculates target due dates accurately', () => {
  const base = '2026-09-01';

  // 1. Initial enrollment from 0 -> Step 1 (Day 1)
  const step1 = advanceCadence({ cadence_stage: 0 }, 0, base);
  assert.equal(step1.next_step, 1);
  assert.equal(step1.next_due_date, '2026-09-01'); // Today
  assert.equal(step1.cadence_status, 'ACTIVE');
  assert.equal(step1.is_completed, false);

  // 2. Step 1 (Day 1) -> Step 2 (Day 3) = +2 days
  const step2 = advanceCadence({ cadence_stage: 1 }, 1, base);
  assert.equal(step2.next_step, 2);
  assert.equal(step2.next_due_date, '2026-09-03');
  assert.equal(step2.step_info.channel, 'FIELD_DROP');

  // 3. Step 2 (Day 3) -> Step 3 (Day 4) = +1 day
  const step3 = advanceCadence({ cadence_stage: 2 }, 2, '2026-09-03');
  assert.equal(step3.next_step, 3);
  assert.equal(step3.next_due_date, '2026-09-04');
  assert.equal(step3.step_info.channel, 'PHONE');

  // 4. Step 3 (Day 4) -> Step 4 (Day 4) = +0 days
  const step4 = advanceCadence({ cadence_stage: 3 }, 3, '2026-09-04');
  assert.equal(step4.next_step, 4);
  assert.equal(step4.next_due_date, '2026-09-04');
  assert.equal(step4.step_info.channel, 'EMAIL');

  // 5. Completion at Step 12
  const completed = advanceCadence({ cadence_stage: 12 }, 12, base);
  assert.equal(completed.next_step, 12);
  assert.equal(completed.cadence_status, 'COMPLETED');
  assert.equal(completed.is_completed, true);
  assert.equal(completed.next_due_date, null);
});

test('calculateFicaSavings computes exact 7.65% payroll tax savings', () => {
  assert.equal(FICA_RATE, 0.0765);

  // 10 employees, 50% participation (5 enrolled), $85/mo ($1,020/yr)
  // Annual contribution = 5 * 1020 = $5,100
  // Savings = 5100 * 0.0765 = $390.15
  const res10 = calculateFicaSavings(10, 0.50, 85);
  assert.equal(res10.w2_count, 10);
  assert.equal(res10.enrolled_workers, 5);
  assert.equal(res10.annual_employee_contribution, 5100.00);
  assert.equal(res10.employer_fica_savings, 390.15);
  assert.equal(res10.formatted_savings, '$390.15');

  // 20 employees, 50% participation (10 enrolled), $85/mo
  // Annual contribution = 10 * 1020 = $10,200
  // Savings = 10200 * 0.0765 = $780.30
  const res20 = calculateFicaSavings(20, 0.50, 85);
  assert.equal(res20.annual_employee_contribution, 10200.00);
  assert.equal(res20.employer_fica_savings, 780.30);
  assert.equal(res20.formatted_savings, '$780.30');

  // 50 employees, 50% participation (25 enrolled), $85/mo
  // Annual contribution = 25 * 1020 = $25,500
  // Savings = 25500 * 0.0765 = $1,950.75
  const res50 = calculateFicaSavings(50, 0.50, 85);
  assert.equal(res50.employer_fica_savings, 1950.75);
  assert.equal(res50.formatted_savings, '$1,950.75');
});

test('numberToWords converts currency amounts into formal legal check text', () => {
  assert.equal(numberToWords(390.15), 'Three Hundred Ninety and 15/100 Dollars');
  assert.equal(numberToWords(780.30), 'Seven Hundred Eighty and 30/100 Dollars');
  assert.equal(numberToWords(1950.75), 'One Thousand Nine Hundred Fifty and 75/100 Dollars');
  assert.equal(numberToWords(0.00), 'Zero and 00/100 Dollars');
});

test('generateTeaserCheckPayload produces valid printable mock check metadata and HTML', () => {
  const company = {
    company_id: 'test-co-1',
    company_name: 'Ozark Precision Tooling',
    decision_maker: 'Greg Vance',
    estimated_w2_count: 24
  };

  const payload = generateTeaserCheckPayload(company);
  assert.equal(payload.company_name, 'Ozark Precision Tooling');
  assert.equal(payload.payee, 'Greg Vance, Ozark Precision Tooling');
  assert.equal(payload.w2_count, 24);
  // 24 * 0.5 * 1020 * 0.0765 = 12 * 1020 * 0.0765 = $936.36
  assert.equal(payload.employer_fica_savings, 936.36);
  assert.equal(payload.formatted_savings, '$936.36');
  assert.match(payload.amount_in_words, /Nine Hundred Thirty-Six and 36\/100 Dollars/);
  assert.match(payload.memo, /Section 125 Pre-Tax Payroll FICA Recovery/);
  assert.ok(payload.check_html.includes('mock-check-container'));
  assert.ok(payload.check_html.includes('UNITED STATES TREASURY TAX RECOVERY OFFSET'));
  assert.ok(payload.check_html.includes('$936.36'));
});
