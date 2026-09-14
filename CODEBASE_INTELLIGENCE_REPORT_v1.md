# CODEBASE INTELLIGENCE REPORT v1.md
**System Architecture & Technical Reconnaissance Audit**  
**Target Repository:** `legacy_sweat_equity`  
**Domain Pivot Context:** B2B Field Prospecting Assistant for Aflac (Springfield, MO)  
**Date of Audit:** 2026-09-14  
**Audit Scope:** 100% Read-Only Deep Dive Analysis  

---

## EXECUTIVE SUMMARY

The `legacy_sweat_equity` repository underwent a total domain pivot on **2026-08-29**, converting a legacy B2C roofing door-canvassing app into an offline-first **Aflac Field Prospecting Assistant & B2B CRM Console**.

The app runs on a zero-cost architecture leveraging:
- **Edge Backend**: Hono framework on Cloudflare Workers with D1 (SQLite) and R2 (audio storage).
- **Client PWA**: Vanilla ES modules with zero build steps/bundlers, utilizing standard HTML5, CSS custom properties (Samsung One UI dark theme), IndexedDB (`AflacProspectDB` & `AgencyOS_DB`), and Service Worker caching (`sw.js`).
- **Multi-Device Adaptability**: Single HTML document serving a rapid 3-tap mobile field log for Samsung Galaxy S21+ / Moto G Stylus and a desktop command console (`≥1024px`) for Samsung Galaxy Book Go 5G (ARM64).
- **AI Orchestration**: Multi-provider mesh consisting of Groq Whisper (`whisper-large-v3-turbo`) for voice note transcription, OpenRouter models (`z-ai/glm-5.3-flash`, `qwen/qwen-3.8-27b`, `meta-llama/llama-3.3-70b-instruct`) for CRM note structuring and pre-call intelligence, and Tavily for live B2B web search.

---

## 1. DATABASE ARCHITECTURE (Cloudflare D1 SQLite)

### 1.1 Overview & Schema Integrity
The production database uses **Cloudflare D1 (SQLite)** (`legacy-db`, ID: `847928be-c56f-4de4-bff4-083e08db9140`). Primary data models mirror Microsoft Dynamics 365 Lead & Contact attributes to allow direct row projection into Aflac D365 "Open Leads" exports without field mapping steps.

All main tables enforce multi-tenancy via composite primary keys and foreign key constraints bound to `agent_email` (defaulting to `sean_deardorff@us.aflac.com`).

```
                              +-----------------------+
                              |       COMPANIES       |
                              +-----------------------+
                              | PK: company_id        |
                              | PK: agent_email       |
                              +-----------+-----------+
                                          |
                   +----------------------+----------------------+
                   | 1:N (ON DELETE CASCADE)                     | 1:N
                   v                                             v
        +--------------------+                         +--------------------+
        |      CONTACTS      |                         |   ACTIVITY_LOGS    |
        +--------------------+                         +--------------------+
        | PK: contact_id     |                         | PK: log_id         |
        | PK: agent_email    |                         | PK: agent_email    |
        | FK: company_id     |                         | FK: company_id     |
        +--------------------+                         +--------------------+
                   |                                             |
                   +----------------------+----------------------+
                                          |
                                          v
                               +---------------------+
                               |   PIPELINE_EVENTS   |
                               +---------------------+
                               | PK: event_id        |
                               | PK: agent_email     |
                               | FK: company_id      |
                               +---------------------+
```

### 1.2 Full Table Schema Extraction

