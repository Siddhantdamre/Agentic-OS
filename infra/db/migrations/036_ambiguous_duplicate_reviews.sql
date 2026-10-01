-------------------------------------------------------------------------------
-- Duplicate Record Cleaner — ambiguous duplicate review queue — Migration 036
--
-- OE-06 previously scored incoming contacts against existing ones
-- (dedup-engine.ts: scoreAgainst/pickDedup) and quarantined 0.60-0.85 band
-- matches into ambiguous_duplicate_reviews via persistAmbiguousDuplicate —
-- but that table never existed, so persistAmbiguousDuplicate silently
-- no-opped on every quarantine (42P01 undefined_table). This creates the
-- table so a human can review and resolve the ambiguous merge instead of
-- the match being lost.
--
-- File: infra/db/migrations/036_ambiguous_duplicate_reviews.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS ambiguous_duplicate_reviews (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  incoming      JSONB NOT NULL,
  match_id      TEXT,
  score         NUMERIC NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  resolved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ambiguous_duplicate_reviews_status_chk CHECK (
    status IN ('pending', 'merged', 'kept_separate')
  ),
  -- a resolved review has a resolution time; a pending one does not.
  CONSTRAINT ambiguous_duplicate_reviews_resolved_chk CHECK (
    (status = 'pending') = (resolved_at IS NULL)
  )
);

-- the review queue: an org's dashboard lists pending reviews newest first.
CREATE INDEX IF NOT EXISTS idx_ambiguous_duplicate_reviews_pending
  ON ambiguous_duplicate_reviews (org_id, created_at DESC)
  WHERE status = 'pending';

ALTER TABLE ambiguous_duplicate_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambiguous_duplicate_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ambiguous_duplicate_reviews_org_isolation ON ambiguous_duplicate_reviews;
CREATE POLICY ambiguous_duplicate_reviews_org_isolation ON ambiguous_duplicate_reviews
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON ambiguous_duplicate_reviews TO darex_app;

COMMENT ON TABLE ambiguous_duplicate_reviews IS
  'OE-06 Duplicate Record Cleaner — contacts scored in the 0.60-0.85 quarantine '
  'band (neither an obvious merge nor an obvious new record) queued for human review.';
