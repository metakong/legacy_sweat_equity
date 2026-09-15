-- Phase 2 Edge Blueprint: Hard Scoring Gates, Native DNC, & Curbside Barriers
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

ALTER TABLE companies ADD COLUMN headcount_confidence_score REAL DEFAULT 0.0;
ALTER TABLE companies ADD COLUMN qualification_status TEXT DEFAULT 'QUALIFIED' CHECK(qualification_status IN ('QUALIFIED', 'SUB_THRESHOLD', 'NEEDS_AUDIT', 'QUARANTINE'));
ALTER TABLE companies ADD COLUMN access_type TEXT DEFAULT 'OPEN_COMMERCIAL' CHECK(access_type IN ('OPEN_COMMERCIAL', 'LOCKED_DOOR_PHONE_ONLY', 'GATED_SECURITY', 'APPOINTMENT_ONLY'));

CREATE INDEX IF NOT EXISTS idx_companies_qualification ON companies(agent_email, qualification_status, status);
CREATE INDEX IF NOT EXISTS idx_companies_access ON companies(agent_email, access_type);
