# 02 — Data model and migrations

Next file in `infra/db/migrations/` after this series is **123**. Highest
planned SaaS file on disk is `122_platform_runtime_controls_audit.sql`.
Migrations run as superuser `darex`. The app runtime stays `darex_app`.
`106`, `115`, and **116–122 are not confirmed applied** on the shared
database (`BUILD_STATE.md` 2026-09-27). Apply the existing chain before
claiming live. None of 116–122 is applied.

Every migration is reversible. Down steps are in [07](07-rollout-plan.md). A down migration that would delete audit rows refuses when the table is non-empty.

## Rule: audit before effect

`darex_platform` is `NOSUPERUSER NOBYPASSRLS`. Superusers bypass FORCE RLS in PostgreSQL, so the platform pool must not log in as `darex`.

Cross-org reads and writes are allowed only when the current transaction already inserted `admin_audit_log` and stored that row id in `app.platform_audit_id` (transaction-local `set_config`). The predicate:

```sql
CREATE OR REPLACE FUNCTION platform_audit_ok()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_user = 'darex_platform'
     AND EXISTS (
       SELECT 1
         FROM admin_audit_log a
        WHERE a.id = NULLIF(current_setting('app.platform_audit_id', true), '')::uuid
          AND a.audit_txid = txid_current()
     );
$$;
```

`audit_txid` is `txid_current()` at insert. A reused audit id from an older transaction fails the predicate. Forgetting the insert returns zero rows or rejects the write. It does not return every tenant.

`darex_app` has no `INSERT` on `admin_audit_log` and is not a member of `darex_platform`, so it cannot mint an authorizing row or `SET ROLE`.

Tenant policies that the console must read gain `OR platform_audit_ok()` on `USING` and `WITH CHECK`. First cut, same migration as the function (`119`): `orgs`, `users`, `organization_memberships`, `org_invites`, `billing_subscriptions`, `billing_invoices`, `billing_meters`, `billing_audit_log`, `org_connectors`, `audit_events`, `failed_webhooks`. Further tables are added when a console screen needs them, in a later numbered migration, each with the same predicate. Do not grant `darex_platform` table-owner rights and do not `ALTER ROLE darex_platform BYPASSRLS`.

Password for `darex_platform` is set out of band (`ALTER ROLE ... PASSWORD` from a secret store). The migration file contains no password.

## 116 — `116_org_status_lifecycle.sql`

Org access states. Plan keys stay as in `017` (`free | starter | growth | enterprise`). Seat quantity stays on `billing_subscriptions.seats`. This file does not add `orgs.seats`.

```sql
UPDATE orgs
   SET status = CASE lower(btrim(status))
     WHEN 'provisioning' THEN 'provisioning'
     WHEN 'active' THEN 'active'
     WHEN 'past_due' THEN 'past_due'
     WHEN 'suspended' THEN 'suspended'
     WHEN 'paused' THEN 'suspended'
     WHEN 'soft_deleted' THEN 'soft_deleted'
     WHEN 'deleted' THEN 'soft_deleted'
     ELSE 'active'
   END;

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_status_check;
ALTER TABLE orgs
  ADD CONSTRAINT orgs_status_check
  CHECK (status IN ('provisioning', 'active', 'past_due', 'suspended', 'soft_deleted'));

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_by TEXT,
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_suspended_by_check;
ALTER TABLE orgs
  ADD CONSTRAINT orgs_suspended_by_check
  CHECK (suspended_by IS NULL OR suspended_by IN ('dunning', 'platform'));
```

Application change that ships with this migration (same commit, not a second schema):

- `applyDunningState` (`billing/_lib.ts:1266`) on `past_due` / `unpaid` sets `orgs.status = 'past_due'` while grace remains.
- When grace has elapsed, it still calls `setOrgPlan(..., 'free')` and also sets `status = 'suspended'`, `suspended_by = 'dunning'`, `suspended_at = now()`.
- When status returns to `active` or `trialing`, it sets `orgs.status = 'active'` only if `suspended_by = 'dunning'` or status is `past_due`. A `platform` suspension stays.

`packages/shared-types/src/domain.ts` `OrgStatus` loses the open `string` escape hatch and matches the CHECK.

## 117 — `117_failed_webhooks_tenant_boundary.sql`

```sql
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
```

