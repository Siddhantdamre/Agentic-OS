# 07 · Security, auth, RBAC, tenancy, compliance, platform admin, infra

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 1 | 1.8% |
> | 🟡 **Pending / In Progress** | 6 | 10.9% |
> | 🔴 **Not Done (Open)** | 47 | 85.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 1.8% |
> | **Total Findings** | **55** | **100.0%** |

Audit date 2026-09-27, read-only. Scope: `apps/dashboard/{middleware.ts,lib/*}`, `app/api/{auth,org,platform,settings,audit*,dsr,onboarding,health}/**`, `app/(auth)`, `app/(platform)`, all 71 migration files (99 `CREATE TABLE`), `infra/db/init`, `services/workflows/src/{db,usage-gate,dsr/**}`, `infra/docker-compose.yml`, `infra/terraform/**`, `.github/workflows/ci.yml`, `.husky/*`. Docs: `gap26sept/{auth,org-tenancy,settings,audit-log,dsr}.md`, `saas-conversion/*.md`, `gap/18_security_and_governance.md`. Migrations 115–122 are **on disk, not applied**; every 🟢 in `saas-conversion/06` that depends on them is a claim.

**Headline.** RLS is broad and mostly correct (`getScopedClient`, FORCE RLS, pool GUC reset, PgBouncer in session mode). Five things break the enterprise story: (1) **`darex_platform` has no GRANT on any tenant table** — the entire `/admin` console fails with `42501` as shipped; (2) every login/OAuth/SSO/invite path mints an **epoch-0 cookie**, so after any `revoke-sessions` or impersonation-end the user is **permanently locked out**, and `requirePlatformAdmin` never checks epoch; (3) the auditor pay-tool block exists on **one** route; (4) DSR delete omits ~40 PII-bearing tables plus Cognee / Nango / Langfuse / SuperTokens; (5) no CSP/HSTS, in-memory rate limits, CI never runs `pnpm test`, and the isolation test **re-grants blanket table privileges** that mask append-only regressions.

---

## 1. RLS matrix — exceptions only (99 tables audited; the rest are ✅ org_id + RLS + FORCE + org policy + grant)

`D` = default privileges via `011:18-21`; `E` = explicit GRANT; `NULLIF` = safe empty-GUC policy; `raw` = `::UUID` cast (fails closed, noisy); `PAO` = `OR platform_audit_ok()` arm (119–122).

| Table | Problem | Evidence |
|---|---|---|
| **`platform_send_counters`** | **No RLS, no policy**, full S/I/U/D to `darex_app` — the only table with no boundary; any tenant can zero/inflate the global send budget | `025:26-30` |
| **`pack_entity_schemas`** | `write_all USING(true)` never dropped — any tenant rewrites pack schemas | `015:119-122` |
| **`rera_cache`** | `write_all USING(true)` — cross-tenant cache poisoning | `015:308-311` |
| **`predicate_defs`** | write policy `USING (GUC IS NULL)` + default I/U/D → writable from any unscoped checkout | `022eg:146-148` |
| `orgs` | `orgs_tenant_insert WITH CHECK (true)` + INSERT grant → any tenant session creates unlimited orgs | `097:31-33` |
| `users` | no self-UPDATE policy → `org/switch` `UPDATE users SET org_id` hits `WITH CHECK (org_id = current_org)` → expected `42501` under FORCE RLS | `org/switch/route.ts:83-90` vs `119:185-193` |
| `audit_events` | append-only (`S+I` only) depends on `106`, whose header says not applied | `106:7,43-44` |
| `org_plan_overrides`, `impersonation_sessions` | RLS correct, but default I/U/D grants to `darex_app` never revoked | `120:35`, `121:56` |
| `connector_defs`, `packs` | ✅ read-all, write dropped, SELECT-only | `022h:37-46` |
| `password_reset_tokens`, `billing_webhook_events`, `admin_audit_log` | ✅ deny-all / REVOKE ALL, SECURITY DEFINER access only | `022h`, `119:49-64` |

