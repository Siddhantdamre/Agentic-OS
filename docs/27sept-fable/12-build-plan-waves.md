# 12 · Build plan — waves, dependencies, work packets

> ### 📊 Master Audit Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 20 | 3.3% |
> | 🟡 **Pending / In Progress** | 42 | 7.0% |
> | 🔴 **Not Done (Open)** | 538 | 89.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 0.2% |
> | **Total Findings** | **601** | **100.0%** |

This is the order in which files 02–11 get closed. Each wave has a definition of done that is checkable in code or in the browser, and each packet lists the finding IDs it closes so `13-master-tracker.md` can be flipped row-by-row. Packets inside a wave are independent unless a dependency is named; they are sized for one agent (or one engineer) each and can run in parallel.

Rules that apply to every packet:

- No `🟢` in any tracker until typecheck, the relevant test, **and** a live browser/API check pass. Docs that overclaim today (`agent-runtime.md`, `health.md`, `decisions.md`, `billing.md`, `integrations-connectors.md`, `packs.md`, `skills.md`, `memory.md`, `3-employee.md`) get their rows reopened in Wave 0 and only re-closed by the packet that fixes them.
- Migrations 115–122 must be applied and verified before any packet that depends on them is marked done; new migrations start at `123`.
- Schema changes that touch approval tables or the ledger follow the standing rule in `AGENTS.md §4a` ("one canonical approval table: schema change, ask first").
- Human-only blockers (OAuth client IDs, Nango public key, MLS licence, Meta token rotation, SOC2 auditor, DPA counsel) stay 🔴 with a reason.

---

## Wave 0 — make the truth visible (1 week, no product change)

Goal: stop lying to ourselves. Nothing here changes user-facing behaviour; it changes what CI, health, and docs *say*.

| Packet | Closes | Definition of done |
|---|---|---|
| **0.1 CI runs the tests** — `pnpm test` in `ci.yml` incl. the 21 workflow test files currently excluded from `package.json`; `pnpm audit --audit-level=high`; push triggers include the active branch; `.husky/pre-push` matches `CLAUDE.md §3` | SEC-I01, SEC-I06, OPS-E08 (pre-push row), ASK-E09 (harness only) | A deliberately failing test blocks the PR; `git log` shows a red run |
| **0.2 Isolation test stops re-granting** — remove the blanket `GRANT` in `e2e-tenant-isolation.test.js`; add a `darex_platform` connection and a negative test for `platform_send_counters`, `pack_entity_schemas`, `rera_cache`, `predicate_defs` | SEC-C02, exposes SEC-P01/T01/T02 as red | Test is red until Wave 1.1 lands |
| **0.3 Apply 115–122 in dev + CI** — bring Postgres up, run `pnpm db:migrate`, fix any failure, record in `BUILD_STATE.md` | prerequisite for everything in `saas-conversion/*` | `SELECT * FROM schema_migrations` lists 122 |
| **0.4 Readiness tells the truth** — `/api/health/ready` includes Nango, Langfuse, SuperTokens, Temporal worker heartbeat; worker healthcheck is a real probe; cost-health reads `org_model_spend` and reports "no data" not "healthy" | OPS-G02, RT-G10, OPS-B02 (report side) | `docker stop worker` → ready = 503 within 60 s |
| **0.5 Reopen overclaiming doc rows** — flip every 🟢 named in files 02–11 back to 🟡/🔴 with the finding ID as reason | RT-E02, OPS-E08, MEM-G12, UI-E12, BIZ (docs vs code table), EMP-G02 doc row | Every reopened row names a finding ID |
| **0.6 Structured logs + request id** — `x-request-id` minted in `middleware.ts`, propagated to Temporal `searchAttributes` and tool executor, printed in every log line and returned in every error body | OPS-E07, ASK-E03, UI-E07 | A failing chat turn can be found in worker logs by the id shown in the UI |
| **0.7 Remove committed scratch** — `usage-gate.ts.aside`; keep `ONBOARDING.md` out of git (contains AI-assistant instructions, `CLAUDE.md §1`) | BIZ dead-code rows | `git status` clean of both |

## Wave 1 — close the P0 safety holes (2–3 weeks)

