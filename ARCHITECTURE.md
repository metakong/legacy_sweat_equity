# Aflac Field Prospecting Assistant — Architecture

> Replaced the "Legacy Sweat Equity" B2C roofing canvassing system on 2026-08-29.
> Same Cloudflare account, same zero-cost posture, entirely different domain model.

## System Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                            CLOUDFLARE EDGE                                │
│                                                                           │
│  ┌──────────────────────┐   ┌────────────────┐   ┌────────────────────┐   │
│  │  Worker (Hono)       │◄─►│  D1 (SQLite)   │   │  R2                │   │
│  │  src/index.js        │   │  legacy-db     │   │  legacysweatequity │   │
│  │  + src/routes/*      │   │                │   │  voice journals    │   │
│  └────────┬─────────────┘   └────────────────┘   └────────────────────┘   │
│           │                                                               │
│           │  outbound, server-side keys only                              │
│           ├──► Groq         whisper-large-v3-turbo   (transcription)      │
│           ├──► OpenRouter   Claude 3.5 Haiku         (CRM structuring)    │
│           ├──► OpenRouter   Llama 3.3 70B            (target dossier)     │
│           ├──► Tavily       web search               (target dossier)     │
│           └──► Mapbox       Optimization v1          (route sequencing)   │
│                                                                           │
│           Cron 0 2 * * *  →  nightly rollup (read-only, logged)           │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  STATIC ASSETS (./public via the ASSETS binding)                    │  │
│  │  /  and  /app/   → the PWA (both form factors)                      │  │
│  │  /sw.js          → service worker                                   │  │
│  │  /manifest.json  → PWA manifest                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                         TRI-DEVICE FIELD SETUP                            │
│                                                                           │
│  Moto G Stylus          Galaxy S21+                Galaxy Book Go 5G      │
│  (live phone calls)     (mobile PWA)               (in-vehicle console)   │
│                                                                           │
│                    ┌──────────────────────┐   ┌──────────────────────┐    │
│                    │ Field Log view       │   │ Sidebar console      │    │
│                    │ • Leaflet map        │   │ • Route Planner      │    │
│                    │ • ⚡ Inspect Target   │   │ • Tier 1 clipboard   │    │
│                    │ • 3-Tap Binary       │   │ • Tier 2/3 exports   │    │
│                    │ • MediaRecorder mic  │   │ • Samson Q2U mic     │    │
│                    │ • IndexedDB queue    │   │   (same field log)   │    │
│                    └──────────────────────┘   └──────────────────────┘    │
│                              < 1024px              ≥ 1024px               │
└───────────────────────────────────────────────────────────────────────────┘
```

One HTML document serves both form factors. The `≥1024px` breakpoint reveals the
sidebar and the three operational tabs; below it the field log **is** the app.

## Data Model

Three tables, named to mirror Dynamics 365 Lead/Contact attributes so a row can be
projected into the Aflac CRM with no field-mapping step.

```
companies ──1:N──► contacts
    │                  │
    └──1:N──► activity_logs ──N:1──┘  (contact_id, nullable)
```

- **`companies`** — the prospect account. Carries the D365 identity
  (`d365_lead_id`, `d365_checksum`, `d365_modified_on`) when one exists. That triple is
  what distinguishes a **Tier 2** update from a **Tier 3** net-new import.
- **`contacts`** — people at the account. `is_primary_dm` flags the decision maker.
- **`activity_logs`** — one row per touch. The three booleans are the entire mobile
  disposition UI; `disposition` is derived from them and refined by the LLM pass.

## The 3-Tap Binary

The mobile UI has no disposition picker. Three paired toggles fully determine a
fallback disposition, and a voice note upgrades it:

| in-person | initial | DM reached | derived disposition |
|-----------|---------|-----------|---------------------|
| ✓ | – | ✗ | Gatekeeper Blocked |
| ✗ | – | ✗ | No Contact |
| – | ✓ | ✓ | Information Left |
| – | ✗ | ✓ | Follow-Up Scheduled |

`deriveDisposition()` lives in `src/lib/validate.js` and is mirrored (for display only)
in `public/app/field.js`. The server is always the authority.

## Data Flow

### 1. Voice journal → CRM record
```
Agent sets 3 toggles, taps 🎙️, talks, taps again
  → MediaRecorder captures mono Opus (16 kHz, 24 kbps)
  → Blob + toggles + company payload queued in IndexedDB
  → When online: POST /api/transcribe-and-log (multipart)
      → R2 archives the raw audio      (best effort, non-fatal)
      → Groq whisper-large-v3-turbo    → transcript
      → OpenRouter Claude 3.5 Haiku    → strict JSON, CRM enums enforced
      → contact upserted if the model named one
      → activity_logs row written, companies.rating updated
  → transcript pushed back to the UI via a `voicelogged` event
```

**Degradation is a feature.** If Groq or OpenRouter fails, the row still lands with the
derived disposition and the response carries `degraded: 'transcription_failed'`. Losing
a field visit because a model provider had a bad minute is strictly worse than losing
the AI polish.

### 2. ⚡ Inspect Target
```
POST /api/enrich { company_name, address }
  → Tavily advanced search
  → OpenRouter Llama 3.3 70B, constrained to exactly three bullets
  → { Executives, Headcount, Industry Hook } + sources
  → headcount parsed back onto companies.employees when confident
```
The model is told to write "Not found in public sources." rather than guess. A
hallucinated HR director's name is worse than a blank.

### 3. Offline queue drain
```
Every log → IndexedDB first, network second
  → voice logs upload one at a time  (multipart + two model calls)
  → silent logs batch 50 at a time   → POST /api/sync
  → server reports accepted[] / rejected[]
      accepted → deleted from the queue
      rejected → deleted + surfaced (a permanently invalid record must not
                 wedge the queue behind it)
      neither  → left queued (infrastructure failure, retry next cycle)
```

### 4. Three-tier D365 handoff
```
Tier 1  navigator.clipboard.writeText(tab-delimited row)
        → paste straight into the Open Leads grid
        → marks sync_tier_status = TIER1_COPIED

Tier 2  companies WITH a d365_lead_id
        → SheetJS .xlsx, led by the three (Do Not Modify) columns
          exactly as Dynamics exported them
        → the checksum is what makes the re-import an UPDATE, not a duplicate
        → marks TIER2_EXPORTED

Tier 3  companies WITHOUT a d365_lead_id
        → clean UTF-8 BOM .csv for the Import Data wizard
        → marks TIER3_EXPORTED
```

`public/app/d365.js` owns the column definitions. All three tiers read from that one
array, so the ordering can never drift between them.

### 5. Route planning
```
POST /api/route/optimize { company_ids, start }
  → MAPBOX_TOKEN set?  → Optimization v1 against the real road network
  → otherwise          → nearest-neighbour + 2-opt over great-circle distance
```
The fallback keeps the feature usable at zero cost. For a dozen stops inside one metro
it lands within a few percent of optimal — well inside traffic noise. The token is
server-side only; it never reaches the browser.

## Timezone Handling

**The field agent works in `America/Chicago`. Never derive a business day from UTC.**

The cron fires at 02:00 UTC, which is 21:00 the *previous* evening in Springfield.
A UTC-derived date analyzes a window that excludes the entire workday that just ended.

`src/lib/time.js` is the only place this math lives:

| function | use |
|----------|-----|
| `businessDate()` | today's local calendar date, `YYYY-MM-DD` |
| `businessDayRangeUtc(date)` | UTC bounds of a local day (DST-aware, two-pass) |
| `toSqlTimestamp(value)` | **coerce any client timestamp into D1's format** |
| `toLocalStamp(ts)` | `YYYY-MM-DD HH:MM` local, for the CRM paste |
| `localHourOf(ts)` | local hour of a stored stamp |

### The storage-format trap

Every date filter in this app is a lexicographic **string** comparison against SQLite's
`'YYYY-MM-DD HH:MM:SS'`. An ISO-8601 string stored verbatim sorts *above* the D1 format
for the same instant, because `'T'` (0x54) > `' '` (0x20). Mixing the two formats in one
column silently drops rows from the daily Tier 1 view.

`normalizeActivityLog()` runs every incoming timestamp through `toSqlTimestamp()` for
exactly this reason. Covered by tests in `test/worker.test.js`.

## Security Model

**Validate on write, escape on output.** Stored text is kept raw — trimmed, length-
capped, control-characters stripped. Escaping happens at the point of output: every
render path builds DOM with `textContent`, and API responses are JSON.

HTML-escaping on write was tried and removed: it corrupted the data (`O'Brien` became
`O&#039;Brien` in the D365 clipboard handoff and in the LLM prompt) without preventing
anything.

Other invariants:
- **Cross-origin POSTs are rejected outright** — a plain form POST needs no preflight,
  so CORS alone would not stop a drive-by write into D1.
- **Only primitives are bound to D1.** An object reaching `.bind()` throws and 500s the
  request; every coercer in `validate.js` returns `null` or a primitive.
- **The model is not a validator.** Every field it returns is re-checked against the
  same coercers the manual paths use, and enum values are matched against the option set.
- **Provider keys never reach the browser.** Groq, OpenRouter, Tavily and Mapbox are all
  called from the Worker.
- **CSP is strict** — no inline script anywhere. The only third-party script origins are
  `unpkg.com` (Leaflet) and `cdn.sheetjs.com` (SRI-pinned).
- **R2 keys are flat and pattern-matched** (`journal-<id>.<ext>`); stored content types
  are re-checked on read rather than echoed back.

## Technology Constraints

- **Zero cost.** Everything sits on Cloudflare's free tier. The model providers have
  their own free/cheap tiers; every AI feature degrades cleanly when unconfigured.
- **No build step you run.** Native ES modules in the browser; `wrangler deploy` bundles
  Hono with esbuild automatically.
- **Hono is the only runtime dependency.**
- **Local dev mirrors production.** `node:sqlite` runs the Worker's real SQL against real
  SQLite, so a broken JOIN, a bad `ON CONFLICT`, or an FK violation fails locally instead
  of after deploy.

## Deviations Worth Knowing

- `wrangler.jsonc` is unchanged (worker name `legacy-sweat-equity`, D1 `legacy-db`, R2
  `legacysweatequity`, routes on `legacysweatequity.com`). Renaming those is a
  destructive infra operation and needs an explicit decision.
- The `0 2 * * *` cron still exists, so `scheduled()` runs a **read-only** nightly rollup
  logged via `npm run tail`. The B2B schema has no `insights` table; add one if the
  numbers turn out to be worth persisting.
