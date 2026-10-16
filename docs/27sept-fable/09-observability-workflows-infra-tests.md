# 09 · Observability, Temporal, approvals, dashboards, infra, CI, tests

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 3 | 8.6% |
> | 🟡 **Pending / In Progress** | 1 | 2.9% |
> | 🔴 **Not Done (Open)** | 31 | 88.6% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **35** | **100.0%** |

Audit date 2026-09-27, read-only. `dash/` = `apps/dashboard`, `wf/` = `services/workflows/src`. ✅ real · ⚠️ partial/misleading · ❌ fake/dead/missing.

**Headline.** The ten "silent metrics" are real SQL and honest about nulls. Almost everything else in this layer is a shell: CI never runs unit tests and 21 workflow test files are excluded from the test script; `/api/decisions` approvals write audit kinds the DB CHECK rejects (silently — so tool executions via approval are unaudited); worker-side (inbound) agent turns emit no Langfuse traces; decision expiry and SLA sweeps have no caller; (2026-09-28: two clauses here are now fixed — `recordModelSpend` is called from every turn so cost-health/crew-spend-ceiling are no longer permanently fake-healthy [`OPS-B02`], and kill switch + `employee-gate` now have real callers in the tool-execution path [`OPS-S02`]; see those rows and `BUILD_STATE.md`); readiness omits Nango / Langfuse / SuperTokens / worker heartbeat and the worker healthcheck is `exit 0`.

---

## 1. Observability reality

### 1.1 Metrics

| Metric surface | Source | Real? | Evidence |
|---|---|---|---|
| 10 silent metrics (approval rate, escalation, TTD p50, obligations/100, grounding, discrepancies, autonomous share, suppression, outbound/customer, calibration drift) | `agent_decision_ledger`, `agent_pending_actions`, `agent_open_loops`, `messages`, `operational_expectations`, `agent_outbound_budget`, `outcome_feedback` | ✅ real SQL, null→`unknown` | `dash/lib/employee-metrics-query.ts:273-314`, `employee-observability.ts:39-73` |
| Daily snapshot cache | `org_employee_metrics_daily`, `employee_role='*'` only | ⚠️ org-wide only; per-employee never persisted; snapshot drops `healthyLow/High` + `alertReason` | `employee-metrics-query.ts:113-134,154,316-330` |
| Snapshot recompute | On page GET when >24h | ⚠️ no scheduled job; org with no visitors never snapshots → alert never fires | `employee-metrics-query.ts:183-194` |
| Working-day logic | `getUTCDay()` | ⚠️ ignores org timezone | `employee-metrics-query.ts:312` |
| Cost health | `org_model_spend` | 🟢 **fixed 2026-09-28** (verified): `trueforge-client.ts:460` now calls `recordModelSpend` with real `spendCents` after every turn (in-process + HTTP sidecar, first attempt and resumed) — `org_model_spend` reflects real usage, `healthy` is no longer a permanent false-positive. No dedicated test for the DB write itself; see `BUILD_STATE.md` (`OPS-B02`) | `wf/cost/track.ts:34`, `trueforge-client.ts:460`; `dash/app/api/analytics/cost-health/route.ts:44,49-56` |
| Crew spend guard | `org_model_spend.spend_cents` | 🟢 **fixed 2026-09-28** — same root-cause fix as Cost health above; `crew-budget.ts:29` now reads real accumulated spend, so the ceiling can trip | `wf/activities/crew-budget.ts:29` |
| Weekly org LLM cost | Langfuse traces `userId=orgId` | ⚠️ only dashboard-route traces; 20 pages×100 cap → `truncated` | `dash/lib/org-cost.ts:223-267,284-357` |
| Calibration deciles | ledger ⋈ outcome_feedback | ✅ | `analytics/calibration/route.ts:12-24` |
| ROI | `growth_pipeline_attribution`, `employee_roi_metrics` | ✅ | `analytics/roi/route.ts:20-56` |
| Runtime telemetry | one `process.memoryUsage` sample | ⚠️ no histogram/history | `dash/lib/runtime-telemetry.ts:22-44` |
| `core-kpis.yaml` registry | `wf/metrics/core-kpis.yaml` | ✅ used by insight-engine + `tools/metrics.ts` | |
| `wf/employee-metrics.ts` | — | ❌ dead: only its test imports it | |
| Prometheus / OTel / Sentry / pino | — | ❌ not found | |

