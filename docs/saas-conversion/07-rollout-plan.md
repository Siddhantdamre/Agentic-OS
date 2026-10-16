# 07 — Rollout

Sequence for a second real tenant and a platform console. SQL sketches and the audit predicate are in [02](02-data-model-migrations.md). This file is the order, what blocks launch, and how each migration comes off.

Apply `infra/db/migrations` through `115` before `116`. `106` and `115` are not confirmed on the shared database. `BUILD_STATE.md` (2026-09-27) records that the Postgres container is not accepting connections. That ops fact blocks every "applied" check below. It does not block writing the migration files later.

## Blocks a safe multi-tenant launch (P0)

Ship these before a second customer org shares the database with real webhook traffic and real billing.

| Step | Change | Why it blocks |
|------|--------|----------------|
| 0 | `pnpm db:migrate` through 115 on a live Postgres | Later files assume `organization_memberships`, `billing_subscriptions.dunning_grace_ends_at`, and the `audit_events` append-only revoke. |
| 1 | `117` + Chatwoot header fix | Cross-tenant read of webhook bodies, and a header that picks any active org (`chatwoot/route.ts:164-172`). |
| 2 | `116` + dunning status writer | Session gate already enforces `suspended` / `soft_deleted`. Nothing sets them, so a failed payment stays a full session (`billing/_lib.ts:1306-1314`). |
| 3 | `118` + switch role copy | A user in two orgs cannot see the target org under current `orgs` SELECT (`097:17-19`) and keeps the old `users.role` (`rbac.ts:136-138`). |
| 4 | `119` before any `/admin` screen | Cross-org UI without `darex_platform` and `admin_audit_log` would be a silent RLS bypass or a superuser connection. |

Steps 1–3 can land as separate commits. Step 4 lands before the first platform route, including a read-only directory. Do not put the directory on `darex_app` "temporarily".

## After launch (P1 then P2)

P1, once step 4 is in:

1. Read-only directory, drill-in, and search ([03](03-superadmin-console.md)). Each read calls `platform_begin`.
2. Confirmation-gated suspend, unsuspend, soft-delete, force-disconnect, session revoke.
3. `120` overrides. Raising a cap stays behind the confirm dialog.
4. `121` impersonation, banner, and `session_epoch`. Deploy the cookie parser in the same release as the column. Legacy `userId.sig` stays epoch 0 so this deploy does not log every user out.
5. Workspace switcher UI (`OrganizationSwitcher.tsx` in AppShell).
6. `GET /api/platform/observability` reading snapshots; metrics GET snapshot-first; alert dispatch via `DAREX_ALERT_WEBHOOK_URL`.
7. `122` so platform kill-switch can UPSERT `org_runtime_controls` under `platform_audit_ok()`.

P2, from org-tenancy tracker rows 12–14:

- Deletion purge after `soft_deleted` (`lib/org-purge.ts`): known Temporal cancel, connector disconnect, listed memory SQL deletes. Still partial — unknown workflow ids and Cognee / external vectors outside those tables are skipped; purge failures do not roll back status.
- Edge API rate limit (`DAREX_ORG_RATE_LIMIT_PER_MINUTE`): keys on `darex_org_id` cookie when present, else session user id; cookie may be stale vs `users.org_id`.
- Customer custom domains and TLS.
- Admin hostname. Path `/admin` does not wait on DNS.

## Human blockers (stay red until a person does them)

| Blocker | What "done" requires |
|---------|----------------------|
| Shared Postgres | Container accepts connections and `pnpm db:migrate` has applied through 115, then 116–122 as they land. |
| `darex_platform` password | `ALTER ROLE` from a secret store. The migration file has no password. |
| First `platform_admins` row | Superuser insert naming a real user and a reason. Signup cannot do this. |
| Stripe and Razorpay production credentials | Secret, webhook secret, and a price or plan id per paid tier. `catalogPlans()` already returns null ids when env is empty (`billing/_lib.ts:399-406`). |
| Admin subdomain DNS | Certificate and hostname. Optional for launch. |
| Customer custom-domain DNS | Optional. Org-tenancy row 14. |

## Rollback

Take a `COPY` of `orgs (id, status)` before `116`. Mapped values (`paused` → `suspended`, `deleted` → `soft_deleted`, unknown → `active`) cannot be reconstructed after the UPDATE.

Down migrations run as `darex`, same as up. They refuse when dropping them would delete a non-empty compliance log.

### 116 down

```sql
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_status_check;
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_suspended_by_check;
ALTER TABLE orgs
  DROP COLUMN IF EXISTS suspended_at,
  DROP COLUMN IF EXISTS suspended_by,
  DROP COLUMN IF EXISTS deletion_requested_at;
```

Deploy the previous app in the same release. The dunning writer that sets `past_due` / `suspended` must leave with the constraint, or the next dunning run will try to write a status the column still accepts as plain text (harmless) while the new app is gone. Restore `orgs.status` from the pre-migrate copy if the mapped values matter.

