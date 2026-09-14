-- 1. Cadence Tracking for 21-Day 12-Touch Multi-Channel Engine
ALTER TABLE companies ADD COLUMN cadence_stage INTEGER DEFAULT 0; -- 0: Unenrolled, 1-12: Current Touchpoint Step
ALTER TABLE companies ADD COLUMN cadence_status TEXT DEFAULT 'INACTIVE' CHECK (cadence_status IN ('INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'DISQUALIFIED'));
ALTER TABLE companies ADD COLUMN cadence_next_due_date TEXT; -- ISO YYYY-MM-DD
ALTER TABLE companies ADD COLUMN cadence_last_touch_at TEXT;

-- 2. Section 125 Tax Metrics
ALTER TABLE companies ADD COLUMN est_fica_tax_savings REAL DEFAULT 0.00;
ALTER TABLE companies ADD COLUMN teaser_check_generated_at TEXT;

-- 3. Offline Vector & Conflict Resolution Tracking
ALTER TABLE companies ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE companies ADD COLUMN updated_at_utc TEXT DEFAULT (datetime('now'));

ALTER TABLE activity_logs ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE activity_logs ADD COLUMN client_timestamp_utc TEXT;

-- 4. Fast Indices for Geofencing & Cadence Sweeps
CREATE INDEX IF NOT EXISTS idx_companies_cadence_sweep 
ON companies (agent_email, cadence_status, cadence_next_due_date) 
WHERE cadence_status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_companies_spatial_active 
ON companies (agent_email, status, lat, long) 
WHERE status = 'ACTIVE' AND lat IS NOT NULL AND long IS NOT NULL;
