-------------------------------------------------------------------------------
-- Platform kill-switch writes org_runtime_controls; migration 119's first
-- platform_audit_ok() list omitted that table. Re-create the tenant policy
-- with OR platform_audit_ok() so audited darex_platform can UPSERT.
-- Idempotent. No password in this file.
-- File: infra/db/migrations/122_platform_runtime_controls_audit.sql
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS org_runtime_controls_org_isolation ON org_runtime_controls;
CREATE POLICY org_runtime_controls_org_isolation ON org_runtime_controls
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );
