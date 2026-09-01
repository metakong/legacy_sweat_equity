-- =====================================================================
-- 0003 — Multi-tenant partitioning by agent_email (CORRECTED)
--
-- Supersedes 0002_multi_tenant.sql, which must NOT be run. That migration
-- rebuilt each table with `INSERT INTO new_x SELECT *, '<email>' FROM x`.
-- The new column order did not match the live column order (production had
-- picked up sic_code / account_number / post_enrollment_date as trailing
-- ALTERs, while the new table declared them mid-list), so the positional
-- SELECT * silently shifted every value one or more columns to the left:
-- is_d365_synced landed in sic_code, created_at landed in account_number,
-- and pipeline_stage was lost. It also stalled after step 2, leaving an
-- orphaned, corrupt `new_companies` behind and the live tables with no
-- agent_email column at all — which is what made every query referencing
-- co.agent_email fail with "no such column" and surface as a 500.
--
-- This migration takes the non-destructive route instead: add the column
-- in place. No data is moved, so no column can be transposed.
--
-- The upserts in src/lib/db.js target ON CONFLICT(company_id, agent_email),
-- ON CONFLICT(contact_id, agent_email), ON CONFLICT(log_id, agent_email) and
-- ON CONFLICT(event_id, agent_email). SQLite resolves an ON CONFLICT target
-- against a UNIQUE index, so each tuple gets one below. The original
-- single-column PRIMARY KEYs stay in place and stay valid.
--
-- D1 rejects multi-statement DDL over the API — run ONE statement per call.
-- =====================================================================

-- 1. Add the tenant column. A non-null literal default is required for
--    ADD COLUMN ... NOT NULL, and it backfills every existing row with the
--    only agent who has ever used this database.
ALTER TABLE companies       ADD COLUMN agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com';
ALTER TABLE contacts        ADD COLUMN agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com';
ALTER TABLE activity_logs   ADD COLUMN agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com';
ALTER TABLE pipeline_events ADD COLUMN agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com';

-- 2. ON CONFLICT targets for the upserts in src/lib/db.js.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_tenant       ON companies(company_id, agent_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_tenant        ON contacts(contact_id, agent_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_tenant        ON activity_logs(log_id, agent_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_events_tenant ON pipeline_events(event_id, agent_email);

-- 3. Tenant-scoped covering indexes. Every hot-path query now filters on
--    agent_email first, so the pre-existing single-column indexes no longer
--    match the leading edge of the WHERE clause.
CREATE INDEX IF NOT EXISTS idx_companies_agent ON companies(agent_email, company_name);
CREATE INDEX IF NOT EXISTS idx_activity_agent  ON activity_logs(agent_email, company_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_contacts_agent  ON contacts(agent_email, company_id);

-- 4. Remove the corrupt orphan left behind by the failed 0002 run.
--    Its contents are the transposed copy described above; the live
--    `companies` table is the intact original and remains authoritative.
DROP TABLE IF EXISTS new_companies;