**Cross-cutting grant defect (SEC-P01):** `darex_platform` receives GRANTs only on `admin_audit_log`, `platform_admins`, `org_plan_overrides`, `impersonation_sessions` and two functions (`119:51,84,133-135`, `120:36`, `121:57`). No `GRANT USAGE ON SCHEMA public`, no SELECT/UPDATE on `orgs`, `users`, `organization_memberships`, `billing_*`, `org_connectors`, `audit_events`, `failed_webhooks`, `messages`, `conversations`, `org_runtime_controls`. Every `OR platform_audit_ok()` arm is unreachable.

## 2. Auth

| ID | Sev | Where | Issue | Fix | Status |
|---|---|---|---|---|---|
| SEC-A01 | **P0** | `auth/[[...path]]/route.ts:49-70,223,243,250,338,396`; `auth/invite/[token]:105-109`; `oauth/callback/[provider]:168`; `sso/callback/[provider]:149` | All cookie-minting paths call `applySessionCookies` **without `sessionEpoch`** → epoch 0. After `revoke-sessions` (`:58-59`) or `impersonation/end` (`:99-101`) bumps `users.session_epoch`, `getScopedClient` rejects `cookieEpoch !== sessionEpoch` (`lib/db.ts:192-194`) on **every future login** — permanent lockout. Only `org/switch:130` and impersonation start pass the epoch. | Read `session_epoch` in `issueSession` and every mint path. | 🔴 |
| SEC-A02 | **P0** | `lib/platform-admin.ts:83-84`; `middleware.ts:47-48`; `auth/[[...path]]:106` | `requirePlatformAdmin`, middleware, `/api/auth/session` use `parseSessionCookie` (no epoch). Revoked platform-admin cookie still runs every `withPlatformTransaction` write. | `parseSessionCookieParts` + epoch compare. | 🟢 (2026-09-29: `requirePlatformAdmin`, `getScopedClient`, `/api/auth/session`, and `/api/auth/invite/[token]` all parse `userId.epoch.sig` via `parseSessionCookieParts` and enforce `cookieEpoch === sessionEpoch`, rejecting revoked cookies; verified in `session-cookie-auth.test.ts`) |
| SEC-A03 | P1 | `session-cookie.ts:81-85,100-118` | Payload `userId.epoch.sig` — no `iat`/`exp`; lifetime unbounded server-side; legacy `userId.sig` still accepted. | Add expiry; drop legacy. | 🔴 |
| SEC-A04 | P1 | `oauth/callback/[provider]:102-114,143-147,262-279`; `sso/callback:100-106` | Account linking by email with unverified emails (GitHub `typed[0]`, Microsoft UPN, Meta); SSO `isVerified ?? true`. Pre-registration takeover. | Require `verified===true`. | 🔴 |
| SEC-A05 | P1 | `lib/supertokens.ts:129,140,178-189`; `sso/callback:122-130` | SSO is **global**: one SAML/OIDC client, Google `hd:'*'`, Microsoft `common`. Any IdP user JIT-creates a new org as `owner`. No org↔IdP binding, group→role, or SCIM. | Per-org SSO config; domain claim; JIT into bound org. | 🔴 |
| SEC-A06 | P1 | `rate-limit-core.ts:98-99,115-132`; `rate-limit.ts:139-153` | All auth/API/webhook limiters process-local `Map`s; Redis only for `ask_ai`. | Redis-backed for `login|register|forgot|reset|oauth|sso|invite|api`. | 🔴 |
| SEC-A07 | P1 | `auth/[[...path]]:192-195,227-263` | Lockout checked **after** `signIn` → locked+wrong → 401, locked+right → 423 → password oracle. | Check lock first. | 🔴 |
| SEC-A08 | P1 | `totp.ts:25-35`; `auth/mfa/route.ts:66-86`; `097:85` | TOTP: no replay guard, secret plaintext in `users.totp_secret`, no recovery codes, no org enforcement. | Last-used counter; encrypt; recovery codes; `orgs.require_mfa`. | 🔴 |
| SEC-A09 | P1 | `auth/reset-password:33-41` | No epoch bump, no MFA, no `password.reset` audit. | Bump + audit. | 🔴 |
| SEC-A10 | P1 | `auth/[[...path]]:283-338`; email verification not found | Full session at register with no verification; password policy `length>=8`; scrypt N 16384. | Verify; strength check; N≥2^17. | 🔴 |
| SEC-A11 | P2 | `session-cookie.ts:36-42`; no CSRF token | `SameSite=lax` only; no Origin check; logout is GET. | Origin check; POST logout. | 🔴 |
| SEC-A12 | P2 | `session-cookie.ts:46,55` | HMAC key falls back to `SUPERTOKENS_API_KEY` then `'darex-dev-session-secret'`. | Dedicated secret; refuse short. | 🔴 |
| SEC-A13 | P2 | `auth/invite/[token]:15-40` | Unauthenticated GET reveals invitee email/role/org. | Org name only. | 🔴 |
| SEC-A14 | P2 | `app/(platform)/layout.tsx:7-13` | `/admin` page renders for any session (API 403s protect data). | Server-side gate. | 🔴 |

