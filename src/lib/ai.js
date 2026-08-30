/**
 * External model + search providers.
 *
 * Every call here is a network hop from a Worker with a hard CPU budget, so
 * each one carries an AbortSignal deadline. A hung upstream must fail the
 * request, not burn the whole invocation.
 *
 * All three keys are secrets and must never reach the browser:
 *   wrangler secret put GROQ_API_KEY
 *   wrangler secret put OPENROUTER_API_KEY
 *   wrangler secret put TAVILY_API_KEY
 * Locally they come from the shell env via dev-server.js.
 */

import { parseJsonLoose } from './validate.js';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TAVILY_URL = 'https://api.tavily.com/search';

// Pinned but overridable, so a model retirement is a config change rather
// than a redeploy.
//
// `structure` was specified as Claude 3.5 Haiku, but OpenRouter has retired
// that id — it returns 404 "no endpoints found", which silently degraded both
// the voice-journal structuring pass and the EOD debrief. claude-haiku-4.5 is
// the current Haiku and fills the same role: fast and cheap enough to run on
// every field log, strong enough for constrained JSON extraction.
// Verified against https://openrouter.ai/api/v1/models on 2026-08-29.
export const DEFAULT_MODELS = {
  transcribe: 'whisper-large-v3-turbo',
  structure: 'anthropic/claude-haiku-4.5',
  enrich: 'meta-llama/llama-3.3-70b-instruct'
};

/** Thrown for provider failures so routes can map them to a clean 502. */
export class ProviderError extends Error {
  constructor(provider, status, detail) {
    super(`${provider} request failed (${status})`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Speech to text via Groq Whisper.
 *
 * @param {object} env    Worker env bindings
 * @param {Blob}   audio  Mono Opus capture from MediaRecorder
 * @param {string} filename  Extension matters — Groq sniffs the container
 * @returns {Promise<string>} the raw transcript
 */
export async function transcribeAudio(env, audio, filename = 'journal.webm') {
  if (!env.GROQ_API_KEY) throw new ProviderError('groq', 503, 'GROQ_API_KEY is not configured');

  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', env.GROQ_MODEL || DEFAULT_MODELS.transcribe);
  form.append('response_format', 'json');
  form.append('language', 'en');
  // Deterministic: this transcript becomes a CRM record, not creative writing.
  form.append('temperature', '0');
  // Priming the decoder with domain nouns measurably cuts errors on the terms
  // that matter most in this workflow.
  form.append(
    'prompt',
    'Aflac supplemental insurance field notes. Terms: decision maker, gatekeeper, '
    + 'HR director, office manager, payroll deduction, Section 125, cafeteria plan, '
    + 'annualized premium, AP, enrollment, open enrollment, presentation, W-2, '
    + 'accident, critical illness, hospital indemnity, short-term disability.'
  );

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000)
  });

  if (!res.ok) {
    throw new ProviderError('groq', res.status, (await res.text().catch(() => '')).slice(0, 500));
  }

  const data = await res.json();
  return typeof data?.text === 'string' ? data.text.trim() : '';
}

/**
 * One-shot chat completion through OpenRouter.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {boolean} [opts.json]  request a JSON object back
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>} the assistant message content
 */