Goal: no path lets an untrusted input run code on the host, write another tenant's rows, spend money unconfirmed, or silently double-execute. Everything here has an existing backend; it is wiring and hardening, not new product.

Packets 1.4, 1.5, 1.8, and 1.9 implement `17-one-turn-contract.md` (one gate, in that order). Packet 1.10 implements memory in `19`. Do not invent a second gate beside that contract.

### 1.1 Tenancy and platform grants (migration `123`, `124`)
Closes **SEC-P01**, SEC-T01, SEC-T02, SEC-T05, SEC-T07, SEC-P05 (fail-open), CH-S07 (DLQ org_id), BIZ-B19 (meter index).
DoD: `/admin` lists orgs with a `darex_platform` connection; isolation test green; kill switch UPSERT error returns 500 and is audited.

### 1.2 Session epoch everywhere
Closes **SEC-A01**, **SEC-A02**, SEC-P04, SEC-A03 (add `exp`), SEC-A09, SEC-A07.
DoD: login → revoke-sessions → login again succeeds; revoked platform-admin cookie gets 401 on `/api/platform/orgs`; impersonation end does not log the customer out.

### 1.3 Sandbox and database tool lock-down
Closes **ASK-S01**, **RT-B01**, **RT-B02**, **RT-S01**, **RT-S02**, **RT-S03**, RT-S09, RT-S15.
Work: delete host fallback; `network_mode: none` + `read_only` + `cap_drop` + `pids_limit` on the sandbox container; per-org sandbox concurrency; `database_query` runs `BEGIN READ ONLY; SET LOCAL statement_timeout` and denies `set_config|pg_|delete|update|insert` after literal stripping — or a `darex_readonly` role; `code_execution|terminal|python|file_ops` removed from `ALWAYS_ALLOWED_CORE_TOOLS`, opt-in per employee and plan.
DoD: `WITH d AS (DELETE …) SELECT` rejected; sandbox down → tool returns error, nothing runs on host; `SELECT set_config(...)` rejected.

### 1.4 One confirm gate, enforced in the executor
Closes **RT-B07**, **ASK-S02**, **RT-B06**, RT-B11, RT-B12, RT-S08, ASK-S05, ASK-G05, EMP-S07, EMP-S08, RT-S18, RT-B22.
Work: `executeAutonomousToolAction` parses `payload` with `def.schema.safeParse`, enforces `module.confirm(action)` and confirm classes (`send/pay/sign/publish/delete`) regardless of caller, requires `employeeRole` from the header/plan step (never from model args), exact-match allowlist, returns approval id (not token). Plan steps execute as the assigned `employeeId` (ASK-G03) with that employee's allowlist. Remove monetary and `#general` defaults.
DoD: `POST /api/agent/tools` with `stripe_create_payment_link` and no approval → `pending_approval`; a plan step with a garbled payload fails validation instead of charging a default amount.

### 1.5 Kill switch, rollout stage, employee gate reach every path
Closes **EMP-S01**, **EMP-S02**, **EMP-S03**, **EMP-G01**, OPS-S02, EMP-S11, OPS-G07, EMP-S04 (critic on all outbound), EMP-S06 (quiet hours on all outbound), EMP-S05.
Work: `tool-executor` checks `org_runtime_controls.kill_switch` and `autonomy_stage` before `checkAutonomy`; `evaluateEmployeeGate` in the same place; the six activities calling raw `executeProvider` (`meeting-prep`, `growth ×3`, `rep-followup-sla`, `workload-balancer`, `customer`, `enrichment`) go through `guardedSend`/executor; `guardedSend` calls the critic and enforces per-customer daily cap; periodic registry re-reads org status per tick.
DoD: kill switch on → chat tool call, webhook reply, MeetingPrep email, crew step all return `blocked:kill_switch`; stage 0 org executes nothing live (shadow ledger only).

### 1.6 Pay RBAC and mutating-route RBAC
Closes **SEC-R01**, ASK-S04, SEC-R02, BIZ-S02, BIZ-S03, BIZ-S04, CH-S05, BIZ-S05, BIZ-S07, SEC-R03, BIZ-S06.
Work: `canCallPayTools` in the executor and every approve route; `canManageOrgSettings` on connector connect/disconnect/BYOK/test/ping/`update_config`; conversations mutations and channel create require `member+`; members DELETE removes the membership row, not the user, and bumps epoch.
DoD: `auditor` gets 403 on plan approve containing a pay tool, on `/api/integrations` POST, on `/api/conversations/[id]/messages` POST.