## 3. RBAC

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| SEC-R01 | **P0** | `lib/rbac.ts:51-65` used only at `api/agent/tools/route.ts:40` | **Auditor/billing pay-tool block enforced on one route.** Not in `ask-ai/*`, `agent/run|stream|crew`, or `tool-executor.ts`. Auditor can approve a plan executing `stripe_create_payment_link`. `019:5` claim unproved. | 🟢 (2026-09-29: `canApproveActions`, `canCallPayTools`, and `canApproveRefunds` enforced across all approval routes: `ask-ai/plan` PATCH blocks `auditor`/`billing` from plan approvals, blocks non-pay roles from financial plans, and blocks non-owners/non-admins from refund plans; `ask-ai/approve` and `agent/pending-actions` enforce matching pay/refund RBAC on resume. Verified in `ask-ai-plan-rbac.test.ts` and `rbac-billing.test.ts`.) |
| SEC-R02 | P1 | mutating routes with **no role check**: `integrations/route.ts` POST (connect/disconnect), `integrations/{whatsapp,razorpay,webhooks,test,nango-token,[provider]/ping}`, `ask-ai/{approve,plan PATCH,revise,conversations DELETE}`, `agent/{pending-actions,crew,run,stream}`, `conversations/[id]` PATCH + `messages` POST, `brain/reindex`, `listings/*`, `showings/*`, `inquiries/*`, `rent-reminders/*`, `insight` POST, `brief/[id]/triage`, `work-items/playbook`, `growth/opportunities/[id]/decision`, `stream/push-subscribe`, `employees/customer/open-loops` PATCH | `auditor` and `billing` can connect OAuth, send customer messages, approve plans, mutate CRM. | 🔴 |
| SEC-R03 | P1 | `settings/members/[id]/route.ts:42` | Member removal hard-deletes `users` — destroys memberships in **other** orgs. | 🔴 |
| SEC-R04 | P2 | `settings/members/[id]:106-110` | No ownership transfer. | 🔴 |
| SEC-R05 | P2 | `org/switch:79` | Blocks `suspended`, allows `soft_deleted`/`provisioning`. | 🔴 |
| SEC-R06 | P2 | `platform-admin.ts:126-131`; `platform/orgs/*` | `support` role reads every org's directory/billing/connectors with no scoping to consented orgs. Stale ref (2026-09-28): `platform-admin.ts:126-131` is now schema-missing-error handling, not role scoping — issue still confirmed live at `app/api/platform/orgs/route.ts` (org list query has no `support_access_enabled`/`platformRole` filter). Still 🔴. | 🔴 (2026-09-28: cited lines now schema-missing-error handling, not the role-scoping code, which moved to ~118-121; re-confirmed live: `app/api/platform/orgs/route.ts` has zero "support" role scoping — issue still real, just at a different location) |