export async function chatCompletion(env, {
  model,
  system,
  user,
  json = false,
  maxTokens = 1024,
  temperature = 0.1,
  timeoutMs = 45_000
}) {
  if (!env.OPENROUTER_API_KEY) {
    throw new ProviderError('openrouter', 503, 'OPENROUTER_API_KEY is not configured');
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature,
    max_tokens: maxTokens
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // OpenRouter attribution headers — optional, but they keep the request
      // off the anonymous rate-limit bucket.
      'HTTP-Referer': env.APP_URL || 'https://legacysweatequity.com',
      'X-Title': 'Aflac Field Prospecting Assistant'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    throw new ProviderError('openrouter', res.status, (await res.text().catch(() => '')).slice(0, 500));
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/** chatCompletion + tolerant JSON parsing. Returns null if unparseable. */
export async function chatJson(env, opts) {
  const raw = await chatCompletion(env, { ...opts, json: true });
  return parseJsonLoose(raw);
}

/**
 * Tavily web search for the pre-call dossier.
 *
 * Auth is sent BOTH as a bearer header (current docs) and as `api_key` in the
 * body (the long-standing v1 form). Tavily accepts either; sending both means
 * this keeps working across their auth migration.
 */
export async function tavilySearch(env, query, {
  maxResults = 6,
  timeoutMs = 20_000,
  includeDomains = [],
  days = undefined
} = {}) {
  if (!env.TAVILY_API_KEY) {
    throw new ProviderError('tavily', 503, 'TAVILY_API_KEY is not configured');
  }

  const body = {
    api_key: env.TAVILY_API_KEY,
    query,
    search_depth: 'advanced',
    max_results: maxResults,
    include_answer: true,
    include_raw_content: false
  };

  // Boost specific domains without excluding others. Tavily treats these
  // as preference hints — results from other domains still appear.
  if (includeDomains.length > 0) body.include_domains = includeDomains;

  // Restrict to results published within the last N days (e.g. 90).
  // Sharpens the Industry Hook bullet toward recent expansions and news.
  if (typeof days === 'number' && days > 0) body.days = days;

  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.TAVILY_API_KEY}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    throw new ProviderError('tavily', res.status, (await res.text().catch(() => '')).slice(0, 500));
  }

  const data = await res.json();
  return {
    answer: typeof data?.answer === 'string' ? data.answer : '',
    results: Array.isArray(data?.results)
      ? data.results.slice(0, maxResults).map((r) => ({
        title: String(r?.title ?? '').slice(0, 300),
        url: String(r?.url ?? '').slice(0, 500),
        content: String(r?.content ?? '').slice(0, 1500)
      }))
      : []
  };
}

/**
 * 19 standard industry categories (18 consolidated buckets + Other Commercial).
 */
export const INDUSTRY_CATEGORIES = [
  'Agriculture & Forestry',
  'Mining & Extraction',
  'Construction & Trades',
  'Manufacturing',
  'Transportation & Logistics',
  'Utilities & Communications',
  'Wholesale & Distribution',
  'Automotive & Dealerships',
  'Hospitality & Food Service',
  'Finance & Insurance',
  'Real Estate',
  'Healthcare & Medical',
  'Professional & Tech Services',
  'Personal & Consumer Services',
  'Education & Schools',
  'Entertainment & Recreation',
  'Civic & Public Admin',
  'Retail Trade',
  'Other Commercial'
];

/**
 * Rule-based fallback classifier for B2B company names.
 */
export function ruleBasedCategory(companyName) {
  if (!companyName || typeof companyName !== 'string') return 'Other Commercial';
  const str = companyName.toLowerCase().trim();
  if (!str) return 'Other Commercial';

  // High-priority civic & municipal check
  if (
    str.startsWith('city of') ||
    str.startsWith('county of') ||
    str.includes('chamber of commerce') ||
    str.includes('emergency services') ||
    str.includes('regional arts council') ||
    str.includes('fire department') ||
    str.includes('police department') ||
    str.includes('township') ||
    /civic|public|admin|execut|legislat|polic|\bfire\b|social|church|relig|non-profit|nonprofit/.test(str)
  ) {
    return 'Civic & Public Admin';
  }

  if (/agri|crop|farm|forest|fish|hunt|trap/.test(str)) return 'Agriculture & Forestry';
  if (/mine|mining|coal|\boil\b|\bgas\b|mineral/.test(str)) return 'Mining & Extraction';
  if (/contractor|construct|build|plumb|hvac|electric|roof|exterior|fencing|railing/.test(str)) return 'Construction & Trades';
  if (/manufactur|lumber|wood|furnitur|paper|chemical|plastic|metal|machin|chocolate|bakery|nutrition|doorworks/.test(str)) return 'Manufacturing';
  if (/transit|railroad|freight|truck|transport|warehous|logistic/.test(str)) return 'Transportation & Logistics';
  if (/utilit|telephon|telegraph|radio|broadcast|communicat/.test(str)) return 'Utilities & Communications';
  if (/wholesale|distribut/.test(str)) return 'Wholesale & Distribution';
  if (/auto|motor|gas station|\bcar\b|vehicle|tire|transmission/.test(str)) return 'Automotive & Dealerships';
  if (/\beat|eating|eatery|drink|restaurant|hotel|motel|camp|lodg|resort/.test(str)) return 'Hospitality & Food Service';
  if (/financ|bank|credit|securit|broker|insur|loan/.test(str)) return 'Finance & Insurance';
  if (/real estate|lessor|propert|title|realty|estate/.test(str)) return 'Real Estate';
  if (/health|medic|physician|dentist|hospit|nurs|clinic|\blab\b|assisted living|care|grief/.test(str)) return 'Healthcare & Medical';
  if (/legal|attorney|\blaw\b|engin|account|\bcpa\b|research|manag|comput|tech|data|consult|architect/.test(str)) return 'Professional & Tech Services';
  if (/laundry|clean|beauty|salon|barber|photo|repair|pest|bug/.test(str)) return 'Personal & Consumer Services';
  if (/educat|school|colleg|univers|librar|academ|teach|children/.test(str)) return 'Education & Schools';
  if (/entertain|recreat|amus|museum|sport|gym|theater|theatre|golf|production|magazine|trip|gig/.test(str)) return 'Entertainment & Recreation';
  if (/retail|store|merchandis|shop|grocer|antique|market|food/.test(str)) return 'Retail Trade';

  return 'Other Commercial';
}

