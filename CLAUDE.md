# CLAUDE.md — Quick Reference for AI Agents

## What This Is
A **B2B field prospecting PWA for an independent Aflac agent** working Springfield, MO.
It replaced "Legacy Sweat Equity", a B2C roofing canvassing app, in the 2026-08-29 pivot.
Anything you find referring to roofing, doors, homeowners, or damage photos is stale — say so.

## Read First
- Check `PROJECT_PROGRESS.md` for recent changes before doing anything
- Read `.agents/AGENTS.md` for full project context

## Stack
Vanilla HTML/CSS/JS + native ES modules → Hono on a Cloudflare Worker (D1 + R2).
No bundler, no build step you run — `wrangler deploy` bundles Hono with esbuild automatically.

## Key Rules
1. Hono is the **only** runtime dependency. Don't add frontend frameworks or a build step.
2. Keep the Samsung One UI dark theme — use the CSS custom properties in `:root` only
3. Offline-first: never break the IndexedDB queue in `public/app/store.js`
4. All touch targets ≥ 48px (field use in sunlight)
5. Validate input on write (`src/lib/validate.js`); escape on OUTPUT — build DOM with
   `textContent`, never `innerHTML`
6. Don't rename HTML element IDs — the ES modules depend on them
7. Don't modify `wrangler.jsonc` without permission
8. Update PROJECT_PROGRESS.md after every change session
9. Springfield is `America/Chicago` — never derive a business day from UTC
   (see ARCHITECTURE.md § Timezone Handling)
10. Bump `CACHE_NAME` in `public/sw.js` when changing precached assets — the ES modules
    are listed individually there
11. Store timestamps in D1's `'YYYY-MM-DD HH:MM:SS'` UTC format via `toSqlTimestamp()`.
    Every date filter is a string comparison; a raw ISO string sorts wrong and drops rows.
12. **A field visit is never lost.** If a model provider fails, still write the activity
    with the disposition derived from the 3-Tap Binary and report `degraded` in the response.

## Run Locally
```bash
npm run dev  # localhost:3000
```
```bash
npm test     # node --test, no dependencies
```
Local D1 is real SQLite (`node:sqlite`) in `.local_db.sqlite`, created from `schema.sql`
on first run. Delete the file to reset. Clear the service worker cache when testing
frontend changes, or you'll be looking at the previous build.

Secrets come from the shell, never from a committed file:
```bash
GROQ_API_KEY=... OPENROUTER_API_KEY=... TAVILY_API_KEY=... npm run dev
```

## Files That Matter
- `src/index.js` — Hono app wiring, security middleware, static fallback, cron
- `src/lib/` — `validate.js` (input + CRM enums), `db.js` (D1 upserts), `ai.js`
  (Groq/OpenRouter/Tavily), `time.js` (America/Chicago), `security.js` (CSP, CORS)
- `src/routes/` — `activity.js` (transcribe-and-log, sync), `companies.js`, `enrich.js`,
  `routing.js` (Mapbox), `exports.js` (Tier 2/3)
- `public/app/` — the PWA. `field.js` is mobile; `desktop.js` is the ≥1024px console;
  `d365.js` is the Dynamics 365 column mapping
- `dev-server.js` / `mockEnv.js` — local dev with real SQLite + filesystem R2
- `schema.sql` — D1 schema (`companies`, `contacts`, `activity_logs`)

## Deploying
```bash
npm run deploy
```
Runs natively on this Windows ARM64 box via `scripts/workerd-win-arm64-shim.cjs` (workerd
ships no win32-arm64 binary; the shim points it at the x64 build, which Windows emulates).
Needs `npm install --no-save --force @cloudflare/workerd-windows-64@1.20260714.1` present —
re-run that after any `npm ci`. Do NOT use WSL; it is currently broken on this machine.
Cloudflare auth is already stored and self-refreshing. Live at **legacysweatequity.com**.

## D365 Columns Are Now Real — Don't Reorder Them
`D365_OPEN_LEADS_COLUMNS` in `public/app/d365.js` is the agent's actual 31-column CRM
export order, and `AGENT_PROFILE` beside it carries the real ownership constants.
`test/d365.test.js` pins both. `IR_NUMBER` is still blank.

The Open Leads view has no Notes column, so voice-journal notes never reach D365 — that is
why `GET /api/eod-debrief` exists. It reads the day's `ai_structured_notes` and renders a
Markdown report in the desktop sidebar. **Metrics are computed in code, never by the
model**, and `public/app/markdown.js` renders the result with createElement/textContent
only — that file must never gain an `innerHTML`.

## Model IDs Rot
`anthropic/claude-3.5-haiku` was retired from OpenRouter and 404s, which silently degraded
both the debrief and the voice-journal structuring pass. Pinned id is now
`anthropic/claude-haiku-4.5`. If AI features start reporting `degraded` for no obvious
reason, check `https://openrouter.ai/api/v1/models` before anything else.
