# Aflac Field Prospecting Assistant — Codebase Intelligence Report v2

**Target Audience:** Senior Edge Systems Architect  
**Objective:** Comprehensive, zero-prior-context brain-dump of the Legacy Sweat Equity codebase (Aflac B2B Prospecting Pivot).

---

## 1. Executive Summary & Tech Stack Overview

### Project Purpose & Evolution
This project is a **zero-cost, offline-first Progressive Web App (PWA) and Cloudflare edge backend** built for an independent Aflac insurance agent prospecting B2B accounts in Springfield, Missouri.
On **2026-08-29**, the project underwent a total domain pivot from a B2C roofing door-canvassing app to a B2B insurance sales tool. **All roofing logic is deprecated and safely ignored.**

### Technology Stack
*   **Backend Runtime:** Cloudflare Workers (via Hono web framework).
*   **Database:** Cloudflare D1 (SQLite at the edge).
*   **Blob Storage:** Cloudflare R2 (for archived voice journals).
*   **Frontend:** Vanilla HTML/CSS + Native ES Modules. **No framework (React/Vue) and no bundler (Webpack/Vite).**
*   **Service Worker:** Custom implementation (`public/sw.js`) managing offline persistence and background sync tag `sync-agency-outbox`.
*   **AI Integration:** Groq Whisper (transcription), OpenRouter (Claude Haiku 4.5 for CRM structuring, Llama 3.3 70B for dossier enrichment).
*   **Hosting Workaround:** Windows 11 ARM64 requires a surgical x64 shim (`scripts/workerd-win-arm64-shim.cjs`) to deploy via Wrangler.

### The Business & Philosophical Alignment
The architecture rigorously enforces the operator's strict sales philosophy:
*   **Radical Transparency:** The codebase reflects a "no tricks" approach. Lead statuses accurately map to the real-world (e.g., Gatekeeper Blocked, Information Left).
*   **The Precision Heuristic:** Exact, mathematically rigorous domain logic is embedded (e.g., the 7.65% Section 125 FICA offset engine in `tax.js`), turning abstract benefits into hard numbers.
*   **Radical Research:** Pre-call intelligence is mandatory. `api/enrich` (and the Gemini MCP `scrape_sos_business_entity` tool) enforce a data-first approach before walking into a business.
*   **The Direct Ask:** UI workflows like the "3-Tap Binary" (`field.js`) optimize for rapid decision-maker conversions without excessive CRM data entry overhead.

---

## 2. Database Schema & Data Models

The Cloudflare D1 SQLite database is the ultimate source of truth. The schema was non-destructively migrated in Phase 3. 

### Core Tables

#### `companies`
Stores B2B prospect targets. 
*   **Key Fields:** `company_id`, `company_name`, `lat`, `long`, `status`, `pipeline_stage`.
*   **Phase 3 Additions:** `cadence_stage` (tracks the 21-Day 12-touch workflow), `est_fica_tax_savings` (calculated via `tax.js`), `sync_version` (for Edge conflict resolution).

#### `contacts`
Tracks individual decision-makers at the company.
*   **Key Fields:** `contact_id`, `company_id`, `name`, `title`, `phone`, `email`.

#### `activity_logs`
Immutable ledger of agent interactions.
*   **Key Fields:** `log_id`, `company_id`, `disposition` (e.g., "Information Left", "DM Met"), `timestamp`.

#### `d365_daily_aggregates`
Rollup tables utilized for partitioning data for the Tier 2 / Tier 3 external exports.

---

## 3. The Edge Sync & Conflict Resolution Engine

Because the app is used in metal warehouses with zero signal, it employs a robust Offline-First Sync Engine located in `public/app/store.js` and `src/routes/activity.js`.

### Last-Write-Wins (LWW) Resolution
When the service worker reconnects, it pushes the `sync-agency-outbox` queue to `POST /api/sync`.
Conflict resolution relies on two Phase 3 columns: `sync_version` and `client_timestamp_utc`.
In `src/lib/db.js`, the upsert query dictates:
```sql
WHERE excluded.sync_version >= activity_logs.sync_version 
OR COALESCE(excluded.client_timestamp_utc, '') >= COALESCE(activity_logs.client_timestamp_utc, '')
```
This ensures that the latest field activity always overrides older edge state, preventing offline data loss.