/**
 * Classify a company name into one of the 19 standard industry categories using OpenRouter
 * with deterministic municipal guardrails and rule-based fallback.
 *
 * @param {string} companyName
 * @param {object} env  Worker env bindings with OPENROUTER_API_KEY
 * @returns {Promise<string>}
 */
export async function classifyIndustry(companyName, env) {
  if (!companyName || typeof companyName !== 'string') return 'Other Commercial';
  const name = companyName.trim();
  if (!name) return 'Other Commercial';

  const lower = name.toLowerCase();
  // Deterministic pre-checks for municipal & institutional entities
  if (
    lower.startsWith('city of') ||
    lower.startsWith('county of') ||
    lower.includes('chamber of commerce') ||
    lower.includes('emergency services') ||
    lower.includes('regional arts council') ||
    lower.includes('fire department') ||
    lower.includes('police department') ||
    lower.includes('township')
  ) {
    return 'Civic & Public Admin';
  }

  if (!env?.OPENROUTER_API_KEY) {
    return ruleBasedCategory(name);
  }

  const payload = {
    models: ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash'],
    messages: [
      {
        role: 'system',
        content: 'You are an expert B2B territory manager. Classify the following business name into exactly one of these 18 categories based on logic and Springfield, MO regional context. Important: municipal governments, public safety, non-profits, civic associations, and community agencies must strictly be classified under "Civic & Public Admin".'
      },
      {
        role: 'user',
        content: name
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'industry_classification',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: INDUSTRY_CATEGORIES
            }
          },
          required: ['category'],
          additionalProperties: false
        }
      }
    },
    temperature: 0.1
  };

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      console.warn(`OpenRouter classification returned status ${res.status}`);
      return ruleBasedCategory(name);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content) {
      const parsed = typeof content === 'object' ? content : JSON.parse(content);
      if (parsed?.category && INDUSTRY_CATEGORIES.includes(parsed.category)) {
        return parsed.category;
      }
    }
    return ruleBasedCategory(name);
  } catch (err) {
    console.warn(`classifyIndustry error for "${name}":`, err.message);
    return ruleBasedCategory(name);
  }
}

/**
 * Geocode a street address via Mapbox Geocoding v5.
 *
 * @param {object} env  Worker env bindings with MAPBOX_TOKEN
 * @param {string} addressStr
 * @returns {Promise<{lat: number, long: number} | null>}
 */
export async function geocodeAddress(env, addressStr) {
  if (!env?.MAPBOX_TOKEN || !addressStr || typeof addressStr !== 'string') return null;
  const query = encodeURIComponent(addressStr.trim().slice(0, 300));
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${env.MAPBOX_TOKEN}&country=US&types=address,poi`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.features?.length > 0 && Array.isArray(data.features[0].center)) {
      const [long, lat] = data.features[0].center;
      if (Number.isFinite(lat) && Number.isFinite(long)) {
        return { lat: Math.round(lat * 1e6) / 1e6, long: Math.round(long * 1e6) / 1e6 };
      }
    }
    return null;
  } catch (err) {
    console.warn('Geocoding fetch failed:', err.message);
    return null;
  }
}



