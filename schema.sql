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
    company_id TEXT,
    d365_lead_id TEXT,
    d365_checksum TEXT,
    d365_modified_on TEXT,
    company_name TEXT NOT NULL,
    street_1 TEXT, street_2 TEXT, city TEXT, state TEXT, zip_code TEXT,
    lat REAL, long REAL,
    lead_source TEXT DEFAULT 'Cold Call',
    rating TEXT DEFAULT 'Cold',
    -- Sprint 6: the account's live callback commitment, promoted off the
    -- append-only activity log so the dialer can order by it with one indexed
    -- range scan (migrations/0006_actionable_callbacks.sql).
    next_action TEXT,
    next_action_date TEXT,
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
    company_phone TEXT,
    decision_maker TEXT,
    notes TEXT,
    current_voluntary_carrier TEXT,
    major_medical_carrier TEXT,
    is_hdhp INTEGER NOT NULL DEFAULT 0 CHECK (is_hdhp IN (0, 1)),
    estimated_w2_count INTEGER CHECK (
        estimated_w2_count IS NULL
        OR (
            typeof(estimated_w2_count) = 'integer'
            AND estimated_w2_count >= 0
        )
    ),
    confidence_score INTEGER NOT NULL DEFAULT 30
        CHECK (confidence_score BETWEEN 0 AND 100),
    geohash TEXT CHECK (
        geohash IS NULL
        OR (
            length(geohash) = 7
            AND geohash NOT GLOB '*[^0123456789bcdefghjkmnpqrstuvwxyz]*'
        )
    ),
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (
        verification_status IN (
            'UNVERIFIED', 'PHONE_VERIFIED', 'FIELD_VERIFIED', 'DISQUALIFIED'
        )
    ),
    cadence_stage INTEGER DEFAULT 0,
    cadence_status TEXT DEFAULT 'INACTIVE' CHECK (cadence_status IN ('INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'DISQUALIFIED')),
    cadence_next_due_date TEXT,
    cadence_last_touch_at TEXT,
    est_fica_tax_savings REAL DEFAULT 0.00,
    teaser_check_generated_at TEXT,
    headcount_confidence_score REAL DEFAULT 0.0,
    qualification_status TEXT DEFAULT 'QUALIFIED' CHECK(qualification_status IN ('QUALIFIED', 'SUB_THRESHOLD', 'NEEDS_AUDIT', 'QUARANTINE')),
    access_type TEXT DEFAULT 'OPEN_COMMERCIAL' CHECK(access_type IN ('OPEN_COMMERCIAL', 'LOCKED_DOOR_PHONE_ONLY', 'GATED_SECURITY', 'APPOINTMENT_ONLY')),
    sync_version INTEGER DEFAULT 1,
    updated_at_utc TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (company_id, agent_email)
);

-- ---------------------------------------------------------------------
-- 2. CONTACTS — people at the account; `is_primary_dm` flags the
--    decision maker whose sign-off actually closes the case.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
    contact_id TEXT,
    company_id TEXT NOT NULL,
    first_name TEXT, last_name TEXT, job_title TEXT,
    phone_number TEXT, email_address TEXT,
    is_primary_dm BOOLEAN DEFAULT 1,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (contact_id, agent_email),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- 3. ACTIVITY_LOGS — one row per touch. The three booleans are the
--    "3-Tap Binary" field UI; `disposition` is derived from them and
--    then refined by the voice-journal LLM pass.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
    log_id TEXT,
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
    coordinator_present BOOLEAN DEFAULT 0,
    next_action_date TEXT,
    next_action_text TEXT,
    sync_version INTEGER DEFAULT 1,
    client_timestamp_utc TEXT,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (log_id, agent_email),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email)
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

-- Tenant-scoped six-character Geohash prefix lookup for radar scans. The
-- partial predicate mirrors the terminal-status exclusion in the radar
-- query so the planner can use this expression index on the hot path.
CREATE INDEX IF NOT EXISTS idx_companies_agent_geohash6
    ON companies (
        agent_email,
        SUBSTR(geohash, 1, 6)
    )
    WHERE status NOT IN ('DISQUALIFIED', 'DO_NOT_CONTACT');

-- Confidence triage and high-confidence field-canvass filtering.
CREATE INDEX IF NOT EXISTS idx_companies_agent_confidence
    ON companies (
        agent_email,
        confidence_score,
        status
    );

-- Sprint 6: due-callback-first ordering for the Monday dialer stack. Partial so
-- the many accounts with no pending commitment never enter the b-tree
-- (migrations/0006_actionable_callbacks.sql).
CREATE INDEX IF NOT EXISTS idx_companies_callback
    ON companies(agent_email, next_action_date)
    WHERE next_action_date IS NOT NULL;

-- Fast Indices for Geofencing & Cadence Sweeps (Phase 3 Enterprise)
CREATE INDEX IF NOT EXISTS idx_companies_cadence_sweep 
ON companies (agent_email, cadence_status, cadence_next_due_date) 
WHERE cadence_status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_companies_spatial_active 
ON companies (agent_email, status, lat, long) 
WHERE status = 'ACTIVE' AND lat IS NOT NULL AND long IS NOT NULL;