### 1.7 Webhook and channel P0s
Closes **CH-S01**, CH-S02, CH-S03/CH-B05, CH-B13, CH-B12, CH-B11, CH-S08, CH-B15.
Work: `/api/webhooks/outbound` keyed by per-org secret resolved from the conversation's org; Slack interaction resolves org from `team_id` ↔ `org_connectors`, not the button; widget session keyed by server-issued visitor token; unique partial index on open conversation per (org, channel, contact); human reply row written after send with `failed` status path; Redis-backed webhook limiter; Stripe tolerance + dedupe on rent-payment.
DoD: forged outbound POST with another org's conversation id → 403; two concurrent WhatsApp deliveries → one conversation.

### 1.8 Idempotent execution
Closes **RT-B03**, **RT-B04**, **RT-B05**, **ASK-B01**, RT-B10, CH-B21, EMP-B08.
Work: per-turn "tools executed" flag stops model failover; `claimIdempotent` on (conversationId, inboundEventId); `AbortSignal` through `ToolActionContext` with module timeout ≤ executor timeout; every write tool sends `Idempotency-Key` derived from `sideEffectKey`; Gmail/Drive non-2xx → `apiError` never `[]`; `execute/route.ts` `running` branch only attaches to the stream; `auditCalendarDeadlocksActivity` keyed by (event, guest, day).
DoD: kill the worker mid-turn and restart → no duplicate email; expired Gmail token → tool says `revoked`, not "0 emails".

### 1.9 Approvals and audit converge
Closes **OPS-B01**, **OPS-S01**, **ASK-E01**, RT-G03, RT-G04, OPS-B07, OPS-S06, OPS-G01, SEC-C03 (helper), EMP-E10, MEM-S07, CH-E07.
Work: one approval executor used by `/api/decisions`, `/api/agent/pending-actions`, `work-items/[id]/decision`, `ask-ai/approve`; approval state in `agent_pending_actions` not process memory; audit kinds extended in migration so decision approve/reject/execute pass the CHECK; expiry + SLA sweeps registered in `periodic-registry`; a single `recordAuditEvent` call in every mutating route (73 today with none).
DoD: approve a high-risk decision → one `audit_events` row with actor, kind, target; worker restart mid-approval → approval survives.

### 1.10 Memory P0s
Closes **MEM-B01**, **MEM-B02**, **MEM-B03**, **MEM-S01**, **MEM-S02**, MEM-B04, MEM-B08, MEM-B10, MEM-B11, MEM-B13, MEM-S04, MEM-S05, MEM-S09.
Work: parent `knowledge_sources` row → `ready` when all chunks done; disable check by `source_ref LIKE path || '#%'`; pendingText moved to a per-job table; `redactForEmbed` applied before Cognee and before storing bodies; W1 write-back gated by `writeback-policy` with customer-tier scoping; Cognee dataset delete in DSR/purge; re-embed via Temporal job row; `memory_revisions`, `sync_cursors`, `knowledge_sources.metadata.*Text` in DSR delete.
DoD: upload a 3-chunk file → Brain shows `ready`; disable it → chat no longer cites it; a PAN in a WhatsApp message never reaches Cognee or `org_memory.body`.

### 1.11 Cost accounting works
Closes **BIZ-B01**, **BIZ-B02**, **RT-G01**, **OPS-B02**, **OPS-B03**, RT-B13, RT-B14, BIZ-B14, MEM-E06, EMP-B14.
Work: spend recorded at the LiteLLM boundary for every path (in-process turns emit Langfuse generations with `usage`; LiteLLM `callbacks: [langfuse]` with `user_id=orgId`); `recordModelSpend` called; embed jobs record spend; `refreshOrgMeters` is a Temporal cron per org; usage gate reads `org_model_spend` and fails closed for hard caps; `wf/tools/billing.ts` uses `orgs.plan`.
DoD: a WhatsApp reply increments `org_model_spend`; a free org past hard cap is blocked from webhook replies within one cron interval.

