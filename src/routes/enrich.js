/**
 * POST /api/enrich — the "⚡ Inspect Target" pre-call dossier.
 *
 * Tavily does the web search; Llama 3.3 70B compresses the raw results into
 * exactly three bullets an agent can read on a phone in a parking lot before
 * walking in: who signs, how many W-2s, and the opener that earns 30 seconds.
 */

import { Hono } from 'hono';
import { LIMITS, cleanCapped, asId, asCount, matchEnum, LEAD_SOURCES } from '../lib/validate.js';
import { DEFAULT_MODELS, ProviderError, tavilySearch, chatCompletion, generateDossier } from '../lib/ai.js';

const enrich = new Hono();

const BULLET_LABELS = ['Executives', 'Headcount', 'Industry Hook'];

export const INDUSTRY_PRODUCT_RECOMMENDATIONS = {
  'Construction & Trades': ['Accident', 'Short-Term Disability', 'Life'],
  'Manufacturing': ['Short-Term Disability', 'Critical Illness', 'Accident'],
  'Transportation & Logistics': ['Accident', 'Short-Term Disability', 'Life'],
  'Healthcare & Medical': ['Hospital Indemnity', 'Critical Illness', 'Dental/Vision'],
  'Automotive & Dealerships': ['Accident', 'Short-Term Disability', 'Hospital Indemnity'],
  'Hospitality & Food Service': ['Short-Term Disability', 'Accident', 'Dental/Vision'],
  'Professional & Tech Services': ['Short-Term Disability', 'Life', 'Dental/Vision'],
  'Wholesale & Distribution': ['Accident', 'Short-Term Disability', 'Life'],
  'Utilities & Communications': ['Accident', 'Short-Term Disability', 'Critical Illness'],
  'Agriculture & Forestry': ['Accident', 'Short-Term Disability', 'Life'],
  'Mining & Extraction': ['Accident', 'Short-Term Disability', 'Critical Illness'],
  'Real Estate': ['Short-Term Disability', 'Life', 'Dental/Vision'],
  'Personal & Consumer Services': ['Short-Term Disability', 'Accident', 'Dental/Vision'],
  'Retail Trade': ['Short-Term Disability', 'Accident', 'Dental/Vision'],
  'Education & Schools': ['Short-Term Disability', 'Critical Illness', 'Cancer'],
  'Entertainment & Recreation': ['Accident', 'Short-Term Disability', 'Life'],
  'Finance & Insurance': ['Short-Term Disability', 'Life', 'Dental/Vision'],
  'Civic & Public Admin': ['Cancer', 'Critical Illness', 'Short-Term Disability'],
  'Other Commercial': ['Accident', 'Short-Term Disability', 'Hospital Indemnity']
};

export function getRecommendedProducts(industry) {
  if (!industry || typeof industry !== 'string') return INDUSTRY_PRODUCT_RECOMMENDATIONS['Other Commercial'];
  return INDUSTRY_PRODUCT_RECOMMENDATIONS[industry.trim()] || INDUSTRY_PRODUCT_RECOMMENDATIONS['Other Commercial'];
}

function buildEnrichSystemPrompt(recommendedProducts = [], { pipelineStage = 'PROSPECT', latestDisposition = 'None', touchCount = 0 } = {}) {
  const prodStr = recommendedProducts.length > 0 ? recommendedProducts.join(', ') : 'Accident, Short-Term Disability, Hospital Indemnity';
  return `You brief an independent Aflac insurance agent immediately before a cold B2B walk-in.

Context: This prospect is currently in stage ${pipelineStage}. Previous disposition: ${latestDisposition}. Total touches: ${touchCount}.

You read raw web search results and return exactly three markdown bullets, in this order and with these exact labels:

- **Executives:** named decision makers and their titles (owner, president, HR director, office manager). Prefer the person who would sign off on a voluntary-benefits offering.
- **Headcount:** employee count or a tight range, plus the basis for it. Aflac needs 3+ W-2 employees, so state whether that bar is clearly met.
- **Industry Hook:** the single most useful conversation opener — a recent expansion, hiring push, award, new location, or an industry-specific risk that speaks directly to primary Aflac voluntary products (${prodStr}) via Section 125 payroll pre-taxing.

Hard rules:
- Output ONLY the three bullets. No preamble, no heading, no closing line.
- One or two sentences per bullet. This is read on a phone screen.
- If specific Decision Maker (DM) names or exact headcounts are missing from the raw content, you must output a high-contrast directive: 'Data stale. Dial main line to verify'.
- If the search results do not support a bullet, write "Data stale. Dial main line to verify" or "Not found in public sources." — never guess a name, a number, or an event.
- Never state a fact the search results do not contain.`;
}

/**
 * Body: { company_name, address?, street_1?, city?, state?, zip_code?, company_id?, pipeline_stage?, latest_disposition?, touch_count? }
 * Returns markdown bullets plus the sources they came from.
 */
