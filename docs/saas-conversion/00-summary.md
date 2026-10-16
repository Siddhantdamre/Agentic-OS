# SaaS conversion — summary

Read this file first. The domain files below are the spec. This page is only the priority roll-up.

Audit date: 2026-09-27. Evidence is the current code and migrations through
`122_platform_runtime_controls_audit.sql` (on disk). **None of 115–122 is
confirmed applied** on the shared Postgres. The narrative "What's broken"
sections in `docs/new-109-pg-plan/gap26sept/org-tenancy.md` and `billing.md`
describe an older tree. Their **Live Resolution Tracker** tables are the ones
that match the code. This folder extends that tracker. It does not rebuild
session tenancy, RLS, or product billing.

When a row below ships, that same commit updates `BUILD_STATE.md` and flips
the row. Applied-on-server stays 🔴 until migrate succeeds.

## Already multi-tenant-safe (leave it)

- Org id comes from the session cookie via `getScopedClient` (`apps/dashboard/lib/db.ts:160-194`). The pool resets `app.current_org_id` and `app.current_user_id` on release.
- Production refuses to boot as `darex` or `postgres` (`apps/dashboard/lib/boot-guards.ts:20-35`). The app role is `darex_app` (`infra/db/init/00_create_databases.sql:27-34`).
- `orgs` has FORCE RLS scoped to the session org, and `organization_memberships` exists (`infra/db/migrations/097_org_tenancy_auth_hardening.sql:7-64`).
- Single-org webhook fallbacks return empty (`infra/db/migrations/108_neutralize_single_org_resolvers.sql`).
- Product plans, seats, meters, Stripe and Razorpay checkout, portal, proration, signed webhooks, and dunning already exist (`017`, `104`, `apps/dashboard/app/api/billing/`).
- Per-org audit reads exist at `GET /api/audit-logs`. Liveness is `GET /api/health`. Readiness is `GET /api/health/ready`.

## P0 — blocks a second real tenant

| # | Gap | Detail |
|---|-----|--------|
| 1 | `failed_webhooks` has no tenant boundary | No `org_id`, no RLS, `GRANT` to `darex_app`, raw body stored (`093_webhooks_dlq_and_delivery.sql:3-14,28`). Any org session can read every tenant's failed payloads. [01](01-tenancy-model.md) [02](02-data-model-migrations.md) [06](06-security-and-rls.md) |
| 2 | Org lifecycle is unconstrained and has no suspend writer | `orgs.status` is free text, default `provisioning` (`001_core_schema.sql:13`). The session gate understands `suspended` and `soft_deleted` (`apps/dashboard/lib/org-session.ts:32-42`) and nothing in the repo sets them. Dunning only downgrades the plan to `free` (`apps/dashboard/app/api/billing/_lib.ts:1306-1314`). [01](01-tenancy-model.md) [02](02-data-model-migrations.md) [04](04-billing-plans.md) |
| 3 | Workspace switch cannot see the target org, and the role stays behind | `orgs` SELECT is `id = current org` (`097:17-19`). Switch joins `orgs` while still scoped to the source org (`apps/dashboard/app/api/org/switch/route.ts:47-50`) and updates `users.org_id` only (`:83-86`). `loadHumanRole` reads `users.role` (`apps/dashboard/lib/rbac.ts:136-138`). [01](01-tenancy-model.md) [06](06-security-and-rls.md) |
| 4 | Chatwoot `X-Darex-Org-Id` selects any active org | Header resolution has no per-org secret (`apps/dashboard/app/api/webhooks/chatwoot/route.ts:164-172`). The same file already says the global webhook secret is shared across orgs (`:178-181`). [06](06-security-and-rls.md) |
| 5 | No platform operator identity | No `platform_admins`, no `admin_audit_log`, no DB role besides `darex` / `darex_app`, no route that a normal org session cannot open. [02](02-data-model-migrations.md) [03](03-superadmin-console.md) [06](06-security-and-rls.md) |

## P1 — ship after the P0 boundary is real

