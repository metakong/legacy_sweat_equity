# Aflac Field Prospecting Assistant — Agent Instructions

## Project Purpose

A **zero-cost, offline-first Progressive Web App and Cloudflare edge backend** built for
one independent Aflac insurance agent prospecting B2B accounts in Springfield, Missouri.

It replaced **Legacy Sweat Equity**, a B2C roofing door-canvassing app, in a total domain
pivot on **2026-08-29**. Nothing about roofing, door knocking, homeowners, damage photos,
or the inbound lead portal survives. If you find a reference to any of that, it is stale
documentation or dead code — flag it.

The app runs on a tri-device field setup:

| Device | Role |
|--------|------|
| Moto G Stylus | live phone calls (not an app surface) |
| Samsung Galaxy S21+ | the mobile PWA — rapid field logging |
| Samsung Galaxy Book Go 5G (ARM64) | in-vehicle command centre + Samson Q2U USB mic |

One HTML document serves both form factors. At `≥1024px` a sidebar reveals four
operational tabs (Route Planner, Tier 1 Handoff, Tier 2/3 Sync, EOD AI Debrief); below
that, the field log is the entire app.

## Architecture Overview

- **Frontend**: vanilla HTML/CSS + native ES modules. No framework, no bundler.
- **Backend**: Hono on a Cloudflare Worker (`src/index.js`), D1, R2.
- **Dev server**: `dev-server.js` — real SQLite via `node:sqlite`, filesystem R2.
- **PWA**: `public/sw.js`, stale-while-revalidate.
- **AI**: Groq Whisper (transcription), OpenRouter Claude Haiku 4.5 (CRM structuring),
  OpenRouter Llama 3.3 70B + Tavily (target dossier).
- **Design system**: Samsung One UI dark, OLED-optimized.

## File Structure

```
legacy_sweat_equity/
├── .agents/AGENTS.md            # this file
├── src/
│   ├── index.js                 # Hono app, security middleware, cron
│   ├── lib/
│   │   ├── validate.js          # input normalization + CRM enums
│   │   ├── db.js                # D1 upserts + record normalization
│   │   ├── ai.js                # Groq / OpenRouter / Tavily clients
│   │   ├── time.js              # America/Chicago business-day math
│   │   └── security.js          # CSP, security headers, origin allowlist
│   └── routes/
│       ├── activity.js          # /api/transcribe-and-log, /api/sync, /api/activity
│       ├── companies.js         # /api/companies, /api/contacts, /api/enums
│       ├── enrich.js            # /api/enrich  (⚡ Inspect Target)
│       ├── eod.js               # /api/eod-debrief (metrics in code, narrative by AI)
│       ├── routing.js           # /api/route/optimize  (Mapbox + fallback)
│       └── exports.js           # /api/export/d365  (Tier 2/3 partitioning)
├── public/
│   ├── app/
│   │   ├── index.html           # both form factors
│   │   ├── app.css              # One UI dark; desktop console at ≥1024px
│   │   ├── app.js               # entry point
│   │   ├── ui.js                # toasts, DOM builders, view switcher
│   │   ├── store.js             # IndexedDB queue + sync engine
│   │   ├── field.js             # field log: map, 3-tap, mic, inspect
│   │   ├── d365.js              # D365 column mapping + AGENT_PROFILE + exporters
│   │   ├── markdown.js          # safe Markdown -> DOM renderer (never innerHTML)
│   │   └── desktop.js           # route planner, Tier 1, Tier 2/3, EOD debrief
│   ├── sw.js  manifest.json  robots.txt  icon.jpg
├── test/
│   ├── worker.test.js           # validation, enums, timezone, EOD metrics
│   ├── d365.test.js             # CRM column projection (TSV/CSV/xlsx matrix)
│   └── markdown.test.js         # renderer structure + XSS safety
├── dev-server.js  mockEnv.js  schema.sql  wrangler.jsonc  package.json
├── ARCHITECTURE.md  PROJECT_PROGRESS.md  CLAUDE.md
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/transcribe-and-log` | multipart: audio + 3 booleans → Groq → OpenRouter → D1 |
| POST | `/api/enrich` | Tavily + Llama 3.3 → 3-bullet pre-call dossier |
| GET | `/api/eod-debrief` | today's notes → Claude Haiku 4.5 → Markdown EOD report |
| POST | `/api/sync` | offline IndexedDB queue drain (batched) |
| POST | `/api/activity` | a silent log (no voice note) |
| GET | `/api/activity` | activities for a business day / tier / company |
| POST | `/api/activity/mark-synced` | advance `sync_tier_status` |
| GET/POST | `/api/companies` | search (`?q=`, `?untouched=1`) / create |
| GET | `/api/companies/:id` | account detail + contacts + timeline |
| POST | `/api/contacts` | attach or update a person |
| GET | `/api/enums` | the CRM option sets the UI renders |
| POST | `/api/route/optimize` | Mapbox Optimization v1, heuristic fallback |
| GET | `/api/export/d365` | Tier 2 / Tier 3 partitioned export rows |
| GET | `/api/audio/:key` | play back an archived voice journal |
| GET | `/api/health` | status + which providers are configured |
| CRON | `0 2 * * *` | nightly rollup (read-only, logged) |

