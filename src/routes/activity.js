/**
 * Activity logging — the heart of the app.
 *
 * Three doors write activity_logs:
 *   POST /api/transcribe-and-log  voice journal -> Groq -> OpenRouter -> D1
 *   POST /api/sync                offline IndexedDB queue drain
 *   POST /api/activity            a plain silent log
 *
 * Guiding rule: a field visit is never lost. If Groq or OpenRouter is down,
 * the log still lands with the disposition derived from the 3-Tap Binary and
 * the response says which stage degraded. Losing the touch because a model
 * provider had a bad minute is strictly worse than losing the AI polish.
 */

import { Hono } from 'hono';
import {
  LIMITS,
  RATINGS,
  DISPOSITIONS,
  SYNC_TIERS,
  cleanCapped,
  matchEnum,
  toBool,
  asId,
  asIsoDate,
  asMoney,
  deriveDisposition,
  parseJsonLoose
} from '../lib/validate.js';
import {
  ValidationError,
  ACTIVITY_SELECT,
  normalizeCompany,
  normalizeContact,
  normalizeActivityLog,
  upsertCompany,
  upsertContact,
  upsertActivityLog,
  setCompanyRating,
  setCompanyRenewalDate,
  calculateRenewalDate,
  inferTargetPipelineStage,
  autoAdvancePipelineStage,
  companyExists
} from '../lib/db.js';
import { businessDate, businessDayRangeUtc } from '../lib/time.js';
import { DEFAULT_MODELS, ProviderError, transcribeAudio, chatCompletion, geocodeAddress } from '../lib/ai.js';

/** Mounted at /api/activity — reads, silent logs, tier bookkeeping. */
const activity = new Hono();

/**
 * Mounted at /api — the two endpoints whose paths are part of the external
 * contract and must sit at the API root, not under /api/activity.
 */
export const root = new Hono();

// Containers MediaRecorder actually produces, plus what a desktop mic app
// might upload. Groq sniffs the container, so the extension has to be right.
const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/flac': 'flac'
};

const extensionFor = (mimeType) => {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return AUDIO_EXTENSIONS[base] || 'webm';
};

// ---------------------------------------------------------------------
// LLM STRUCTURING PASS
// ---------------------------------------------------------------------

export const AFLAC_PRODUCTS = [
  'Accident',
  'Cancer',
  'Critical Illness',
  'Hospital Indemnity',
  'Short-Term Disability',
  'Life',
  'Dental/Vision'
];

/**
 * The system prompt is written as a hard contract because its output is
 * inserted into a CRM. Enum values are restated verbatim, and the model is
 * told to prefer null over a guess — a hallucinated $8,400 projected AP is
 * far more damaging than an empty cell.
 */
