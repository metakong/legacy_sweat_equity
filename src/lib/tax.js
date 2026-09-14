/**
 * Section 125 FICA Tax Offset Engine & Teaser Check Generator
 * Calculates employer payroll tax savings under IRC Section 125 Cafeteria Plans.
 */

import { businessDate } from './time.js';

export const FICA_RATE = 0.0765; // 6.2% OASDI (Social Security) + 1.45% Medicare

/**
 * Convert a dollar number to English words for mock checks.
 */
export function numberToWords(amount) {
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);

  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function convertHundreds(n) {
    let str = '';
    if (n >= 100) {
      str += ones[Math.floor(n / 100)] + ' Hundred ';
      n %= 100;
    }
    if (n >= 20) {
      const t = Math.floor(n / 10);
      const r = n % 10;
      str += tens[t] + (r > 0 ? '-' + ones[r] : '') + ' ';
    } else if (n > 0) {
      str += ones[n] + ' ';
    }
    return str.trim();
  }

  if (dollars === 0) return `Zero and ${String(cents).padStart(2, '0')}/100 Dollars`;

  let words = '';
  const thousands = Math.floor(dollars / 1000);
  const remainder = dollars % 1000;

  if (thousands > 0) {
    words += convertHundreds(thousands) + ' Thousand ';
  }
  if (remainder > 0) {
    words += convertHundreds(remainder) + ' ';
  }

  words = words.trim();
  return `${words} and ${String(cents).padStart(2, '0')}/100 Dollars`;
}

/**
 * Calculate Section 125 payroll tax offset savings.
 *
 * @param {number} w2Count - Number of full-time W-2 employees
 * @param {number} [participationRate=0.50] - Estimated employee opt-in rate
 * @param {number} [avgMonthlyPremium=85] - Average monthly pre-tax voluntary premium per enrolled worker ($85/mo)
 * @returns {object} Calculated financial savings metrics
 */
export function calculateFicaSavings(w2Count, participationRate = 0.50, avgMonthlyPremium = 85) {
  const count = Number.isFinite(Number(w2Count)) && Number(w2Count) > 0 ? Number(w2Count) : 10;
  const partRate = Number.isFinite(Number(participationRate)) && Number(participationRate) > 0 ? Number(participationRate) : 0.50;
  const premium = Number.isFinite(Number(avgMonthlyPremium)) && Number(avgMonthlyPremium) > 0 ? Number(avgMonthlyPremium) : 85;

  const enrolledWorkers = Math.round(count * partRate);
  const annualContribution = count * partRate * (premium * 12);
  const employerSavings = annualContribution * FICA_RATE;

  return {
    w2_count: count,
    participation_rate: partRate,
    avg_monthly_premium: premium,
    enrolled_workers: enrolledWorkers,
    annual_employee_contribution: Math.round(annualContribution * 100) / 100,
    employer_fica_savings: Math.round(employerSavings * 100) / 100,
    fica_rate: FICA_RATE,
    formatted_savings: '$' + (Math.round(employerSavings * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  };
}

/**
 * Generate complete payload and printable HTML cardstock mock check.
 *
 * @param {object} company - Company database record
 * @returns {object} Teaser check payload and HTML block
 */
export function generateTeaserCheckPayload(company) {
  const w2 = company?.estimated_w2_count || company?.employees || 15;
  const metrics = calculateFicaSavings(w2);
  const companyName = company?.company_name || 'Business Owner';
  const payee = company?.decision_maker ? `${company.decision_maker}, ${companyName}` : companyName;
  const checkDate = businessDate();
  const checkNumber = '125-' + (Math.floor(Math.random() * 8999) + 1000);
  const words = numberToWords(metrics.employer_fica_savings);

  const checkHtml = `
<div class="mock-check-container" style="font-family: 'Courier New', Courier, monospace; border: 2px dashed #333; padding: 20px; max-width: 680px; background: #fdfdf9; color: #111; border-radius: 8px; margin: 10px auto;">
  <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 15px;">
    <div>
      <strong style="font-size: 16px; text-transform: uppercase;">UNITED STATES TREASURY TAX RECOVERY OFFSET</strong><br>
      <span style="font-size: 12px; color: #555;">IRC Section 125 Cafeteria Plan FICA Refund Credit</span>
    </div>
    <div style="text-align: right;">
      <span style="font-weight: bold; font-size: 14px;">CHECK NO: ${checkNumber}</span><br>
      <span style="font-size: 13px;">DATE: ${checkDate}</span>
    </div>
  </div>
  
  <div style="margin: 20px 0; font-size: 15px;">
    <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px;">
      <span>PAY TO THE ORDER OF: <strong>${payee}</strong></span>
      <span style="font-size: 18px; font-weight: bold; border: 2px solid #000; padding: 4px 10px; background: #fff;">${metrics.formatted_savings}</span>
    </div>
    <div style="border-bottom: 1px solid #777; padding-bottom: 4px; margin-bottom: 15px;">
      AMOUNT: <em>${words}</em>
    </div>
  </div>

  <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 25px; font-size: 12px; color: #444;">
    <div>
      <strong>MEMO:</strong> Section 125 FICA Payroll Savings (${metrics.w2_count} W-2 Employees @ 50% Participation)<br>
      <span style="font-size: 11px; color: #777;">*Calculated at 7.65% FICA (OASDI + Medicare) on Pre-Tax Supplemental Benefits</span>
    </div>
    <div style="text-align: center; border-top: 1px solid #000; width: 220px; padding-top: 4px;">
      <span style="font-family: cursive; font-size: 14px;">Sean Deardorff</span><br>
      AUTHORIZED ADVISOR
    </div>
  </div>
</div>
`.trim();

  return {
    company_id: company?.company_id || null,
    company_name: companyName,
    payee,
    check_number: checkNumber,
    check_date: checkDate,
    w2_count: metrics.w2_count,
    employer_fica_savings: metrics.employer_fica_savings,
    formatted_savings: metrics.formatted_savings,
    amount_in_words: words,
    memo: `Section 125 Pre-Tax Payroll FICA Recovery (${metrics.w2_count} W-2 Staff)`,
    check_html: checkHtml
  };
}
