# 01 · Executive summary — where Darex is, and what "enterprise-complete" costs

> ### 📊 Master Audit Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 20 | 3.3% |
> | 🟡 **Pending / In Progress** | 42 | 7.0% |
> | 🔴 **Not Done (Open)** | 538 | 89.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 0.2% |
> | **Total Findings** | **601** | **100.0%** |

Audit of `feat/close-109-plan-gaps` at `334c6e9`, 2026-09-27, read-only. Evidence lives in files 02–11 (every claim has a `file:line`); the ordered plan is `12-build-plan-waves.md`; every finding is one row in `13-master-tracker.md` (**504 findings, 61 P0**).

## One paragraph

Darex is a real product, not a demo: 99 tenant tables behind Postgres RLS with FORCE and a session-scoped GUC, a TrueForge agent loop behind an MCP bridge, ~70 tool modules that mostly report `notConnected` honestly, 36 Temporal workflows, ten roster employees with personas, allowlists and hand-off rules, an Ask AI chat with Auto / Pick one / Team modes and plan-confirm-execute, Stripe + Razorpay checkout/portal/webhooks/dunning, SuperTokens auth with SSO/MFA routes, a graph + vector memory, and a platform control plane (migrations 115–122, on disk). What it is **not** yet is *safe to sell to a company*. The audit found the same pattern in every domain: the guard exists as code but is not on the path. The kill switch is read by one send helper; the confirm gate is skipped whenever a caller omits `employeeRole` (plan steps, direct tool calls, six periodic activities); `employee-gate`, `employee-metrics`, `recordModelSpend`, the decision-expiry sweep and the SLA sweep have zero callers; pay-tool RBAC is on one route; usage meters refresh only when someone opens `/billing`. On top of that sit a handful of outright holes — model-written code runs on the worker host when the sandbox is down, `database_query` accepts CTE writes and `set_config`, a global webhook secret lets anyone inject messages into any tenant, every login mints an epoch-0 cookie so one `revoke-sessions` locks a user out forever, and the platform-admin role has no grants so the `/admin` console cannot run a single cross-org query. CI has never run the 91 test files. Enterprise buyers reject vendors on exactly these axes, not on missing features.

## The ten things that block an enterprise sale today