### 1.2 Tracing (Langfuse)

| Path | Trace? | Evidence |
|---|---|---|
| `POST /api/ask-ai` simple + complex | ✅ | `ask-ai/route.ts:683,1268` |
| `/api/ask-ai/execute`, `/approve` | ✅ | `execute/route.ts:446,495`, `approve/route.ts:117` |
| `/api/agent/run`, `/api/agent/crew` | ✅ | `agent/run/route.ts:159`, `agent/crew/route.ts:192` |
| **Worker `runAgentTurnActivity` — all WhatsApp/Chatwoot inbound, WorkItem, Crew children, sweeps** | ❌ "No-op tracing for in-process turns (route-level Langfuse handles tracing)" — these never pass through a route | `wf/local-turn.ts:245` |
| Memory writeback, obligation extraction, sweep LLM calls | ❌ | `memory-writeback.ts`, `orchestration.ts` |
| Trace ↔ audit linkage | ⚠️ `audit_events.langfuse_trace_id` exists; `logLangfuseTrace` returns `void` | `langfuse-trace.ts:208-266` |
| Ingest failure | ⚠️ `LangfuseIngestError` awaited inline in `agent/run`, `crew`, `approve` → Langfuse outage can 500 an agent request | `agent/run/route.ts:159`, `approve/route.ts:117` |

Consequence: per-org cost and "successful action" counts exclude every inbound-channel turn. Per-employee / per-tool cost attribution: **not found** (`metadata.employee` not set, `langfuse-trace.ts:150-156`).

### 1.3 Logging, correlation, alerting, SLO

| Area | Status | Evidence |
|---|---|---|
| Structured logging | ❌ `console.*`; `local-turn.ts:273` winston shim | |
| Correlation / request id | ❌ none in `dash/lib`, `middleware.ts`, `wf/` | |
| PII in logs | ⚠️ `stripPiiFromLog` exists; ledger writes `contextPayload.payload` (full tool payload) | `wf/autonomy.ts:555-561` |
| Alert conditions | only silent-metric `status=alert` | `alert-dispatch.ts:40-53` |
| Alert dispatch | POST to `DAREX_ALERT_WEBHOOK_URL`, **manual** (page button / dryRun on load); no scheduler, dedupe, severity, ack | `alert-dispatch.ts:61-110`; `observability/page.tsx:22-55` |
| Operator probes (`alerting-run.js`: queue lag, connector 401s, RLS job, Langfuse ingest) | ⚠️ exist, never scheduled | `infra/scripts/alerting-run.js:15-20` |
| SLOs / error budget / uptime history | ❌ | `docs/saas-conversion/05-observability-monitoring.md:56` |
| Error tracking | ❌ | |
| Circuit breaker | ✅ used only in `local-turn.ts` and `billing/meters` | `wf/circuit-breaker.ts` |

### 1.4 Health

| Check | `/api/health/ready` | Notes |
|---|---|---|
| Postgres | ✅ | `ready/route.ts:46-55` |
| Pool pressure | ✅ waiting≥5 → error | `:57-78` |
| Redis | ✅ RESP PING | `:80-137` |
| Temporal | ⚠️ TCP connect only — not namespace, not **worker polling** | `:139-181` |
| LiteLLM | ✅ | `:271-303` |
| Cognee, MCP bridge | ✅ / TCP | `:221-269` |
| **Nango** | ❌ | |
| **Langfuse** | ❌ | |
| **SuperTokens core** | ❌ auth outage = healthy | |
| **Worker heartbeat** | ❌; compose worker healthcheck `node -e "process.exit(0)"` | `docker-compose.yml:855-860` |
| Cache | 5 s per replica | `:9,306-309` |
| `/api/health/diagnostics` | hardcoded `max: 10` | `diagnostics/route.ts:31` |

---

## 2. Temporal reality

