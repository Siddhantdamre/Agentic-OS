# 11 · Enterprise readiness checklist (what a buyer's security/procurement team will ask)

> ### 📊 Completion Status
>
> **Checklist Questions (A1–F6):**
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 5 | 9.4% |
> | 🟡 **Pending / In Progress** | 35 | 66.0% |
> | 🔴 **Not Done (Open)** | 13 | 24.5% |
> | **Total Questions** | **53** | **100.0%** |
>
> **Tracked Enterprise Gaps (ENT-01–ENT-12):**
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 0 | 0.0% |
> | 🟡 **Pending / In Progress** | 1 | 8.3% |
> | 🔴 **Not Done (Open)** | 11 | 91.7% |
> | **Total Findings** | **12** | **100.0%** |

Date: 2026-09-27. Each row is a question an enterprise buyer, their CISO, or
their procurement desk will ask before signing. The **Code reality** column
is verified in source; the **Gap ID** column points to the finding in files
02–10 that closes it. 🟢 answerable "yes" today · 🟡 partially · 🔴 no.

This file is the bridge between "we have RLS" and "we can pass a vendor
security questionnaire". Rows that are 🔴 with no gap ID are new work
surfaced only by this checklist and are added to `13-master-tracker.md` as
`ENT-##`.

---

## A. Identity & access

| # | Question | Code reality (file:line) | Status | Gap ID |
|---|---|---|---|---|
| A1 | SSO (SAML / OIDC) for the workforce | Routes exist: `apps/dashboard/app/api/auth/sso/[provider]`, `sso/callback/[provider]`. No JIT group→role mapping, no IdP-initiated flow, no SSO-enforced (password disabled) mode | 🟡 | SEC-A (see 07) |
| A2 | SCIM user provisioning / deprovisioning | Not found anywhere in `apps/dashboard/app/api` | 🔴 | ENT-01 |
| A3 | MFA available and **enforceable per org** | `lib/totp.ts`, `api/auth/mfa/route.ts` exist; no org-level "require MFA" flag, no recovery codes, no WebAuthn | 🟡 | SEC-A (07) |
| A4 | Brute-force / credential-stuffing protection | `lib/rate-limit.ts` + `rate-limit-core.ts` in-memory (per replica); lockout not found; see 07 for what login/register actually enforce | 🟡 | SEC-A (07) |
| A5 | Session revocation on password change / admin action | Epoch in cookie (`session-cookie.ts` `userId.epoch.sig`) + `revoke-sessions` platform route exists; verify user-initiated revoke, device list | 🟡 | SEC-A (07) |
| A6 | RBAC with least privilege, documented role matrix | Roles `owner/admin/member/billing/auditor` (`lib/rbac.ts`); many routes unguarded (see 07 unguarded-mutating-route list) | 🟡 | SEC-R (07) |
| A7 | Separate platform-operator identity, audited | `darex_platform` role, `platform_admins`, `admin_audit_log`, `platform_begin` (`119_*.sql`, `lib/platform-db.ts`) — migrations not applied | 🟡 | SEC-P (07) |
| A8 | Support access requires customer consent, time-boxed, banner | `orgs.support_access_enabled`, `121_impersonation_sessions.sql`, `ImpersonationBanner.tsx` | 🟡 (not applied) | SEC-P (07) |
| A9 | Password policy, email verification, invite expiry | See 07 | 🟡 | SEC-A (07) |

## B. Data protection & tenancy