### 1.12 Frontend P0s
Closes **UI-B01**, **UI-B02**, UI-B06, UI-B07, UI-B08, UI-B09, UI-B10, UI-B14, UI-B15, UI-B16, UI-B17, UI-B18, UI-B13, UI-G10 (toast).
DoD: throw in a page → styled error boundary; mobile viewport reaches Settings and Billing; a 500 on `/listings` shows an error banner, not "No listings".

**Wave 1 exit:** every P0 row in `13-master-tracker.md` is 🟢 or 🔴-blocked-by-human; security review (`security-review` subagent, `Diff: branch changes`) clean.

## Wave 2 — the product actually does what the docs say (4–6 weeks)

Goal: chat covers every tool and tab action with the right employee; employees are gated, measured, and cannot fabricate; channels have parity.

### 2.1 Chat coverage matrix + search stack
Closes **ASK-G01**, ASK-G08, RT-E01, RT-B24, RT-G05, BIZ-G19, BIZ-G20, ASK-G09, ASK-G10, **WEB-G01**, **WEB-B01**, WEB-B11, WEB-B12, WEB-G04, WEB-E03.
Work: also adopt the SearchProvider + citation UI + W1–W13 proving prompts in `14` §12–§13. DDG HTML scrape retired in the same packet as WEB-G01.
Work: `gap26sept/chat-coverage.md` with one row per tool (109) and per tab action, each with a proving prompt and the live result; CI check that a new `ToolModule` adds a row; planner `VALID_TOOLS` generated from the catalog; playbook payload schemas; standard `{items,nextCursor,truncated}` envelope; nine orphan tool modules either get catalog + connect UI or are removed; remove the regex that synthesises founder/year claims.
DoD: every row 🟢 or 🔴-connector-blocked; no "catalog_only" tool reachable from the model.

### 2.2 Per-step approvals and plan lifecycle
Closes **ASK-G02**, ASK-B02, ASK-B05, ASK-B06, ASK-B11, ASK-B07, ASK-B08, ASK-B09, ASK-B03, ASK-B10, ASK-G07, UI-G02, UI-B03, UI-B04, UI-B05, ASK-B13..B17.
Work: PlanCard shows per-step risk/employee/argument preview and per-step approve; `PlanExecuteWorkflow` checks decision per stage and honours cancel; revise → back to `pending`; hydration newest-first with cursor; classification streamed after first byte; plan history with diff and re-run; one persistence shape for `tool_calls`.
DoD: cancel a running durable plan → next stage does not run; edit a step → re-approval required.

### 2.3 Employees: routing, personas, hand-offs, delegation
Closes **EMP-B01**, **EMP-B02**, EMP-B03, EMP-B04, EMP-B05, EMP-B06, EMP-B07, EMP-B09, EMP-B10, EMP-B11, EMP-B13, EMP-B16, EMP-B17, EMP-G07, EMP-G08, EMP-G10, ASK-G04, ASK-G06, ASK-G11, EMP-S09, EMP-S10, EMP-S12, RT-B26.
Work: canonical `persona` enum column on `ai_employees` (no substring inference); router uses persona + LLM tie-break with explicit destination table; `EMERGENCY_RE` only under a real-estate/PM pack; empty allowlist = deny not org-union; one `filterAllowlistForPersona`; hand-off is a delegation protocol (work item assigned to target employee, context carried, report back) with in-thread "continue as X"; channel→employee assignment config with sticky contact routing; one sweep registry; one `MAX_CREW_SPAWN`.
DoD: locked Executive + "brief me on today's meetings" runs calendar tools; "fire the drive campaign" does not hit dispatch; custom Legal employee gets a Legal persona.

### 2.4 Per-employee metrics, KPIs, budgets
Closes EMP-G03, EMP-E01, EMP-E02, EMP-E04, EMP-B12, OPS-G03, OPS-G06, BIZ-E07, EMP-E07 (reachability).
Work: `employee_id UUID` on ledger, metrics daily, spend; one automation-rate formula; per-employee scorecard on `/employees/[id]`; per-employee daily budget enforced in the executor; metrics rows written by cron not page view.
DoD: two employees in one org show different approval rates and spend.

