-------------------------------------------------------------------------------
-- Brain revisions + insight action history + brief query helpers
-- (gap26sept Subagent 5 — unique name amid concurrent 093_* migrations)
-------------------------------------------------------------------------------

-- 1. Memory revision snapshots (brain PATCH correct)
CREATE TABLE IF NOT EXISTS memory_revisions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  memory_id           UUID NOT NULL,
  tier                TEXT NOT NULL CHECK (tier IN ('org', 'employee', 'entity', 'conversation')),
  previous_title      TEXT,
  previous_body       TEXT NOT NULL,
  changed_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_revisions_lookup
  ON memory_revisions (org_id, memory_id, created_at DESC);

ALTER TABLE memory_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_revisions_isolation ON memory_revisions;
CREATE POLICY memory_revisions_isolation ON memory_revisions
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- 2. Insight remediation action history
CREATE TABLE IF NOT EXISTS insight_action_runs (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id               UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  metric_id            TEXT NOT NULL,
  workflow_id          TEXT NOT NULL,
  named_workflow       TEXT,
  triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'completed', 'failed')),
  result_summary       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_insight_action_runs_org
  ON insight_action_runs (org_id, created_at DESC);

ALTER TABLE insight_action_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_action_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS insight_action_runs_isolation ON insight_action_runs;
CREATE POLICY insight_action_runs_isolation ON insight_action_runs
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- 3. Brief query indexes
CREATE INDEX IF NOT EXISTS idx_work_items_brief_lookup
  ON work_items (org_id, status, due_at ASC NULLS LAST, updated_at DESC)
  WHERE status IN ('needs_attention', 'waiting_approval');

CREATE INDEX IF NOT EXISTS idx_work_items_handled_lookup
  ON work_items (org_id, status, updated_at DESC)
  WHERE status IN ('done', 'cancelled');