const buildStructuringPrompt = (today) => `You are a CRM data-entry and sales coaching engine for an independent Aflac insurance agent working B2B accounts in Springfield, Missouri. You will receive either a dictated summary from the agent OR a raw ambient transcript of a live sales conversation. You convert it into one strict JSON object.

Today's date is ${today} (America/Chicago). Resolve every relative date ("next Tuesday", "in two weeks") against it and emit YYYY-MM-DD.

Return ONLY a JSON object with exactly these keys:
{
  "disposition": one of ${JSON.stringify(DISPOSITIONS)},
  "rating": one of ${JSON.stringify(RATINGS)},
  "presentation_date": "YYYY-MM-DD" or null,
  "enrollment_date": "YYYY-MM-DD" or null,
  "projected_ap": number (annualized premium in USD) or null,
  "contact": { "first_name": string|null, "last_name": string|null, "job_title": string|null, "phone_number": string|null, "email_address": string|null } or null,
  "summary": string (2-3 sentences, third person, factual),
  "objections": array of short strings (max 5, [] if none),
  "next_action": string (imperative, one line) or null,
  "next_action_date": "YYYY-MM-DD" or null,
  "key_facts": array of short strings (max 5, [] if none),
  "coaching_feedback": "string (1-2 sentences of direct, actionable critique on the agent's pitch, tone, or objection handling if a live conversation was recorded. Emit null if it was just a dictated note) or null",
  "product_interests": "array of strings (only pick from: 'Accident', 'Cancer', 'Critical Illness', 'Hospital Indemnity', 'Short-Term Disability', 'Life', 'Dental/Vision') or []"
}

Rules:
- Use ONLY the listed enum values. Never invent a disposition or rating.
- Rating guide: "Hot" = decision maker engaged and a date is set; "Warm" = decision maker interested, no date; "Cold" = no decision-maker traction.
- Emit null for anything not clearly stated. Do not infer premium, headcount, or names.
- "projected_ap" is annualized premium. If a monthly figure is spoken, multiply by 12.
- Tag a product in 'product_interests' only if the decision maker explicitly asked a question about it or showed positive reception. Do not tag products you merely pitched without engagement.
- CRITICAL B2B COMPLIANCE: You must actively redact, remove, and ignore any mention of specific medical conditions, health data, or individual employee names (other than the primary B2B Decision Maker). Replace any such instances with [REDACTED - PHI].
- Never include commentary, markdown, or code fences. JSON only.`;

/**
 * Run the structuring pass and hard-validate everything that comes back.
 * A model is not a validator, so every field is re-checked against the same
 * coercers the manual paths use.
 */
async function structureTranscript(env, transcript, booleans) {
  const today = businessDate();
  const raw = await chatCompletion(env, {
    taskTier: 'simple',
    model: env.OPENROUTER_STRUCTURE_MODEL || DEFAULT_MODELS.simple || DEFAULT_MODELS.structure,
    system: buildStructuringPrompt(today),
    user: [
      `Contact channel: ${booleans.is_in_person ? 'in person' : 'phone call'}`,
      `Touch type: ${booleans.is_initial ? 'initial contact' : 'follow-up'}`,
      `Reached: ${booleans.is_dm_contact ? 'the decision maker' : 'a gatekeeper or staff member'}`,
      '',
      'Field note transcript:',
      transcript
    ].join('\n'),
    json: true,
    maxTokens: 900
  });

  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const asShortList = (value, max) => (Array.isArray(value)
    ? value.filter((v) => typeof v === 'string' && v.trim()).slice(0, max).map((v) => v.trim().slice(0, 200))
    : []);

  return {
    disposition: matchEnum(parsed.disposition, DISPOSITIONS) || deriveDisposition(booleans),
    rating: matchEnum(parsed.rating, RATINGS),
    presentation_date: asIsoDate(parsed.presentation_date),
    enrollment_date: asIsoDate(parsed.enrollment_date),
    projected_ap: asMoney(parsed.projected_ap),
    contact: parsed.contact && typeof parsed.contact === 'object' ? parsed.contact : null,
    notes: {
      summary: cleanCapped(parsed.summary, 1500, { allowNewlines: true }) || '',
      objections: asShortList(parsed.objections, 5),
      next_action: cleanCapped(parsed.next_action, 300),
      next_action_date: asIsoDate(parsed.next_action_date),
      key_facts: asShortList(parsed.key_facts, 5),
      coaching_feedback: cleanCapped(parsed.coaching_feedback, 1000),
      product_interests: Array.isArray(parsed.product_interests)
        ? parsed.product_interests.filter((p) => AFLAC_PRODUCTS.includes(p))
        : []
    }
  };
}

// ---------------------------------------------------------------------
// POST /api/transcribe-and-log
// ---------------------------------------------------------------------

/**
 * FormData fields:
 *   audio          (File)     Mono Opus capture from MediaRecorder — required
 *   is_in_person   (bool)     required
 *   is_initial     (bool)     required
 *   is_dm_contact  (bool)     required
 *   company_id     (string)   existing account; OR
 *   company        (JSON)     a net-new account to create in the same call
 *   contact_id     (string)   optional, pins the log to a known person
 *   log_id         (string)   optional client-generated id, makes retries idempotent
 *   timestamp      (string)   optional ISO capture time (queued-offline case)
 */
