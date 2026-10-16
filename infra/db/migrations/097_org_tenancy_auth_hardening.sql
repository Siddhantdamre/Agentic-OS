-------------------------------------------------------------------------------
-- 097_org_tenancy_auth_hardening.sql
-- Org-table RLS, multi-org memberships, login lockout + optional TOTP columns,
-- audit_events kind expansion for auth events.
-------------------------------------------------------------------------------

-- 1. Root orgs RLS (SELECT/UPDATE/DELETE scoped; INSERT allowed for provisioning)
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orgs_tenant_select ON orgs;
DROP POLICY IF EXISTS orgs_tenant_update ON orgs;
DROP POLICY IF EXISTS orgs_tenant_delete ON orgs;
DROP POLICY IF EXISTS orgs_tenant_insert ON orgs;
DROP POLICY IF EXISTS orgs_tenant_isolation ON orgs;

CREATE POLICY orgs_tenant_select ON orgs
  FOR SELECT
  USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY orgs_tenant_update ON orgs
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY orgs_tenant_delete ON orgs
  FOR DELETE
  USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Provisioning paths insert before GUC is set to the new id.
CREATE POLICY orgs_tenant_insert ON orgs
  FOR INSERT
  WITH CHECK (true);

-- 2. organization_memberships (multi-workspace)
CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member', 'auditor')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON organization_memberships(org_id);

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_memberships_isolation ON organization_memberships;
CREATE POLICY org_memberships_isolation ON organization_memberships
  FOR ALL
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

-- Backfill from users.org_id
INSERT INTO organization_memberships (user_id, org_id, role, is_default)
SELECT
  u.id,
  u.org_id,
  CASE
    WHEN lower(COALESCE(u.role, 'member')) IN ('owner', 'admin', 'member', 'auditor')
      THEN lower(u.role)
    ELSE 'member'
  END,
  true
FROM users u
WHERE u.org_id IS NOT NULL
ON CONFLICT (user_id, org_id) DO NOTHING;

-- 3. Login lockout + optional TOTP (secrets stored as base32; never log them)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS totp_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- 4. Expand audit_events kinds for auth lifecycle
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_kind_chk;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_kind_chk CHECK (kind IN (
  'tool.execute',
  'plan.approve',
  'plan.reject',
  'plan.execute',
  'connector.connect',
  'connector.disconnect',
  'memory.write',
  'memory.delete',
  'memory.correct',
  'pack.install',
  'pack.uninstall',
  'dsr.export',
  'dsr.delete',
  'role.change',
  'login',
  'register',
  'logout',
  'password.reset',
  'invite.accept',
  'member.remove',
  'member.invite',
  'mfa.enable',
  'mfa.disable',
  'confirm.override',
  'settings.update',
  'org.switch'
));

COMMENT ON TABLE organization_memberships IS
  'Many-to-many user↔org membership. users.org_id is the active workspace pointer.';
