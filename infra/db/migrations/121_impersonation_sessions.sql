-------------------------------------------------------------------------------
-- Impersonation sessions + users.session_epoch for cookie revoke.
-- Legacy cookies (userId.sig) are epoch 0; new cookies are userId.epoch.sig.
-- File: infra/db/migrations/121_impersonation_sessions.sql
-------------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN users.session_epoch IS
  'Incremented to revoke signed session cookies. Cookie must match this epoch.';

-- Consent gate for non-break-glass impersonation. Default false so orgs opt in.
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS support_access_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN orgs.support_access_enabled IS
  'When true, platform support may start consent impersonation without break-glass.';

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  target_user_id UUID NOT NULL REFERENCES users(id),
  target_org_id UUID NOT NULL REFERENCES orgs(id),
  reason TEXT NOT NULL,
  audit_id UUID NOT NULL REFERENCES admin_audit_log(id),
  consent_recorded_at TIMESTAMPTZ,
  break_glass BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT impersonation_expires_chk CHECK (expires_at > created_at),
  CONSTRAINT impersonation_break_glass_reason_chk CHECK (
    break_glass = false OR length(btrim(reason)) >= 12
  )
);

ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_platform ON impersonation_sessions;
CREATE POLICY impersonation_platform ON impersonation_sessions
  FOR ALL
  USING (platform_audit_ok())
  WITH CHECK (platform_audit_ok());

DROP POLICY IF EXISTS impersonation_target_read ON impersonation_sessions;
CREATE POLICY impersonation_target_read ON impersonation_sessions
  FOR SELECT
  USING (
    target_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND ended_at IS NULL
    AND expires_at > NOW()
  );

GRANT SELECT ON impersonation_sessions TO darex_app;
GRANT SELECT, INSERT, UPDATE ON impersonation_sessions TO darex_platform;

COMMENT ON TABLE impersonation_sessions IS
  'Support/operator impersonation. Target user may SELECT active rows for banner.';