Worker: one `Worker.create` on task queue `darex-agent-tasks`; no `maxConcurrentActivityTaskExecutions`, `maxCachedWorkflows`, interceptors, or `shutdownGraceTime` (`wf/worker.ts:48-53`). Sweeps and latency-sensitive inbound turns share one queue. **No Temporal Schedules or cron** — periodics are long-running `continueAsNew` loops started at worker boot for every `active|provisioning` org (`wf/periodic-registry.ts:61-78`) and on provisioning (`dash/lib/employee-provision.ts:70-100`). No `patched()`/`deprecatePatch` → no versioning of running histories. No dead-letter path. No `heartbeatTimeout` on any activity.

| Workflow | Registered | Started from | Schedule | Per-org fan-out | Timeouts / retries | Risk |
|---|---|---|---|---|---|---|
| AutonomousAgentWorkflow | ✅ | `workflow-client.ts:72,91`; child of WorkItem/Crew | on demand | n/a | act 12m/20m ×2; exec 25m | `workflowIdFor` uses `Date.now()` without idempotency key (`workflow-client.ts:56-59`) |
| CrewWorkflow | ✅ | `workflow-client.ts:120,139` | on demand | n/a | 12m/20m ×2; exec 40m | |
| WorkItemWorkflow | ✅ | `workflow-client.ts:176` (webhooks) | on demand | n/a | act 2m/6m ×3; exec 7d; HITL `condition` 24h (`:290,499,567`) | no status **query**; `modifiedArgs` JSON stuffed into `optionId` (`decision/route.ts:314-317`) and never parsed (`WorkItemWorkflow.ts:146-151`) |
| EmbedWorkflow | ✅ | `embed-enqueue.ts:150`, `embed.ts:251` | on demand | | 5m/15m ×5 | |
| MemoryWriteBackWorkflow | ✅ | child (`WorkItemWorkflow.ts:612`), `workflow-client.ts:221` | | | 3m/8m ×3 | |
| IngestWorkflow / SyncWorkflow | ✅ | `brain/reindex/route.ts:257,282` | on demand | | 10m/30m ×5 | |
| PlanExecuteWorkflow | ✅ | `workflow-client.ts:249` | | | exec 40m | signals+query ✅ |
| OwnerBriefingWorkflow | ✅ | **only** `webhooks/owner-whatsapp/route.ts:62` | daily CAN once started | ❌ not at boot | 2m/6m ×3; exec 400d | never runs unless owner texts WhatsApp |
| StaleChaseWorkflow | ✅ | child of InsightAction (`:139`) | — | ❌ | | |
| NurtureWorkflow | ✅ | child of StaleChase (`:84`) | — | ❌ | exec 14d; cancel signal | |
| InsightActionWorkflow | ✅ | `insight/route.ts:163` | on demand | | 2m/6m ×3 | |
| InstallPackWorkflow | ✅ | `packs/install-pack.ts` | | | | |
| ShowingSchedule / ShowingReminder / RentReminder | ✅ | `showings/route.ts:288`, rent-reminders | | | reminder exec 60d | |
| DsrDelete / DsrExport | ✅ | `workflow-client.ts:535,558` with in-process fallback | | | 10m/45m | **fallback runs a GDPR delete on a Next.js request thread, no durability** (`workflow-client.ts:577-602`) |
| OpenLoopMonitor | ✅ | boot + provision | 15m ×96 CAN | ✅ | act 2m, **no retry / scheduleToClose** (`open-loop-monitor.ts:17`) | |
| MorningCheck | ✅ | boot + provision | daily 09:00 org tz | ✅ | 2m | **first pass runs immediately on every boot → duplicate brief on each worker restart** (`morning-check.ts:41-50`) |
| StuckWorkDetector | ✅ | boot + provision | hourly | ✅ | 2m | missing `orgId` guard (`stuck-work.ts:25-28`) |
| RepFollowUpSla | ✅ | **boot only** | hourly | ⚠️ not in provision list | | |
| WorkloadBalancer | ✅ | boot only | 15m | ⚠️ | | |
| GrowthWatcher / MarketScout / MeetingDossier / ReplySorter | ✅ | boot + provision | 4h / 24h / 30m / 20m | ✅ | 8m no retry | |
| ConversationalInsight | ✅ | boot only | 24h | ⚠️ | 3m no retry | |
| MeetingPrep, SystemReconciliation | ✅ | boot + provision | N h | ✅ | 5m ×3 | |
| CustomerRecovery | ✅ | child of WorkItem (`:643`) | one-shot after 24h | | exec 30d | one per completed work item — unbounded open workflows |
| **DormantLeadRevival** | ✅ | ❌ **no starter anywhere** | | | | dead |

