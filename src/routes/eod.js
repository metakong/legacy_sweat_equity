/**
 * GET /api/eod-debrief — the End-of-Day AI debrief.
 *
 * The Dynamics 365 Open Leads view has no Notes column, so the voice-journal
 * content never reaches the CRM. This endpoint is where that intelligence gets
 * read back: it takes the day's structured notes and turns them into a manager-
 * style report the agent reads before closing out.
 *
 * Two deliberate engineering choices:
 *
 * 1. The metrics are computed in SQL, not by the model. Language models are
 *    unreliable at arithmetic, and a debrief that misreports "12 doors" when
 *    the agent knocked 9 is worse than no debrief. The model is handed the
 *    finished numbers and asked to present them.
 *
 * 2. The day is bounded by businessDayRangeUtc(), never date('now','localtime').
 *    A Worker's "localtime" IS UTC, so a 6pm Springfield call is already
 *    tomorrow by that reckoning and would silently vanish from the report.
 */

import { Hono } from 'hono';
import { businessDate, businessDayRangeUtc, toLocalStamp } from '../lib/time.js';
import { DEFAULT_MODELS, ProviderError, chatCompletion } from '../lib/ai.js';
import { cleanCapped, parseJsonLoose } from '../lib/validate.js';

const eod = new Hono();

const SYSTEM_PROMPT = 'You are an elite B2B sales manager. Read the canvasser\'s daily log. '
  + 'Return a Markdown report with four sections: 1. A metrics table (Total Doors, DMs Met, '
  + 'Appointments). 2. A narrative summary highlighting the most valuable interactions and '
  + 'recommended next steps based on the voice notes. 3. 🎙️ Sales Coaching & Execution: A synthesized '
  + 'analysis of the agent\'s pitch delivery, objection handling, and areas for improvement based on the day\'s coaching feedback. '
  + '4. 📈 Territory Product Trends: A brief analysis of which specific Aflac product lines generated the most interest today across the territory.';

/**
 * Appended to the system prompt. The model controls prose, not facts: the
 * counts are already correct and must survive verbatim, and it must not invent
 * a company or a commitment that is not in the log.
 */
const GUARDRAILS = '\n\nRules:\n'
  + '- The metrics you are given are already computed and correct. Reproduce those exact numbers; never recount or estimate.\n'
  + '- Reference only companies, people and commitments that appear in the log. Never invent a name, a dollar figure, or a date.\n'
  + '- Output GitHub-flavored Markdown only: headings, a pipe table, bold, and bullet lists. No code fences, no HTML.\n'
  + '- CRITICAL B2B COMPLIANCE: You must actively redact, remove, and ignore any mention of specific medical conditions, health data, or individual employee names (other than the primary B2B Decision Maker). Replace any such instances with [REDACTED - PHI].\n'
  + '- Be concise and specific. This is read at the end of a long day.';

/** Deterministic counts. Everything the metrics table reports comes from here. */
function computeMetrics(rows) {
  const metrics = {
    total_doors: rows.length,
    accounts: new Set(rows.map((r) => r.company_id)).size,
    dms_met: 0,
    appointments: 0,
    in_person: 0,
    phone: 0,
    initial: 0,
    follow_up: 0,
    enrollments: 0,
    projected_ap: 0
  };

  for (const row of rows) {
    if (row.is_dm_contact) metrics.dms_met += 1;
    if (row.presentation_date || row.disposition === 'Presentation Scheduled') metrics.appointments += 1;
    if (row.enrollment_date || row.disposition === 'Enrolled') metrics.enrollments += 1;
    if (row.is_in_person) metrics.in_person += 1; else metrics.phone += 1;
    if (row.is_initial) metrics.initial += 1; else metrics.follow_up += 1;
    if (Number.isFinite(row.projected_ap)) metrics.projected_ap += row.projected_ap;
  }

  metrics.projected_ap = Math.round(metrics.projected_ap * 100) / 100;
  metrics.dm_contact_rate = rows.length
    ? `${Math.round((metrics.dms_met / rows.length) * 100)}%`
    : '0%';

  return metrics;
}

/** A compact, model-readable rendering of one touch. */
function describeActivity(row) {
  const notes = parseJsonLoose(row.ai_structured_notes) || {};
  return {
    time: toLocalStamp(row.timestamp).slice(11),
    company: row.company_name,
    contact: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.job_title || null,
    channel: row.is_in_person ? 'in person' : 'phone',
    touch: row.is_initial ? 'initial' : 'follow-up',
    reached: row.is_dm_contact ? 'decision maker' : 'gatekeeper/staff',
    disposition: row.disposition,
    rating: row.rating,
    employees: row.employees,
    industry: row.industry,
    presentation_date: row.presentation_date,
    enrollment_date: row.enrollment_date,
    projected_ap: row.projected_ap,
    summary: notes.summary || null,
    objections: notes.objections?.length ? notes.objections : null,
    next_action: notes.next_action || null,
    next_action_date: notes.next_action_date || null,
    key_facts: notes.key_facts?.length ? notes.key_facts : null,
    coaching_feedback: notes.coaching_feedback || null,
    product_interests: notes.product_interests?.length ? notes.product_interests : null,
    // Only when the structuring pass produced nothing usable — otherwise the
    // full transcript just burns context the summary already covers.
    transcript: notes.summary ? null : cleanCapped(row.raw_audio_transcription, 600, { allowNewlines: true })
  };
}

