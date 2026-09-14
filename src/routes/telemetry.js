/**
 * GET /api/telemetry/daily — PowerApp field submission automation.
 *
 * Aggregates the exact fields required for the Aflac Sales Tool Belt PowerApp:
 * Initial/Follow-up In-Person, Phone Calls, DM Contacts, AP Projections,
 * Appointments Set, and Enrollments.
 *
 * When coordinator_present = 1, the touch counts toward BOTH the agent's core
 * metrics AND a separate coordinator_metrics block. This matches Aflac's
 * operational model where ride-along activities count for both individuals.
 *
 * Two disjoint sources are summed (same pattern as handleEodAggregates in
 * eod.js): activity_logs (3-tap field shell) and d365_daily_aggregates (voice
 * debriefs + quick drops). Summing cannot double-count; reading only one would
 * silently drop half a day.
 */

import { Hono } from 'hono';
import { businessDate, businessDayRangeUtc } from '../lib/time.js';

const telemetry = new Hono();

/** SQLite SUMs return NULL on empty sets; coerce to 0. */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 *   ?date=YYYY-MM-DD  a specific Springfield business day (default: today)
 */
telemetry.get('/', async (c) => {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  const url = new URL(c.req.url);
  const date = url.searchParams.get('date') || businessDate();

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }

  const { start, end } = businessDayRangeUtc(date);

  // ── Source 1: activity_logs (3-tap field shell) ──
  let alMetrics = {
    initial_in_person: 0,
    followup_in_person: 0,
    initial_phone: 0,
    followup_phone: 0,
    dm_contacts: 0,
    ap_projections: 0,
    appointments_set: 0,
    enrollments: 0,
    coordinator_touches: 0,
    coordinator_initial_in_person: 0,
    coordinator_followup_in_person: 0
  };
  let alDegraded = false;

  try {
    const row = await c.env.DB.prepare(`
      SELECT
        SUM(CASE WHEN is_in_person AND is_initial THEN 1 ELSE 0 END) AS initial_in_person,
        SUM(CASE WHEN is_in_person AND NOT is_initial THEN 1 ELSE 0 END) AS followup_in_person,
        SUM(CASE WHEN NOT is_in_person AND is_initial THEN 1 ELSE 0 END) AS initial_phone,
        SUM(CASE WHEN NOT is_in_person AND NOT is_initial THEN 1 ELSE 0 END) AS followup_phone,
        SUM(CASE WHEN is_dm_contact THEN 1 ELSE 0 END) AS dm_contacts,
        COALESCE(SUM(projected_ap), 0) AS ap_projections,
        SUM(CASE WHEN presentation_date IS NOT NULL OR disposition = 'Presentation Scheduled'
                 THEN 1 ELSE 0 END) AS appointments_set,
        SUM(CASE WHEN enrollment_date IS NOT NULL OR disposition = 'Enrolled'
                 THEN 1 ELSE 0 END) AS enrollments,
        SUM(CASE WHEN coordinator_present THEN 1 ELSE 0 END) AS coordinator_touches,
        SUM(CASE WHEN coordinator_present AND is_in_person AND is_initial THEN 1 ELSE 0 END) AS coordinator_initial_in_person,
        SUM(CASE WHEN coordinator_present AND is_in_person AND NOT is_initial THEN 1 ELSE 0 END) AS coordinator_followup_in_person
      FROM activity_logs
      WHERE timestamp >= ? AND timestamp < ? AND agent_email = ?
    `).bind(start, end, userEmail).first();

    if (row) {
      alMetrics = {
        initial_in_person: toCount(row.initial_in_person),
        followup_in_person: toCount(row.followup_in_person),
        initial_phone: toCount(row.initial_phone),
        followup_phone: toCount(row.followup_phone),
        dm_contacts: toCount(row.dm_contacts),
        ap_projections: Math.round(Number(row.ap_projections || 0) * 100) / 100,
        appointments_set: toCount(row.appointments_set),
        enrollments: toCount(row.enrollments),
        coordinator_touches: toCount(row.coordinator_touches),
        coordinator_initial_in_person: toCount(row.coordinator_initial_in_person),
        coordinator_followup_in_person: toCount(row.coordinator_followup_in_person)
      };
    }
  } catch (err) {
    console.error('Daily telemetry activity_logs query failed:', err);
    alDegraded = true;
  }

  // ── Source 2: d365_daily_aggregates (voice debriefs + quick drops) ──
  let aggMetrics = { walk_ins: 0, dm_contacts: 0, phone_dials: 0, appointments_set: 0 };
  let aggDegraded = false;

  try {
    const row = await c.env.DB.prepare(`
      SELECT walk_ins, dm_contacts, phone_dials, appointments_set
      FROM d365_daily_aggregates
      WHERE business_date = ? AND agent_email = ?
      LIMIT 1
    `).bind(date, userEmail).first();

    if (row) {
      aggMetrics = {
        walk_ins: toCount(row.walk_ins),
        dm_contacts: toCount(row.dm_contacts),
        phone_dials: toCount(row.phone_dials),
        appointments_set: toCount(row.appointments_set)
      };
    }
  } catch (err) {
    console.error('Daily telemetry d365_daily_aggregates query failed:', err);
    aggDegraded = true;
  }

  // ── Merge: sum disjoint sources ──
  const hasCoordinator = alMetrics.coordinator_touches > 0;

  return c.json({
    success: true,
    business_date: date,
    powerapp_fields: {
      initial_in_person: alMetrics.initial_in_person + aggMetrics.walk_ins,
      followup_in_person: alMetrics.followup_in_person,
      initial_phone: alMetrics.initial_phone + aggMetrics.phone_dials,
      followup_phone: alMetrics.followup_phone,
      dm_contacts: alMetrics.dm_contacts + aggMetrics.dm_contacts,
      ap_projections: alMetrics.ap_projections,
      appointments_set: alMetrics.appointments_set + aggMetrics.appointments_set,
      enrollments: alMetrics.enrollments
    },
    coordinator_metrics: {
      joint_field_work: hasCoordinator,
      coordinator_touches: alMetrics.coordinator_touches,
      coordinator_initial_in_person: alMetrics.coordinator_initial_in_person,
      coordinator_followup_in_person: alMetrics.coordinator_followup_in_person
    },
    sources: {
      activity_logs: !alDegraded,
      d365_daily_aggregates: !aggDegraded,
      degraded: [
        alDegraded ? 'activity_logs' : null,
        aggDegraded ? 'd365_daily_aggregates' : null
      ].filter(Boolean)
    }
  }, 200, { 'Cache-Control': 'no-store' });
});

export default telemetry;