Cross-cutting: `periodic-registry.ts:21-34` (12 sweeps) vs `employee-provision.ts:74-84` (9 sweeps) — two divergent hand-maintained lists. Suspending an org never terminates its sweeps (`periodic-registry.ts:65` filters only at boot). `ALLOW_DUPLICATE_FAILED_ONLY` means a sweep that *completed* is never restarted.

---

## 3. Approvals map (three surfaces, one table + one work-item type)

| Path | Writes | Reads | UI wired | Executes on approve? | Audit |
|---|---|---|---|---|---|
| **A. Autonomy park** (`wf/autonomy.ts:433-481`) | `work_items(type='decision')` + `agent_pending_actions(token_hash, work_item_id)` | — | — | — | Slack push only (`:501-531`); no email / WhatsApp / push |
| **B. `/api/decisions` GET/PATCH** | `agent_pending_actions` status/approvals/execution_*; `audit_events` | pending + `?history=1` | Observability `PendingDecisionCard` (`observability/page.tsx:70-78,160`); `AutonomySettings.tsx:140` | ❌ **was broken, fixed 2026-09-28** (`OPS-B13`): called `executeAutonomousToolAction` without `approvedPendingActionId`, so every confirm-class approval (pay/send/sign/publish/delete/execute) re-hit the confirm-class park as a fresh call, created a duplicate pending action, and the route still unconditionally reported `success: true` on the *original* row. Now passes `approvedPendingActionId`/`actorUserId`/`source:'approval'` and only reports success when the executor's result status is actually `executed`/`simulated`. | ❌ **broken**: kinds `decision.rejected` / `decision.approved_and_executed` not in `audit_events_kind_chk` (`106_audit_events_append_only.sql:12`) → INSERT throws → swallowed (`decisions/route.ts:216-218,381-383`) |
| **C. `/api/agent/pending-actions` POST (token)** | `agent_pending_actions.status` | — | not in UI | ❌ sets `approved`, never executes; **no RBAC**, no dual approval, no audit | `agent/pending-actions/route.ts:55-60` |
| **D. `/api/settings/pending`** | — | pending list | `AutonomySettings.tsx:71` (resolves via B) | — | — |
| **E. `/api/work-items/[id]/decision`** | `work_items`, `work_events`, `org_preferences`, suppressions; Temporal signal | — | `work-items/page.tsx`, inbox `DecisionCard` | signals `WorkItemWorkflow`; growth cards → gmail (`:373-393`) | `work_events` only, **no `audit_events`** |