### 2.5 Channels parity and inbox
Closes CH-B01, CH-B02, CH-B03, CH-B04, CH-B06, CH-B07..B10, CH-B14, CH-B16..B24, CH-S04, CH-S06 (with 3.2), CH-S09..S13, CH-G01, CH-G02, CH-G03, CH-G04, CH-G05, CH-G06, CH-G07, CH-G08, CH-G09, CH-G11, CH-G12, CH-E04, CH-E08, UI-G09, UI-B11, UI-B12, UI-G07.
Work: store `wamid` and make receipts work; one event schema shared by hub, routes and pages (typed union with exhaustive switch); HITL result via workflow signal → Redis, not in-process await; Gmail history cursor and self-reply loop fix; widget receives human replies over `/api/widget/stream`; WhatsApp 24 h window + templates + STOP; per-conversation sequence numbers; provider rate limits and jittered retry with `Retry-After`; inbox tags/snooze/canned/assign; one shared SSE hook.
DoD: WhatsApp message → delivered/read status visible; human reply visible in widget within 2 s; STOP → no further outbound.

### 2.6 Eval gate for employees
Closes **ENT-06**, MEM-G08, RT-E05 (gate before upgrade), EMP-S04 (coverage set).
Work: golden set (prompt → expected employee, tool, confirm class); fair-housing/legal-promise set; retrieval recall set; runs in CI on `services/workflows` changes and before any `trueforge-core` bump.
DoD: a routing regression fails CI.

### 2.7 Memory: ingest breadth, freshness, provenance
Closes MEM-G01, MEM-G02, MEM-G03, MEM-B05, MEM-B06, MEM-B07, MEM-B09, MEM-B12, MEM-B14..B20, MEM-S03, MEM-S06, MEM-S08, MEM-G04..G07, MEM-G09..G11, MEM-E05, MEM-E10.
Work: Gmail/Slack/Notion/Calendar ingest through the same `SyncWorkflow`; scheduled sync per connector with freshness SLA; citations carry `sourceRef`, revision, link; vector query as `ORDER BY <=> LIMIT` then filter; chunk all of long SOPs; Drive tombstones; per-employee memory actually written; supersedes chain; Cognee access control on with per-org key; provenance FK checks; per-org quotas; RLS vector test in `pnpm test`.
DoD: an answer's citation opens the exact chunk; a Slack thread is retrievable within the SLA.

### 2.8 Frontend information architecture
Closes **UI-G01**, UI-G03..G06, UI-G08, UI-G11..G20, UI-B19..B29, UI-E05, UI-E09.
DoD: labelled grouped nav + ⌘K; every mutating button hidden/disabled per role; jest-axe in CI.

**Wave 2 exit:** chat-coverage matrix complete; every employee spec in `gap26sept/employees/<role>.md` matches behaviour; eval gate green.

## Wave 3 — enterprise identity, data lifecycle, commercial (4–6 weeks)

### 3.1 Identity
Closes **SEC-A05**, **ENT-01**, SEC-A04, SEC-A06, SEC-A08, SEC-A10, SEC-A11..A14, SEC-R04..R06, SEC-T08, BIZ-E01, BIZ-S08, UI-G04, UI-E06.
Work: per-org SSO config (SAML/OIDC metadata, domain claim, group→role, JIT into bound org); SCIM 2.0 Users/Groups with per-org bearer; org-enforced MFA with recovery codes and replay guard; email verification; verified-only account linking; Redis-backed limiters; CSRF Origin check; ownership transfer; support-role scoping to consented orgs.
DoD: an Okta-provisioned user lands in the right org with the mapped role; deprovision revokes sessions.