| # | Blocker | Finding IDs | Closes in |
|---|---|---|---|
| 1 | **Untrusted code and SQL reach the host and the RLS boundary.** Sandbox fallback runs model code on the worker with `process.env`; sandbox container shares `darex-net` with Postgres/Nango/LiteLLM; `database_query` guard is `startsWith('select'|'with')` so `WITH d AS (DELETE …) SELECT` and `SELECT set_config('app.current_org_id', …)` pass; terminal/bash/python are core tools for every employee. | ASK-S01, RT-B01, RT-B02, RT-S01–S03, RT-S09 | Wave 1.3 |
| 2 | **The confirm / autonomy gate is bypassable by construction.** `module.confirm` is not enforced in `executeAutonomousToolAction`; plan steps and direct tool calls pass no `employeeRole` so `checkAutonomy` is skipped; model-supplied `employee_role` is honoured; no zod parse so a garbled payload charges a default ₹500/$50; six activities call raw `executeProvider`. | RT-B06, RT-B07, ASK-S02, RT-B11, RT-B12, EMP-S02 | Wave 1.4–1.5 |
| 3 | **Kill switch, rollout stage, and employee gate do not reach execution.** Kill switch only in `outbound-budget.ts`; stage 0 "shadow" executes live; gate/metrics modules imported only by tests. Suspended orgs keep sweeping until the worker restarts. | EMP-S01, EMP-S03, EMP-G01, OPS-S02, EMP-S11 | Wave 1.5 |
| 4 | **Tenancy and identity have concrete holes.** `darex_platform` has no GRANTs on tenant tables (admin console non-functional); all login paths mint epoch-0 cookies → permanent lockout after revoke; `requirePlatformAdmin` ignores epoch; `platform_send_counters` has no RLS; pack catalogs writable by any tenant; global `CHATWOOT_WEBHOOK_SECRET` lets a caller write into any org's conversation. | SEC-P01, SEC-A01, SEC-A02, SEC-T01, SEC-T02, CH-S01 | Wave 1.1, 1.2, 1.7 |
| 5 | **Money is not measured, so caps cannot trip.** LLM cost traced only from dashboard routes (webhook/crew/sweep turns bypass LiteLLM and Langfuse); `recordModelSpend` never called; meters refresh on page view; gate fails open; `orgs.plan` gates nothing so a free org gets nine employees and every tool. | BIZ-B01, BIZ-B02, RT-G01, OPS-B02, OPS-B03, BIZ-G01 | Wave 1.11, 3.5 |
| 6 | **Writes can double, and failures read as success.** Three re-execution paths with no per-turn idempotency; ~85 provider fetches without abort while the executor gives up at 15 s; Gmail/Drive 401/403 become `[]` + "executed"; `running` plan re-runs every step on SSE reconnect; calendar audit emails guests every day forever. | RT-B03, RT-B04, RT-B05, ASK-B01, EMP-B08 | Wave 1.8 |
| 7 | **Oversight is unaudited and fragmented.** Decision approve/reject/execute audit rows fail a CHECK constraint silently; `/api/agent/pending-actions` approves with no RBAC or audit; five approval surfaces with two executors; approval state process-local; 73 mutating routes emit no audit; pay-tool RBAC on one route. | OPS-B01, OPS-S01, ASK-E01, RT-G03, RT-G04, SEC-R01, SEC-C03 | Wave 1.6, 1.9 |
| 8 | **Memory leaks PII and forgets nothing.** Raw transcripts and facts go to Cognee whose LLM is external OpenRouter with no redaction; every inbound customer message becomes org-wide memory with no policy gate; parent file never becomes `ready`; disabling a file does not hide its chunks; DSR delete omits ~40 PII tables plus Cognee/Nango/Langfuse/SuperTokens. | MEM-S01, MEM-S02, MEM-B01–B03, SEC-C01, MEM-E01 | Wave 1.10, 3.3 |
| 9 | **Nothing is proven.** `pnpm test` is not in CI or pre-push; 21 workflow test files are excluded from the test script; the isolation test re-grants blanket privileges that mask regressions; `chat-coverage.md` does not exist; no OTel/Sentry/Prometheus; readiness omits Nango/Langfuse/SuperTokens/worker; docs mark 🟢 on rows the code contradicts. | SEC-I01, SEC-C02, ASK-G01, ENT-06, ENT-08, OPS-G02, OPS-E08, RT-E02 | Wave 0, 2.1, 2.6 |
| 10 | **Identity, data lifecycle, and procurement are SMB-grade.** One global SSO client that JIT-creates owner orgs; no SCIM; TOTP replayable with plaintext secret; in-memory rate limits per replica; no CSP/HSTS; plaintext Meta/Razorpay/BYOK tokens; no retention engine; no DPA/sub-processor list. | SEC-A05, ENT-01, SEC-A08, SEC-A06, SEC-C04, SEC-C05, BIZ-S01, ENT-03, ENT-04 | Wave 3 |

## What "enterprise-complete" means for this repo (definition of done)

1. **Every tool call passes one gate, in one place.** `executeAutonomousToolAction` validates the payload against the tool schema, resolves the employee from the caller (never the model), applies allowlist (exact match, deny on empty), kill switch, rollout stage, employee gate, confirm class, pay RBAC, per-employee budget, then `checkAutonomy` — for chat, plans, direct calls, webhooks, crews and every periodic activity. No path calls `executeProvider` directly.
2. **Untrusted code and SQL cannot touch the host or the tenant boundary.** Sandbox with no network, read-only FS, dropped capabilities, per-org concurrency, no host fallback; `database_query` runs read-only in a transaction under a read-only role.
3. **Every write is idempotent and every failure is a failure.** Per-turn idempotency across model failover, HTTP fallthrough and Temporal retry; provider `Idempotency-Key` on every write tool; abort signals through every fetch; non-2xx never becomes an empty success.
4. **Every risky action is approved, audited and explainable.** One approval table and one executor behind all five surfaces; per-step approval with argument preview; audit kinds that pass the CHECK; an audit row from every mutating route; owner approval from WhatsApp/push.
5. **Tenancy holds for every role.** `darex_platform` grants that make the console work; RLS on all 99 tables with no `write_all`; epoch on every cookie mint and every admin check; per-org webhook and Slack secrets; isolation test that does not re-grant.
6. **Cost is measured at the model boundary and caps fail closed.** Spend recorded for every LLM and embed call on every path; cron-refreshed meters; `plan_limits` enforced at provision, invite, executor and crew start; credits ledger that matches the pricing doc.
7. **Memory is redacted, scoped, traceable and deletable.** Redaction before storage and before Cognee; write-back policy on inbound; citations with row identity; scheduled sync; DSR/purge generated from `information_schema` plus every external store.
8. **Identity an IdP admin accepts.** Per-org SSO with group→role and domain claim, SCIM, org-enforced MFA with recovery codes, email verification, Redis rate limits, CSRF, security headers, envelope encryption for every stored secret, retention engine with legal hold.
9. **Proven, not asserted.** `pnpm test` + `pnpm audit` in CI and pre-push; chat-coverage matrix (109 tools × tab actions) with a live proof per row and a CI check on new tools; agent eval set (routing, tool, confirm class, fair housing, retrieval recall) as a gate; OTel + exception tracking with a request id from HTTP → Temporal → tool; readiness for every dependency.
10. **Ten employees that do their whole job from chat, and a stranger reaches value in one sitting.** Canonical persona enum, delegation protocol, per-employee KPIs/budgets/versioning, custom-employee builder; channels at parity with a unified inbox; onboarding with a guided OAuth step and a measured first reply.