## 4. Tenancy

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| SEC-T01 | P1 | `025:26-30` | `platform_send_counters` no RLS → cross-tenant DoS on send budget. | 🔴 |
| SEC-T02 | P1 | `015:119-122,308-311`; `022eg:146-148` | Global catalogs writable by any tenant. | 🔴 |
| SEC-T03 | P1 | `webhooks/outbound/route.ts:14-16,38-42` | Global `CHATWOOT_WEBHOOK_SECRET` + any `conversationId` → inject messages into every tenant (= CH-S01). 🟡 (2026-09-28: verified — route now requires the conversation's own org `meta.webhook_secret` (`route.ts:50-65`), so a global secret no longer reaches another tenant's conversation; `body.recipient`/`body.channel` overrides (`route.ts:87-90`) are still honored once the correct org secret is presented — the "no recipient override" half of the fix sketch is not done. Partial, matches `CH-S01`.) | 🟡 (2026-09-28: `outbound/route.ts:50-65` now requires the conversation's own org `meta.webhook_secret` — global-secret cross-tenant injection closed; `body.recipient`/`body.channel` overrides still work once the correct org secret is presented) |
| SEC-T04 | P1 | `wf/tools/shared.ts:17-30` | Worker pool: no production fail-fast on `DB_USER`; `darex` silently bypasses FORCE RLS; hardcoded fallback password. | 🔴 |
| SEC-T05 | P1 | `097:31-33` | Any tenant session creates unlimited orgs. | 🔴 |
| SEC-T06 | P2 | `oauth/callback:293-306` | PII into `channel_logs.payload`. | 🔴 |
| SEC-T07 | P2 | `org/switch:83-90` | UPDATE users likely `42501` under FORCE RLS (unverified live). Use `auth_attach_user_to_org`. | 🔴 |
| SEC-T08 | P2 | `rate-limit-core.ts:236-249`; `middleware.ts:62-67` | Edge quota keyed on unsigned, attacker-writable `darex_org_id` cookie. | 🔴 |
| SEC-T09 | P2 | `langfuse-trace.ts:146-170` | Full prompts/tool results to Langfuse, no PII scrub. | 🔴 |
| ✅ | — | body `org_id` rejected everywhere checked; `108` neutralises single-org resolvers; Redis topics `org:<id>` cross-checked; Cognee dataset from ctx; Temporal ids embed orgId; pool RESETs GUCs; PgBouncer `POOL_MODE: session`. | |

## 5. Compliance

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| SEC-C01 | **P0** | `wf/dsr/tables.ts:7-53`; `run-export.ts:85-181`; `run-delete.ts:49` | DSR delete omits ~40 PII tables: `users`, `org_invites`, `channels` (tokens), `ai_employees`, `org_connectors`, `sync_cursors`, `entities`, `entity_identifiers`, `re_*`, `pm_*`, `lead_intent_signals`, `growth_scout_leads`, `growth_meeting_dossiers`, `visitor_company_intent`, `org_notification_log`, `agent_sentiment_history`, `ambiguous_duplicate_reviews`, `memory_revisions`, `insight_action_runs`, `ask_ai_feedback`, `org_sql_connections`, `widget_embed_tokens`, `chatwoot_inbox_map`, `web_push_subscriptions`, `gcal_calendar_watches`, `billing_*`, `dsr_requests`, `orgs`. No Cognee / Nango / Langfuse / SuperTokens / MinIO cleanup. Export covers 17 tables; result says `includeVectors:true` while touching no vector store. | 🟡 2026-10-05: every org_id table is now deleted (61) or retained with a reason (28); `tables.test.ts` fails on an unclassified table. Open: retention policy for account/config/billing (product/legal), export coverage, Nango/Langfuse/SuperTokens/MinIO cleanup |
| SEC-C02 | P1 | `tests/e2e-tenant-isolation.test.js:38-49` | CI test runs `GRANT S/I/U/D ON ALL TABLES TO darex_app` as superuser — undoes `106` append-only, writes on `packs`/`connector_defs`/`platform_admins`/`admin_audit_log`. Masks grant regressions. | 🔴 |
| SEC-C03 | P1 | 73 mutating routes emit no audit; kinds exist in `106:13-41` never emitted: `connector.connect`, `plan.approve`, `plan.execute`, `logout`, `password.reset` | Coverage gap (24/148 route files touch audit). 🟡 (2026-09-28: verified — `connector.connect` (`integrations/route.ts:307,385,440`) and `plan.approve` (`ask-ai/plan/route.ts:112`) now have real `recordAuditEvent` call sites; `auth/[[...path]]/route.ts:212,328,386` emit `login`/`register` kinds but not `password.reset` itself (`reset-password/route.ts` still has no `recordAuditEvent` call); `logout` still has no route file and no emit found. 73-route count not re-measured — partial, not closed. | 🟡 (2026-09-28: `connector.connect` and `plan.approve` now emit real `recordAuditEvent` calls; `password.reset` and `logout` still emit nothing) |
| SEC-C04 | P1 | `next.config.js`, `middleware.ts` | **No CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy.** | 🔴 |
| SEC-C05 | P1 | `integrations/whatsapp:35-40`, `integrations/razorpay:6,20`, `users.totp_secret` | Plaintext secrets in `channels.meta`; only `org_sql_connections` encrypted. | 🔴 |
| SEC-C06 | P1 | not found | No retention/TTL for `audit_events`, `messages`, `channel_logs`, `failed_webhooks.raw_payload`, Langfuse. | 🔴 |
| SEC-C07 | P1 | `admin_audit_log` vs `audit_events` | Tenant cannot see platform actions on its own org; no owner notification on impersonation. | 🔴 |
| SEC-C08 | P2 | `auth/[[...path]]:284-286`; `115:21-38` | Terms consent for email signup only; OAuth/SSO never record; no terms version. | 🔴 |
| SEC-C09 | P2 | `restore-drill.sh:7,52-64` | Schema-only dry run; no data backup job in compose/terraform. | 🔴 |
| SEC-C10 | P2 | `ci.yml` | No `pnpm audit`/SBOM/Dependabot; no residency controls; incident hook = one webhook. 🟡 (2026-09-28: verified — `ci.yml`'s `test` job now runs `pnpm audit --audit-level=high` (line ~163); no Dependabot config, no SBOM step, no residency controls found. Partial only.) | 🟡 (2026-09-28: `ci.yml:163` now runs `pnpm audit --audit-level=high`; still no Dependabot/SBOM/residency controls) |
| SEC-C11 | P2 | `audit-logs/route.ts:95`; `platform-admin.ts:50-66` | Regex redaction on key names only; free text unredacted. | 🔴 |

## 6. Platform admin

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| SEC-P01 | **P0** | `119`, `120:36`, `121:57`; `platform-db.ts:253-300` | `darex_platform` has no grants on tenant tables → every `/api/platform/*` cross-org query fails `42501`. Console non-functional as shipped; docs say 🟢. ⛔ (2026-09-28: verified — no `123_platform_grants.sql` or equivalent exists; `darex_platform` still ungranted on tenant tables per migrations 119–121. This is an infra/human blocker (needs the grant migration written + Postgres up + applied), not closeable by app code alone.) | ⛔ (2026-09-28: migrations 119-121 grant only 4 tables/2 functions; migrations 118-122 on disk but not applied to the live DB — infra/human blocker, not a code gap) |
| SEC-P02 | P1 | `platform/impersonation/route.ts:198-217`; `audit-events.ts:116-147` | Impersonation **replaces** the operator cookie with a full target session; all actions audited as `actor_user_id = target` with no impersonation marker; not read-only; no allow-list. | 🔴 |
| SEC-P03 | P1 | `impersonation:206-217`; `end/route.ts:39-58` | `darex_impersonation` cookie **unsigned**; `/end` trusts actor/role from it; `expires_at` enforced only for the banner query. | 🔴 |
| SEC-P04 | P1 | `end/route.ts:97-104` | Ending impersonation bumps target epoch → logs the **customer** out everywhere and (with A01) locks them out. | 🔴 |
| SEC-P05 | P1 | `platform/orgs/[orgId]/kill-switch/route.ts:74-95` | Write errors swallowed, returns `ok:true`; kill switch **fails open** if grants reject the UPSERT; `orgs.meta.kill_switch` written but readers use `org_runtime_controls`. | 🔴 |
| SEC-P06 | P2 | `org-purge.ts:61-69,423-491` | Purge: 7 memory tables only; no users/invites/channels/entities/re_*; Nango only if key set; no Cognee; fire-and-forget in request process. | 🔴 |
| SEC-P07 | P2 | `platform-admin.ts:80-103` | No MFA / IP allow-list / step-up for platform admins; bootstrap is manual SQL. | 🔴 |
| ✅ | — | `platform_begin` SECURITY INVOKER + `txid`; refuses superuser; consent gate `support_access_enabled`; operator-only break-glass; ≥12-char reason; banner mounted. | |

## 7. Infra / CI

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| SEC-I01 | P1 | `ci.yml:120-155` | **`pnpm test` never runs in CI**; no `pnpm audit`, secret scan, SBOM. 🟡 (2026-09-28: verified — the `test` job now runs `pnpm --filter @darex/workflows test` and `pnpm --filter @darex/dashboard test` (ci.yml:157-160), plus `pnpm audit --audit-level=high` (:162-163). Core claim (pnpm test not run) is fixed; no secret scan or SBOM step exists yet — partial.) | 🟡 |
| SEC-I02 | P1 | `docker-compose.yml:70,107,142,246,253,290,315-318,362,372,383-402,479` | Dev secrets as `${VAR:-default}` fallbacks (DB, Nango, Langfuse, NextAuth, SuperTokens). Missing prod env silently uses them. | 🔴 |
| SEC-I03 | P1 | `infra/db/migrate.js:20-34,63` | Migrations as superuser with dev-password default; no separate migrator role. Per-file txn + advisory lock ✅. | 🔴 |
| SEC-I04 | P1 | `wf/tools/shared.ts:17-21` | Worker no prod boot guard (= T04). | 🔴 |
| SEC-I05 | P2 | `docker-compose.yml:95-125` | PgBouncer session mode ✅; `ADMIN_USERS: darex_app` grants admin console to app role. Switching to transaction mode would silently break RLS. | 🔴 |
| SEC-I06 | P2 | `.husky/pre-push` | Only dashboard `tsc`; `CLAUDE.md §3` wrong. 🟢 (2026-09-28: verified — `.husky/pre-push` now runs `pnpm --filter @darex/workflows build`, `pnpm --filter @darex/workflows test`, then `pnpm --filter @darex/dashboard exec tsc --noEmit` — matches `CLAUDE.md §3`'s "typecheck, build, and tests" description; docs no longer wrong.) | 🟢 (2026-09-28: confirmed `.husky/pre-push` runs workflows build+test then dashboard `tsc --noEmit` — real git-hook enforcement, matches CLAUDE.md §3) |
| SEC-I07 | P2 | `115:7-15` | 15 s `statement_timeout` on `darex_app` will fail DSR delete loops on large tenants (`run-delete.ts:114-128`). | 🔴 |
| SEC-I08 | P2 | `terraform/main.tf:19-25` | No KMS/rotation evidence. | 🔴 |
| ✅ | — | `boot-guards.ts:20-61`; health probe pool never sets GUC; idempotent migrations (one duplicate number pair `022_*`). | |

## 8. Test coverage

| Area | Present | Gaps |
|---|---|---|
| Session cookie | `session-cookie-auth.test.ts:22-84` | login mints current epoch (A01), expiry, tamper |
| Org status gate | `org-session-status.test.ts` | — |
| Audit helper | `audit-events.test.ts` | per-route emit coverage |
| RBAC | `rbac-billing.test.ts` (matrix) | route-level auditor 403 on approve/connect |
| DSR | `dsr-confirm.test.ts`, `dsr/tables.test.ts` | completeness vs `information_schema` |
| Isolation | `e2e-tenant-isolation.test.js` | grants re-applied (C02); no `darex_platform` connection test (would catch P01); no negative test for the 4 boundary-less tables |
| Platform admin / impersonation / rate limit / lockout / TOTP / OAuth linking / SSO / headers / CSRF | **none** | |

## 9. Fix order for this domain

1. **SEC-P01** — migration `123_platform_grants.sql`: `GRANT USAGE ON SCHEMA public TO darex_platform; GRANT SELECT ON <tenant tables>; GRANT UPDATE(status, suspended_by, meta, …) ON orgs; …`; add a `darex_platform` connection to the isolation test.
2. **SEC-A01 / A02 / P04** — every cookie mint reads `session_epoch`; `requirePlatformAdmin` checks epoch; impersonation end does not bump the customer's epoch.
3. **SEC-R01** — pay-tool RBAC inside `tool-executor` and at every approve route.
4. **SEC-C01 + P06 + MEM-E01** — DSR/purge generated from `information_schema` (`org_id` tables) + Cognee + Nango + Langfuse + SuperTokens + MinIO; run as Temporal only.
5. **SEC-T01 / T02 / T05** — RLS on `platform_send_counters`; drop `write_all` on catalogs; restrict `orgs` INSERT to the SECURITY DEFINER path.
6. **SEC-C04** — security headers in `next.config.js`; `frame-ancestors` from widget origins.
7. **SEC-A06 / T08** — Redis-backed limiters; signed org hint.
8. **SEC-C02 / I01** — isolation test stops re-granting; CI runs `pnpm test` + `pnpm audit`.
9. **SEC-A05 / A08 / A10 / A04** — per-org SSO with group mapping + SCIM (ENT-01); org-enforced MFA with recovery codes; email verification; verified-only linking.
10. **SEC-P02 / P03** — signed impersonation cookie; actor marker in every audit row during impersonation; read-only default; mirror platform actions into org `audit_events` (C07).
11. **SEC-C05** — envelope encryption for `channels.meta` secrets and `totp_secret`. **SEC-C06** — retention engine (ENT-03). **SEC-C03** — one audit helper on all 73 unaudited mutating routes.

## 10. Resolution log

🟢 = verified against a live Postgres (all migrations applied, `tests/e2e-tenant-isolation.test.js`), 🟡 = typecheck + unit tests only, not proven against the full stack, ⛔ = blocked on a human.

| ID | Status | Fix |
|---|---|---|
| SEC-P01 | 🟢 | `200_platform_role_grants.sql`: schema USAGE + table/column grants for `darex_platform`; `OR platform_audit_ok()` arms moved out of TO PUBLIC tenant policies into `<table>_platform` policies TO darex_platform. The 119 arms made every darex_app read that touched another org's row fail with `permission denied for table admin_audit_log` (reproduced on PG17 with 001–122). Isolation suite now connects as `darex_platform`: 0 orgs without `platform_begin`, both orgs + messages + `orgs.status` UPDATE with it. |
| SEC-T01 | 🟢 | `201`: `platform_send_counters` FORCE RLS, no direct grants; writes only via SECURITY DEFINER `platform_send_counter_bump()` (`outbound-budget.ts`). Live: darex_app direct INSERT → 42501, bump works. |
| SEC-T02 | 🟢 | `201`: dropped `write_all` on `pack_entity_schemas` / `rera_cache` / `predicate_defs`, revoked I/U/D; RERA writes only via `rera_cache_put()` (official hosts, 64 KB cap, ≤30 d TTL). Live: all three writes → 42501. |
| SEC-T05 | 🟢 | `201`: dropped `orgs_tenant_insert`, revoked INSERT; `createOrgForEmail` calls `auth_create_org()` which pins `plan=free`, `status=provisioning`. Live: darex_app INSERT → 42501. |
| SEC-C02 | 🟢 | Isolation suite no longer re-grants table privileges; orgs/users seeded as superuser; 12 negative probes (orgs INSERT, send counters, 3 catalogs, packs, connector_defs, platform_admins, admin_audit_log read, audit_events UPDATE/DELETE, org_plan_overrides) + `darex_platform` connection checks. Passes on PG17 with all migrations. **CI needs** `DAREX_PLATFORM_DB_PASSWORD` + `ALTER ROLE darex_platform PASSWORD` after migrate (the suite fails in CI without it by design). |
| SEC-A01 | 🟡 | Every login / OAuth / SSO / invite / org-create path mints via `issueSessionCookies()` (`lib/session-epoch.ts`), which reads `users.session_epoch`; `applySessionCookies` now *requires* `sessionEpoch`. Tests: mint-at-current-epoch, login-after-revoke works, source scan fails if any route calls `applySessionCookies` without an epoch. |
| SEC-A02 | 🟡 | `requirePlatformAdmin`, `/api/auth/session` and invite accept use `verifySessionCookie()` (epoch compared to DB). Middleware stays presence-only (Edge, no DB) — every data path behind it re-checks via `getScopedClient`/`verifySessionCookie`. |
| SEC-A03 | 🟡 | Cookie is `userId.epoch.exp.sig`; `exp` signed and enforced server-side; legacy 2- and 3-part cookies refused (one-time sign-out on deploy). |
| SEC-A12 | 🟡 | Production requires dedicated `DAREX_SESSION_SECRET` ≥ 32 chars; `SUPERTOKENS_API_KEY` no longer a fallback. **Deploy prerequisite.** |
