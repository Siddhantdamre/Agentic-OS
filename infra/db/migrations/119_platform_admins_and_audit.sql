-------------------------------------------------------------------------------
-- Platform plane: darex_platform role, platform_admins, admin_audit_log,
-- platform_audit_ok() / platform_begin(), and OR arms on tenant policies.
-- No password in this file. No fake platform_admins seed.
-- File: infra/db/migrations/119_platform_admins_and_audit.sql
-------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'darex_platform') THEN
    CREATE ROLE darex_platform
      LOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS platform_admins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  platform_role TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_admins_role_chk CHECK (platform_role IN ('operator', 'support'))
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  platform_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_org_id UUID REFERENCES orgs(id),
  target_table TEXT,
  target_row_id TEXT,
  reason TEXT NOT NULL,
  audit_txid BIGINT NOT NULL DEFAULT txid_current(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created
  ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_org
  ON admin_audit_log (target_org_id, created_at DESC);

REVOKE ALL ON admin_audit_log FROM PUBLIC, darex_app;
REVOKE UPDATE, DELETE ON admin_audit_log FROM darex_platform;
GRANT INSERT, SELECT ON admin_audit_log TO darex_platform;

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_audit_log_platform ON admin_audit_log;
CREATE POLICY admin_audit_log_platform ON admin_audit_log
  FOR SELECT
  USING (current_user = 'darex_platform');

DROP POLICY IF EXISTS admin_audit_log_insert ON admin_audit_log;
CREATE POLICY admin_audit_log_insert ON admin_audit_log
  FOR INSERT
  WITH CHECK (current_user = 'darex_platform');

-- platform_admins: session user may SELECT own row; darex_platform SELECT all;
-- darex_app cannot INSERT (first operator is a superuser SQL change by a human).
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admins_self_select ON platform_admins;
CREATE POLICY platform_admins_self_select ON platform_admins
  FOR SELECT
  USING (
    user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS platform_admins_platform_select ON platform_admins;
CREATE POLICY platform_admins_platform_select ON platform_admins
  FOR SELECT
  USING (current_user = 'darex_platform');

GRANT SELECT ON platform_admins TO darex_app;
GRANT SELECT ON platform_admins TO darex_platform;
REVOKE INSERT, UPDATE, DELETE ON platform_admins FROM darex_app, PUBLIC;

CREATE OR REPLACE FUNCTION platform_audit_ok()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT current_user = 'darex_platform'
     AND EXISTS (
       SELECT 1
         FROM admin_audit_log a
        WHERE a.id = NULLIF(current_setting('app.platform_audit_id', true), '')::uuid
          AND a.audit_txid = txid_current()
     );
$$;

CREATE OR REPLACE FUNCTION platform_begin(
  p_actor uuid,
  p_role text,
  p_action text,
  p_org uuid,
  p_table text,
  p_row text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF current_user <> 'darex_platform' THEN
    RAISE EXCEPTION 'platform_begin requires darex_platform';
  END IF;
  INSERT INTO admin_audit_log (
    actor_user_id, platform_role, action, target_org_id,
    target_table, target_row_id, reason
  )
  VALUES (p_actor, p_role, p_action, p_org, p_table, p_row, p_reason)
  RETURNING id INTO new_id;
  PERFORM set_config('app.platform_audit_id', new_id::text, true);
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION platform_begin(uuid, text, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_begin(uuid, text, text, uuid, text, text, text) TO darex_platform;
REVOKE ALL ON FUNCTION platform_audit_ok() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_audit_ok() TO darex_platform, darex_app;

-------------------------------------------------------------------------------
-- OR platform_audit_ok() on tenant policies the console must read
-------------------------------------------------------------------------------

-- orgs
DROP POLICY IF EXISTS orgs_tenant_select ON orgs;
CREATE POLICY orgs_tenant_select ON orgs
  FOR SELECT
  USING (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

DROP POLICY IF EXISTS orgs_member_select ON orgs;
CREATE POLICY orgs_member_select ON orgs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM organization_memberships om
       WHERE om.org_id = orgs.id
         AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
    OR platform_audit_ok()
  );

DROP POLICY IF EXISTS orgs_tenant_update ON orgs;
CREATE POLICY orgs_tenant_update ON orgs
  FOR UPDATE
  USING (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

DROP POLICY IF EXISTS orgs_tenant_delete ON orgs;
CREATE POLICY orgs_tenant_delete ON orgs
  FOR DELETE
  USING (
    id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- users
DROP POLICY IF EXISTS users_org_isolation ON users;
CREATE POLICY users_org_isolation ON users
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

DROP POLICY IF EXISTS users_self_select ON users;
CREATE POLICY users_self_select ON users
  FOR SELECT
  USING (
    id::text = current_setting('app.current_user_id', true)
    OR platform_audit_ok()
  );

-- organization_memberships
DROP POLICY IF EXISTS org_memberships_isolation ON organization_memberships;
CREATE POLICY org_memberships_isolation ON organization_memberships
  FOR ALL
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- org_invites
DROP POLICY IF EXISTS org_invites_org_isolation ON org_invites;
CREATE POLICY org_invites_org_isolation ON org_invites
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- billing_subscriptions
DROP POLICY IF EXISTS billing_subscriptions_org_isolation ON billing_subscriptions;
CREATE POLICY billing_subscriptions_org_isolation ON billing_subscriptions
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- billing_invoices
DROP POLICY IF EXISTS billing_invoices_org_isolation ON billing_invoices;
CREATE POLICY billing_invoices_org_isolation ON billing_invoices
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- billing_meters
DROP POLICY IF EXISTS billing_meters_org_isolation ON billing_meters;
CREATE POLICY billing_meters_org_isolation ON billing_meters
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- billing_audit_log
DROP POLICY IF EXISTS billing_audit_log_org_isolation ON billing_audit_log;
CREATE POLICY billing_audit_log_org_isolation ON billing_audit_log
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- org_connectors
DROP POLICY IF EXISTS org_connectors_org_isolation ON org_connectors;
CREATE POLICY org_connectors_org_isolation ON org_connectors
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- audit_events
DROP POLICY IF EXISTS audit_events_org_isolation ON audit_events;
CREATE POLICY audit_events_org_isolation ON audit_events
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

-- failed_webhooks: tenant policy + platform SELECT for unresolved NULL rows
DROP POLICY IF EXISTS failed_webhooks_tenant ON failed_webhooks;
CREATE POLICY failed_webhooks_tenant ON failed_webhooks
  FOR ALL
  USING (
    (
      org_id IS NOT NULL
      AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id IS NULL
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

DROP POLICY IF EXISTS failed_webhooks_platform_select ON failed_webhooks;
CREATE POLICY failed_webhooks_platform_select ON failed_webhooks
  FOR SELECT
  USING (platform_audit_ok());

-- messages + conversations (directory last-activity)
DROP POLICY IF EXISTS messages_org_isolation ON messages;
CREATE POLICY messages_org_isolation ON messages
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

DROP POLICY IF EXISTS conversations_org_isolation ON conversations;
CREATE POLICY conversations_org_isolation ON conversations
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

COMMENT ON FUNCTION platform_audit_ok() IS
  'True only for darex_platform when admin_audit_log.id matches app.platform_audit_id in this tx.';
COMMENT ON FUNCTION platform_begin(uuid, text, text, uuid, text, text, text) IS
  'Inserts admin_audit_log and sets app.platform_audit_id (transaction-local). SECURITY INVOKER.';
