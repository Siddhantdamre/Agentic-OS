# 01 — Tenant model

How an organization lives in Darex, who can act inside it, and which tables are inside the tenant boundary. Extend the session GUC model. A second tenancy stack is out of scope.

## What the code does today

Signup creates an org with `plan = 'free'` and `status = 'provisioning'` (`apps/dashboard/lib/db.ts:254-263`). Completing org create sets `status = 'active'` (`apps/dashboard/app/api/org/create/route.ts:108`). `orgs.plan` is constrained to `free | starter | growth | enterprise` (`infra/db/migrations/017_billing.sql:21-24`). `orgs.status` is unconstrained text (`infra/db/migrations/001_core_schema.sql:8-16`).

The session refuses `soft_deleted` always and `suspended` unless the caller passes `allowSuspended` (`apps/dashboard/lib/org-session.ts:32-42`). Billing routes use that exception so a suspended workspace can still open the paywall. No application or migration statement sets `suspended`, `soft_deleted`, `past_due`, or `deleted`.

Trial is a subscription state, `billing_subscriptions.status = 'trialing'` (`017_billing.sql:53-55`), with `current_period_end` on the same row. It is not an `orgs.status` value. Keep that split: one payment clock, one access gate.

A user has one active workspace pointer, `users.org_id` (`001_core_schema.sql:21-29`). Many-to-many membership is `organization_memberships` (`097_org_tenancy_auth_hardening.sql:36-46`), backfilled from `users`. `POST /api/org/switch` verifies a membership, then updates the pointer (`apps/dashboard/app/api/org/switch/route.ts:41-86`). It does not copy `organization_memberships.role` onto `users.role`. `loadHumanRole` reads `users.role` only (`apps/dashboard/lib/rbac.ts:136-138`).

`orgs` SELECT policy is `id = app.current_org_id` (`097:17-19`). The switch query joins `orgs` before the pointer moves, so the target org row is invisible to the current session. The fallback query joins `users.org_id` to the target and fails the same way. Multi-org switch is not live until migration `118` adds a membership SELECT policy and the route copies the role in the same transaction.

Invites: table `org_invites` (`009_auth_tenancy.sql:169-179`), accept via `auth_accept_invite`. API `invite_member` in `apps/dashboard/app/api/settings/route.ts`. TTL is 7 days (`settings/route.ts:18`). Seat check calls `checkSeatAvailability` (`settings/route.ts:180`). The invite parser accepts `member` or `admin` only (`settings/route.ts:20-25`). The database also allows `owner` and `auditor` (`019_human_roles.sql:33-36`). Owner stays non-invitable: ownership moves by an explicit transfer, not an invite link.

Seats live on `billing_subscriptions.seats` (`017_billing.sql:42`), default 1, check `seats >= 1`. There is no `orgs.seats` column. Do not add one. Overrides of the seat cap belong on `org_plan_overrides` (migration `120`), and the invite check reads the override when a row exists, otherwise the subscription seat count, otherwise the env hard cap already used by `checkSeatAvailability`.

## Org lifecycle

Access column `orgs.status`, after migration `116`:

| Status | Who sets it | Session |
|--------|-------------|---------|
| `provisioning` | `createOrgForEmail` | Allowed. Onboarding unfinished. |
| `active` | Org create, or dunning cleared when `suspended_by = 'dunning'` | Allowed. |
| `past_due` | `applyDunningState` when the subscription is `past_due` or `unpaid` and grace has not elapsed | Allowed. Billing banner already exists. |
| `suspended` | Grace elapsed, or a platform operator | HTTP 402. Billing routes keep `allowSuspended: true`. |
| `soft_deleted` | Owner deletion request, or a platform operator | Always refused. Purge is the existing P2 saga (org-tenancy row 12), not this file. |

`suspended_by` is `dunning` or `platform`. A successful payment may move `dunning` back to `active`. It must leave a `platform` suspension in place until an operator clears it. `suspended_at` records the transition. `deletion_requested_at` records a soft-delete request before purge.