#### `companies` (Prospect Accounts & D365 Leads)
```sql
CREATE TABLE IF NOT EXISTS companies (
    company_id TEXT,
    d365_lead_id TEXT,
    d365_checksum TEXT,
    d365_modified_on TEXT,
    company_name TEXT NOT NULL,
    street_1 TEXT, street_2 TEXT, city TEXT, state TEXT, zip_code TEXT,
    lat REAL, long REAL,
    lead_source TEXT DEFAULT 'Cold Call',
    rating TEXT DEFAULT 'Cold',
    next_action TEXT,             -- Promoted actionable callback text
    next_action_date TEXT,        -- Promoted ISO-8601 callback date (YYYY-MM-DD)
    employees INTEGER, industry TEXT,
    sic_code TEXT, account_number TEXT, post_enrollment_date TEXT,
    is_d365_synced BOOLEAN DEFAULT 0,
    renewal_date TEXT,
    pipeline_stage TEXT DEFAULT 'PROSPECT',
    stage_entered_at TEXT,
    snoozed_until TEXT,
    disqualified_reason TEXT,
    forecast_ap REAL,
    forecast_confidence INTEGER,
    company_phone TEXT,
    decision_maker TEXT,          -- Name/Title string from import/debrief
    notes TEXT,
    current_voluntary_carrier TEXT,
    major_medical_carrier TEXT,
    is_hdhp INTEGER NOT NULL DEFAULT 0 CHECK (is_hdhp IN (0, 1)),
    estimated_w2_count INTEGER CHECK (estimated_w2_count IS NULL OR (typeof(estimated_w2_count) = 'integer' AND estimated_w2_count >= 0)),
    confidence_score INTEGER NOT NULL DEFAULT 30 CHECK (confidence_score BETWEEN 0 AND 100),
    geohash TEXT CHECK (geohash IS NULL OR (length(geohash) = 7 AND geohash NOT GLOB '*[^0123456789bcdefghjkmnpqrstuvwxyz]*')),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED', 'PHONE_VERIFIED', 'FIELD_VERIFIED', 'DISQUALIFIED')),
    created_at TEXT DEFAULT (datetime('now')),
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (company_id, agent_email)
);
```

#### `contacts` (People at Accounts)
```sql
CREATE TABLE IF NOT EXISTS contacts (
    contact_id TEXT,
    company_id TEXT NOT NULL,
    first_name TEXT, last_name TEXT, job_title TEXT,
    phone_number TEXT, email_address TEXT,
    is_primary_dm BOOLEAN DEFAULT 1,  -- Decision maker sign-off flag
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (contact_id, agent_email),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email) ON DELETE CASCADE
);
```

#### `activity_logs` (Append-Only Touch Audit Trail for D365 Export)
```sql
CREATE TABLE IF NOT EXISTS activity_logs (
    log_id TEXT,
    company_id TEXT NOT NULL,
    contact_id TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    is_in_person BOOLEAN NOT NULL,  -- 3-Tap Binary Toggle 1
    is_initial BOOLEAN NOT NULL,    -- 3-Tap Binary Toggle 2
    is_dm_contact BOOLEAN NOT NULL, -- 3-Tap Binary Toggle 3
    disposition TEXT NOT NULL,
    presentation_date TEXT, enrollment_date TEXT, projected_ap REAL,
    raw_audio_transcription TEXT,
    ai_structured_notes TEXT,       -- JSON blob storing summary, objections, next actions
    sync_tier_status TEXT DEFAULT 'PENDING',
    next_action_date TEXT,
    next_action_text TEXT,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (log_id, agent_email),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email)
);
```

#### `pipeline_events` (Pipeline Stage Transitions Audit Log)
```sql
CREATE TABLE IF NOT EXISTS pipeline_events (
    event_id TEXT,
    company_id TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    trigger_log_id TEXT,
    reason TEXT,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (event_id, agent_email),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email)
);
```

#### `activities` (Voice & Quick-Drop Event Log)
```sql
CREATE TABLE IF NOT EXISTS activities (
    activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    activity_type TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('PHONE', 'FIELD')),
    notes TEXT NOT NULL,
    outcome TEXT NOT NULL,
    raw_transcript TEXT NOT NULL,
    extracted_json TEXT NOT NULL,
    next_action TEXT NOT NULL DEFAULT 'NONE',
    next_action_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email)
);
```

#### `d365_daily_aggregates` (Local Compliance Counter Buffer)
```sql
CREATE TABLE IF NOT EXISTS d365_daily_aggregates (
    business_date TEXT NOT NULL,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    phone_dials INTEGER NOT NULL DEFAULT 0 CHECK (phone_dials >= 0),
    dm_contacts INTEGER NOT NULL DEFAULT 0 CHECK (dm_contacts >= 0),
    walk_ins INTEGER NOT NULL DEFAULT 0 CHECK (walk_ins >= 0),
    appointments_set INTEGER NOT NULL DEFAULT 0 CHECK (appointments_set >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_date, agent_email)
);
```

