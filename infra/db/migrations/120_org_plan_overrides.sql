-------------------------------------------------------------------------------
-- Per-org plan overrides (meter caps, feature flags, seat cap).
-- Tenant may SELECT active org; only audited platform may write.
-- File: infra/db/migrations/120_org_plan_overrides.sql
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_plan_overrides (
  org_id UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  meter_caps JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  seat_cap INTEGER,
  reason TEXT NOT NULL,
  updated_by UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_plan_overrides_seat_cap_chk CHECK (seat_cap IS NULL OR seat_cap >= 1)
);

ALTER TABLE org_plan_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_plan_overrides FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_plan_overrides_read ON org_plan_overrides;
CREATE POLICY org_plan_overrides_read ON org_plan_overrides
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

DROP POLICY IF EXISTS org_plan_overrides_write ON org_plan_overrides;
CREATE POLICY org_plan_overrides_write ON org_plan_overrides
  FOR ALL
  USING (platform_audit_ok())
  WITH CHECK (platform_audit_ok());

GRANT SELECT ON org_plan_overrides TO darex_app;
GRANT SELECT, INSERT, UPDATE ON org_plan_overrides TO darex_platform;

COMMENT ON TABLE org_plan_overrides IS
  'Platform-set meter/feature/seat overrides. darex_app reads active org only.';
