-- =====================================================================
-- 0004 V2 — Agency OS Section 125, confidence, and spatial foundation
--
-- This migration is additive and intentionally coexists with
-- migrations/0004_company_intel.sql. Do not delete, rename, or fold that
-- earlier in-progress migration into this file.
--
-- `status` is an operational suppression state used by spatial/radar
-- lookups. It does not replace the existing sales `pipeline_stage`.
--
-- SQLite/D1 does not provide portable ADD COLUMN IF NOT EXISTS syntax.
-- Apply this migration exactly once. When using an API that rejects
-- multi-statement DDL, execute one statement at a time in file order.
-- =====================================================================

-- Section 125 and displacement diagnostics.
ALTER TABLE companies ADD COLUMN current_voluntary_carrier TEXT;
ALTER TABLE companies ADD COLUMN major_medical_carrier TEXT;

ALTER TABLE companies ADD COLUMN is_hdhp INTEGER NOT NULL DEFAULT 0
    CHECK (is_hdhp IN (0, 1));

ALTER TABLE companies ADD COLUMN estimated_w2_count INTEGER
    CHECK (
        estimated_w2_count IS NULL
        OR (
            typeof(estimated_w2_count) = 'integer'
            AND estimated_w2_count >= 0
        )
    );

-- Closed-loop confidence scoring. Thirty is the conservative starting
-- point for an existing or raw/unverified account.
ALTER TABLE companies ADD COLUMN confidence_score INTEGER NOT NULL DEFAULT 30
    CHECK (confidence_score BETWEEN 0 AND 100);

-- Stored hashes are always seven characters. Radar queries use their
-- six-character prefixes plus the eight neighboring prefix cells.
ALTER TABLE companies ADD COLUMN geohash TEXT
    CHECK (
        geohash IS NULL
        OR (
            length(geohash) = 7
            AND geohash NOT GLOB '*[^0123456789bcdefghjkmnpqrstuvwxyz]*'
        )
    );

-- Operational contactability/suppression state. This is deliberately
-- separate from pipeline_stage because DO_NOT_CONTACT is not a sales stage.
ALTER TABLE companies ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';

-- Preserve useful legacy headcount without manufacturing a value when the
-- old column is null or contains a non-integer value.
UPDATE companies
SET estimated_w2_count = employees
WHERE estimated_w2_count IS NULL
  AND typeof(employees) = 'integer'
  AND employees >= 0;

-- Preserve existing terminal pipeline state in the new suppression field.
UPDATE companies
SET status = 'DISQUALIFIED'
WHERE pipeline_stage = 'DISQUALIFIED';

-- Expression index matching the exact six-character prefix expression used
-- by the radar query. The partial predicate mirrors the terminal-status
-- exclusion so the planner can use this index for the hot-path lookup, and
-- agent_email stays the leading column to preserve tenant isolation.
CREATE INDEX IF NOT EXISTS idx_companies_agent_geohash6
    ON companies (
        agent_email,
        SUBSTR(geohash, 1, 6)
    )
    WHERE status NOT IN ('DISQUALIFIED', 'DO_NOT_CONTACT');

-- Supports confidence triage and high-confidence field-canvass selection.
CREATE INDEX IF NOT EXISTS idx_companies_agent_confidence
    ON companies (
        agent_email,
        confidence_score,
        status
    );