-- =====================================================================
-- D1 Schema — Aflac B2B Field Prospecting Assistant
--
-- Replaces the retired "Legacy Sweat Equity" B2C roofing canvassing
-- schema. Column names on `companies` and `contacts` intentionally mirror
-- Microsoft Dynamics 365 Lead / Contact attributes so a row can be
-- projected straight into the Aflac D365 "Open Leads" view with no
-- field mapping step (see public/app/app.js -> D365_OPEN_LEADS_COLUMNS).
--
-- Idempotent: safe to re-run with
--   npm run db:migrate        (remote)
--   npm run db:migrate:local  (local)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. TEARDOWN — retired B2C roofing tables
--    Children first: `leads` references `properties`, which references
--    `canvassers`. Dropping a parent first errors under enforced FKs.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS damages;
DROP TABLE IF EXISTS insights;
DROP TABLE IF EXISTS properties;
DROP TABLE IF EXISTS canvassers;

-- ---------------------------------------------------------------------
-- 1. COMPANIES — the prospect account (D365 Lead)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
    company_id TEXT PRIMARY KEY,
    d365_lead_id TEXT,
    d365_checksum TEXT,
    d365_modified_on TEXT,
    company_name TEXT NOT NULL,
    street_1 TEXT, street_2 TEXT, city TEXT, state TEXT, zip_code TEXT,
    lat REAL, long REAL,
    lead_source TEXT DEFAULT 'Cold Call',
    rating TEXT DEFAULT 'Cold',
    employees INTEGER, industry TEXT,
    sic_code TEXT,
    account_number TEXT,
    post_enrollment_date TEXT,
    is_d365_synced BOOLEAN DEFAULT 0,
    renewal_date TEXT,
    pipeline_stage TEXT DEFAULT 'PROSPECT',
    stage_entered_at TEXT,
    snoozed_until TEXT,
    disqualified_reason TEXT,
    forecast_ap REAL,
    forecast_confidence INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- 2. CONTACTS — people at the account; `is_primary_dm` flags the
--    decision maker whose sign-off actually closes the case.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
    contact_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    first_name TEXT, last_name TEXT, job_title TEXT,
    phone_number TEXT, email_address TEXT,
    is_primary_dm BOOLEAN DEFAULT 1,
    FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- 3. ACTIVITY_LOGS — one row per touch. The three booleans are the
--    "3-Tap Binary" field UI; `disposition` is derived from them and
--    then refined by the voice-journal LLM pass.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
    log_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    contact_id TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    is_in_person BOOLEAN NOT NULL,
    is_initial BOOLEAN NOT NULL,
    is_dm_contact BOOLEAN NOT NULL,
    disposition TEXT NOT NULL,
    presentation_date TEXT, enrollment_date TEXT, projected_ap REAL,
    raw_audio_transcription TEXT,
    ai_structured_notes TEXT,
    sync_tier_status TEXT DEFAULT 'PENDING',
    next_action_date TEXT,
    next_action_text TEXT,
    FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_companies_coords ON companies(lat, long);

-- ---------------------------------------------------------------------
-- 4. SUPPORTING INDEXES
--    Every one of these backs a query the Worker issues on a hot path.
--    Without them each request degrades to a full table scan.
-- ---------------------------------------------------------------------

-- Route planner: "companies with no activity_logs row yet" anti-join,
-- and the company timeline on the detail view.
CREATE INDEX IF NOT EXISTS idx_activity_company ON activity_logs(company_id, timestamp);

-- Tier 1 handoff table: today's activities, newest first.
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_logs(timestamp);

-- Tier 2/3 export split: which rows still owe D365 a write.
CREATE INDEX IF NOT EXISTS idx_activity_sync_tier ON activity_logs(sync_tier_status);

-- Tier 2 (update existing) vs Tier 3 (create net-new) partitioning.
CREATE INDEX IF NOT EXISTS idx_companies_d365_synced ON companies(is_d365_synced);

-- Mobile company type-ahead (LIKE prefix scan) and duplicate detection.
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(company_name);

-- Contact lookup when building a Tier 1 row for an account.
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id, is_primary_dm);

-- Pipeline CRM: stage filter + snooze wake-up queries.
CREATE INDEX IF NOT EXISTS idx_companies_pipeline ON companies(pipeline_stage, snoozed_until);

-- Pipeline CRM: next-action task list queries.
CREATE INDEX IF NOT EXISTS idx_activity_next_action ON activity_logs(company_id, next_action_date);

-- ---------------------------------------------------------------------
-- 5. PIPELINE EVENTS — audit log for stage transitions.
--    Every time pipeline_stage changes, a row lands here so the agent
--    can review their deal-flow history and the EOD debrief can cite
--    concrete pipeline movement stats.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_events (
    event_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    trigger_log_id TEXT,
    reason TEXT,
    FOREIGN KEY (company_id) REFERENCES companies(company_id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_company ON pipeline_events(company_id, changed_at);

-- ---------------------------------------------------------------------
-- 6. NON-DESTRUCTIVE MIGRATIONS — add new columns to existing production DB.
--    All listed ALTERs below have been EXECUTED against production D1
--    on 2026-08-30. They are kept commented as documentation.
--    (D1 MCP rejects multi-statement DDL — run one statement per call.)
-- ---------------------------------------------------------------------
-- Phase 1 (D365 fields, executed 2026-08-30):
--   ALTER TABLE companies ADD COLUMN sic_code TEXT;
--   ALTER TABLE companies ADD COLUMN account_number TEXT;
--   ALTER TABLE companies ADD COLUMN post_enrollment_date TEXT;
--
-- Phase 2 (Pipeline CRM, executed 2026-08-30):
--   ALTER TABLE activity_logs ADD COLUMN next_action_date TEXT;
--   ALTER TABLE activity_logs ADD COLUMN next_action_text TEXT;
--   ALTER TABLE companies ADD COLUMN pipeline_stage TEXT DEFAULT 'PROSPECT';
--   ALTER TABLE companies ADD COLUMN stage_entered_at TEXT;
--   ALTER TABLE companies ADD COLUMN snoozed_until TEXT;
--   ALTER TABLE companies ADD COLUMN disqualified_reason TEXT;
--   ALTER TABLE companies ADD COLUMN forecast_ap REAL;
--   ALTER TABLE companies ADD COLUMN forecast_confidence INTEGER;
--   CREATE TABLE IF NOT EXISTS pipeline_events (...);
--   CREATE INDEX IF NOT EXISTS idx_companies_pipeline ON companies(pipeline_stage, snoozed_until);
--   CREATE INDEX IF NOT EXISTS idx_activity_next_action ON activity_logs(company_id, next_action_date);
--   CREATE INDEX IF NOT EXISTS idx_pipeline_events_company ON pipeline_events(company_id, changed_at);