### 3.2 Secrets, headers, retention
Closes **SEC-C04**, **UI-E01**, SEC-C05, BIZ-S01, RT-S04, CH-S06, BIZ-E15, SEC-C06, **ENT-03**, MEM-E03, ASK-E04, CH-E05, OPS-S03, SEC-C11, RT-S11, RT-S16, RT-S17, SEC-I02, SEC-I03, SEC-T04, SEC-I04, OPS-S04, OPS-S05, CH-E06, RT-S12.
Work: envelope encryption (per-org DEK, KMS/KEK) for `channels.meta`, `totp_secret`, BYOK, `nango_connection_id='manual_json'`; CSP/HSTS/XFO/Referrer-Policy with widget `frame-ancestors`; retention engine (per-table policy, per-org override, legal hold, Temporal sweep) for `audit_events`, `messages`, `channel_logs`, `failed_webhooks`, `memory`, Langfuse; PII scrub before Langfuse; prod fail-fast asserts non-default for every secret; per-service env; non-root containers; TrueForge sidecar auth.
DoD: Mozilla Observatory A; `channels.meta` has no plaintext token; audit rows older than policy are gone.

### 3.3 DSR and purge complete
Closes **SEC-C01**, SEC-P06, MEM-E01, SEC-C07, SEC-C08, UI-E08.
Work: delete/export table list generated from `information_schema` (every table with `org_id`) plus Cognee, Nango, Langfuse, SuperTokens, MinIO; runs only as Temporal with progress; export includes vectors or says it does not; platform actions mirrored into org `audit_events`; terms version recorded for every signup path; export on audit/conversations/work items.
DoD: DSR delete → `SELECT count(*)` over every `org_id` table for that subject = 0; Cognee dataset gone.

### 3.4 Platform admin hardened
Closes SEC-P02, SEC-P03, SEC-P07, UI-B22, UI-B27, BIZ-E08 (flags consumed).
Work: impersonation as a signed, time-boxed, read-only-by-default overlay on the operator session; every audit row during impersonation carries `impersonator_user_id`; platform admin MFA + IP allow-list; feature flags read by product code.
DoD: an impersonated action shows both actor and impersonator in the customer's audit log.

### 3.5 Billing: entitlements, integrity, catalog
Closes **BIZ-G01**, **BIZ-B03**, BIZ-B04..B08, BIZ-B15..B18, BIZ-B20, BIZ-G03..G07, BIZ-G02, BIZ-E03, BIZ-E04, BIZ-E06, BIZ-E13, ASK-E02, RT-G02.
Work: `plan_limits` table (employees, seats, tools, crews, memory, channels, credits) enforced at provision, invite, executor, crew start; seat quantity by price id; plan from price id; one live subscription; seats incl. invites with lock; dunning + soft-cap sweep with email; Scale tier, annual, INR/USD, trials; refunds/disputes; credits ledger (DWC) fed from `org_model_spend` + tool invocations; invoicing/PO; tax ids; usage alerts.
DoD: a free org cannot provision a 4th employee; buying 5 seats shows 5.

### 3.6 Packs, skills, onboarding, connectors
Closes BIZ-B09..B13, BIZ-B21..B27, BIZ-G08..G16, BIZ-S09..S11, EMP-G04, EMP-G09, EMP-E05, EMP-E06, UI-G15, UI-G16, RT-B17, RT-G08, CH-G10, CH-G13.
Work: skills honoured at runtime (`org_skills.enabled`, overlay); pack upgrade scoped to `pack_id`, version persisted, manifest from YAML with schema, workflows scheduled on install, uninstall cascades; onboarding with guided OAuth step, per-step persistence, demo data, "first reply" measured; multi-account per provider with `account_id`; scheduled ping + Nango webhook → demote + re-auth email; granted scopes persisted; custom employee builder; tool picker from catalog.
DoD: disable a skill → its tools vanish from that employee's calls; two Gmail accounts on one org.

### 3.7 Owner channels and notifications
Closes **ENT-11**, EMP-E08, BIZ-G13, OPS-G05, CH-G04 (presence), EMP-G05.
Work: approve/reject a decision by WhatsApp/push reply; per-employee schedules and org business hours consumed by all outbound; notification preferences; owner briefing scheduled per org; outage buffer wired into `guardedSend` failures.

**Wave 3 exit:** section A–E of `11-enterprise-readiness-checklist.md` all 🟢 or 🔴-human.

## Wave 4 — scale, reliability, polish (ongoing)

