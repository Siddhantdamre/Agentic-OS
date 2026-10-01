-------------------------------------------------------------------------------
-- Soft-delete for AI employees + domain-level outbound locks for growth.
-- Additive only. Unique filename for concurrent swarm agents.
-------------------------------------------------------------------------------

ALTER TABLE ai_employees
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ai_employees_active_org
  ON ai_employees (org_id, status)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS outbound_domain_locks (
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  domain       TEXT NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL,
  work_item_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, domain)
);

ALTER TABLE outbound_domain_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_domain_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbound_domain_locks_org_isolation ON outbound_domain_locks;
CREATE POLICY outbound_domain_locks_org_isolation ON outbound_domain_locks
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_domain_locks TO darex_app;