| # | Question | Code reality | Status | Gap ID |
|---|---|---|---|---|
| B1 | Tenant isolation enforced at the database | RLS + `FORCE` on core tables, `getScopedClient` sets `app.current_org_id` (`lib/db.ts`); full table matrix in 07 — some tables still without boundary | 🟡 | SEC-T (07) |
| B2 | Isolation proven by automated tests | `tests/e2e-tenant-isolation.test.js` runs in CI `isolation` job (`.github/workflows/ci.yml`) | 🟢 (extend coverage) | OPS (09) |
| B3 | Encryption at rest for tokens/secrets | Nango holds OAuth tokens; anything stored in Postgres (`meta.webhook_secret`, API keys, BYOK) — check 07/08 for plaintext | 🟡 | SEC-C (07) |
| B4 | Encryption in transit (TLS everywhere incl. internal) | Compose is plain HTTP between services; Terraform HTTPS module exists (`infra/terraform/modules`) | 🟡 | SEC-I (07) |
| B5 | Data residency (EU / IN pinning) | Not found | 🔴 | ENT-02 |
| B6 | Data retention policy, automated deletion | No retention job found (`rg retention` → only comments); `conversation_memory`, `messages`, `audit`, `failed_webhooks` grow forever | 🔴 | ENT-03 |
| B7 | Customer data deletion (GDPR Art.17) complete across all stores | `DsrDeleteWorkflow`, `lib/org-purge.ts` — SQL tables yes; Cognee / external vectors / Nango / Langfuse traces / logs **not** covered (BUILD_STATE 2026-09-27) | 🟡 | SEC-C, MEM-E (05/07) |
| B8 | Data export (GDPR Art.20) | `DsrExportWorkflow` exists; UI now shipped — `DsrPrivacyPanel.tsx` (Settings → Privacy & GDPR) queues export, lists history, downloads via `GET /api/dsr/:id/download` | 🟡 (2026-09-28: verified — "no UI" is stale, real export/download UI exists; still partial — migration `107_dsr_progress_artifact.sql` not applied to shared DB per BUILD_STATE, live UI not exercised) | SEC-C (07), UI (10) |
| B9 | PII redaction before LLM / vector / third party | `activities/redact.ts` exists; is it a closed gate on every embed and every model call? See 05 | 🟡 | MEM-S (05) |
| B10 | Sub-processor list (LiteLLM providers, Cognee, Langfuse, Nango, Resend, Meta, Twilio, Stripe, Razorpay) | Not documented in repo | 🔴 | ENT-04 |
| B11 | Customer-managed keys (BYOK for LLM) | BYOK mentioned in connectors (`future-scope STATUS`), verify in 08 | 🟡 | BIZ (08) |
| B12 | Backups + tested restore | `infra/scripts/restore-drill.sh/.md`, RDS module; no recorded drill, no compose-level backup job | 🟡 | OPS-E (09) |

## C. AI-specific governance (this is where AI vendors get rejected)

| # | Question | Code reality | Status | Gap ID |
|---|---|---|---|---|
| C1 | Human approval before risky actions, configurable per action class | `autonomy.ts` confirm classes, `PATCH /api/settings/autonomy` exists; `AutonomySettings.tsx` (`updateTier:92-134`, `resolvePending:136-155`) now calls it and the pending approve/reject actions for real, with error surfaced on failure | 🟢 (2026-09-28: verified — UI wires tier PATCH and pending approve/reject; dashboard tsc clean per BUILD_STATE 2026-09-27 "Autonomy settings tier save and pending approve/reject"; no live-stack test) | ASK/EMP/UI |
| C2 | Full action log: who (employee), what tool, which inputs, result, approver | `audit_events` exist; only 24 of 148 API route files reference audit emit (`rg -l ... apps/dashboard/app/api`). Tool-level audit from the worker: see 04 | 🟡 | SEC-C, RT-E |
| C3 | No fabricated data — provable | `notConnected` honesty pattern is a repo rule; per-tool verification table in 04 | 🟡 | RT (04) |
| C4 | Prompt-injection defence for tool outputs / inbound messages | `untrusted.ts`, `guardrails/**`, `critic-check.ts`; coverage of every path in 03/04 | 🟡 | RT-S, EMP-S |
| C5 | Model/provider allow-list, no training on customer data | LiteLLM config in `infra/litellm`; no per-org model policy, no DPA text | 🔴 | ENT-05 |
| C6 | Per-org spend limits and budgets for AI | `usage-gate.ts` + `org_plan_overrides` caps (not applied); no per-employee budget | 🟡 | BIZ-E (08) |
| C7 | Kill switch per org and per employee, honoured on every path | `org_runtime_controls`, `platform kill-switch route`; every path (chat/webhook/periodic/crew) — see 03 | 🟡 | EMP-S (03) |
| C8 | Evaluation harness / regression tests for agent behaviour | Unit tests for routing (`route-employee.test.ts`, `employee-capabilities.test.ts`); no golden eval set gated in CI | 🔴 | ENT-06 |
| C9 | Explainability: why this employee, why this action | `routing.reason` chips in Ask AI, `decision-explain.ts` | 🟡 | ASK-G |
| C10 | Content safety (fair housing, harassment, regulated advice) | Fair-housing critic on send (`activities/critic-check.ts`); scope limited to RE sends | 🟡 | EMP-S |