enrich.post('/', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Malformed JSON body' }, 400);
  }

  const companyName = cleanCapped(body?.company_name, LIMITS.companyName);
  if (!companyName) return c.json({ error: 'company_name is required' }, 400);

  // Accept either a single pre-joined address or the discrete D365 columns.
  const address = cleanCapped(body?.address, LIMITS.street * 2)
    || [body?.street_1, body?.city, body?.state, body?.zip_code]
      .map((part) => cleanCapped(part, LIMITS.street))
      .filter(Boolean)
      .join(', ');

  // Strict query: company name, city, and state
  const query = [
    companyName,
    address || 'Springfield, MO'
  ].filter(Boolean).join(', ');

  // Prioritize the company's own domain (when known) plus the two
  // highest-signal Springfield local business sources. Tavily treats these
  // as boost hints, not hard filters, so generic results still surface.
  const companyDomain = cleanCapped(body?.website, 200);
  const includeDomains = ['sbj.net', 'news-leader.com'];
  if (companyDomain) includeDomains.unshift(companyDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));

  let search;
  try {
    search = await tavilySearch(c.env, query.slice(0, 400), {
      includeDomains,
      days: 90,
      maxResults: 5,
      includeRawContent: true
    });
  } catch (err) {
    console.error('Tavily search failed:', err);
    const status = err instanceof ProviderError && err.status === 503 ? 503 : 502;
    return c.json({
      error: status === 503
        ? 'Search is not configured (TAVILY_API_KEY missing)'
        : 'Search provider is unavailable',
      dossier: null
    }, status);
  }

  if (search.results.length === 0 && !search.answer) {
    return c.json({
      success: true,
      company_name: companyName,
      dossier: BULLET_LABELS.map((label) => `- **${label}:** Data stale. Dial main line to verify`).join('\n'),
      bullets: BULLET_LABELS.map((label) => ({ label, text: 'Data stale. Dial main line to verify' })),
      sources: [],
      degraded: 'no_search_results'
    });
  }

  const context = [
    `TARGET: ${companyName}`,
    address ? `ADDRESS: ${address}` : null,
    search.answer ? `\nSEARCH SUMMARY:\n${search.answer}` : null,
    '\nSEARCH RESULTS:',
    ...search.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
  ].filter(Boolean).join('\n');

  const industry = cleanCapped(body?.industry, LIMITS.industry);
  const recommendedProducts = getRecommendedProducts(industry);

  const pipelineStage = cleanCapped(body?.pipeline_stage, 32) || 'PROSPECT';
  const latestDisposition = cleanCapped(body?.latest_disposition, 60) || 'None';
  const touchCount = asCount(body?.touch_count, 1000) ?? 0;

  let markdown;
  try {
    markdown = await generateDossier(c.env, {
      model: c.env.OPENROUTER_ENRICH_MODEL || DEFAULT_MODELS.complex,
      system: buildEnrichSystemPrompt(recommendedProducts, { pipelineStage, latestDisposition, touchCount }),
      user: context.slice(0, 14000),
      maxTokens: 500,
      temperature: 0.2
    });
  } catch (err) {
    console.error('Dossier generation failed:', err);
    const status = err instanceof ProviderError && err.status === 503 ? 503 : 502;
    return c.json({
      error: status === 503
        ? 'Dossier model is not configured (OPENROUTER_API_KEY missing)'
        : 'Dossier model is unavailable',
      dossier: null,
      sources: search.results.map((r) => ({ title: r.title, url: r.url }))
    }, status);
  }

  const bullets = parseBullets(markdown);
  const dossier = cleanCapped(markdown, LIMITS.dossierChars, { allowNewlines: true })
    || bullets.map((b) => `- **${b.label}:** ${b.text}`).join('\n');

  // Persist the two structured facts the dossier reliably yields, so a later
  // D365 export carries them. Enrichment on an unknown id is still useful to
  // read — it just has nowhere to be stored.
  const companyId = asId(body?.company_id);
  if (companyId) {
    const employees = asCount(extractHeadcount(bullets), 5_000_000);
    const leadSource = matchEnum(body?.lead_source, LEAD_SOURCES);
    if (employees !== null || industry || leadSource) {
      await c.env.DB.prepare(`
        UPDATE companies SET
          employees   = COALESCE(?, employees),
          industry    = COALESCE(?, industry),
          lead_source = COALESCE(?, lead_source)
        WHERE company_id = ?
      `).bind(employees, industry, leadSource, companyId).run();
    }
  }

  return c.json({
    success: true,
    company_name: companyName,
    dossier,
    bullets,
    recommended_products: recommendedProducts,
    sources: search.results.map((r) => ({ title: r.title, url: r.url }))
  }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * Split the model's markdown into labelled bullets. Falls back to positional
 * assignment when the model drops the bold labels — the UI renders three rows
 * either way rather than an empty panel.
 */
function parseBullets(markdown) {
  const lines = String(markdown || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-') || line.startsWith('*'));

  const bullets = BULLET_LABELS.map((label) => {
    const match = lines.find((line) => new RegExp(`\\*\\*\\s*${label}\\s*:?\\s*\\*\\*`, 'i').test(line));
    if (!match) return null;
    const text = match
      .replace(/^[-*]\s*/, '')
      .replace(new RegExp(`\\*\\*\\s*${label}\\s*:?\\s*\\*\\*:?\\s*`, 'i'), '')
      .trim();
    return { label, text: text || 'Not found in public sources.' };
  });

  const unlabelled = lines.map((line) => line.replace(/^[-*]\s*/, '').replace(/^\*\*[^*]+\*\*:?\s*/, '').trim());

  return BULLET_LABELS.map((label, i) => bullets[i]
    || { label, text: unlabelled[i] || 'Not found in public sources.' });
}

/** Pull the first plausible employee count out of the Headcount bullet. */
function extractHeadcount(bullets) {
  const text = bullets.find((b) => b.label === 'Headcount')?.text || '';
  // Ranges ("40-60 employees") resolve to the lower bound: under-promising a
  // headcount is the safe direction for an eligibility check.
  const match = text.replace(/,/g, '').match(/\b(\d{1,7})\s*(?:[-–—to]+\s*\d{1,7})?\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 && n < 5_000_000 ? n : null;
}

export default enrich;
