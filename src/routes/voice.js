/**
 * Voice debrief — one atomic path from an audio blob to the CRM.
 *
 *   multipart audio -> Groq whisper-large-v3-turbo      -> transcript
 *                   -> OpenRouter strict JSON object    -> structured intel
 *                   -> ONE D1 batch                     -> company + activity
 *                                                          + compliance counters
 *
 * WHY A BATCH AND NOT THREE AWAITS
 * A partial write here is worse than no write. If the activity landed but the
 * counter did not, D365 compliance quietly under-reports a dial the agent
 * actually made; if the counter landed but the activity did not, the day's
 * numbers cannot be reconstructed. D1's batch() is a single transaction, so
 * either all three land or none do.
 *
 * WHY NOT activity_logs
 * activity_logs.company_id is NOT NULL and foreign-keyed, which is right for a
 * touch that is always against an account. A debrief recorded between stops has
 * no account yet, so voice events go to the append-only `activities` table
 * instead. The D365 Tier 1/2/3 exports keep reading activity_logs, untouched.
 */

import { Hono } from 'hono';
import { LIMITS, asId, cleanCapped } from '../lib/validate.js';
import {
  ProviderError,
  transcribeAudio,
  extractVoiceIntelligence,
  audioExtensionFor
} from '../lib/ai.js';
import { businessDate } from '../lib/time.js';

const voice = new Hono();

const VOICE_MODES = ['PHONE', 'FIELD'];

/** Primary-verb + disposition -> the coarse bucket D365 compliance counts. */
export const ACTIVITY_TYPES = [
  'PHONE_DIAL',
  'PHONE_DM_TOUCH',
  'FIELD_WALK_IN',
  'FIELD_DM_TOUCH',
  'PRESENTATION',
  'CLOSED_WON',
  'DISQUALIFIED'
];

/**
 * Map one interaction to its compliance bucket.
 *
 * The primary verb is what happened physically — a dial or a walk-in — and the
 * decision-maker flag is what the disposition adds. Collapsing both into one
 * column would make "30 walk-ins, 6 DM conversations" impossible to report.
 */
export function mapVoiceActivityType(mode, disposition) {
  const field = mode === 'FIELD';

  if (disposition === 'PRESENTATION') return 'PRESENTATION';
  if (disposition === 'CLOSED_WON') return 'CLOSED_WON';
  if (disposition === 'DISQUALIFIED') return 'DISQUALIFIED';
  if (disposition === 'DM_TOUCH') return field ? 'FIELD_DM_TOUCH' : 'PHONE_DM_TOUCH';

  return field ? 'FIELD_WALK_IN' : 'PHONE_DIAL';
}

/** FormData delivers every scalar as a string; '' and 'null' mean "absent". */
function formText(form, key) {
  const raw = form.get(key);
  if (raw === null || raw === undefined) return '';
  const text = String(raw).trim();
  return ['', 'null', 'undefined'].includes(text) ? '' : text;
}

/**
 * POST /api/voice-debrief   (multipart/form-data)
 *   audio       required  File/Blob
 *   company_id  optional  existing account; the debrief is stored unlinked if absent
 *   mode        optional  'PHONE' | 'FIELD' (defaults to PHONE)
 */