### D1 Transaction Batching
Cloudflare D1 imposes limits on transaction sizes. To protect the worker, `POST /api/sync` (`activity.js`) chunks incoming syncs. It uses a `BATCH_CHUNK_LIMIT = 25`, executing exactly 25 statements via `c.env.DB.batch(statements)` before starting a new batch chunk.

---

## 4. Domain Logic & Sales Automations

### Expected Premium Value (EPV) & Routing
The `src/routes/routing.js` file handles geographical routing. It leverages:
1.  **Headcount Null-Safety:** `COALESCE(employees, estimated_w2_count, 3)` ensures mathematical safety. A business is assumed to have at least 3 employees if data is missing.
2.  **Risk Multipliers:** Base EPV is adjusted using 6 industry risk multipliers (e.g., a 2.0x multiplier for high-turnover/risk industries like Construction).
3.  **Fallback Algorithm:** If the Mapbox token is missing, the app gracefully falls back to a custom **2-opt bounded Haversine tour** heuristic to calculate the shortest path.

### FICA Tax Math (`tax.js`)
Calculates the tactical value of the Section 125 plan. For every dollar employees spend pre-tax on Aflac, the employer saves **7.65% in FICA taxes**. `tax.js` accurately generates these offset numbers (mock checks) for direct negotiation.

### The 21-Day Cadence Engine (`cadence.js`)
Defines the strict 12-touch B2B multi-channel sequence logic (combining Mail, Phone, Field Drop, and Email). The cadence engine advances statefully via `advance_cadence_touch`.

---

## 5. PWA Field UX & Safety Mechanisms

The frontend is completely vanilla JS, highly optimized for bright sunlight and one-handed operation.

### Passive Geofencing & 50m HUD Banner
In `public/app/field.js`, `navigator.geolocation.watchPosition` (abstracted away as location events) continuously tracks the agent. 
*   **The Check:** `evaluateGeofenceProximity(currentLat, currentLong)` measures Haversine distance against known accounts.
*   **The Trigger:** When within `PROXIMITY_THRESHOLD_METERS` (50 meters), a real-time HUD banner appears natively on the device, prompting a rapid 1-tap interaction (e.g., "DM Met", "Dropped Teaser", or "Quick Disqualify").

### Universal Reversibility (The 6-Second Buffer)
Sales agents make fast taps and mistakes happen.
*   **UI Buffer:** Handled in `public/app/ui.js` via `showUndoToast`. When an action (like Geofence Quick Disqualify) occurs, a toast appears with a 6-second countdown timer.
*   **Execution:** The API request is held in a `setTimeout`. If the user taps "UNDO", `clearTimeout` fires and the action is aborted before it ever hits the network. 
*   **Reactivation:** If a disqualification goes through, it can be mathematically reversed via the `POST /api/leads/reactivate` REST endpoint.

---

## 6. The Gemini Spark MCP Ecosystem

The system features a complete Model Context Protocol (MCP) server integration (`src/routes/mcp.js`), enabling a Gemini instance to interact directly with the Aflac ecosystem. 

**Registered Tools:**
1.  `update_lead_intel`: Updates missing decision-maker names, headcount, and CRM notes.
2.  `get_daily_telemetry`: Fetches live metrics (Doors knocked, DMs met, Next steps).
3.  `get_pipeline_summary`: Aggregates current pipeline stages.
4.  `triage_suppression_list`: Scans leads to flag likely un-closeable targets (Do Not Contact).
5.  `generate_route_manifest`: Calculates optimal pathing via EPV and the Haversine heuristic.
6.  `log_quick_action`: Pushes a silent CRM activity log entry.
7.  `generate_section125_teaser`: Calculates the specific 7.65% FICA tax offset hook for a target.
8.  `advance_cadence_touch`: Bumps the 21-day, 12-touch B2B cadence to the next stage.
9.  `scrape_sos_business_entity`: Radical research tool to pull Missouri Secretary of State public filings. **Crucially, this tool utilizes a strict `AbortSignal.timeout(4000)` fallback mechanism.** If the state registry hangs for more than 4 seconds, the tool bails out safely to prevent blocking the LLM request context.
