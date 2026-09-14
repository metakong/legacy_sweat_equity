/**
 * The 21-Day 12-Touch Blue-Collar B2B Cadence Engine
 * Optimized for commercial trades, manufacturing, construction, and blue-collar payrolls.
 */

import { businessDate } from './time.js';

export const CADENCE_TOUCHES = [
  {
    step: 1,
    day: 1,
    channel: 'DIMENSIONAL_MAIL',
    title: 'Send Mock FICA Savings Check Cardstock Mailer',
    instruction: 'Print and mail the high-contrast cardstock mock FICA savings check addressed to the primary business owner / CFO.',
    target_time: null
  },
  {
    step: 2,
    day: 3,
    channel: 'FIELD_DROP',
    title: 'Drop 1: Check Arrival Verification with Gatekeeper',
    instruction: 'In-person drop-in: Verify arrival of priority tax-offset parcel with receptionist/gatekeeper. Leave payroll audit slip.',
    target_time: '10:00 AM - 2:00 PM'
  },
  {
    step: 3,
    day: 4,
    channel: 'PHONE',
    title: "Afternoon Dial (4:30 PM): 'How have you been?' Pattern Interrupt",
    instruction: "Direct phone dial to decision maker. Use pattern interrupt: 'Hey [Name], Sean Deardorff with Aflac in Springfield. How have you been?'",
    target_time: '4:30 PM'
  },
  {
    step: 4,
    day: 4,
    channel: 'EMAIL',
    title: 'Thread 1: Section 125 Mechanics & FICA Offset Primer',
    instruction: 'Send email primer explaining the 7.65% payroll tax savings on pre-tax employee voluntary premiums.',
    target_time: '5:00 PM'
  },
  {
    step: 5,
    day: 7,
    channel: 'PHONE',
    title: 'Morning Dial (10:15 AM): Stated Permission-Based Pitch',
    instruction: "Morning dial to DM: 'I know I caught you in the middle of your morning, do you have 27 seconds for why I called?'",
    target_time: '10:15 AM'
  },
  {
    step: 6,
    day: 9,
    channel: 'EMAIL',
    title: 'Thread 1 Reply: Local Greene County Case Study',
    instruction: 'Reply to Thread 1 citing anonymous local Greene County manufacturing/construction peer payroll case study.',
    target_time: '8:30 AM'
  },
  {
    step: 7,
    day: 11,
    channel: 'PHONE',
    title: '20-Second Targeted Voicemail Drop',
    instruction: "Leave concise voicemail referencing the mock check mailer and Section 125 payroll tax offset. Keep under 20 seconds.",
    target_time: '11:30 AM'
  },
  {
    step: 8,
    day: 14,
    channel: 'FIELD_DROP',
    title: 'Drop 2: Hand-deliver 1-Page Payroll Audit Brief (Ask 5 mins)',
    instruction: 'In-person field visit: Ask for 5 minutes with owner/DM to walk through the exact dollar savings for their W-2 headcount.',
    target_time: '1:30 PM - 3:30 PM'
  },
  {
    step: 9,
    day: 15,
    channel: 'PHONE',
    title: 'Post-Drop Callback Referencing Drop 2',
    instruction: "Phone dial: 'Hey [Name], dropped by your shop yesterday and left the 1-page payroll audit calculation with your front desk.'",
    target_time: '9:00 AM'
  },
  {
    step: 10,
    day: 18,
    channel: 'EMAIL',
    title: 'Thread 2: Simple Cafeteria Plan Safe Harbor Compliance Note',
    instruction: 'Send note highlighting that Section 125 Cafeteria plans carry zero direct employer setup fees and satisfy safe-harbor compliance.',
    target_time: '11:00 AM'
  },
  {
    step: 11,
    day: 20,
    channel: 'PHONE',
    title: 'Final Attempt & Opportunity-Cost Voicemail',
    instruction: 'Final dial and voicemail outlining the opportunity cost of delaying until Q4 open enrollment.',
    target_time: '3:45 PM'
  },
  {
    step: 12,
    day: 21,
    channel: 'EMAIL',
    title: 'Polite Breakup / Future Tax-Season File Close',
    instruction: 'Professional close-out email: Closing file for now; will follow up in 6 months ahead of annual tax renewal.',
    target_time: '9:00 AM'
  }
];

/**
 * Add days to an ISO YYYY-MM-DD date.
 */
export function addDaysToIso(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

/**
 * Calculate the next cadence step and target due date.
 *
 * @param {object} company - The company record
 * @param {number} [currentStep=0] - The current cadence step (0 = not started)
 * @param {string} [baseDate] - Reference date (YYYY-MM-DD), defaults to Springfield today
 * @returns {object} { next_step, step_info, next_due_date, cadence_status, is_completed }
 */
export function advanceCadence(companyOrStep, currentStepOrDisposition = null, baseDate = null) {
  let current = 0;
  let referenceDate = baseDate;

  if (typeof companyOrStep === 'number') {
    current = companyOrStep;
    if (typeof currentStepOrDisposition === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(currentStepOrDisposition)) {
      referenceDate = currentStepOrDisposition;
    }
  } else if (companyOrStep && typeof companyOrStep === 'object') {
    if (typeof currentStepOrDisposition === 'number') {
      current = currentStepOrDisposition;
    } else {
      current = Number(companyOrStep.cadence_stage || 0);
    }
  }

  if (!Number.isFinite(current) || current < 0) current = 0;

  const today = referenceDate || businessDate();

  if (current >= 12) {
    const finalStep = CADENCE_TOUCHES[11];
    return {
      next_step: 12,
      nextStage: 12,
      touch_step: 12,
      step_info: finalStep,
      channel: finalStep.channel,
      next_due_date: null,
      cadence_next_due_date: null,
      cadence_status: 'COMPLETED',
      is_completed: true,
      is_terminal: true
    };
  }

  const nextStep = current + 1;
  const stepInfo = CADENCE_TOUCHES[nextStep - 1] || CADENCE_TOUCHES[0];

  let dayDelta = 0;
  if (current === 0) {
    dayDelta = 0;
  } else {
    const prevStepInfo = CADENCE_TOUCHES[current - 1] || CADENCE_TOUCHES[0];
    dayDelta = (stepInfo.day || 0) - (prevStepInfo.day || 0);
  }

  const nextDueDate = addDaysToIso(today, Math.max(dayDelta, 0));

  return {
    next_step: nextStep,
    nextStage: nextStep,
    touch_step: nextStep,
    step_info: stepInfo,
    channel: stepInfo.channel,
    next_due_date: nextDueDate,
    cadence_next_due_date: nextDueDate,
    cadence_status: 'ACTIVE',
    is_completed: false,
    is_terminal: false
  };
}