### 1.3 Supporting Indexes & Query Optimization
- `idx_companies_agent_geohash6`: Partial index for spatial radar scans on 6-character geohashes excluding terminal statuses (`DISQUALIFIED`, `DO_NOT_CONTACT`).
- `idx_companies_callback`: Partial index on `(agent_email, next_action_date) WHERE next_action_date IS NOT NULL` powering the dialer stack.
- `idx_companies_agent_confidence`: Fast confidence triage scans.
- `idx_activity_sync_tier`: Accelerates Tier 1/2/3 export queries.

---

## 2. PROGRESSIVE WEB APP (PWA) & OFFLINE CAPABILITIES

### 2.1 Service Worker Strategy (`public/sw.js`)
- **Cache Name**: `aflac-prospect-v11`
- **Pre-caching**: Caches static app shell files (`CORE_ASSETS`) and essential CDN dependencies (Leaflet CSS/JS, Outfit Google Font).
- **Fetch Handler**: Implements **Stale-While-Revalidate** for static shell resources. All `/api/*` network requests explicitly bypass the service worker cache to prevent stale state reads.
- **Background Sync**: Listens for tag `sync-agency-outbox` to drain IndexedDB outboxes (`AUDIO_STORE` and `ACTION_STORE` in `AgencyOS_DB`) in the background.

```javascript
// Service Worker Fetch Handler (stale-while-revalidate snippet)
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      });
      return cachedResponse || fetchPromise;
    })
  );
});
```

### 2.2 Offline Capture & Queue Engine (`public/app/store.js`)
- **Primary Database**: `AflacProspectDB` (v2) with object stores:
  - `queue` (KeyPath: `log_id`, Index: `by_timestamp`): Stores pending field activities, audio Blobs, company creations, and quick actions.
  - `dossiers` (KeyPath: `key`): Local cache for pre-call target dossiers.
- **Queue Drain Logic (`syncQueue()`)**:
  - Sorts pending entries chronologically by timestamp.
  - Evaluates dependency guards: if a company creation for `company_id` fails or is deferred, subsequent activity logs for that company are blocked to prevent server foreign key rejections.
  - Retries transient errors up to `MAX_ORDERED_ATTEMPTS = 4`. Beyond 4 attempts, the entry steps aside to allow remaining independent queue items to sync.
  - Permanent 4xx HTTP responses cause the client to drop the invalid entry and surface a toast notification.

---

## 3. BACKEND ROUTING & MCP SERVER PROTOCOLS

### 3.1 API Surface Area (`src/index.js`)

All endpoints sit under `/api/` and are enforced by CORS and authentication middleware in `src/lib/security.js`.

| Method | Endpoint | Handler File | Description |
|--------|----------|--------------|-------------|
| GET/POST | `/api/companies` | `src/routes/companies.js` | Search (`?q=`, `?untouched=1`), detail, and manual creation |
| POST | `/api/import` | `src/routes/companies.js` | Bulk import company records |
| POST | `/api/contacts` | `src/routes/companies.js` | Attach/update contact person |
| GET | `/api/enums` | `src/routes/companies.js` | Returns CRM option sets (dispositions, ratings, stages) |
| POST | `/api/enrich` | `src/routes/enrich.js` | Web search + Llama 3.3 pre-call intelligence dossier |
| GET | `/api/eod-debrief` | `src/routes/eod.js` | Aggregates day's activities into AI markdown EOD report |
| GET | `/api/eod-aggregates` | `src/routes/eod.js` | Compliance metrics (dials, DMs, walk-ins, appointments) |
| POST | `/api/route/optimize` | `src/routes/routing.js` | Drive sequence optimization (Mapbox + local 2-opt fallback) |
| GET | `/api/export/d365` | `src/routes/exports.js` | Export Tier 2 (.xlsx) / Tier 3 (.csv) partitioned D365 rows |
| POST | `/api/transcribe-and-log` | `src/routes/activity.js` | Multipart upload: Audio + booleans → Groq → OpenRouter → D1 |
| POST | `/api/sync` | `src/routes/activity.js` | Offline queue batch drain endpoint |
| POST/GET | `/api/activity` | `src/routes/activity.js` | Silent log creation / list day activities |
| GET | `/api/radar` | `src/routes/radar.js` | Proximity radar scan around lat/lng |
| POST | `/api/voice-debrief` | `src/routes/voice.js` | Process voice debrief recordings |
| GET | `/api/leads` | `src/routes/leads.js` | Confidence-band queue (PHONE 30-79, FIELD 80-100, TRIAGE 0-39) |
| ALL | `/api/mcp` | `src/routes/mcp.js` | Model Context Protocol stateless HTTP endpoint |

