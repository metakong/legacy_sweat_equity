-- =====================================================================
-- 0005 — Voice orchestration: verification state, append-only activities,
--        and the local D365 compliance counter buffer
--
-- WHY A NEW TABLE
-- `activity_logs` cannot carry this workload. Its `company_id` is NOT NULL and
-- foreign-keyed, which is correct for a touch that is always made against an
-- account. The voice debrief endpoint explicitly accepts a recording with no
-- account attached (the agent talks while driving), so the event store for
-- voice must allow a null company.
--
-- `activities` is therefore an append-only event log, not a replacement for
-- `activity_logs`. The D365 Tier 1/2/3 exports keep reading `activity_logs`
-- and are unchanged by this migration.
--
-- `extracted_json` holds the immutable model output verbatim, so a later
-- correction to company intel never destroys what the model actually said.
--
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS. Apply exactly once; when using an
-- API that rejects multi-statement DDL, run one statement per call in order.
-- =====================================================================

-- 1. Closed-loop verification state on the account.
--    UNVERIFIED is the correct starting point for a row that came out of a
--    Google Maps scrape: the address exists, the contacts do not.
ALTER TABLE companies ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (
        verification_status IN (
            'UNVERIFIED',
            'PHONE_VERIFIED',
            'FIELD_VERIFIED',
            'DISQUALIFIED'
        )
    );

-- 2. Append-only voice event log.
CREATE TABLE IF NOT EXISTS activities (
    activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Nullable on purpose: a debrief recorded between stops has no account yet.
    company_id TEXT,
    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',
    -- Coarse compliance bucket (PHONE_DIAL, FIELD_WALK_IN, ...), separate from
    -- the fine-grained sales `outcome` below.
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

-- 3. Daily D365 compliance counters.
--    Keyed to the Springfield business date, never UTC: an 8 PM CDT phone block
--    belongs to the day the agent worked, not to tomorrow's UTC date.
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