Shared type `OrgStatus` in `packages/shared-types/src/domain.ts` currently lists `provisioning | active | paused | deleted` and a string escape hatch. Align it to the CHECK above when `116` ships. `paused` maps to `suspended` in the backfill. `deleted` maps to `soft_deleted`.

## Roles inside an org

Today: `owner | admin | member | auditor` (`apps/dashboard/lib/rbac.ts:3`, `019_human_roles.sql:22-25`).

After migration `118`, add `billing`. Keep `auditor`.

| Role | Settings, employees, kill-switch | Billing portal, checkout, seats | Audit log read | DSR delete | Pay tools |
|------|----------------------------------|---------------------------------|----------------|------------|-----------|
| `owner` | yes | yes | yes | yes | yes |
| `admin` | yes | yes | yes | no | yes |
| `billing` | no | yes | no | no | no |
| `member` | no | no | no | no | yes (existing `canCallPayTools`) |
| `auditor` | no | no | yes | no | no |

`canManageBilling` (`billing/_lib.ts:144-156`) grows a `billing` arm and stays false for `member` and `auditor`. `canManageOrgSettings`, `canDeleteDsr`, and `canCallPayTools` stay false for `billing`. Invite creation may offer `member`, `admin`, `billing`, and `auditor`. It still rejects `owner`.

`organization_memberships.role` is the source of truth per org. `users.role` is the cached role for the active pointer. `POST /api/org/switch` sets both in one transaction after migration `118` makes the target org readable. `loadHumanRole` keeps reading `users.role` so every existing call site stays valid.

Platform staff are not an org role. See `platform_admins` in [02](02-data-model-migrations.md). An operator who is also a member of a customer org uses their membership role inside that org and the platform role only on `/admin` and `/api/platform/*`.

## Seat and invite flow (keep, then extend)

1. Owner, admin, or (after `118`) billing calls `POST /api/settings` `invite_member`.
2. `checkSeatAvailability(orgId, 1)` counts `users` for that org against subscription seats or the meter hard cap.
3. Insert `org_invites` with a hashed token. Mail the link (`apps/dashboard/lib/mail.ts`).
4. `POST /api/auth/invite/[token]` accepts, attaches the user, and upserts `organization_memberships`.
5. When an override row exists, step 2 uses `org_plan_overrides` seat cap instead of the env default. The subscription seat count remains the billed quantity. An override can lower or raise the cap; raising it is a confirmation-gated platform action ([03](03-superadmin-console.md)).

## Table boundary

Tenant tables already have `org_id` (or, for `orgs`, RLS on `id`) and FORCE RLS in their defining migrations. That set includes the core tables in `001`, billing tables in `017` except the webhook inbox, `audit_events`, `organization_memberships`, memory, work items, connectors (`org_connectors`), and the employee domain tables. Re-check a new `CREATE TABLE` against this list before calling it a gap.

### P0 — missing tenant boundary

| Table | Evidence | Required change |
|-------|----------|-----------------|
| `failed_webhooks` | `093_webhooks_dlq_and_delivery.sql:3-14` has no `org_id`. Line 28 grants `darex_app` with no RLS. `raw_payload` is the full body. | Migration `117`. Nullable `org_id`. FORCE RLS. Tenants may insert an unresolved row and may read only their own non-null `org_id`. Unresolved rows are invisible to `darex_app`. |

### Intentional global or non-tenant tables

These stay without a tenant `org_id`. Do not "fix" them by adding a fake org column.