| # | Gap | Detail |
|---|-----|--------|
| 6 | Console UI | Cross-org directory, drill-in, search, and audited wrappers. Path-based route group. Subdomain DNS is a separate human blocker. [03](03-superadmin-console.md) |
| 7 | Impersonation | Time-boxed, consent, audit row before the cookie, visible banner. Stateless HMAC cookies cannot be revoked until a server epoch exists (`apps/dashboard/lib/session-cookie.ts:66-68`). [03](03-superadmin-console.md) [02](02-data-model-migrations.md) |
| 8 | Per-org flag and cap overrides | Caps today are process env (`DAREX_METER_*`) plus `billing_meters`. No override table. [02](02-data-model-migrations.md) [03](03-superadmin-console.md) |
| 9 | `billing` org role | Roles are `owner`, `admin`, `member`, `auditor` (`019_human_roles.sql:22-25`, `apps/dashboard/lib/rbac.ts:3`). Billing mutations are owner/admin only (`apps/dashboard/app/api/billing/_lib.ts:144-166`). Add `billing`; keep `auditor`. [01](01-tenancy-model.md) |
| 10 | Workspace switcher UI | Memberships and `POST /api/org/switch` exist. No shell component calls them (org-tenancy tracker row 11, re-checked: no `.tsx` fetch). [01](01-tenancy-model.md) [07](07-rollout-plan.md) |
| 11 | Platform observability | Reuse `/api/health`, `/api/health/ready`, `/api/health/diagnostics`, `/api/audit-logs`, `/api/observability/metrics`, Langfuse. Alert dispatch and the metrics GET write-stampede are still open (`docs/new-109-pg-plan/gap26sept/observability.md` rows 2 and 5). [05](05-observability-monitoring.md) |

## P2 — already tracked, or human-only

| # | Gap | Detail |
|---|-----|--------|
| 12 | Tenant deletion saga | Org-tenancy tracker row 12. Grace, Temporal cancel, Nango disconnect, memory purge. [07](07-rollout-plan.md) |
| 13 | Edge per-tenant quotas | Org-tenancy tracker row 13. Usage gate already blocks execution; edge middleware does not. [07](07-rollout-plan.md) |
| 14 | Customer custom domains + TLS | Org-tenancy tracker row 14. Human: DNS and certificate automation. [07](07-rollout-plan.md) |
| 15 | Admin console subdomain | Path `/admin` can ship without it. Human: DNS for a dedicated hostname. [03](03-superadmin-console.md) [07](07-rollout-plan.md) |
| 16 | Production payment keys | Stripe secret, webhook secret, price IDs, and Razorpay keys. Billing already fails closed without them. [04](04-billing-plans.md) |
| 17 | Shared Postgres | `BUILD_STATE.md` (2026-09-27): container not accepting connections; `115_*` not confirmed applied. `106` header says the same for that migration. No row in this folder can be marked applied until `pnpm db:migrate` succeeds. [07](07-rollout-plan.md) |

## Suggested order

