-- =====================================================================
-- !! DO NOT RUN THIS FILE. SUPERSEDED BY 0003_add_agent_email.sql. !!
--
-- Kept only as a record of what went wrong on 2026-08-31.
--
-- Every step below is `INSERT INTO new_x SELECT *, '<email>' FROM x`, which
-- maps columns BY POSITION. The live tables had grown sic_code,
-- account_number and post_enrollment_date as trailing ALTER TABLE columns,
-- but this file declares them in the middle of the column list. The counts
-- happened to match (29 = 29), so SQLite raised no error and silently
-- transposed the data instead:
--
--   is_d365_synced -> sic_code
--   created_at     -> account_number
--   renewal_date   -> post_enrollment_date
--   pipeline_stage -> lost
--
-- The run also stopped after the companies step, so production was left
-- with an orphaned, corrupt `new_companies` table AND live tables that
-- still had no agent_email column. That missing column is what made every
-- query referencing co.agent_email fail with "no such column", which the
-- UI surfaced as "Could not load targets: Internal Server Error".
--
-- Running this file now would rebuild the tables from the corrupt shape.
-- Use 0003_add_agent_email.sql, which adds the column in place and moves
-- no data at all.
-- =====================================================================

-- 1. COMPANIES
CREATE TABLE new_companies (
    company_id TEXT,
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
    created_at TEXT DEFAULT (datetime('now')),
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (company_id, agent_email)
);
INSERT INTO new_companies SELECT *, 'sean_deardorff@us.aflac.com' FROM companies;
DROP TABLE companies;
ALTER TABLE new_companies RENAME TO companies;
CREATE INDEX idx_companies_coords ON companies(lat, long);
CREATE INDEX idx_companies_d365_synced ON companies(is_d365_synced);
CREATE INDEX idx_companies_name ON companies(company_name);
CREATE INDEX idx_companies_pipeline ON companies(pipeline_stage, snoozed_until);

-- 2. CONTACTS
CREATE TABLE new_contacts (
    contact_id TEXT,
    company_id TEXT NOT NULL,
    first_name TEXT, last_name TEXT, job_title TEXT,
    phone_number TEXT, email_address TEXT,
    is_primary_dm BOOLEAN DEFAULT 1,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (contact_id, agent_email),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email) ON DELETE CASCADE
);
INSERT INTO new_contacts SELECT *, 'sean_deardorff@us.aflac.com' FROM contacts;
DROP TABLE contacts;
ALTER TABLE new_contacts RENAME TO contacts;
CREATE INDEX idx_contacts_company ON contacts(company_id, is_primary_dm);

-- 3. ACTIVITY_LOGS
CREATE TABLE new_activity_logs (
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
    next_action_date TEXT,
    next_action_text TEXT,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    PRIMARY KEY (log_id, agent_email),
    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email)
);
INSERT INTO new_activity_logs SELECT *, 'sean_deardorff@us.aflac.com' FROM activity_logs;
DROP TABLE activity_logs;
ALTER TABLE new_activity_logs RENAME TO activity_logs;
CREATE INDEX idx_activity_company ON activity_logs(company_id, timestamp);
CREATE INDEX idx_activity_timestamp ON activity_logs(timestamp);
CREATE INDEX idx_activity_sync_tier ON activity_logs(sync_tier_status);
CREATE INDEX idx_activity_next_action ON activity_logs(company_id, next_action_date);

-- 4. PIPELINE_EVENTS
CREATE TABLE new_pipeline_events (
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
INSERT INTO new_pipeline_events SELECT *, 'sean_deardorff@us.aflac.com' FROM pipeline_events;
DROP TABLE pipeline_events;
ALTER TABLE new_pipeline_events RENAME TO pipeline_events;
CREATE INDEX idx_pipeline_events_company ON pipeline_events(company_id, changed_at);