/** Locally-built report, used whenever the model is unavailable. */
function fallbackReport(date, metrics, activities) {
  const lines = [
    `# End-of-Day Debrief — ${date}`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Total Doors | ${metrics.total_doors} |`,
    `| DMs Met | ${metrics.dms_met} |`,
    `| Appointments | ${metrics.appointments} |`,
    `| Accounts Touched | ${metrics.accounts} |`,
    `| In Person / Phone | ${metrics.in_person} / ${metrics.phone} |`,
    `| Projected AP | $${metrics.projected_ap.toLocaleString('en-US')} |`,
    '',
    '## Activity',
    ''
  ];

  for (const activity of activities) {
    const bits = [`**${activity.company}** — ${activity.disposition}`];
    if (activity.contact) bits.push(`with ${activity.contact}`);
    if (activity.next_action) bits.push(`Next: ${activity.next_action}`);
    lines.push(`- ${bits.join(' · ')}`);
  }

  lines.push('', '_AI narrative unavailable — this is the locally computed report._');
  return lines.join('\n');
}

/**
 *   ?date=YYYY-MM-DD  a specific Springfield business day (default: today)
 */
eod.get('/', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const url = new URL(c.req.url);
  const date = url.searchParams.get('date') || businessDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return c.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }

  const { start, end } = businessDayRangeUtc(date);

  const { results } = await c.env.DB.prepare(`
    SELECT
      a.log_id, a.company_id, a.timestamp, a.disposition,
      a.is_in_person, a.is_initial, a.is_dm_contact,
      a.presentation_date, a.enrollment_date, a.projected_ap,
      a.raw_audio_transcription, a.ai_structured_notes,
      c.company_name, c.rating, c.employees, c.industry,
      ct.first_name, ct.last_name, ct.job_title
    FROM activity_logs a
    JOIN companies c ON c.company_id = a.company_id
    LEFT JOIN contacts ct ON ct.contact_id = COALESCE(
      a.contact_id,
      (SELECT contact_id FROM contacts z
       WHERE z.company_id = a.company_id AND z.agent_email = a.agent_email
       ORDER BY z.is_primary_dm DESC LIMIT 1)
    )
    WHERE a.timestamp >= ? AND a.timestamp < ? AND a.agent_email = ?
    ORDER BY a.timestamp ASC
    LIMIT 300
  `).bind(start, end, userEmail).all();

  const rows = results || [];
  const metrics = computeMetrics(rows);

  // Nothing logged: say so without paying for a model call.
  if (rows.length === 0) {
    return c.json({
      date,
      metrics,
      activity_count: 0,
      degraded: null,
      report: `# End-of-Day Debrief — ${date}\n\nNo activity logged for this business day.`
    }, 200, { 'Cache-Control': 'no-store' });
  }

  const activities = rows.map(describeActivity);

  let report = null;
  let degraded = null;

  try {
    report = await chatCompletion(c.env, {
      model: c.env.OPENROUTER_STRUCTURE_MODEL || DEFAULT_MODELS.structure,
      system: SYSTEM_PROMPT + GUARDRAILS,
      user: [
        `Business day: ${date} (Springfield, Missouri).`,
        '',
        'COMPUTED METRICS (authoritative — reproduce exactly):',
        JSON.stringify(metrics, null, 2),
        '',
        `DAILY LOG (${activities.length} ${activities.length === 1 ? 'touch' : 'touches'}):`,
        JSON.stringify(activities, null, 2)
      ].join('\n'),
      maxTokens: 1600,
      temperature: 0.3,
      timeoutMs: 60_000
    });
    if (!report || !report.trim()) {
      degraded = 'empty_model_response';
      report = null;
    }
  } catch (err) {
    console.error('EOD debrief generation failed:', err);
    degraded = err instanceof ProviderError && err.status === 503
      ? 'model_unconfigured'
      : 'model_unavailable';
  }

  // The numbers are already known, so a provider outage costs the narrative,
  // not the debrief.
  if (!report) report = fallbackReport(date, metrics, activities);

  return c.json({
    date,
    metrics,
    activity_count: rows.length,
    degraded,
    report
  }, 200, { 'Cache-Control': 'no-store' });
});

export default eod;
export { computeMetrics, fallbackReport };
