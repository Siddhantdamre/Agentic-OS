# 06 — Security and RLS

Non-negotiables for the multi-tenant launch. Each one is either already true in the tree or is a P0 in [00](00-summary.md). A console, a migration, or a support workflow that breaks one of them does not ship.

## 1. Every tenant table has RLS

`FORCE ROW LEVEL SECURITY` plus a policy on `org_id = app.current_org_id` (NULLIF cast, the `037` pattern) or, for `orgs`, on `id`. `darex_app` is not a superuser (`infra/db/init/00_create_databases.sql:27-34`). Production refuses `DB_USER=darex` or `postgres` (`apps/dashboard/lib/boot-guards.ts:20-35`).

`failed_webhooks` violates this. `093_webhooks_dlq_and_delivery.sql:3-14` has no `org_id`. Line 28 grants `darex_app` SELECT/INSERT/UPDATE with no policy. `raw_payload` can contain another tenant's inbound body. Migration `117` is the fix: FORCE RLS, tenants read only their non-null `org_id`, unresolved rows stay invisible to `darex_app`.

Global catalogs and deny-all token tables are listed in [01](01-tenancy-model.md). They are not tenant tables. `platform_send_counters` stays a platform bucket.

`orgs` INSERT `WITH CHECK (true)` (`097:31-33`) is the signup exception `createOrgForEmail` depends on (`db.ts:257-264`). It is not permission to read another org.

## 2. Platform admin is a distinct database role

`darex_platform` is `LOGIN NOSUPERUSER NOBYPASSRLS`, created in migration `119`, with no password in git. It is not a row in `organization_memberships` and not `users.role = 'owner'`.

PostgreSQL superusers bypass FORCE RLS. Owning the platform functions as `darex` would silently skip policies. Functions that touch tenant rows are `SECURITY INVOKER` and run only when `current_user = 'darex_platform'`.

`darex_app` is not a member of `darex_platform` and cannot `SET ROLE`. The product pool and the platform pool are separate connection strings.

## 3. Audit before the effect

`platform_audit_ok()` is true only when `admin_audit_log.id` equals `app.platform_audit_id` and `audit_txid = txid_current()` ([02](02-data-model-migrations.md)). The insert is the first statement in the transaction. The GUC is transaction-local. A later transaction cannot reuse the id.

`admin_audit_log` has no UPDATE or DELETE grant and no such policy. Same posture as `106_audit_events_append_only.sql` on `audit_events` (that migration is written; its header says it was not applied on the shared database).

Directory loads are audited (`org.list`, `org.read`). Search is audited. Kill switches are audited before the status change. Reading one webhook payload is audited as `platform.webhook.read` and does not copy the body into the log.

`billing_audit_log` remains the customer billing trail. It does not replace `admin_audit_log`.

## 4. Impersonation is visible and expiring

No support login that only sets `users.org_id`. Migration `121` stores actor, target user, target org, reason, `audit_id`, expiry, and `break_glass`. The route writes the audit row first. Lifetime is at most 30 minutes. The dashboard banner reads `impersonation_sessions` through the target-user SELECT policy so the person being impersonated can see it. Ending the session or revoking it increments `users.session_epoch`, which the HMAC cookie must match.

`support` requires `orgs.support_access_enabled`. Break-glass is `operator` only, still bannered, still audited. Details in [03](03-superadmin-console.md). This control does not ship without the confirmation dialog.

## 5. The client does not choose `org_id`

`getScopedClient` sets `app.current_org_id` from `users.org_id` after the session cookie resolves the user (`db.ts:172-185`). Product routes that take a body reject `org_id` / `orgId` (billing helper `requestHasClientOrgId`, packs `rejectBodyOrgId`, ask-ai, org switch). Switch accepts `targetOrgId` only after a membership row matches (`org/switch/route.ts:26-76`).

Webhook org resolution stays server-side: inbox map, per-org secret, or provider customer id. Two current holes:

- `X-Darex-Org-Id` on Chatwoot resolves any active org with no per-org secret (`apps/dashboard/app/api/webhooks/chatwoot/route.ts:164-172`). Lines 178–181 already state that the global webhook secret is shared, which is why `?org_id=` requires the org's own token. The header path must require that same per-org secret or be removed. Until then a holder of the platform Chatwoot secret can deliver into any active org.
- `failed_webhooks` has no org column, so a tenant session can read other tenants' failures (section 1).

`ORG_COOKIE` (`session-cookie.ts:7`) is rotated on switch. It is not the authority `getScopedClient` uses. Do not start reading the org from that cookie.

## 6. What a platform request must not do

- `SET row_security = off`
- `BYPASSRLS`
- Connect the console as `darex` or `postgres`
- Call `getScopedClient()` and then query with a different org id than the session user
- Put a raw webhook body, session secret, TOTP secret, or connector token into `admin_audit_log.reason` or into a log line
- Let signup insert `platform_admins`

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Session GUC tenancy on `darex_app` | — | `db.ts:160-194`; `boot-guards.ts:20-35` | 🟢 Done | Keep. Production refuses superuser `DB_USER`. |
| 2 | FORCE RLS on tenant tables except the DLQ | — | `097` and per-table migrations | 🟢 Done | `failed_webhooks` is the exception (row 3). |
| 3 | `failed_webhooks` has no RLS | P0 | `117_failed_webhooks_tenant_boundary.sql` | 🟢 Done | Nullable `org_id`, FORCE RLS. Not applied on live DB. |
| 4 | Chatwoot header selects a tenant | P0 | `webhooks/chatwoot/route.ts:164-174` | 🟢 Done | Header requires per-org `meta.webhook_secret`. |
| 5 | `darex_platform` distinct from org owner | P0 | `119_platform_admins_and_audit.sql`; `lib/platform-db.ts` | 🟢 Done | `NOSUPERUSER NOBYPASSRLS`. No password in git. Pool 503 when unconfigured. |
| 6 | Audit row before cross-org effect | P0 | `platform_begin` in `119_*.sql`; `withPlatformTransaction` in `platform-db.ts` | 🟢 Done | Same transaction, `audit_txid = txid_current()`. |
| 7 | Append-only `audit_events` applied | P1 | `106_audit_events_append_only.sql:7-8` | 🟡 Partial | File revokes UPDATE/DELETE. Header says not applied on shared DB. |
| 8 | Impersonation banner + expiry + epoch | P1 | `session-cookie.ts`; `121_*.sql`; `ImpersonationBanner.tsx` | 🟢 Done | `userId.epoch.sig`; banner honest-empty when table missing. |
| 9 | Client `org_id` rejected on product routes | — | billing, packs, ask-ai, `org/switch/route.ts:26-33` | 🟢 Done | Keep the tests in `org-body-orgid-reject`. Webhook header is row 4. |
| 10 | Edge API rate limit | P2 | `middleware.ts`; `rate-limit-core.ts` `denyOrgApiIfLimited` | 🟡 Partial | `DAREX_ORG_RATE_LIMIT_PER_MINUTE` default 120. Key = `darex_org_id` UUID cookie when present, else session user id. Cookie can be stale vs `users.org_id` (Edge cannot query Postgres). |