| Packet | Closes |
|---|---|
| 4.1 OpenTelemetry + Sentry, SLOs, error budgets, status page, on-call runbooks | **ENT-08**, ENT-07, ENT-10, OPS-E01, OPS-E02, RT-G09, UI-E11, ASK-E03 (metrics) |
| 4.2 Backup/DR: compose sidecar, RDS retention, Cognee/TrueForge/workspace volumes, recorded drill, RPO/RTO | ENT-09, OPS-E03, OPS-E04, RT-E03, MEM-E07, SEC-C09 |
| 4.3 Temporal hygiene: Schedules instead of boot fan-out `continueAsNew`, heartbeats, worker concurrency ≈ pool, versioning + replay tests, retry policies, MorningCheck dedupe, DormantLeadRevival started | EMP-G02, OPS-B04, OPS-B05, OPS-B06, OPS-B11, OPS-G08, OPS-E06, RT-B19, RT-B08, RT-B09, RT-B15, RT-B16, RT-B18, RT-B20, RT-B21, RT-G07, RT-G11, EMP-B15, CH-E03 |
| 4.4 Load and chaos tests; per-org concurrency; provider SLOs | OPS-E05, RT-G02, CH-E01 (replay ring in Redis) |
| 4.5 Tool invocation audit table + hidden-action removal + prompt-injection fence on the HTTP path | RT-G06, RT-S07, RT-S05, RT-S06, RT-S13, RT-S14, RT-B23, RT-B25, RT-B27, RT-B28, ASK-S07, ASK-S10, ASK-S03, ASK-S06, ASK-S08, ASK-S09, ASK-E05 |
| 4.6 i18n, timezone, currency, dark mode, white-label, fonts/perf budget | **ENT-12**, UI-E02, UI-E03, UI-E04, UI-E10, ASK-E07, EMP-E09, UI-G12, UI-G13, MEM-B20, BIZ-E11 |
| 4.7 Residency, per-org model policy, per-tenant LLM keys, virus scan/parsers | ENT-02, ENT-05, RT-E04, MEM-E02, MEM-E08, MEM-E09, BIZ-E12 |
| 4.8 Procurement docs: sub-processors, DPA, privacy, SLA doc, questionnaire answers | ENT-04, BIZ-E14, SEC-C10, BIZ-E02 |
| 4.9 Employee versioning / prompt history / A-B; marketplace | EMP-E03, EMP-E11, BIZ-G16, ASK-E06, ASK-E08, OPS-B08, OPS-B09, OPS-B10, OPS-B12, UI-B28, EMP-G06 |

---

## Dependency graph (what must land before what)

```
0.3 migrations ──► 1.1 grants ──► 3.4 platform admin
0.1 CI tests ────► every packet's DoD
0.6 request id ──► 4.1 OTel
1.4 confirm gate ─► 1.5 kill/gate/stage ─► 2.3 employees ─► 2.4 per-employee metrics
1.4 confirm gate ─► 2.2 per-step approvals
1.9 approvals ────► 2.2, 3.7 owner channel approvals
1.11 cost ────────► 2.4 budgets ─► 3.5 credits/entitlements
1.10 memory P0 ───► 2.7 ingest breadth ─► 3.3 DSR complete
1.7 channel P0 ───► 2.5 channel parity
1.2 epoch ────────► 3.1 identity
2.1 coverage ─────► 2.6 eval gate (golden set derives from the matrix)
3.2 encryption ───► 3.6 multi-account BYOK
```

## Sizing (rough, one agent-week = one focused agent for a week with review)

| Wave | Packets | Agent-weeks | Human-only items |
|---|---|---|---|
| 0 | 7 | 1–1.5 | none |
| 1 | 12 | 10–14 | none |
| 2 | 8 | 18–24 | OAuth client IDs for orphan providers (2.1) |
| 3 | 7 | 16–22 | KMS/KEK provisioning, DPA counsel, IdP test tenants |
| 4 | 9 | 12–18 (spread) | SOC2 auditor, status page vendor, region infra |

Parallelism: Wave 1 packets 1.1, 1.2, 1.3, 1.7, 1.10, 1.12 are fully independent; 1.4→1.5→1.6 chain; 1.8, 1.9, 1.11 depend only on 1.4's executor changes. Five agents can finish Wave 1 in ~3 weeks.
