-- Migration 0011: Deduplicate and enforce physical door uniqueness per agent
-- Adds door_key column and creates a partial unique index for accounts with physical street addresses.

ALTER TABLE companies ADD COLUMN door_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_unique_door
ON companies (agent_email, door_key)
WHERE street_1 IS NOT NULL AND street_1 != '' AND door_key IS NOT NULL;
