-------------------------------------------------------------------------------
-- darex_platform grants + role-scoped platform policies (SEC-P01).
--
-- Two defects in 119–122:
--   1. darex_platform had no USAGE on schema public and no privileges on the
--      tenant tables the /admin console reads and writes, so every
--      withPlatformTransaction query failed with 42501.
--   2. The `OR platform_audit_ok()` arms were added to TO PUBLIC tenant
--      policies. platform_audit_ok() reads admin_audit_log, which darex_app
--      may not SELECT, so any row that fails the org_id arm made a tenant
--      query raise 42501. The OR arm also stops the planner using org_id
--      indexes on hot tables (messages, conversations, audit_events).
--
-- Fix: tenant policies go back to the plain org_id predicate, and each table
-- gets a separate `<table>_platform` policy scoped TO darex_platform. Tenant
-- sessions never evaluate platform_audit_ok(); platform sessions still need
-- an admin_audit_log row in the same transaction (platform_begin).
--
-- Idempotent. No password in this file.
-- File: infra/db/migrations/200_platform_role_grants.sql
-------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO darex_platform;

-- Read-only surfaces of the console.
GRANT SELECT ON
  orgs,
  users,
  organization_memberships,
  org_invites,
  billing_subscriptions,
  billing_invoices,
  billing_meters,
  billing_audit_log,
  org_connectors,
  audit_events,
  failed_webhooks,
  messages,
  conversations,
  org_employee_metrics_daily,
  org_runtime_controls,
  channels,
  channel_logs
TO darex_platform;

-- Writes, column-scoped where the console only flips lifecycle fields.
GRANT UPDATE (status, suspended_by, suspended_at, deletion_requested_at, meta, updated_at)
  ON orgs TO darex_platform;
GRANT UPDATE (session_epoch, updated_at) ON users TO darex_platform;
GRANT INSERT, UPDATE ON org_runtime_controls TO darex_platform;
GRANT INSERT, UPDATE ON org_connectors TO darex_platform;
GRANT INSERT, UPDATE ON channels TO darex_platform;
GRANT INSERT ON channel_logs TO darex_platform;

-- Default privileges from 011 gave darex_app I/U/D on these; the tenant may
-- only read them (writes are platform-only, enforced here and by RLS).
REVOKE INSERT, UPDATE, DELETE ON org_plan_overrides FROM darex_app;
REVOKE INSERT, UPDATE, DELETE ON impersonation_sessions FROM darex_app;

-------------------------------------------------------------------------------
-- Tenant policies without the platform arm (restores pre-119 predicates).
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS orgs_tenant_select ON orgs;
CREATE POLICY orgs_tenant_select ON orgs
  FOR SELECT
  USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

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
  );

DROP POLICY IF EXISTS orgs_tenant_update ON orgs;
CREATE POLICY orgs_tenant_update ON orgs
  FOR UPDATE
  USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS orgs_tenant_delete ON orgs;
CREATE POLICY orgs_tenant_delete ON orgs
  FOR DELETE
  USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS users_org_isolation ON users;
CREATE POLICY users_org_isolation ON users
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS users_self_select ON users;
CREATE POLICY users_self_select ON users
  FOR SELECT
  USING (id::text = current_setting('app.current_user_id', true));

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

DROP POLICY IF EXISTS failed_webhooks_platform_select ON failed_webhooks;
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

DROP POLICY IF EXISTS org_plan_overrides_read ON org_plan_overrides;
CREATE POLICY org_plan_overrides_read ON org_plan_overrides
  FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
DROP POLICY IF EXISTS org_plan_overrides_write ON org_plan_overrides;

DROP POLICY IF EXISTS impersonation_platform ON impersonation_sessions;

-- Plain org_id tenant policies (same shape for every table in this list).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('org_invites',            'org_invites_org_isolation'),
      ('billing_subscriptions',  'billing_subscriptions_org_isolation'),
      ('billing_invoices',       'billing_invoices_org_isolation'),
      ('billing_meters',         'billing_meters_org_isolation'),
      ('billing_audit_log',      'billing_audit_log_org_isolation'),
      ('org_connectors',         'org_connectors_org_isolation'),
      ('audit_events',           'audit_events_org_isolation'),
      ('messages',               'messages_org_isolation'),
      ('conversations',          'conversations_org_isolation'),
      ('org_runtime_controls',   'org_runtime_controls_org_isolation')
    ) AS v(tbl, pol)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.pol, t.tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)
         WITH CHECK (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
      t.pol, t.tbl
    );
  END LOOP;
END
$$;

-- audit_events is append-only for tenants (106). Re-assert after the policy
-- rewrite so a drifted grant cannot reopen UPDATE/DELETE.
REVOKE UPDATE, DELETE ON audit_events FROM darex_app;

-------------------------------------------------------------------------------
-- Platform policies: TO darex_platform only, gated on an audit row in this tx.
-------------------------------------------------------------------------------

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      -- table,                       command
      ('orgs',                        'ALL'),
      ('users',                       'ALL'),
      ('organization_memberships',    'SELECT'),
      ('org_invites',                 'SELECT'),
      ('billing_subscriptions',       'SELECT'),
      ('billing_invoices',            'SELECT'),
      ('billing_meters',              'SELECT'),
      ('billing_audit_log',           'SELECT'),
      ('org_connectors',              'ALL'),
      ('audit_events',                'SELECT'),
      ('failed_webhooks',             'SELECT'),
      ('messages',                    'SELECT'),
      ('conversations',               'SELECT'),
      ('org_employee_metrics_daily',  'SELECT'),
      ('org_runtime_controls',        'ALL'),
      ('channels',                    'ALL'),
      ('channel_logs',                'ALL'),
      ('org_plan_overrides',          'ALL'),
      ('impersonation_sessions',      'ALL')
    ) AS v(tbl, cmd)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_platform', t.tbl);
    IF t.cmd = 'SELECT' THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT TO darex_platform USING (platform_audit_ok())',
        t.tbl || '_platform', t.tbl
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO darex_platform
           USING (platform_audit_ok()) WITH CHECK (platform_audit_ok())',
        t.tbl || '_platform', t.tbl
      );
    END IF;
  END LOOP;
END
$$;