## Environment Bindings

Secrets — see the Provider Secrets section below for how to set them:

| Name | Purpose | Missing → |
|------|---------|-----------|
| `GROQ_API_KEY` | Whisper transcription | log saves, `degraded: transcription_unconfigured` |
| `OPENROUTER_API_KEY` | structuring + dossier | log saves with derived disposition; enrich 503 |
| `TAVILY_API_KEY` | dossier web search | enrich 503 with a clear message |
| `MAPBOX_TOKEN` | road-network routing | falls back to the local heuristic |

Vars: `ALLOWED_ORIGINS` (comma separated), `STORE_AUDIO` (`'0'` disables R2 archiving),
`GROQ_MODEL` / `OPENROUTER_STRUCTURE_MODEL` / `OPENROUTER_ENRICH_MODEL` (pin overrides).

Locally they come from the shell:
```bash
GROQ_API_KEY=... OPENROUTER_API_KEY=... TAVILY_API_KEY=... npm run dev
```

## Deployment Environment

**Host machine**: Windows 11 ARM64. Deployment runs **natively here** — no WSL needed.

### The ARM64 workaround (already in place)

`workerd`'s platform table has no `win32 arm64` entry, so the wrangler CLI throws
`Unsupported platform: win32 arm64 LE` at *import* time — before any subcommand runs,
including `deploy`, which never actually spawns workerd.

`scripts/workerd-win-arm64-shim.cjs` fixes this: Windows 11 ARM64 emulates x64, so it
reports `x64` to workerd's platform check for exactly one `require`, then restores the
real value. It is surgical on purpose — a blanket override would break esbuild, which
resolves its own native binary the same way and has a real `@esbuild/win32-arm64` build.

It needs the x64 workerd package, which npm refuses on this cpu:
```bash
npm install --no-save --force @cloudflare/workerd-windows-64@1.20260714.1
```
Match the version to `node_modules/workerd/package.json`. `--no-save` is deliberate: it is
a machine-specific workaround, not a project dependency. **Re-run it after any `npm ci`.**

### Deploying
```bash
npm run deploy
```
That routes through the shim with `--max-old-space-size=4096` — the default Node heap dies
with `Fatal process out of memory: Zone` during asset upload. Any other wrangler command:
`npm run wrangler -- <command>`.

| Tool | Location | Version | Notes |
|------|----------|---------|-------|
| Node.js (Windows) | `C:\Program Files\nodejs\` | v24.15.0 | runs everything, wrangler included |
| wrangler | `node_modules/wrangler` | 4.112.0 | works via the shim |
| WSL Debian | — | — | **currently broken** (`Wsl/Service/E_UNEXPECTED`); no longer needed |

- **CLOUDFLARE_ACCOUNT_ID**: `f0c4e17596d18716db367d6c7814b394`
- **CLOUDFLARE_ZONE_ID**: `264f01c7f5d0920b06eb12b773362c80` (legacysweatequity.com)
- **D1 Database ID**: `847928be-c56f-4de4-bff4-083e08db9140` (`legacy-db`)
- **Auth**: an OAuth session is stored at
  `%APPDATA%\xdg.config\.wrangler\config\default.toml` with `workers_scripts:write` and
  `d1:write`. It carries `offline_access`, so an expired access token refreshes silently.
  No API token needs to be supplied.

`wrangler deploy` bundles Hono, so `node_modules` must be populated before deploying.

## ⚠️ Migrating Production D1

Production was migrated **non-destructively** on 2026-08-29: only the three new tables and
seven indexes were created. The retired roofing tables (`canvassers`, `properties`,
`leads`, `insights`) are **still there** — they do not collide with anything and the app
ignores them.

`schema.sql` still opens with DROP statements, so running `npm run db:migrate` against
production **will** destroy those tables. That is fine — a verified backup of all 64 rows
sits in `roofing-archive-2026-08-29.sql` (gitignored; it holds real prospect names and
phone numbers). Restore it into an empty database to undo.

Schema changes go through the Cloudflare MCP rather than the CLI:
```
mcp__b974c1ad-f820-4734-9544-136ef3ce9117__d1_database_query
  database_id: 847928be-c56f-4de4-bff4-083e08db9140