### 3.2 Model Context Protocol (MCP) Server (`src/routes/mcp.js`)
- Protocol Standard: **MCP 2026-07-28 (Stateless Streamable HTTP)**
- Authentication: Enforces `Authorization: Bearer <MCP_SECRET_KEY>` header.
- Available Tool:
  - `update_lead_intel`: Accepts `company_name`, `pipeline_stage`, and `new_notes`. Executes fuzzy matching (`LIKE %name%`) on `companies`. Updates stage and appends timestamped field notes directly in D1 SQLite.

```javascript
// MCP Tool Definition (src/routes/mcp.js snippet)
server.tool(
  'update_lead_intel',
  'Updates the pipeline stage and appends field notes/intelligence to a company in the PWA database.',
  {
    company_name: z.string().describe('Fuzzy matching target company name'),
    pipeline_stage: z.string().optional().describe('Pipeline stage to update'),
    new_notes: z.string().optional().describe('Field notes or intelligence to append')
  },
  async ({ company_name, pipeline_stage, new_notes }) => {
    const pattern = `%${company_name.trim()}%`;
    const { results } = await env.DB.prepare(
      'SELECT company_id, company_name, pipeline_stage, notes FROM companies WHERE company_name LIKE ?'
    ).bind(pattern).all();
    // Handles zero, single, or multiple match errors cleanly...
  }
);
```

### 3.3 Territory Routing Engine (`src/routes/routing.js`)
- **Primary Optimization**: Uses Mapbox Optimized Trips API (`https://api.mapbox.com/optimized-trips/v1/mapbox/driving`) when `MAPBOX_TOKEN` is configured.
- **Local Fallback**: When `MAPBOX_TOKEN` is absent or unconfigured, executes a nearest-neighbor tour construction followed by a **bounded 2-opt local search** over Haversine great-circle distances:

```javascript
// Bounded 2-opt Heuristic Fallback (src/routes/routing.js)
let improved = true;
let passes = 0;
while (improved && passes < 40) {
  improved = false;
  passes += 1;
  for (let i = 1; i < ordered.length - 1; i += 1) {
    for (let k = i + 1; k < ordered.length; k += 1) {
      const candidate = [
        ...ordered.slice(0, i),
        ...ordered.slice(i, k + 1).reverse(),
        ...ordered.slice(k + 1)
      ];
      if (tourLength(candidate) < tourLength(ordered) - 1e-9) {
        ordered.splice(0, ordered.length, ...candidate);
        improved = true;
      }
    }
  }
}
```

- **Expected Premium Value (EPV)**: Computes B2B risk multipliers per target:
  $$\text{EPV Score} = \frac{\text{Employees} \times \text{Industry Multiplier}}{\text{Distance (miles)} + 0.5}$$
  - Multipliers: Construction/Trades (2.0x), Manufacturing (1.8x), Transportation (1.7x), Healthcare (1.6x), Auto Dealerships (1.5x).

---

## 4. DATA INGESTION & ENRICHMENT PIPELINES

### 4.1 Ingestion Scripts
- **`ingest_leads.py` (SUPERSEDED)**: Kept for historical reference. Minted client-side `uuid4()` for every target and sent un-batched payloads, which previously created 91 duplicate records on 2026-09-01 due to identity resolution mismatches.
- **`sync_leads.py` (ACTIVE CANONICAL INGESTER)**:
  - Parses Markdown lead lists (`leads.md`).
  - Extracts canonical address components, email addresses, and splits Decision Makers into structured contacts (`first_name`, `last_name`, `job_title`).
  - Omits client-side UUID generation, allowing server-side matching (`src/lib/match.js`) to resolve existing identity via street/name fuzzy matching or create new accounts safely.
  - Batches imports in groups of 100 (below server limit of 250).

### 4.2 Deduplication & Matching Logic (`src/lib/match.js`)
Server matching operates in tiered priority:
1. Exact `d365_lead_id` match.
2. Normalized `company_name` + `street_1` match.
3. Normalized `company_phone` match.
4. High-confidence name match with missing street details.

---

