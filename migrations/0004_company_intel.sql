-- =====================================================================
-- 0004 — Persist the field intelligence the import path was discarding
--
-- The 2026-09-01 follow-up import sent three fields per target that the
-- Worker silently dropped on the floor: the decision maker's name, the
-- account's phone number, and the CRM strategy narrative — which is the
-- entire reason the agent built the list. `normalizeCompany()` had no
-- mapping for them and `companies` had nowhere to put them, so all 63
-- strategy notes were parsed, uploaded, validated, and thrown away.
--
-- `notes` is appended to (never overwritten) by upsertCompany, so a later
-- enrichment pass adds to the account's history instead of replacing it.
--
-- D1 rejects multi-statement DDL over the API — run ONE statement per call.
-- =====================================================================

ALTER TABLE companies ADD COLUMN company_phone TEXT;
ALTER TABLE companies ADD COLUMN decision_maker TEXT;
ALTER TABLE companies ADD COLUMN notes TEXT;