root.post('/transcribe-and-log', async (c) => {
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

  const booleans = {
    is_in_person: toBool(form.get('is_in_person')),
    is_initial: toBool(form.get('is_initial')),
    is_dm_contact: toBool(form.get('is_dm_contact'))
  };

  // Resolve the account first: a log with no valid company_id violates the FK
  // and would 500 after we had already paid for transcription.
  let companyId = asId(form.get('company_id'));
  const companyRaw = form.get('company');
  if (companyRaw) {
    try {
      let parsedCompany = companyRaw;
      if (typeof parsedCompany === 'string') {
        const trimmed = parsedCompany.trim();
        if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') {
          try {
            parsedCompany = JSON.parse(trimmed);
          } catch {
            throw new ValidationError('Malformed company JSON payload');
          }
        } else {
          parsedCompany = null;
        }
      }
      if (parsedCompany && typeof parsedCompany === 'object') {
        if ((!parsedCompany.lat || !parsedCompany.long) && parsedCompany.street_1) {
          const fullAddress = [parsedCompany.street_1, parsedCompany.city || 'Springfield', parsedCompany.state || 'MO', parsedCompany.zip_code]
            .filter(Boolean)
            .join(', ');
          try {
            const coords = await geocodeAddress(c.env, fullAddress);
            if (coords) {
              parsedCompany.lat = coords.lat;
              parsedCompany.long = coords.long;
            }
          } catch (geoErr) {
            console.warn('Geocoding address failed (non-fatal):', geoErr);
          }
        }
        const company = normalizeCompany({ ...parsedCompany, company_id: companyId || parsedCompany.company_id || undefined });
        await upsertCompany(c.env.DB, company);
        companyId = company.company_id;
      }
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      console.error('Failed to process company in transcribe-and-log:', err);
      return c.json({ error: 'Malformed company payload' }, 400);
    }
  }

  if (!companyId) return c.json({ error: 'company_id or company payload is required' }, 400);
  if (!(await companyExists(c.env.DB, companyId))) {
    return c.json({ error: 'Unknown company_id' }, 400);
  }

  const logId = asId(form.get('log_id')) || crypto.randomUUID();
  let contactId = asId(form.get('contact_id'));
  const filename = `journal-${logId}.${extensionFor(audio.type)}`;

  // Keep the raw capture. Model output is reproducible from it, so a bad
  // structuring run can be replayed later without another field visit.
  if (c.env.BUCKET && c.env.STORE_AUDIO !== '0') {
    try {
      await c.env.BUCKET.put(filename, await audio.arrayBuffer(), {
        httpMetadata: { contentType: audio.type || 'audio/webm' }
      });
    } catch (err) {
      console.error('R2 audio archive failed (non-fatal):', err);
    }
  }

  let transcript = null;
  let structured = null;
  let degraded = null;

  try {
    transcript = await transcribeAudio(c.env, audio, filename);
    if (!transcript) degraded = 'empty_transcript';
  } catch (err) {
    console.error('Transcription failed:', err);
    degraded = err instanceof ProviderError && err.status === 503
      ? 'transcription_unconfigured'
      : 'transcription_failed';
  }

  if (transcript) {
    try {
      structured = await structureTranscript(c.env, transcript, booleans);
      if (!structured) degraded = 'structuring_unparseable';
    } catch (err) {
      console.error('Structuring failed:', err);
      degraded = err instanceof ProviderError && err.status === 503
        ? 'structuring_unconfigured'
        : 'structuring_failed';
    }
  }

  // The AI often names the person the agent just met. Attach them so the
  // Tier 1 clipboard row carries a real contact instead of a blank column.
  if (structured?.contact && !contactId) {
    const contact = normalizeContact(structured.contact, companyId);
    if (contact) {
      contact.is_primary_dm = booleans.is_dm_contact;
      contactId = await upsertContact(c.env.DB, contact);
    }
  }

  const manualDisposition = matchEnum(form.get('manual_disposition') || form.get('disposition'), DISPOSITIONS);
  const finalDisposition = manualDisposition || structured?.disposition || deriveDisposition(booleans);

  const log = normalizeActivityLog({
    log_id: logId,
    company_id: companyId,
    contact_id: contactId,
    timestamp: form.get('timestamp'),
    ...booleans,
    disposition: finalDisposition,
    presentation_date: structured?.presentation_date,
    enrollment_date: structured?.enrollment_date,
    projected_ap: structured?.projected_ap,
    raw_audio_transcription: transcript,
    ai_structured_notes: structured?.notes ? { ...structured.notes, audio_key: filename } : null,
    next_action_date: structured?.notes?.next_action_date,
    next_action_text: structured?.notes?.next_action
  });

  await upsertActivityLog(c.env.DB, log);

  if (structured?.rating) await setCompanyRating(c.env.DB, companyId, structured.rating);

  if (log.disposition === 'Enrolled') {
    const renewalDate = calculateRenewalDate(log.enrollment_date, log.timestamp?.slice(0, 10));
    await setCompanyRenewalDate(c.env.DB, companyId, renewalDate);
  }

  // Auto-advance pipeline stage
  try {
    const targetStage = inferTargetPipelineStage(null, log.disposition, log.is_dm_contact);
    if (targetStage) {
      await autoAdvancePipelineStage(c.env.DB, companyId, targetStage, log.log_id, `Auto-advanced on touch (${log.disposition})`);
    }
  } catch (err) {
    console.error('Auto-advance pipeline stage failed (non-fatal):', err);
  }

  return c.json({
    success: true,
    degraded,
    log_id: log.log_id,
    company_id: companyId,
    contact_id: contactId,
    audio_key: filename,
    transcript: transcript || '',
    disposition: log.disposition,
    rating: structured?.rating || null,
    notes: structured?.notes || null
  });
});