## D. Reliability & operations

| # | Question | Code reality | Status | Gap ID |
|---|---|---|---|---|
| D1 | Published SLA with uptime target | None | 🔴 | ENT-07 |
| D2 | Health/readiness endpoints covering all dependencies | `/api/health/ready/route.ts:351` now probes Postgres, Redis, Temporal, LiteLLM, Cognee, MCP bridge, Nango, Langfuse, SuperTokens, worker, runtime in one `Promise.all` | 🟢 (2026-09-28: verified — full dependency list checked, not just Postgres/Cognee/MCP; see 09 for depth of each probe) | OPS (09) |
| D3 | Error tracking, APM, structured logs with correlation ids | No Sentry / OpenTelemetry / prom-client anywhere (`rg` → 0 hits). Langfuse only for LLM traces (12 route dirs) | 🔴 | ENT-08 |
| D4 | Alerting + on-call runbooks | `lib/alert-dispatch.ts` → one webhook URL; no runbooks folder | 🟡 | OPS-E (09) |
| D5 | Horizontal scaling proven (2+ dashboard replicas, N workers) | Redis pub/sub on SSE hub; in-memory rate limits break across replicas; not load-tested | 🟡 | OPS-E, SEC-A |
| D6 | CI runs the unit test suite | **Yes now.** `ci.yml` `test` job has a "Unit tests" step running `pnpm --filter @darex/workflows test` and `pnpm --filter @darex/dashboard test` (`ci.yml:157-160`), after typecheck/lint/build. `.husky/pre-push` also now runs `@darex/workflows` tests in addition to dashboard `tsc --noEmit` | 🟢 (2026-09-28: verified — `ci.yml:157-160`) | OPS-B (09) |
| D7 | CI runs on the active branch | `ci.yml` `on.push.branches` now includes `feat/close-109-plan-gaps` (`ci.yml:5`) — push-triggered CI runs on the active branch, not only via PR | 🟢 (2026-09-28: verified — `ci.yml:5`) | OPS-B (09) |
| D8 | Migration safety (idempotent, reversible, tested) | `infra/db/migrate.js` runs in CI isolation job; migrations run as superuser; no down migrations | 🟡 | SEC-I (07) |
| D9 | Disaster recovery plan, RPO/RTO | Not documented | 🔴 | ENT-09 |
| D10 | Dependency on a release-candidate runtime | `@truefoundry/trueforge-core` pinned `0.2.0-rc.0` (`services/workflows/package.json:22`) — RC in the critical path | 🟡 | RT-E (04) |
| D11 | Status page / incident comms | None | 🔴 | ENT-10 |

## E. Commercial & legal

| # | Question | Code reality | Status | Gap ID |
|---|---|---|---|---|
| E1 | Terms acceptance recorded | `users.terms_accepted_at` via `auth_set_terms_accepted` (`115_*.sql`) — not applied | 🟡 | BIZ |
| E2 | DPA, privacy policy, sub-processor page | Not in repo | 🔴 | ENT-04 |
| E3 | Invoicing / PO / annual billing / seat pooling | Stripe/Razorpay monthly; see 08 | 🟡 | BIZ-E (08) |
| E4 | Usage alerts & spend caps visible to customer | Meters exist; alerts to customer not found | 🟡 | BIZ-E (08) |
| E5 | White-label / custom domain | DNS human-blocked; no code for per-org domain routing | 🔴 | SEC-P/BIZ-E |
| E6 | Audit export for the customer (CSV / SIEM) | `GET /api/audit-logs` JSON only; no export, no webhook/SIEM push | 🟡 | SEC-C |