### 117 down

```sql
DROP POLICY IF EXISTS failed_webhooks_tenant ON failed_webhooks;
ALTER TABLE failed_webhooks DISABLE ROW LEVEL SECURITY;
ALTER TABLE failed_webhooks DROP COLUMN IF EXISTS org_id;
```

This restores the cross-tenant read. Roll it back only to unbreak a DLQ insert that the WITH CHECK rejected, then fix the insert and re-apply. Do not leave 117 reverted on a shared production database.

### 118 down

Refuse if any `users`, `org_invites`, or `organization_memberships` row has `role = 'billing'`. Otherwise drop `orgs_member_select` and restore the four-value CHECKs from `019` and `097` (`owner`, `admin`, `member`, `auditor`). Ship the previous switch route in the same release so it does not write `billing`.

### 119 down

Refuse when `admin_audit_log` has any row. Export the table first if the business accepts dropping history; the migration itself does not delete audit rows.

When empty:

```sql
-- Drop OR platform_audit_ok() arms added to tenant policies first.
DROP FUNCTION IF EXISTS platform_begin(uuid, text, text, uuid, text, text, text);
DROP FUNCTION IF EXISTS platform_audit_ok();
DROP TABLE IF EXISTS admin_audit_log;
DROP TABLE IF EXISTS platform_admins;
DROP ROLE IF EXISTS darex_platform;
```

Remove the platform pool from the app config in that same release so the process does not boot with a missing role.

### 120 down

```sql
DROP TABLE IF EXISTS org_plan_overrides;
```

Caps fall back to `DAREX_METER_*` and `billing_subscriptions.seats`. Allowed because this table is configuration, not the compliance log. Record the dropped JSON in the change ticket before running it.

### 121 down

Refuse when `impersonation_sessions` is non-empty or any `users.session_epoch` is greater than 0. Those cookies would become unverifiable or, worse, match epoch 0 again and revive a revoked session.

When all epochs are 0 and the impersonation table is empty, drop the table and the column, and deploy the previous cookie signer (`userId.sig` only) together.

### 122 down

```sql
DROP POLICY IF EXISTS org_runtime_controls_org_isolation ON org_runtime_controls;
CREATE POLICY org_runtime_controls_org_isolation ON org_runtime_controls
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

Restores tenant-only isolation (no `platform_audit_ok()` arm). Platform kill-switch then cannot UPSERT `org_runtime_controls` under RLS; deploy the prior app behavior in the same release if rolling back.

## Release shape

One migration and the app code that requires it land in one commit, matching the repo rule that a migration and its caller ship together. Suggested commits after this planning pass (not part of this pass):

1. `fix(webhooks)`: Chatwoot per-org secret on the header path.
2. `fix(rls)`: `117` failed webhook boundary.
3. `feat(tenancy)`: `116` plus the dunning status writer.
4. `fix(tenancy)`: `118` plus switch role copy and the `billing` role in `rbac.ts`.
5. `feat(platform)`: `119`, pool, middleware gate, no directory yet if the gate returns 404. Directory can be the next commit once the gate is tested.
6. Later: overrides, impersonation, switcher UI, platform observability.

`BUILD_STATE.md` updates inside the commit that changes runtime behavior. This planning folder does not update it.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | P0 order documented | — | this file | 🟢 Done | Planning only. |
| 2 | Migrate through 115 on shared Postgres | P0 | `BUILD_STATE.md` database section; `106:7-8` | 🔴 Blocked | Human/ops: database not accepting connections. |
| 3 | Launch slice: 117, Chatwoot header, 116, 118, 119 | P0 | migrations `116`–`119` on disk; Chatwoot `route.ts:164-174` | 🟡 Partial | Code + SQL on disk. Not applied on live DB. First `platform_admins` insert still human. |
| 4 | Console, overrides, impersonation, switcher, platform metrics | P1 | `app/(platform)/admin/`; `api/platform/**`; `120`/`121`/`122`; `OrganizationSwitcher.tsx`; `alert-dispatch.ts` | 🟢 Done | Console, overrides, impersonation, switcher, platform observability, snapshot-first metrics, alert dispatch code path. Env `DAREX_ALERT_WEBHOOK_URL` required for live delivery. |
| 5 | Deletion saga, edge quotas, custom domains | P2 | `lib/org-purge.ts`; org-tenancy rows 12–14; `middleware.ts` | 🟡 Partial | Purge scheduled after soft-delete (known Temporal + connectors + listed memory tables; not Cognee / unknown workflows). Edge key = org cookie UUID else user id (cookie may be stale). Custom domains + admin DNS remain 🔴. |
| 6 | Each of 116–122 has a down path | — | this file, Rollback | 🟢 Done | Specified for 116–121. `122` down restores prior `org_runtime_controls` policy without `platform_audit_ok()`. 119 and 121 refuse when they would drop or revive history. Not executed. |