// ---------------------------------------------------------------------
// POST /api/activity — a silent log (no voice journal)
// ---------------------------------------------------------------------
activity.post('/', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  try {
    const result = await writeQueuedLog(c.env, body);
    return c.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/**
 * Write one queued entry: optional inline company + contact, then the log.
 * Shared by POST /api/activity and the /api/sync batch drain.
 */
async function writeQueuedLog(env, entry) {
  let companyId = asId(entry?.company_id);

  if (entry?.company) {
    let parsedCompany = entry.company;
    if (typeof parsedCompany === 'string') {
      const trimmed = parsedCompany.trim();
      if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') {
        try {
          parsedCompany = JSON.parse(trimmed);
        } catch {
          throw new ValidationError('Malformed company JSON payload');
        }
      } else {
        parsedCompany = null;
      }
    }
    if (parsedCompany && typeof parsedCompany === 'object') {
      const companyPayload = { ...parsedCompany, company_id: companyId || parsedCompany.company_id };
      if ((!companyPayload.lat || !companyPayload.long) && companyPayload.street_1) {
        const fullAddress = [companyPayload.street_1, companyPayload.city || 'Springfield', companyPayload.state || 'MO', companyPayload.zip_code]
          .filter(Boolean)
          .join(', ');
        try {
          const coords = await geocodeAddress(env, fullAddress);
          if (coords) {
            companyPayload.lat = coords.lat;
            companyPayload.long = coords.long;
          }
        } catch (geoErr) {
          console.warn('Geocoding address failed (non-fatal):', geoErr);
        }
      }
      const company = normalizeCompany(companyPayload);
      await upsertCompany(env.DB, company);
      companyId = company.company_id;
    }
  }

  if (!companyId) throw new ValidationError('company_id or company payload is required');
  if (!(await companyExists(env.DB, companyId))) throw new ValidationError('Unknown company_id');

  let contactId = asId(entry?.contact_id);
  if (entry?.contact) {
    const contact = normalizeContact(entry.contact, companyId);
    if (contact) contactId = await upsertContact(env.DB, contact);
  }

  const log = normalizeActivityLog({
    ...entry,
    disposition: entry?.manual_disposition || entry?.disposition,
    company_id: companyId,
    contact_id: contactId
  });
  await upsertActivityLog(env.DB, log);

  if (entry?.rating) await setCompanyRating(env.DB, companyId, entry.rating);

  if (log.disposition === 'Enrolled') {
    const renewalDate = calculateRenewalDate(log.enrollment_date, log.timestamp?.slice(0, 10));
    await setCompanyRenewalDate(env.DB, companyId, renewalDate);
  }

  // Auto-advance pipeline stage
  try {
    const targetStage = inferTargetPipelineStage(null, log.disposition, log.is_dm_contact);
    if (targetStage) {
      await autoAdvancePipelineStage(env.DB, companyId, targetStage, log.log_id, `Auto-advanced on touch (${log.disposition})`);
    }
  } catch (err) {
    console.error('Auto-advance pipeline stage failed (non-fatal):', err);
  }

  return { log_id: log.log_id, company_id: companyId, contact_id: contactId, disposition: log.disposition };
}

// ---------------------------------------------------------------------
// POST /api/sync — offline queue drain
// ---------------------------------------------------------------------

/**
 * Body: { logs: [ { ...activity, company?: {...}, contact?: {...} } ] }
 *
 * One bad entry must never wedge the queue behind it, so failures are
 * reported per-item and the batch still commits everything else. The client
 * drops any id listed in `rejected` instead of retrying it forever.
 */
root.post('/sync', async (c) => {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const logs = payload?.logs;
  if (!Array.isArray(logs)) return c.json({ error: 'Invalid logs array' }, 400);
  if (logs.length > LIMITS.syncBatch) {
    return c.json({ error: `Sync batch too large (max ${LIMITS.syncBatch})` }, 400);
  }

  const accepted = [];
  const rejected = [];

  for (const entry of logs) {
    try {
      const result = await writeQueuedLog(c.env, entry);
      accepted.push(result.log_id);
    } catch (err) {
      const clientId = typeof entry?.log_id === 'string' ? entry.log_id.slice(0, 64) : null;
      if (err instanceof ValidationError) {
        rejected.push({ log_id: clientId, reason: err.message });
      } else {
        // An infrastructure failure is retryable — do NOT tell the client to
        // discard the record. Leave it out of both lists so it stays queued.
        console.error('Sync entry failed:', err);
      }
    }
  }

  return c.json({
    success: true,
    count: accepted.length,
    accepted,
    rejected,
    skipped: rejected.length
  });
});

/**
 * GET /api/metrics/today — real-time HUD scoreboard for field motivation.
 * Queries D1 activity_logs for the current Central business day.
 */
root.get('/metrics/today', async (c) => {
  const today = businessDate();
  const { start, end } = businessDayRangeUtc(today);

  const row = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS doors,
      SUM(CASE WHEN is_dm_contact = 1 THEN 1 ELSE 0 END) AS dms,
      SUM(
        CASE
          WHEN disposition IN ('Follow-Up Scheduled', 'appointment_set', 'Presentation Scheduled', 'Information Left', 'Enrolled', 'enrolled')
            OR presentation_date IS NOT NULL
            OR enrollment_date IS NOT NULL
          THEN 1
          ELSE 0
        END
      ) AS next_steps
    FROM activity_logs
    WHERE timestamp >= ? AND timestamp < ?
  `).bind(start, end).first();

  return c.json({
    doors: Number(row?.doors || 0),
    dms: Number(row?.dms || 0),
    next_steps: Number(row?.next_steps || 0)
  }, 200, { 'Cache-Control': 'no-store' });
});

// ---------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------

/**
 * GET /api/activity
 *   ?date=YYYY-MM-DD   one Springfield business day (default: today)
 *   ?sync_tier=        PENDING | TIER1_COPIED | ...
 *   ?company_id=
 *   ?limit=            1..500, default 200
 */
activity.get('/', async (c) => {
  const url = new URL(c.req.url);
  const dateParam = url.searchParams.get('date');
  const all = url.searchParams.get('all') === '1';
  const date = dateParam || businessDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return c.json({ error: 'Invalid date format (expected YYYY-MM-DD)' }, 400);
  }

  const where = [];
  const binds = [];

  if (!all) {
    // UTC bounds of the LOCAL day: a 6pm call in Springfield is already
    // tomorrow in UTC, and filtering on the UTC date would drop it.
    const { start, end } = businessDayRangeUtc(date);
    where.push('a.timestamp >= ? AND a.timestamp < ?');
    binds.push(start, end);
  }

  const syncTier = matchEnum(url.searchParams.get('sync_tier'), SYNC_TIERS);
  if (syncTier) {
    where.push('a.sync_tier_status = ?');
    binds.push(syncTier);
  }

  const companyId = asId(url.searchParams.get('company_id'));
  if (companyId) {
    where.push('a.company_id = ?');
    binds.push(companyId);
  }

  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 200;

  const { results } = await c.env.DB.prepare(`
    ${ACTIVITY_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.timestamp DESC
    LIMIT ?
  `).bind(...binds, limit).all();

  return c.json({ date, activities: results || [] }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * POST /api/activity/mark-synced
 * Body: { log_ids: [...], sync_tier_status: 'TIER1_COPIED' }
 *
 * Called after a successful clipboard copy or file export so the desktop
 * handoff tabs stop re-offering rows that already moved to D365.
 */
activity.post('/mark-synced', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const status = matchEnum(body?.sync_tier_status, SYNC_TIERS);
  if (!status) {
    return c.json({ error: `sync_tier_status must be one of ${SYNC_TIERS.join(', ')}` }, 400);
  }

  const ids = Array.isArray(body?.log_ids)
    ? body.log_ids.map(asId).filter(Boolean).slice(0, LIMITS.syncBatch * 5)
    : [];
  if (ids.length === 0) return c.json({ error: 'log_ids must be a non-empty array' }, 400);

  // Placeholders, never interpolated values — asId already constrains the
  // charset, but parameter binding is the thing that actually guarantees it.
  const placeholders = ids.map(() => '?').join(', ');
  await c.env.DB.prepare(
    `UPDATE activity_logs SET sync_tier_status = ? WHERE log_id IN (${placeholders})`
  ).bind(status, ...ids).run();

  return c.json({ success: true, updated: ids.length, sync_tier_status: status });
});

export default activity;

// ---------------------------------------------------------------------
// GET /api/audio/:key — play back an archived voice journal
// ---------------------------------------------------------------------
export const audio = new Hono();

const SAFE_AUDIO_KEY = /^journal-[A-Za-z0-9._-]{1,80}$/;
const PLAYABLE_AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/flac'];

audio.get('/:key', async (c) => {
  const key = c.req.param('key');
  if (!SAFE_AUDIO_KEY.test(key)) return c.text('Not found', 404);
  if (!c.env.BUCKET) return c.text('Audio storage not configured', 503);

  const object = await c.env.BUCKET.get(key);
  if (!object) return c.text('Not found', 404);

  // Never echo a stored Content-Type back unchecked.
  const stored = String(object.httpMetadata?.contentType || '').split(';')[0].trim().toLowerCase();
  const contentType = PLAYABLE_AUDIO.includes(stored) ? stored : 'application/octet-stream';

  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ETag: object.httpEtag,
      'Cache-Control': 'private, max-age=31536000, immutable'
    }
  });
});
