-- Phase 4: Staging table for overnight automated prospecting pipeline
CREATE TABLE IF NOT EXISTS raw_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT,
    address TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_raw_targets_status ON raw_targets(status);