```
Send one statement per call — multi-statement DDL and destructive DROP/DELETE are
generally refused, which is the desired behaviour for a production database.

## Provider Secrets

`GROQ_API_KEY`, `OPENROUTER_API_KEY` and `TAVILY_API_KEY` are bound and verified live
(2026-08-29). `MAPBOX_TOKEN` is not set, so the route planner uses its great-circle
heuristic. Check status any time with `GET /api/health`.

To set or rotate one — pipe on stdin so it works non-interactively, and use `printf`
rather than `echo` so no trailing newline lands inside the secret:
```bash
printf '%s' "<key>" | npm run wrangler -- secret put GROQ_API_KEY
```

A stale `GEMINI_API_KEY` from the roofing app is still bound; nothing reads it.
Remove with `npm run wrangler -- secret delete GEMINI_API_KEY`.

### Model IDs are a live dependency

`anthropic/claude-3.5-haiku` was retired from OpenRouter and returns **404**, which
silently degraded both the EOD debrief and the voice-journal structuring pass. The pinned
id is now `anthropic/claude-haiku-4.5`. If AI features start reporting `degraded` with
nothing else changed, check the id against `https://openrouter.ai/api/v1/models` first.
All three are overridable without a code change via `GROQ_MODEL`,
`OPENROUTER_STRUCTURE_MODEL` and `OPENROUTER_ENRICH_MODEL`.

## Critical Rules for Agents

### DO
- **Check `PROJECT_PROGRESS.md` first.** Update it after every change session.
- **Maintain the zero-cost architecture.** Cloudflare free tier; every AI feature must
  degrade cleanly when its key is absent.
- **Keep the Samsung One UI dark theme** — use the CSS custom properties in `:root`.
- **Preserve offline-first.** Every log goes to IndexedDB first, network second.
  `public/app/store.js` is load-bearing.
- **Never lose a field visit.** If a provider fails, still write the activity with the
  derived disposition and report `degraded`.
- **Validate on write, escape on output.** `src/lib/validate.js` before D1; `textContent`
  when rendering. Do not reintroduce HTML-escaping at the storage layer — it corrupts
  `O'Brien` into `O&#039;Brien` in the CRM handoff without preventing anything.
- **Do all business-day math in `America/Chicago`** via `src/lib/time.js`. Never
  `DATE('now')`.
- **Store timestamps via `toSqlTimestamp()`.** Date filters are string comparisons; a raw
  ISO string sorts wrong and silently drops rows.
- **Re-validate model output.** A model is not a validator.
- **Keep touch targets ≥ 48px.** Used in bright sunlight, one-handed.
- **Run `npm test`** — 89 zero-dependency tests.

### DON'T
- **Don't add a frontend framework or a build step.** Hono is the only runtime dependency.
- **Don't modify `wrangler.jsonc`** unless explicitly asked.
- **Don't expose provider keys client-side.** Groq, OpenRouter, Tavily and Mapbox are all
  server-side.
- **Don't rename HTML element IDs** — the ES modules reference them.
- **Don't break the API contract** — `store.js` and `desktop.js` depend on the exact
  response shapes of `/api/sync`, `/api/transcribe-and-log`, `/api/activity`,
  `/api/companies`, `/api/enrich`, `/api/route/optimize` and `/api/export/d365`.

## D365 Column Mapping

`D365_OPEN_LEADS_COLUMNS` in `public/app/d365.js` now holds the agent's **actual** 31-column
Open Leads export sequence (supplied 2026-08-29). It is authoritative — do not reorder it.
`test/d365.test.js` pins the exact header order, so an accidental change fails loudly.

Two things about it are worth knowing:

1. **`AGENT_PROFILE` (same file) is still blank.** Lead Owner, DSC User, RSC User, Market
   and IR Number export as empty cells until the agent fills them in. D365 accepts blanks;
   it just leaves the lead unassigned and unrouted.
2. **The view has no Description or Notes column**, so the voice journal's AI summary,
   objections and next action do not reach D365 — they live only in the app.
   `buildDescription()` is kept and documented; splicing one line into the array restores
   it if a notes column is ever added to the view.