## 5. AI & PROMPTING INFRASTRUCTURE

### 5.1 Model Selection Matrix (`src/lib/ai.js`)

| Task | Default Model ID | Fallback / Alternative | Provider |
|------|-------------------|------------------------|----------|
| Speech-to-Text | `whisper-large-v3-turbo` | — | Groq API |
| Simple Structuring | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4-flash` | OpenRouter |
| Complex Intelligence | `qwen/qwen-3.8-27b` | `meta-llama/llama-3.3-70b-instruct` | OpenRouter |
| Industry Classification | `z-ai/glm-5.3-flash` | Rule-based regex engine | OpenRouter |
| Web Intelligence | Tavily API v1 | — | Tavily |

### 5.2 Key Agentic Workflows & Prompts

1. **Voice Journal Structuring (`src/routes/activity.js`)**:
   - System prompt enforces extraction of strict JSON containing: `disposition`, `rating`, `presentation_date`, `enrollment_date`, `projected_ap`, `contact`, `summary`, `objections`, `next_action`, `key_facts`, `coaching_feedback`, and `product_interests`.
   - Explicitly instructs the LLM to redact PHI: `[REDACTED - PHI]`.

2. **Pre-Call Target Inspection (`src/routes/enrich.js`)**:
   - Prompts Llama 3.3 / Qwen to process Tavily raw web search output and generate 3 concise phone-ready bullets:
     - `**Executives:**` Decision makers.
     - `**Headcount:**` W-2 headcount range (bar: 3+ W-2 employees).
     - `**Industry Hook:**` Pitch opener referencing Springfield local commercial corridors (Glenstone, Battlefield, Sunshine, Kearney) and Section 125 pre-tax savings.
   - Guardrail directive: If facts are missing from search results, output `'Data stale. Dial main line to verify'`.

3. **End-of-Day (EOD) Debrief (`src/routes/eod.js`)**:
   - Compiles SQL-calculated metrics (Total Doors, DMs Met, Appointments, AP) alongside touch summaries.
   - Generates a 4-section Markdown report (Metrics Table, Narrative Summary, Sales Coaching, Territory Product Trends).

---

## 6. IDENTIFIED ARCHITECTURAL BOTTLENECK ANALYSIS

### ⚠️ Critical Inefficiencies & Operational Risks

1. **IndexedDB Outbox Queue Partitioning Discrepancy**
   - The application has two distinct offline outbox systems:
     - `store.js` manages `AflacProspectDB` (stores `queue` and `dossiers`).
     - `sw.js` and `state.js` attempt to open `AgencyOS_DB` (stores `audio_outbox` and `action_outbox`).
   - *Risk*: `sw.js` background sync listens on `sync-agency-outbox` and attempts to read from `AgencyOS_DB`. However, items queued by `field.js` via `store.js` land in `AflacProspectDB`. This disconnect can cause items queued in `AflacProspectDB` to wait for a manual app foreground/click event rather than being drained by background Service Worker sync.

2. **Mapbox Geocoding & Route Limits**
   - `routing.js` caps route optimization requests at 30 stops (`LIMITS.routeStops`). If an agent attempts to route a cluster of 35 field targets, the server rejects the request with HTTP 400 instead of chunking or auto-truncating the tour.

3. **Windows 11 ARM64 Workerd Shim Requirement**
   - Deployments running natively on Windows 11 ARM64 (Samsung Galaxy Book Go) require `scripts/workerd-win-arm64-shim.cjs` and `--no-save --force @cloudflare/workerd-windows-64@1.20260714.1` due to missing native win32-arm64 binaries in workerd. Re-running `npm ci` without this step breaks `npm run deploy`.

4. **Multi-Statement DDL Constraints on Cloudflare D1**
   - Production database D1 migrations reject multi-statement DDL string execution. Running `schema.sql` directly via remote migration scripts can fail if statements are not broken out into single-query MCP/API invocations.

5. **Local Business Day Math vs UTC Storage**
   - Activity timestamps and nightly rollups rely on `America/Chicago` business day math (`src/lib/time.js`). If client devices have out-of-sync system clocks or timezone misconfigurations, activity logs may sort improperly or land on the wrong business day aggregate block in `d365_daily_aggregates`.

---
*Report compiled autonomously by Lead Solutions Architect for CTO/CSO Strategist Review.*
