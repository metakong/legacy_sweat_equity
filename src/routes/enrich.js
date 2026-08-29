/**
 * POST /api/enrich — the "⚡ Inspect Target" pre-call dossier.
 *
 * Tavily does the web search; Llama 3.3 70B compresses the raw results into
 * exactly three bullets an agent can read on a phone in a parking lot before
 * walking in: who signs, how many W-2s, and the opener that earns 30 seconds.
 */

import { Hono } from 'hono';
import { LIMITS, cleanCapped, asId, asCount, matchEnum, LEAD_SOURCES } from '../lib/validate.js';
import { DEFAULT_MODELS, ProviderError, tavilySearch, chatCompletion } from '../lib/ai.js';

const enrich = new Hono();

const BULLET_LABELS = ['Executives', 'Headcount', 'Industry Hook'];

const SYSTEM_PROMPT = `You brief an independent Aflac insurance agent immediately before a cold B2B walk-in. You read raw web search results and return exactly three markdown bullets, in this order and with these exact labels:

- **Executives:** named decision makers and their titles (owner, president, HR director, office manager). Prefer the person who would sign off on a voluntary-benefits offering.
- **Headcount:** employee count or a tight range, plus the basis for it. Aflac needs 3+ W-2 employees, so state whether that bar is clearly met.
- **Industry Hook:** the single most useful conversation opener — a recent expansion, hiring push, award, new location, or an industry-specific risk that supplemental accident or disability coverage speaks to.

Hard rules:
- Output ONLY the three bullets. No preamble, no heading, no closing line.
- One or two sentences per bullet. This is read on a phone screen.
- If the search results do not support a bullet, write "Not found in public sources." — never guess a name, a number, or an event.
- Never state a fact the search results do not contain.`;

/**
 * Body: { company_name, address?, street_1?, city?, state?, zip_code?, company_id? }
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

  const query = [
    companyName,
    address || 'Springfield Missouri',
    'company owner OR president OR HR director number of employees industry',
    '"Springfield Business Journal" OR "Springfield News-Leader"'
  ].join(' ');

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
      days: 90
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
      dossier: BULLET_LABELS.map((label) => `- **${label}:** Not found in public sources.`).join('\n'),
      bullets: BULLET_LABELS.map((label) => ({ label, text: 'Not found in public sources.' })),
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

  let markdown;
  try {
    markdown = await chatCompletion(c.env, {
      model: c.env.OPENROUTER_ENRICH_MODEL || DEFAULT_MODELS.enrich,
      system: SYSTEM_PROMPT,
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
    const industry = cleanCapped(body?.industry, LIMITS.industry);
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
