-- =====================================================================
-- 0006 — Actionable callbacks: promote the parsed next action from the
--        append-only activity log onto the account itself.
--
-- WHY THE ACCOUNT NEEDS ITS OWN COPY
-- `activities.next_action` already records what the model heard on each
-- debrief, and that row is immutable on purpose. But the Monday dialer asks a
-- different question — "who do I owe a call to today?" — and answering it from
-- the activity log means a correlated subquery or a GROUP BY over every touch
-- ever recorded, on the hot path, for every render of the call list.
--
-- Storing the CURRENT commitment on `companies` turns that into one indexed
-- range scan. The activity log stays the audit trail of how the commitment got
-- there; these two columns are the live pointer.
--
-- WHY THE INDEX IS PARTIAL
-- Most accounts have no pending callback (next_action_date IS NULL). A partial
-- index keeps those rows out of the b-tree entirely, so the index stays small
-- and the dialer's "due today" lookup never walks a mostly-empty range. The
-- predicate on agent_email stays the leading column to preserve tenant
-- isolation, exactly as idx_companies_agent_geohash6 does.
--
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS. Apply exactly once; when using an
-- API that rejects multi-statement DDL, run one statement per call in order.
-- =====================================================================

-- The human-readable commitment, e.g. "Call back Monday morning and ask for Jim".
ALTER TABLE companies ADD COLUMN next_action TEXT;

-- ISO-8601 date (YYYY-MM-DD) the commitment comes due. Deliberately TEXT, not a
-- date type: SQLite has no date storage class, and `date('now')` comparisons
-- against an ISO string are lexicographic and therefore correct.
ALTER TABLE companies ADD COLUMN next_action_date TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_callback
    ON companies(agent_email, next_action_date)
    WHERE next_action_date IS NOT NULL;