export async function handleVoiceDebrief(c) {
  const userEmail = c.get('userEmail');
  if (!userEmail) return c.json({ error: 'Unauthorized' }, 401);

  let form;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }

  const audio = form.get('audio');
  if (!audio || typeof audio === 'string' || typeof audio.arrayBuffer !== 'function') {
    return c.json({ error: 'Missing audio file' }, 400);
  }
  if (audio.size === 0) return c.json({ error: 'Empty audio file' }, 400);
  if (audio.size > LIMITS.audioBytes) {
    return c.json({ error: 'Audio exceeds 20MB limit' }, 413);
  }

  const modeRaw = formText(form, 'mode').toUpperCase();
  const mode = VOICE_MODES.includes(modeRaw) ? modeRaw : 'PHONE';

  const companyIdText = formText(form, 'company_id');
  let companyId = null;
  if (companyIdText) {
    companyId = asId(companyIdText);
    if (!companyId) return c.json({ error: 'Invalid company_id' }, 400);
  }

  // Resolve the account BEFORE paying for two model calls. An unknown id must
  // cost one indexed read, not a transcription and a completion.
  let company = null;
  if (companyId) {
    company = await c.env.DB
      .prepare('SELECT company_id, company_name FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1')
      .bind(companyId, userEmail)
      .first();

    if (!company) return c.json({ error: 'Unknown company_id' }, 404);
  }

  let transcript;
  try {
    transcript = (await transcribeAudio(audio, { env: c.env })).text;
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json(
        { error: err.message, stage: 'transcription', detail: err.detail || null },
        err.status === 503 ? 503 : 502
      );
    }
    console.error('Voice transcription failed:', err);
    return c.json({ error: 'Transcription failed', stage: 'transcription' }, 502);
  }

  let degraded = null;
  let extracted;
  try {
    extracted = await extractVoiceIntelligence(
      transcript,
      { mode, company_id: companyId, company_name: company?.company_name || null },
      c.env
    );
    if (!c.env.OPENROUTER_API_KEY && !c.env.VOICE_INTELLIGENCE_MOCK) {
      degraded = 'structuring_unconfigured';
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      return c.json(
        { error: err.message, stage: 'extraction', detail: err.detail || null },
        err.status === 503 ? 503 : 502
      );
    }
    console.error('Voice extraction failed:', err);
    return c.json({ error: 'Voice extraction failed', stage: 'extraction' }, 502);
  }

  // Keep the raw capture so a bad structuring run can be replayed later without
  // another field visit. Best effort: a storage hiccup must never cost the log.
  const filename = `voice-${crypto.randomUUID()}.${audioExtensionFor(audio.type)}`;
  if (c.env.BUCKET && c.env.STORE_AUDIO !== '0') {
    try {
      await c.env.BUCKET.put(filename, await audio.arrayBuffer(), {
        httpMetadata: { contentType: audio.type || 'audio/webm' }
      });
    } catch (err) {
      console.error('R2 voice archive failed (non-fatal):', err);
    }
  }

  const activityType = mapVoiceActivityType(mode, extracted.disposition);
  const counters = extracted.d365_counters;
  const isDisqualified = extracted.disposition === 'DISQUALIFIED';
  const storedTranscript = cleanCapped(transcript, LIMITS.transcript, { allowNewlines: true })
    || transcript.slice(0, LIMITS.transcript);

  let companyUpdated = false;
  let activityId = null;

  // Statement CONSTRUCTION is inside the guard as well as execution: a missing
  // column or table surfaces at prepare/bind time, and that failure has to be a
  // clean 500 with nothing written, not an unhandled throw from inside the batch.
  try {
    const statements = [];

    if (companyId) {
      // COALESCE semantics: the model returns null for everything it could not
      // confirm, and a null must never erase intelligence the agent already has.
      statements.push(c.env.DB.prepare(`
        UPDATE companies SET
          confidence_score          = ?,
          verification_status       = ?,
          decision_maker            = COALESCE(?, decision_maker),
          current_voluntary_carrier = COALESCE(?, current_voluntary_carrier),
          major_medical_carrier     = COALESCE(?, major_medical_carrier),
          is_hdhp                   = COALESCE(?, is_hdhp),
          estimated_w2_count        = COALESCE(?, estimated_w2_count),
          status                    = CASE WHEN ? = 1 THEN 'DISQUALIFIED' ELSE status END
        WHERE company_id = ? AND agent_email = ?
      `).bind(
        extracted.confidence_score,
        extracted.verification_status,
        extracted.decision_maker_name,
        extracted.current_voluntary_carrier,
        extracted.major_medical_carrier,
        extracted.is_hdhp === null ? null : (extracted.is_hdhp ? 1 : 0),
        extracted.estimated_w2_count,
        isDisqualified ? 1 : 0,
        companyId,
        userEmail
      ));
      companyUpdated = true;
    }

    statements.push(c.env.DB.prepare(`
      INSERT INTO activities (
        company_id, agent_email, activity_type, mode, notes, outcome,
        raw_transcript, extracted_json, next_action, next_action_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      companyId,
      userEmail,
      activityType,
      mode,
      extracted.summary_notes,
      extracted.disposition,
      storedTranscript,
      JSON.stringify(extracted),
      extracted.next_action,
      extracted.next_action_date
    ));

    const activityStatementIndex = statements.length - 1;

    // Counters accumulate on the Springfield business date, never UTC: an 8 PM
    // CDT phone block belongs to the day the agent worked.
    statements.push(c.env.DB.prepare(`
      INSERT INTO d365_daily_aggregates (
        business_date, agent_email, phone_dials, dm_contacts, walk_ins, appointments_set, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(business_date, agent_email) DO UPDATE SET
        phone_dials      = d365_daily_aggregates.phone_dials + excluded.phone_dials,
        dm_contacts      = d365_daily_aggregates.dm_contacts + excluded.dm_contacts,
        walk_ins         = d365_daily_aggregates.walk_ins + excluded.walk_ins,
        appointments_set = d365_daily_aggregates.appointments_set + excluded.appointments_set,
        updated_at       = datetime('now')
    `).bind(
      businessDate(),
      userEmail,
      counters.phone_dials,
      counters.dm_contacts,
      counters.walk_ins,
      counters.appointments_set
    ));

    const results = await c.env.DB.batch(statements);
    activityId = results?.[activityStatementIndex]?.meta?.last_row_id ?? null;
  } catch (err) {
    console.error('Voice debrief commit failed:', err);
    return c.json({ error: 'Voice debrief could not be committed', stage: 'commit' }, 500);
  }

  return c.json({
    success: true,
    degraded,
    transcript,
    extracted,
    company_id: companyId,
    activity_id: activityId,
    activity_type: activityType,
    audio_key: c.env.BUCKET && c.env.STORE_AUDIO !== '0' ? filename : null,
    company_updated: companyUpdated
  });
}

voice.post('/', handleVoiceDebrief);

export default voice;