## Build order (detail and packet-level DoD in `12-build-plan-waves.md`)

- **Wave 0 — Make the truth visible (~1 week).** Tests in CI and pre-push; isolation test stops re-granting; migrations 115–122 applied; honest readiness; request id everywhere; reopen every overclaiming doc row; remove committed scratch.
- **Wave 1 — Close the P0 safety holes (~3 weeks, 5 agents in parallel).** Platform grants; epoch on every cookie; sandbox and `database_query` lock-down; one confirm gate in the executor; kill switch/stage/gate on every path; pay and mutating-route RBAC; webhook/channel P0s; idempotent execution; approvals and audit converge; memory P0s; cost accounting; frontend error boundaries and mobile nav. Exit: every P0 row 🟢 or human-blocked; security review clean.
- **Wave 2 — The product does what the docs say (4–6 weeks).** Chat-coverage matrix; per-step approvals and plan lifecycle; employee routing/personas/delegation; per-employee metrics and budgets; channel parity and inbox; eval gate in CI; memory ingest breadth, freshness and provenance; navigation and RBAC-aware UI.
- **Wave 3 — Enterprise identity, data lifecycle, commercial (4–6 weeks).** Per-org SSO + SCIM + org MFA; encryption at rest, headers, retention; complete DSR/purge; hardened impersonation; plan entitlements, subscription integrity, catalog, credits, invoicing; skills/packs/onboarding/multi-account connectors; owner channels and notifications.
- **Wave 4 — Scale, reliability, polish (ongoing).** OTel/Sentry/SLOs/status page; backup and DR drill; Temporal Schedules, heartbeats, replay tests; load and chaos; tool-invocation audit and injection fences; i18n/timezone/currency/dark mode/white-label; residency and per-org model policy; procurement docs; employee versioning and marketplace.

Rough size: Wave 0–1 ≈ 12–16 agent-weeks, Wave 2 ≈ 18–24, Wave 3 ≈ 16–22, Wave 4 ≈ 12–18 spread. Human-blocked items (OAuth client IDs, `NEXT_PUBLIC_NANGO_PUBLIC_KEY`, Meta token rotation, MLS licence, KMS/KEK, IdP test tenants, DPA counsel, SOC2 auditor, platform-admin bootstrap) are listed once in `00-index.md` and are marked ⛔ in the tracker, never faked.

## How to read the rest

| Want to… | Open |
|---|---|
| Fix one thing | `13-master-tracker.md` → find the ID → the domain file section → the packet in `12` |
| Plan a sprint | `12-build-plan-waves.md` (packets are one-agent-sized and list the IDs they close) |
| Answer a buyer's questionnaire | `11-enterprise-readiness-checklist.md` |
| Understand a domain end to end | `02`–`10` (headline → reality tables → Bugs / Security / Gaps / Enterprise → dead code → tests → fix order) |
| Make chat, employees, and tools one system | `17-one-turn-contract.md`, then `18-employee-jobs.md`, then `19-working-system-contracts.md` |
