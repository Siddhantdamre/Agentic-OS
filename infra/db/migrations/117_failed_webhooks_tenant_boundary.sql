-------------------------------------------------------------------------------
-- failed_webhooks tenant boundary: nullable org_id + FORCE RLS.
-- Unresolved (NULL org_id) rows stay invisible to darex_app SELECT.
-- File: infra/db/migrations/117_failed_webhooks_tenant_boundary.sql
-------------------------------------------------------------------------------

ALTER TABLE failed_webhooks
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES orgs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_failed_webhooks_org
  ON failed_webhooks (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;

ALTER TABLE failed_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE failed_webhooks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS failed_webhooks_tenant ON failed_webhooks;
CREATE POLICY failed_webhooks_tenant ON failed_webhooks
  FOR ALL
  USING (
    org_id IS NOT NULL
    AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id IS NULL
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE ON failed_webhooks TO darex_app;

COMMENT ON COLUMN failed_webhooks.org_id IS
  'Tenant when known at insert. NULL unresolved rows are invisible to darex_app.';