Existing rows stay `org_id` NULL. They cannot be honestly backfilled from `raw_payload`. They become invisible to `darex_app` (USING requires non-null `org_id`). Insert of a new unresolved failure still works (`WITH CHECK` allows NULL) so the DLQ does not start dropping errors. Replay of a NULL row waits for the platform function in `119`. Webhook handlers that already know the org write `org_id` on insert.

Platform SELECT of NULL rows is the `OR platform_audit_ok()` arm added in `119`, not a grant to `darex_app`.

## 118 — `118_org_membership_visibility.sql`

```sql
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
```

SELECT only. `orgs_tenant_update` and `orgs_tenant_delete` stay pinned to the active org (`097:21-28`).

Widen role CHECKs. Keep `auditor`. Add `billing`.

```sql
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_human_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_human_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor', 'billing'));

ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_human_role_check;
ALTER TABLE org_invites
  ADD CONSTRAINT org_invites_human_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor', 'billing'));

-- 097 declares CHECK inline on organization_memberships.role (lines 40-41).
-- The generated constraint name varies. Look it up in pg_constraint and drop
-- that one check before adding organization_memberships_role_check.
ALTER TABLE organization_memberships
  ADD CONSTRAINT organization_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor', 'billing'));
```

The lookup must match the old predicate `role IN ('owner','admin','member','auditor')` and drop only that constraint. A guessed name that misses leaves both checks in place, and the old one still rejects `billing`.

Code in the same commit:

- `POST /api/org/switch` copies `organization_memberships.role` onto `users.role` in the same transaction as `users.org_id`.
- `HUMAN_ROLES` and every exhaustive switch in `apps/dashboard/lib/rbac.ts` gain `billing`.
- `canManageBilling` returns true for `billing`.
- `parseInviteRole` accepts `member | admin | billing | auditor`.

## 119 — `119_platform_admins_and_audit.sql`

One migration so the role cannot exist without the log.

```sql
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

CREATE POLICY admin_audit_log_platform ON admin_audit_log
  FOR SELECT
  USING (current_user = 'darex_platform');

CREATE POLICY admin_audit_log_insert ON admin_audit_log
  FOR INSERT
  WITH CHECK (current_user = 'darex_platform');
```

No UPDATE or DELETE policy. Append-only matches `106` on `audit_events`.

`platform_admins` RLS: a session user may SELECT their own row (`user_id = app.current_user_id`) so middleware can answer "is this user an operator?" without a cross-tenant query. `darex_platform` may SELECT all rows. `darex_app` cannot INSERT. The first operator is inserted by a superuser SQL change run by a human, with a reason, not by the signup path.

Then `platform_audit_ok()` as above, and `OR platform_audit_ok()` on the tenant policies listed in the rule section. `failed_webhooks` gains a second SELECT policy for `platform_audit_ok()` so unresolved (`org_id` NULL) rows are visible only inside an audited platform transaction.

Helper shape the app calls inside one transaction:

```sql
CREATE OR REPLACE FUNCTION platform_begin(p_actor uuid, p_role text, p_action text,
  p_org uuid, p_table text, p_row text, p_reason text)
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
  INSERT INTO admin_audit_log (actor_user_id, platform_role, action, target_org_id,
                               target_table, target_row_id, reason)
  VALUES (p_actor, p_role, p_action, p_org, p_table, p_row, p_reason)
  RETURNING id INTO new_id;
  PERFORM set_config('app.platform_audit_id', new_id::text, true);
  RETURN new_id;
END;
$$;
```

`SECURITY INVOKER` so the function does not run as a superuser owner. The platform pool's search path is `public` only.

`platform_role` values: `operator` (directory, drill-in, kill switches, overrides) and `support` (read-only directory and drill-in, impersonation when consent exists). Enforced again in the route layer ([03](03-superadmin-console.md)).

## 120 — `120_org_plan_overrides.sql`

```sql
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

CREATE POLICY org_plan_overrides_read ON org_plan_overrides
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR platform_audit_ok()
  );

CREATE POLICY org_plan_overrides_write ON org_plan_overrides
  FOR ALL
  USING (platform_audit_ok())
  WITH CHECK (platform_audit_ok());

GRANT SELECT ON org_plan_overrides TO darex_app;
GRANT SELECT, INSERT, UPDATE ON org_plan_overrides TO darex_platform;
```

`darex_app` can read the active org's override so `assertUsageAllowed` and `checkSeatAvailability` honor it. It cannot write. Flag keys and the rule that a flag must not turn off the audit predicate are in [03](03-superadmin-console.md).