## F. Product completeness (what the demo must survive)

| # | Question | Code reality | Status | Gap ID |
|---|---|---|---|---|
| F1 | "Anything on any tab is doable from chat" — proven matrix | `gap26sept/chat-coverage.md` referenced by `AGENTS.md` **does not exist** (`ls` → no such file). Coverage is asserted per-employee in `employees/*.md` only | 🔴 | ASK-G (02) |
| F2 | Every roster employee does its whole job from chat | Per-role specs 🟡; Auto router keyword-based; see 03 | 🟡 | EMP (03) |
| F3 | Two-way parity on advertised channels | Gmail / Instagram / SMS outbound gaps (gap26sept webhooks.md); see 06 | 🟡 | CH-G (06) |
| F4 | Stranger → connected channel → first memory-grounded reply in one sitting | Not proven (future-scope STATUS test #1/#2) | 🟡 | BIZ-G (08) |
| F5 | Owner can approve from WhatsApp/mobile | `api/webhooks/owner-whatsapp/route.ts` parses `approve plan <id>` (`:81-140`), verifies Meta signature, updates `agent_plans`, signals the Temporal workflow, records an audit event | 🟡 (2026-09-28: verified — real, signature-checked path exists for plan approval; no `reject`/`pause` command beyond `pause_employee`, not exercised against a live WhatsApp number) | ENT-11 |
| F6 | Localisation (India + US buyers): timezone, currency, language | No i18n lib (`rg next-intl|i18next` → 0); currency/timezone handling per 10 | 🔴 | ENT-12 |

---

## New enterprise-only findings surfaced here (added to 13)

| ID | Item | Severity | Notes | Status |
|---|---|---|---|---|
| ENT-01 | SCIM 2.0 provisioning endpoint set (`/scim/v2/Users`, `/Groups`) with bearer token per org | P1 | Needed by any IdP-driven customer | 🔴 |
| ENT-02 | Data residency: region tag per org, region-pinned Postgres/Cognee/vector, LiteLLM provider allow-list per region | P2 | Design first; do not ship half | 🔴 |
| ENT-03 | Retention engine: per-table policy, per-org override, Temporal sweep, legal hold flag | P1 | Also fixes unbounded table growth | 🔴 |
| ENT-04 | Sub-processor list + DPA + privacy docs as versioned repo docs served at `/legal/*` | P1 | Pure docs + one page | 🔴 |
| ENT-05 | Per-org model policy (allowed providers/models, no-training flag), surfaced in LiteLLM routing | P1 | LiteLLM supports per-key model allow-lists | 🔴 |
| ENT-06 | Agent eval harness in CI: golden prompts → expected employee, expected tool, expected confirm class; fair-housing set | P0 for trust | Ties to C8 and the "eval datasets" gap in 04 | 🔴 |
| ENT-07 | SLA doc + SLO definitions + error budget in observability page | P2 | After D3 | 🔴 |
| ENT-08 | OpenTelemetry (traces + metrics + logs) with correlation id from HTTP → Temporal → tool; Sentry or equivalent for exceptions | P0 | Nothing exists today | 🔴 |
| ENT-09 | DR runbook, RPO/RTO, recorded restore drill | P1 | Script exists; drill never recorded | 🔴 |
| ENT-10 | Status page + incident comms template | P2 | | 🔴 |
| ENT-11 | Owner approval channel on WhatsApp / push (approve/reject a decision by replying) | P1 | 2026-09-28: `owner-whatsapp` webhook now has a real `approve plan <id>` path (see F5 above); no reject-by-reply command yet, not proven live | 🟡 (2026-09-28: `webhooks/owner-whatsapp/route.ts:81-140` has a real, signature-verified `approve plan <id>` path wired to `agent_plans` + Temporal signal + audit event; no reject-by-reply command yet, not proven live) |
| ENT-12 | i18n + per-user timezone/currency/locale preferences | P1 | India + US at minimum | 🔴 |
