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
 * A real calendar day, not merely the right shape.
 *
 * Date.parse rolls 2026-02-31 over to March 3 rather than rejecting it, so a
 * format check alone would accept a day that does not exist and then report
 * another day's counters under its heading.
 */
function isValidBusinessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;

  return parsed.toISOString().slice(0, 10) === value;
}

/**
 *   ?date=YYYY-MM-DD  a specific Springfield business day (default: today)
 */
eod.get('/', async (c) => {
  const userEmail = c.get('userEmail'); if (!userEmail) return c.json({error: 'Unauthorized'}, 401);
  const url = new URL(c.req.url);
  const date = url.searchParams.get('date') || businessDate();

  if (!isValidBusinessDate(date)) {
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

// ---------------------------------------------------------------------
// GET /api/eod-aggregates — the D365 compliance block
// ---------------------------------------------------------------------

/**
 * The counters the agent pastes into Dynamics 365 at close of day.
 *
 * TWO SOURCES, ON PURPOSE
 * `d365_daily_aggregates` counts what Agency OS wrote — voice debriefs and
 * quick drops. `activity_logs` counts what the legacy field shell wrote. The
 * two are disjoint by construction: the voice and quick-drop paths never touch
 * activity_logs, and the legacy /api/transcribe-and-log path never touches the
 * counters. So summing them cannot double-count a touch, and reading only one
 * would silently drop half a day's numbers — an agent who logs three doors in
 * the legacy shell and forty dials in the dialer must see forty-three.
 *
 * BOTH READS DEGRADE TO ZERO
 * On a deployment where migrations/0005 has not been applied,
 * d365_daily_aggregates does not exist. An error page is the wrong answer there:
 * the legacy half of the report is still true, so it is returned with the
 * missing source named in `sources.degraded`.
 */

const EMPTY_COUNTERS = { walk_ins: 0, dm_contacts: 0, phone_dials: 0, appointments_set: 0 };

/** Counters are SQLite SUMs; a NULL from an empty day is not a number. */
function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeCounters(row) {
  return {
    walk_ins: toCount(row?.walk_ins),
    dm_contacts: toCount(row?.dm_contacts),
    phone_dials: toCount(row?.phone_dials),
    appointments_set: toCount(row?.appointments_set)
  };
}

/** Voice debriefs + quick drops. Keyed to the Springfield business date. */
async function readAggregateCounters(env, userEmail, date) {
  try {
    const row = await env.DB.prepare(`
      SELECT walk_ins, dm_contacts, phone_dials, appointments_set
      FROM d365_daily_aggregates
      WHERE business_date = ? AND agent_email = ?
      LIMIT 1
    `).bind(date, userEmail).first();

    return { ...normalizeCounters(row), degraded: false };
  } catch (err) {
    console.error('EOD aggregate counters unavailable (treating as zero):', err);
    return { ...EMPTY_COUNTERS, degraded: true };
  }
}

/**
 * The legacy shell's touches, derived with the same definitions computeMetrics()
 * uses for the narrative debrief so the two reports can never disagree:
 * a door is in-person, a DM contact is a DM contact, and a dial is anything
 * that was not in person.
 */
async function readLegacyCounters(env, userEmail, date) {
  const { start, end } = businessDayRangeUtc(date);

  try {
    const row = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN is_in_person THEN 1 ELSE 0 END) AS walk_ins,
        SUM(CASE WHEN is_dm_contact THEN 1 ELSE 0 END) AS dm_contacts,
        SUM(CASE WHEN is_in_person THEN 0 ELSE 1 END) AS phone_dials,
        SUM(CASE WHEN presentation_date IS NOT NULL OR disposition = 'Presentation Scheduled'
                 THEN 1 ELSE 0 END) AS appointments_set
      FROM activity_logs
      WHERE timestamp >= ? AND timestamp < ? AND agent_email = ?
    `).bind(start, end, userEmail).first();

    return { ...normalizeCounters(row), degraded: false };
  } catch (err) {
    console.error('EOD legacy counters unavailable (treating as zero):', err);
    return { ...EMPTY_COUNTERS, degraded: true };
  }
}

/**
 *   ?date=YYYY-MM-DD  a specific Springfield business day (default: today)
 */
export async function handleEodAggregates(c) {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  const url = new URL(c.req.url);
  const date = url.searchParams.get('date') || businessDate();

  if (!isValidBusinessDate(date)) {
    return c.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }

  const agency = await readAggregateCounters(c.env, userEmail, date);
  const legacy = await readLegacyCounters(c.env, userEmail, date);

  const degraded = [
    agency.degraded ? 'd365_daily_aggregates' : null,
    legacy.degraded ? 'activity_logs' : null
  ].filter(Boolean);

  return c.json({
    success: true,
    date,
    walk_ins: agency.walk_ins + legacy.walk_ins,
    dm_contacts: agency.dm_contacts + legacy.dm_contacts,
    phone_dials: agency.phone_dials + legacy.phone_dials,
    appointments_set: agency.appointments_set + legacy.appointments_set,
    // The merge is shown, not implied: when a total looks wrong the first
    // question is always "which half is missing?".
    sources: {
      voice_and_quick_drops: {
        walk_ins: agency.walk_ins,
        dm_contacts: agency.dm_contacts,
        phone_dials: agency.phone_dials,
        appointments_set: agency.appointments_set
      },
      legacy_shell: {
        walk_ins: legacy.walk_ins,
        dm_contacts: legacy.dm_contacts,
        phone_dials: legacy.phone_dials,
        appointments_set: legacy.appointments_set
      },
      degraded
    }
  }, 200, { 'Cache-Control': 'no-store' });
}

eod.get('/aggregates', handleEodAggregates);

// ---------------------------------------------------------------------
// GET /api/eod-debrief/weekly-pipeline — deterministic pipeline review
// ---------------------------------------------------------------------

/**
 * Generates a Markdown "Weekly Pipeline Status" block the agent pastes into
 * their pipeline review. No AI call — this is deterministic SQL → Markdown,
 * so it works with zero provider keys.
 *
 * Groups active accounts by pipeline stage (PROPOSAL, CLOSED_WON) with
 * forecast_ap from the companies table (deal-level, not touch-level).
 */
eod.get('/weekly-pipeline', async (c) => {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  const today = businessDate();

  const { results } = await c.env.DB.prepare(`
    SELECT
      c.company_id,
      c.company_name,
      c.pipeline_stage,
      c.forecast_ap,
      c.stage_entered_at,
      CAST(
        ROUND(julianday('${today}') - julianday(COALESCE(c.stage_entered_at, c.created_at, '${today}')))
      AS INTEGER) AS days_in_stage,
      (SELECT al.next_action_text FROM activity_logs al
       WHERE al.company_id = c.company_id AND al.agent_email = c.agent_email
       ORDER BY al.timestamp DESC LIMIT 1) AS latest_next_action
    FROM companies c
    WHERE c.agent_email = ?
      AND c.pipeline_stage IN ('PROSPECT', 'ENGAGED', 'QUALIFIED', 'PROPOSAL', 'CLOSED_WON')
      AND (c.snoozed_until IS NULL OR c.snoozed_until <= '${today}')
    ORDER BY
      CASE c.pipeline_stage
        WHEN 'CLOSED_WON' THEN 1
        WHEN 'PROPOSAL' THEN 2
        WHEN 'QUALIFIED' THEN 3
        WHEN 'ENGAGED' THEN 4
        WHEN 'PROSPECT' THEN 5
      END,
      COALESCE(c.forecast_ap, 0) DESC,
      c.company_name COLLATE NOCASE
    LIMIT 500
  `).bind(userEmail).all();

  const rows = Array.isArray(results) ? results : [];

  if (rows.length === 0) {
    return c.json({
      success: true,
      date: today,
      markdown: `## Weekly Pipeline Status — ${today}\n\nNo active deals in the pipeline.`,
      stages: {},
      total_ap: 0
    }, 200, { 'Cache-Control': 'no-store' });
  }

  // Group by stage
  const grouped = {};
  let totalAp = 0;

  for (const row of rows) {
    const stage = row.pipeline_stage;
    if (!grouped[stage]) grouped[stage] = { rows: [], ap: 0 };
    grouped[stage].rows.push(row);
    const ap = Number(row.forecast_ap) || 0;
    grouped[stage].ap += ap;
    totalAp += ap;
  }

  totalAp = Math.round(totalAp * 100) / 100;

  // Build Markdown
  const lines = [`## Weekly Pipeline Status — ${today}`, ''];

  // Render stages in pipeline order (most advanced first)
  const STAGE_ORDER = ['CLOSED_WON', 'PROPOSAL', 'QUALIFIED', 'ENGAGED', 'PROSPECT'];
  for (const stage of STAGE_ORDER) {
    const group = grouped[stage];
    if (!group) continue;

    const stageAp = Math.round(group.ap * 100) / 100;
    const label = stage.replace(/_/g, ' ');
    lines.push(`### ${label} (${group.rows.length} ${group.rows.length === 1 ? 'account' : 'accounts'} · $${stageAp.toLocaleString('en-US')} projected AP)`);
    lines.push('');
    lines.push('| Account | Days in Stage | Projected AP | Next Action |');
    lines.push('|---------|--------------|-------------|-------------|');

    for (const row of group.rows) {
      const ap = Number(row.forecast_ap) || 0;
      const apStr = `$${ap.toLocaleString('en-US')}`;
      const days = row.days_in_stage ?? '—';
      const next = row.latest_next_action || '—';
      lines.push(`| ${row.company_name} | ${days} | ${apStr} | ${next} |`);
    }

    lines.push('');
  }

  lines.push(`**Total Pipeline AP: $${totalAp.toLocaleString('en-US')}**`);

  const markdown = lines.join('\n');

  // Structured response for programmatic consumers
  const stages = {};
  for (const [stage, group] of Object.entries(grouped)) {
    stages[stage] = {
      count: group.rows.length,
      forecast_ap: Math.round(group.ap * 100) / 100,
      accounts: group.rows.map((r) => ({
        company_id: r.company_id,
        company_name: r.company_name,
        forecast_ap: Number(r.forecast_ap) || 0,
        days_in_stage: r.days_in_stage,
        next_action: r.latest_next_action || null
      }))
    };
  }

  return c.json({
    success: true,
    date: today,
    markdown,
    stages,
    total_ap: totalAp
  }, 200, { 'Cache-Control': 'no-store' });
});

export default eod;
export { computeMetrics, fallbackReport };