1. Migration `117` (webhook DLQ isolation) and the Chatwoot header fix. Both are cross-tenant leaks on a shared database.
2. Migration `116` plus the dunning writer that sets `past_due` / `suspended`.
3. Migration `118` plus the switch/role code so a user in two orgs gets the membership role.
4. Migration `119` (`darex_platform` + `admin_audit_log`) before any cross-org screen.
5. Console read-only directory, then confirmation-gated kill switches.
6. Overrides, impersonation, switcher UI, alerting.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | `failed_webhooks` readable across tenants | P0 | `infra/db/migrations/117_failed_webhooks_tenant_boundary.sql` | 🟢 Done | Migration on disk: nullable `org_id`, FORCE RLS. Not applied on live DB (row 17). |
| 2 | `orgs.status` has no CHECK and no suspend writer | P0 | `116_org_status_lifecycle.sql`; `billing/_lib.ts` `applyDunningState` | 🟢 Done | CHECK + `suspended_by`; dunning writes `past_due` / `suspended`. Not applied on live DB. |
| 3 | Switch blocked by orgs RLS; role not copied from membership | P0 | `118_org_membership_visibility.sql`; `org/switch/route.ts:83-90` | 🟢 Done | Member SELECT policy; switch sets `users.role` from membership. |
| 4 | Chatwoot header chooses any active org | P0 | `webhooks/chatwoot/route.ts:164-174` | 🟢 Done | `X-Darex-Org-Id` requires matching `meta.webhook_secret`. |
| 5 | No platform admin role, table, or audit log | P0 | `119_platform_admins_and_audit.sql`; `lib/platform-db.ts` | 🟢 Done | Role + tables + `platform_begin`. First operator insert still human (row stays ops-blocked in 03). |
| 6 | Superadmin console | P1 | `app/(platform)/admin/`; `middleware.ts:12-18`; `api/platform/**` | 🟢 Done | Path `/admin` + platform APIs; `requirePlatformAdmin`. Subdomain DNS still blocked. |
| 7 | Impersonation with consent, expiry, banner | P1 | `121_impersonation_sessions.sql`; `session-cookie.ts` `signSessionValue(userId, epoch)`; `api/platform/impersonation/**`; `ImpersonationBanner.tsx` | 🟢 Done | Epoch cookie; consent via `orgs.support_access_enabled`; banner honest-empty when table missing. |
| 8 | Per-org plan overrides | P1 | `120_org_plan_overrides.sql`; `api/platform/orgs/[orgId]/overrides/route.ts`; `usage-gate.ts`; `billing/_lib.ts` `checkSeatAvailability` | 🟢 Done | Platform write + tenant read; meter hard caps and seat_cap enforced at gate. Not applied on live DB. |
| 9 | Dedicated `billing` org role | P1 | `rbac.ts:3`; `118_*.sql`; `settings/route.ts:20-23`; `settings/page.tsx`; `billing/_lib.ts:144-148` | 🟢 Done | `billing` (+ `auditor`) on invites UI/API; `canManageBilling`; owner `support_access` toggle. |
| 10 | Workspace switcher UI | P1 | `components/shell/OrganizationSwitcher.tsx`; `AppShell.tsx` | 🟢 Done | Fetches `/api/org/memberships`, switches via `/api/org/switch`. Honest-empty when none. |
| 11 | Platform-wide monitoring wrappers | P1 | `api/platform/observability/route.ts`; `employee-metrics-query.ts` `loadFreshDailyMetricsSnapshot`; `lib/alert-dispatch.ts`; `api/observability/alerts/dispatch` | 🟢 Done | Audited aggregate; metrics GET snapshot-first; alert dispatch posts to `DAREX_ALERT_WEBHOOK_URL` (unset → `not_configured`). |
| 12 | Deletion / offboarding saga | P2 | `lib/org-purge.ts`; settings `request_deletion`; platform soft-delete | 🟡 Partial | Soft-delete commits first, then `scheduleOrgPurge`: cancel known Temporal handles, disconnect connectors, DELETE listed memory tables. Failures do not roll back `soft_deleted`. Skipped: unknown workflow ids; Cognee / external vectors outside those SQL tables. |
| 13 | Edge tenant quotas | P2 | `middleware.ts`; `rate-limit-core.ts` `denyOrgApiIfLimited` | 🟡 Partial | `DAREX_ORG_RATE_LIMIT_PER_MINUTE` default 120 on authenticated `/api/*`. Key = `darex_org_id` UUID cookie when present, else session user id. Cookie can be stale vs `users.org_id` (Edge cannot query Postgres). |
| 14 | Customer custom domains + TLS | P2 | infra | 🔴 Blocked | Human: DNS and certificate automation. |
| 15 | Admin subdomain | P2 | DNS | 🔴 Blocked | Human: hostname and certificate. Path `/admin` does not wait on this. |
| 16 | Production Stripe / Razorpay keys and price IDs | P2 | `billing/_lib.ts` `catalogPlans` | 🔴 Blocked | Human: `STRIPE_*` secret, webhook secret, price IDs; Razorpay key id and secret. Do not stub prices. |
| 17 | Apply migrations on shared Postgres | P2 | `BUILD_STATE.md` SaaS conversion section | 🔴 Blocked | Human/ops: Postgres down; 115–122 not confirmed applied. |