## 121 — `121_impersonation_sessions.sql`

The session cookie is `userId.sig` (`apps/dashboard/lib/session-cookie.ts:66-68`). It stays valid until `maxAge` (7 days, or 30 with remember). Revoke needs a server counter.

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

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

CREATE POLICY impersonation_platform ON impersonation_sessions
  FOR ALL
  USING (platform_audit_ok())
  WITH CHECK (platform_audit_ok());

CREATE POLICY impersonation_target_read ON impersonation_sessions
  FOR SELECT
  USING (
    target_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND ended_at IS NULL
    AND expires_at > NOW()
  );

GRANT SELECT ON impersonation_sessions TO darex_app;
GRANT SELECT, INSERT, UPDATE ON impersonation_sessions TO darex_platform;
```

`darex_app` SELECT is how the dashboard banner proves an active impersonation to the target user without joining the platform pool. Updates (end session) stay on `darex_platform`.

Also in this migration:

```sql
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS support_access_enabled BOOLEAN NOT NULL DEFAULT false;
```

Consent impersonation requires this flag; break-glass (operator) does not.

Cookie change, same commit as `121`: parser accepts legacy `userId.sig` as epoch `0`. New cookies are `userId.epoch.sig`. `getScopedClient` rejects the cookie when `epoch` does not match `users.session_epoch`. Revoke increments `session_epoch`. Epoch `0` keeps existing cookies valid across deploy so the migration does not log every customer out.

Max impersonation lifetime is 30 minutes, enforced in the route even if a caller sends a later `expires_at`.

## 122 — `122_platform_runtime_controls_audit.sql`

Migration `119`'s first `platform_audit_ok()` allow-list omitted `org_runtime_controls`. Platform kill-switch needs to UPSERT that table under `darex_platform`. This migration re-creates the tenant policy with `OR platform_audit_ok()` on `USING` and `WITH CHECK`. Idempotent. No password in the file.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Chain through 115 on disk | — | `infra/db/migrations/115_app_role_timeouts_and_signup_terms.sql` | 🟢 Done | File exists. Applied-on-server is row 2. |
| 2 | 106 and 115 applied on shared Postgres | P0 | `106` header lines 7–8; `BUILD_STATE.md` | 🔴 Blocked | Human/ops: database not accepting connections. Apply the existing chain before 116. |
| 3 | `116_org_status_lifecycle.sql` | P0 | `infra/db/migrations/116_org_status_lifecycle.sql` | 🟢 Done | CHECK, `suspended_at`, `suspended_by`, `deletion_requested_at`. Not applied on live DB. |
| 4 | Dunning writes `past_due` / `suspended` | P0 | `billing/_lib.ts` `applyDunningState` (~1268–1381) | 🟢 Done | Writes `past_due` / `suspended`+`dunning`; clears dunning only. |
| 5 | `117_failed_webhooks_tenant_boundary.sql` | P0 | `infra/db/migrations/117_failed_webhooks_tenant_boundary.sql` | 🟢 Done | Nullable `org_id`, FORCE RLS. Not applied on live DB. |
| 6 | `118_org_membership_visibility.sql` | P0 | `infra/db/migrations/118_org_membership_visibility.sql` | 🟢 Done | Member SELECT + `billing` on role CHECKs. |
| 7 | `119_platform_admins_and_audit.sql` | P0 | `infra/db/migrations/119_platform_admins_and_audit.sql` | 🟢 Done | Role, tables, `platform_audit_ok()`, `platform_begin`. No password in git. |
| 8 | `120_org_plan_overrides.sql` | P1 | `infra/db/migrations/120_org_plan_overrides.sql`; `lib/org-feature-flags.ts` | 🟢 Done | Tenant read, platform write, audit predicate. Enforced in `usage-gate.ts` + `checkSeatAvailability`. Session flags via `org-feature-flags.ts`. |
| 9 | `121_impersonation_sessions.sql` + cookie epoch | P1 | `121_impersonation_sessions.sql`; `session-cookie.ts` `userId.epoch.sig`; `orgs.support_access_enabled` | 🟢 Done | Banner SELECT; legacy two-part cookies epoch 0; consent column default false. |
| 10 | `122_platform_runtime_controls_audit.sql` | P1 | `infra/db/migrations/122_platform_runtime_controls_audit.sql` | 🟢 Done | `org_runtime_controls` policy OR `platform_audit_ok()`. Not applied on live DB. |