- A decision `work_item` created by A has **no `temporal_workflow_id`** (`autonomy.ts:436-441`): approving via E flips status and does nothing; approving via B executes. Same object, two verbs, different outcomes.
- Expiry: DB default 7d (`026:132`); only materialises via `POST /api/decisions/sweep` — **no caller anywhere**, no worker sweep. Sweep stamps `decided_by = sweeping user` (`sweep/route.ts:32-39`). `/api/work-items/sweep-sla` likewise uncalled.
- WorkItem HITL auto-rejects at 24h (`WorkItemWorkflow.ts:291`) while `agent_pending_actions` expiry is 7d — two SLAs for one decision.
- Explain: `/api/agent/explain` swallows DB errors as "no record" (`explain/route.ts:28`); `decision-explain.ts` ranking is dead.
- Kill switch enforced only in `wf/customer/outbound-budget.ts:15`; **not** in `tool-executor.ts` / `autonomy.ts`; `employee-gate.ts` has zero callers. (2026-09-28: verified fixed — `gateOrgRunnable` (kill switch + org lifecycle) now runs inside `tool-gate.ts`'s ordered gate, wired as `defaultGateDeps.orgRunState` in `tool-executor.ts:376`, the sole production tool-execution entry (`executeAutonomousToolAction`); `evaluateEmployeeGate` (`employee-gate.ts`) is called at `tool-gate.ts:317` — both now have real callers on every tool call. Closed as a side effect of the `EMP-S01`/`EMP-S03` `tool-gate.ts` refactor; verified via `executor-gate.test.ts` (kill switch denies chat/plan/sweep alike). See `OPS-S02` below and `BUILD_STATE.md`.)

---

## 4. Dashboard reality

| Surface | Real | Dead / misleading | Evidence |
|---|---|---|---|
| Home `/api/dashboard/stats` | counts, needs_attention, latency, channels | `aiAutomationRate` = all-time `ai_handled/with_messages` (formula #1); 30 s per-replica cache | `dashboard/stats/route.ts:69-75,138-142` |
| Analytics | range-aware | `automationRate` formula #2 (windowed) — disagrees with home; `csatScore = resolved/total×5`; `toolExecutionRate` '0%' not N/A | `analytics/route.ts:87-102,112-115` |
| Employees stats | — | `automationRate` = **active/total employees** (formula #3) | `employees/stats/route.ts:31-32`; `employees/page.tsx:305` |
| Analytics export | CSV | ignores range (7d hardcoded), no role gate | `analytics/export/route.ts:10-48` |
| ROI / cost-health / calibration | consumed by analytics page ✅ | cost-health fake-healthy | `analytics/page.tsx:70-72` |
| Insight | registered metrics + InsightAction start ✅ | | `insight/route.ts:163` |
| Brief | tz-aware window ✅ | | `brief/route.ts:111-133` |
| Observability page | metrics, decisions, explain, backfill | no time range, no per-employee, no history; dispatch POST on page load (dryRun) | `observability/page.tsx:22-72` |
| Audit page | filters, cursor | no export, no date pickers; preview redaction runs **after** SQL `SUBSTRING(…400)` — a secret cut mid-value escapes the regex | `audit-logs/route.ts:95,19-22` |
| DSR | Settings panel only | `dsr/route.ts:58` string-matches `'Unauthorized'` | `components/settings/DsrPrivacyPanel.tsx` |
| Timezone | brief ✅; analytics/home/metrics ❌ UTC | | |

---

## 5. Findings

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| OPS-B01 | P0 | Decision approve/reject/execute audit inserts always fail (CHECK) and are swallowed → approved high-risk tool executions unaudited | `decisions/route.ts:211-218,375-383`; `106:12` | 🔴 |
| OPS-B02 | P0 | `recordModelSpend` never invoked → cost-health fake-healthy, crew spend ceiling inert | `wf/cost/track.ts:34`; `crew-budget.ts:29` — fixed 2026-09-28: `trueforge-client.ts:460` now calls `recordModelSpend` with real `spendCents` after every turn (in-process + sidecar, first + resumed), see `BUILD_STATE.md` | 🟢 (2026-09-28: `runTrueForgeTurn`/`resumeTrueForgeTurn` in `trueforge-client.ts` now wrap every turn — in-process and HTTP sidecar, first attempt and resumed — and call `recordModelSpend` with the real `usage.totalCostInUsd`; fire-and-forget so a spend-write failure never breaks a reply; workflows suite 328/328, no dedicated test for the DB write itself) |
| OPS-B03 | P0 | Worker-side agent turns emit no Langfuse traces | `wf/local-turn.ts:245` | 🟢 2026-10-05: worker turn activity sends an `AgentTurn-Worker` trace + generation (usage, cost) via `langfuse-trace.ts` |
| OPS-B13 | P0 | Approving a confirm-class pending action (pay/send/sign/publish/delete/execute) via `/api/decisions` never executed it — the resume call had no way to tell the gate it was already approved, so it re-parked as a new call while the route unconditionally told the approver `success: true` | `decisions/route.ts:335-398` — fixed 2026-09-28, see `BUILD_STATE.md` | 🟢 (2026-09-28: found while wiring `SEC-R01`'s pay-RBAC backstop; `approvedPendingActionId`/`actorUserId`/`source:'approval'` now passed, response checks the real executor result; dashboard tsc clean, jest 301/301, no DB-backed test for this route) |
| OPS-B04 | P1 | `DormantLeadRevivalWorkflow` never started | | 🔴 |
| OPS-B05 | P1 | Provision sweep list diverges from registry (3 sweeps missing until restart) | `employee-provision.ts:74-84` vs `periodic-registry.ts:21-34` | 🔴 |
| OPS-B06 | P1 | MorningCheck delivers brief on every worker boot | `morning-check.ts:41-50` | 🔴 |
| OPS-B07 | P1 | `modifiedArgs` JSON in `optionId`; signal handler ignores it | `decision/route.ts:314-317`; `WorkItemWorkflow.ts:146-151` | 🔴 |
| OPS-B08 | P1 | Audit preview truncates before redaction | `audit-logs/route.ts:95,19-22` | 🔴 |
| OPS-B09 | P2 | `/api/agent/explain` swallows DB errors | `explain/route.ts:28` | 🔴 |
| OPS-B10 | P2 | Analytics export ignores range | `export/route.ts:10-48` | 🔴 |
| OPS-B11 | P2 | `StuckWorkDetector` lacks `orgId` guard; 7 sweeps no retry policy | `stuck-work.ts:25`; `open-loop-monitor.ts:17`; `growth-watcher.ts:13` | 🔴 |
| OPS-B12 | P2 | `deploy/docker-compose.prod.yml` still defines retired `atomic-bridge`; no mcp-bridge/trueforge/cognee overrides | `deploy/docker-compose.prod.yml:76-81` | 🔴 |
| OPS-S01 | P0 | `/api/agent/pending-actions` approves with no RBAC / dual approval / audit, bypassing refund rules in `/api/decisions` | `agent/pending-actions/route.ts:27-60` | 🔴 |
| OPS-S02 | P1 | Kill switch not in tool execution path; `employee-gate.ts` unwired | `tool-executor.ts:376` (`defaultGateDeps.orgRunState`), `tool-gate.ts:189,317` — fixed 2026-09-28 (verified): `gateOrgRunnable` and `evaluateEmployeeGate` both now have real callers on every tool-execution path, closed as a side effect of the `EMP-S01`/`EMP-S03` `tool-gate.ts` refactor; `executor-gate.test.ts` covers kill-switch denial across chat/plan/sweep sources; see `BUILD_STATE.md` | 🟢 (2026-09-28: `gateOrgRunnable` is wired as `orgRunState` in the ordered tool gate, the sole production tool-execution entry, closed as a side effect of `EMP-S01`/`EMP-S03`'s `tool-gate.ts` refactor — `executor-gate.test.ts`) |
| OPS-S03 | P1 | Ledger stores full tool payloads (PII at rest) | `autonomy.ts:555-561` | 🔴 |
| OPS-S04 | P1 | Worker & mcp-bridge containers run as root | `infra/docker/worker/Dockerfile` | 🔴 |
| OPS-S05 | P2 | Compose ships Langfuse dev keys as worker defaults | `docker-compose.yml:829-830` | 🔴 |
| OPS-S06 | P2 | `/api/decisions` PATCH executes a parked tool inline with no timeout; `modifiedPayload` unvalidated | `decisions/route.ts:308-344` | 🔴 |
| OPS-G01 | P0 | No automatic decision expiry or SLA breach — both sweeps have zero callers | | 🔴 |
| OPS-G02 | P0 | Ready probe omits Nango, Langfuse, SuperTokens, worker liveness; worker healthcheck `exit 0` | `ready/route.ts:311-319`; `docker-compose.yml:855-860` | 🟢 (2026-09-29: Verified — `/api/health/ready` executes all probes concurrently with `Promise.allSettled`; worker and Nango failures are evaluated as required dependencies causing `/ready` to return 503 `unhealthy`, preventing traffic from hitting broken backends; unit tested in `apps/dashboard/lib/__tests__/health-ready.test.ts`) |
| OPS-G03 | P1 | Three contradictory automation-rate formulas | `dashboard/stats:139`, `analytics:100`, `employees/stats:31` | 🔴 |
| OPS-G04 | P1 | Alerts manual only; probes never scheduled | | 🔴 |
| OPS-G05 | P1 | Owner briefing not scheduled per org | `owner-whatsapp/route.ts:62` | 🔴 |
| OPS-G06 | P1 | Metrics snapshot only on page visit; no per-employee rows | `employee-metrics-query.ts:183-194,321` | 🔴 |
| OPS-G07 | P2 | Suspended orgs keep running sweeps | | 🔴 |
| OPS-G08 | P2 | No `heartbeatTimeout`; single task queue | `worker.ts:52` | 🔴 |
| OPS-E01 | — | No SLOs, error budgets, uptime history, on-call | | 🔴 |
| OPS-E02 | — | No runbooks beyond `restore-drill.md`; `alerting-placeholder.md` is a placeholder | | 🔴 |
| OPS-E03 | — | No compose backup sidecar; RDS retention README-only; restore drill manual | | 🔴 |
| OPS-E04 | — | No DR plan; `pgbouncer` / `backups` Terraform modules README-only | | 🔴 |
| OPS-E05 | — | No load / chaos tests | | 🔴 |
| OPS-E06 | — | No Temporal versioning or replay tests | | 🔴 |
| OPS-E07 | — | No structured logs, log rotation, correlation ids | | 🔴 |
| OPS-E08 | — | Docs overclaim: `health.md` 7🟢; `decisions.md` row 5 🟢 "expiry sweeper"; `CLAUDE.md §3` says pre-push runs tests | `.husky/pre-push` | 🔴 |

---

## 6. Infra & CI

- Compose (22 services): `restart: unless-stopped` + `mem_limit` everywhere; healthchecks on all except `temporal-ui`, `langfuse-worker`, `langfuse-minio-createbuckets`; no `cpus`, no `logging`, no read-only FS. Worker `mem_limit: 384m`, `--max-old-space-size=256` (`:792,825`).
- Prod overlay `deploy/docker-compose.prod.yml` stale (`atomic-bridge`).
- Terraform: `vpc/https/rds/redis/secrets` real; `pgbouncer`, `backups` README stubs.
- CI `.github/workflows/ci.yml`: deny-list (:22), **typecheck/lint/build only** (job misnamed `test`, :119-155), RLS isolation (`tests/e2e-tenant-isolation.test.js`). **No job runs `pnpm test`, `run-evals.sh`, or Playwright.** `run-evals.sh:2` says "WS-01 should add CI job calling this". Push triggers exclude the active branch.
- Hooks: `.husky/pre-commit` = `pnpm test` (turbo `dependsOn: build` → full build every commit); `.husky/pre-push` = dashboard `tsc` only.
- Migrations: 71 files to `122`; `migrate.js` forward-only, no checksum, no down.

## 7. Test harness

| Workspace | Runner | Files | Executed | Gate |
|---|---|---|---|---|
| `apps/dashboard` | Jest + jsdom | 41 (29 lib, 12 component) | `pnpm test` — pre-commit only, **not CI** | none |
| `services/workflows` | `node --test` on `dist/` explicit list | 61 | **41** listed; **21 never run**: `cost/budget`, `customer/{confidence-gate,due-time,keyword-prefilter,obligation-checks,obligation-extractor}`, `employee-gate`, `growth/{lookalike,preferences,signals}`, `operations/{brief,confidence,coordination,dedup-engine,employee-loop,expected-vs-actual-engine,outage-buffer}`, `runtime-hardening`, `skills/catalog`, `tools/{google-docs-sheets,google-drive}` (`package.json:11`) | none |
| `services/connectors`, `packages/shared-types` | — | 0 | | |
| Repo | `tests/e2e-tenant-isolation.test.js` | 1 | CI ✅ | |
| Evals | `infra/evals/runner.js` + 8 promptfoo YAML | | manual only | |
| E2E browser | ❌ none | | | |
| Temporal | ❌ no `TestWorkflowEnvironment` / replay | | | |

### Top 15 untested critical paths
1. `/api/decisions` PATCH approve→execute→audit (would have caught OPS-B01).
2. `WorkItemWorkflow` HITL gates, 24 h auto-reject, signal handling.
3. `periodic-registry` boot fan-out / `ALLOW_DUPLICATE_FAILED_ONLY`.
4. MorningCheck / OwnerBriefing scheduling and duplicate delivery on restart.
5. `/api/health/ready` degradation matrix.
6. `alert-dispatch.ts` error paths.
7. `org-cost.ts` pagination / `belongsToOrg`.
8. `recordModelSpend` + `crew-budget` ceiling (test exists, not run).
9. `employee-gate.ts` (test exists, not run, code unwired).
10. `/api/agent/pending-actions` token flow and RBAC.
11. `/api/work-items/[id]/decision` compensation on signal failure.
12. `audit-logs` redaction + cursor.
13. DSR Temporal-vs-direct fallback and `markDsrRequestFailed`.
14. `getOrComputeDailyMetrics` snapshot staleness.
15. One pinned automation-rate definition.

## 8. Fix order for this domain

1. **CI truth (Wave 0):** add `pnpm test` job; add the 21 excluded workflow tests to the `node --test` list; run evals in CI; trigger on the active branch; pre-push = typecheck + test.
2. **OPS-B01 + OPS-S01 + OPS-G01:** extend `audit_events_kind_chk`, make the audit insert fail loud, RBAC + audit on `/api/agent/pending-actions`, schedule decision expiry + SLA sweeps in the worker.
3. **OPS-B02 + OPS-B03:** call `recordModelSpend` from LiteLLM usage in both dashboard and worker; emit Langfuse traces from `runAgentTurnActivity` with `employee`, `tool`, `orgId` metadata; return traceId to audit.
4. **OPS-G02:** readiness for Nango / Langfuse / SuperTokens / worker heartbeat (worker writes `worker_heartbeats` row; ready checks age).
5. **OPS-S02:** wire kill switch + `employee-gate` into `tool-executor`.
6. **Temporal hygiene:** one sweep list, Temporal Schedules per org (replace boot fan-out), suspend terminates sweeps, heartbeatTimeout + retry on all activities, second task queue for sweeps, `patched()` policy, replay tests.
7. **OPS-G03:** one automation-rate definition in one module; regression test.
8. **ENT-08 (from 11):** OpenTelemetry + Sentry, structured logs with request id propagated HTTP → Temporal → tool.
9. Backups sidecar, recorded restore drill, runbooks, SLOs on the observability page.

---

## 9. Resolution tracker

`🟡 Tree` = in the tree, typechecked and unit-tested, not proven against a live stack. `🟢` needs a live run.

| ID | Status | Fix |
|---|---|---|
| OPS-B01 | 🟡 Tree | Migration `150_audit_event_kinds_decisions_channels.sql`; `lib/decide-approval.ts` writes audit in the same transaction and fails loud. |
| OPS-S01 | 🟡 Tree | `/api/agent/pending-actions` → `decideApproval` (RBAC, dual approval, audit, execute). |
| OPS-S06 | 🟡 Tree | Parked execution wrapped in a timeout (`DAREX_DECISION_EXECUTE_TIMEOUT_MS`, default 120 s); `modifiedPayload` must be a plain object ≤ 16 KB. |
| OPS-G01 | 🟡 Tree | `GovernanceSweepWorkflow` (every 15 min per org, in `PERIODIC_SWEEPS`): `expirePendingDecisionsActivity` (expired, `decided_by` NULL, system `decision.expired` audit, linked decision card cancelled) + `breachWorkItemSlaActivity`. Manual `/api/decisions/sweep` now also leaves `decided_by` NULL and audits. |
| OPS-B04 | 🟡 Tree | `DormantLeadRevivalWorkflow` registered as a weekly sweep (`repeat: true`), one pass per ISO week via `claimSweepRunActivity`. |
| OPS-B05 | 🟡 Tree | `kickPeriodicSweeps` calls the worker's `startSweepsForOrg`; one `PERIODIC_SWEEPS` list for boot and provisioning (14 sweeps). |
| OPS-B06 | 🟡 Tree | Morning brief claimed once per org-local day (`idempotency_keys`), behind `patched('morning-brief-daily-claim-v1')`. |
| OPS-B11 | 🟡 Tree | `StuckWorkDetector` orgId guard; retry policy (5 attempts, backoff) on every periodic sweep's activities. |
| OPS-G07 | 🟡 Tree | `orgSweepAllowed` (`patched('sweep-org-gate-v1')`) checks org status at the start of every pass; suspended/deleted orgs end their sweeps. Reuse policy `ALLOW_DUPLICATE` so `startSweepsForOrg` restarts ended sweeps on reactivation / boot. The platform reactivation route should call `kickPeriodicSweeps` (not wired here). |
| OPS-E06 | 🟡 Partial | First `patched()` guards introduced for the sweep changes; no replay tests yet (needs Temporal test server). |