| Table | Why it stays global | Isolation that already exists |
|-------|---------------------|-------------------------------|
| `orgs` | Tenant root | FORCE RLS on `id = app.current_org_id` (`097:17-19`). INSERT `WITH CHECK (true)` is the signup exception (`097:31-33`). |
| `connector_defs`, `packs`, `pack_entity_schemas`, `predicate_defs` | Product catalog | Tenant SELECT; writes restricted to the owner role in `022_hardening.sql` (comment at line 33). |
| `rera_cache` | Public cache | Global read. No customer payload. |
| `platform_send_counters` | Process-wide send bucket | `025_customer_employee.sql:26-30`. Counts only. |
| `password_reset_tokens` | Capability token | Deny-all RLS and `REVOKE` from `darex_app` (`022_hardening.sql:5-16`). |
| `billing_webhook_events` | Provider id arrives before the org is known | Deny-all plus SECURITY DEFINER lookup (`022_hardening.sql:18-30`, `017` webhook functions). |
| `platform_admins`, `admin_audit_log` | Platform plane, introduced in `119` | No `org_id` as a tenant key. `target_org_id` on the log is an attribute, not the RLS tenant. |

`orgs` INSERT `WITH CHECK (true)` lets any `darex_app` session insert an org row. Signup needs a provisioning insert before the GUC matches the new id (`db.ts:257-264` explains why). Hardening that to a SECURITY DEFINER provision function is P2, after the P0 leaks above. It is a write of a new empty org, not a cross-tenant read.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Session-derived `org_id` | — | `apps/dashboard/lib/db.ts:160-194` | 🟢 Done | Cookie → user → `set_config`. Leave it. |
| 2 | Org RLS + memberships | — | `097_org_tenancy_auth_hardening.sql:7-64` | 🟢 Done | FORCE RLS. Membership backfill. Leave the table. |
| 3 | Suspended / soft-deleted session gate | — | `apps/dashboard/lib/org-session.ts:32-42` | 🟢 Done | Gate works. Writers are row 5. |
| 4 | Invite + seat check | — | `settings/route.ts:18-25,180` | 🟢 Done | 7-day invite, `checkSeatAvailability`. Role parser is row 8. |
| 5 | Status CHECK + lifecycle columns | P0 | `116_org_status_lifecycle.sql` | 🟢 Done | CHECK + `suspended_at` / `suspended_by` / `deletion_requested_at`. Not applied on live DB. |
| 6 | `failed_webhooks` tenant boundary | P0 | `117_failed_webhooks_tenant_boundary.sql` | 🟢 Done | Nullable `org_id`, FORCE RLS. Not applied on live DB. |
| 7 | Membership-visible `orgs` SELECT + role copy on switch | P0 | `118_org_membership_visibility.sql`; `org/switch/route.ts:83-90` | 🟢 Done | Member SELECT + `users.role = om.role` in switch transaction. |
| 8 | `billing` role beside `auditor` | P1 | `rbac.ts:3`; `118_*.sql`; `settings/route.ts:20-23`; `settings/page.tsx` invite + `support_access` | 🟢 Done | `billing` on CHECKs, invites UI/API, `canManageBilling`; owner support-access toggle. |
| 9 | Workspace switcher UI | P1 | `components/shell/OrganizationSwitcher.tsx`; `AppShell.tsx` | 🟢 Done | Fetches memberships + `POST /api/org/switch`. Honest-empty when none. |
| 10 | Global catalogs and deny-all token tables | — | `022_hardening.sql:5-33`; `025:26-30` | 🟢 Done | Documented as intentional. Do not add `org_id`. |
| 11 | Owner `request_deletion` soft-delete | P2 | `settings/route.ts` `request_deletion`; `settings/page.tsx` | 🟢 Done | Owner + confirm + reason ≥ 12 → `status = soft_deleted`, then `scheduleOrgPurge`. Purge completeness is row 12. |
| 12 | Deletion / offboarding purge saga | P2 | `lib/org-purge.ts`; platform `soft-delete/route.ts` | 🟡 Partial | Known Temporal cancel + connector disconnect + listed memory SQL deletes. Failures never roll back `soft_deleted`. Skipped: unknown workflow ids; Cognee / vectors outside those tables. |
| 13 | Edge tenant API quotas | P2 | `middleware.ts`; `rate-limit-core.ts` | 🟡 Partial | Key = `darex_org_id` cookie UUID when set, else session user id. Cookie may be stale vs `users.org_id`. |
| 14 | Customer custom domains + TLS | P2 | infra / DNS | 🔴 Blocked | Human: DNS and certificate automation. |