-- Phase 2 Edge Blueprint: Hard scoring gates & curbside access indexes
CREATE INDEX IF NOT EXISTS idx_companies_qualification ON companies(agent_email, qualification_status, status);
CREATE INDEX IF NOT EXISTS idx_companies_access ON companies(agent_email, access_type);


-- ---------------------------------------------------------------------
-- 5. PIPELINE EVENTS — audit log for stage transitions.
--    Every time pipeline_stage changes, a row lands here so the agent
--    can review their deal-flow history and the EOD debrief can cite
--    concrete pipeline movement stats.
-- ---------------------------------------------------------------------
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
CREATE INDEX IF NOT EXISTS idx_pipeline_events_company ON pipeline_events(company_id, changed_at);

-- ---------------------------------------------------------------------
-- 5b. ACTIVITIES — append-only voice event log (migrations/0005_voice_orchestration.sql)
--     Distinct from activity_logs: `company_id` is nullable, because the
--     voice debrief endpoint deliberately accepts a recording with no account
--     attached. activity_logs stays the D365-export source of truth.
-- ---------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_activities_agent_created
    ON activities(agent_email, created_at);

CREATE INDEX IF NOT EXISTS idx_activities_company_created
    ON activities(company_id, created_at);

-- ---------------------------------------------------------------------
-- 5c. D365_DAILY_AGGREGATES — local compliance counter buffer, keyed to the
--     Springfield business date so an evening phone block lands on the day
--     the agent actually worked.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 5d. RAW_TARGETS — staging table for overnight automated prospecting
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT,
    address TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_raw_targets_status ON raw_targets(status);

-- ---------------------------------------------------------------------
-- 5e. DO_NOT_CONTACT — suppressed territory accounts (Phase 2 Defenses)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS do_not_contact (
    dnc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    street_address TEXT,
    zip_code TEXT,
    exclusion_reason TEXT NOT NULL, -- 'EXISTING_ACCOUNT', 'COMPETITOR_BROKER', 'TERRITORY_COLLEAGUE', 'NATIONAL_FRANCHISE'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dnc_normalized ON do_not_contact(normalized_name);

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
--
-- Phase 3 (field intelligence, migrations/0004_company_intel.sql):
--   ALTER TABLE companies ADD COLUMN company_phone TEXT;
--   ALTER TABLE companies ADD COLUMN decision_maker TEXT;
--   ALTER TABLE companies ADD COLUMN notes TEXT;
--
-- Phase 3 Enterprise (cadence, tax, conflict resolution, migrations/0008_phase3_enterprise.sql):
--   ALTER TABLE companies ADD COLUMN cadence_stage INTEGER DEFAULT 0;
--   ALTER TABLE companies ADD COLUMN cadence_status TEXT DEFAULT 'INACTIVE' CHECK (cadence_status IN ('INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'DISQUALIFIED'));
--   ALTER TABLE companies ADD COLUMN cadence_next_due_date TEXT;
--   ALTER TABLE companies ADD COLUMN cadence_last_touch_at TEXT;
--   ALTER TABLE companies ADD COLUMN est_fica_tax_savings REAL DEFAULT 0.00;
--   ALTER TABLE companies ADD COLUMN teaser_check_generated_at TEXT;
--   ALTER TABLE companies ADD COLUMN sync_version INTEGER DEFAULT 1;
--   ALTER TABLE companies ADD COLUMN updated_at_utc TEXT DEFAULT (datetime('now'));
--   ALTER TABLE activity_logs ADD COLUMN sync_version INTEGER DEFAULT 1;
--   ALTER TABLE activity_logs ADD COLUMN client_timestamp_utc TEXT;
--   CREATE INDEX IF NOT EXISTS idx_companies_cadence_sweep ...;
--   CREATE INDEX IF NOT EXISTS idx_companies_spatial_active ...;
--
-- Phase 2 Edge Blueprint (migrations/0010_phase2_defenses.sql):
--   CREATE TABLE IF NOT EXISTS do_not_contact (...);
--   CREATE INDEX IF NOT EXISTS idx_dnc_normalized ON do_not_contact(normalized_name);
--   ALTER TABLE companies ADD COLUMN headcount_confidence_score REAL DEFAULT 0.0;
--   ALTER TABLE companies ADD COLUMN qualification_status TEXT DEFAULT 'QUALIFIED' CHECK(qualification_status IN ('QUALIFIED', 'SUB_THRESHOLD', 'NEEDS_AUDIT', 'QUARANTINE'));
--   ALTER TABLE companies ADD COLUMN access_type TEXT DEFAULT 'OPEN_COMMERCIAL' CHECK(access_type IN ('OPEN_COMMERCIAL', 'LOCKED_DOOR_PHONE_ONLY', 'GATED_SECURITY', 'APPOINTMENT_ONLY'));
--   CREATE INDEX IF NOT EXISTS idx_companies_qualification ON companies(agent_email, qualification_status, status);
--   CREATE INDEX IF NOT EXISTS idx_companies_access ON companies(agent_email, access_type);


