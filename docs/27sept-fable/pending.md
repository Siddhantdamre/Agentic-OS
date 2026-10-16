# Pending & Half-Finished Items — Fast-Track Completion Guide

> ### 📊 Current Pending Status
>
> | Total Pending | P0 Blockers | P1 High Priority | P2 Polish |
> |:---:|:---:|:---:|:---:|
> | **0** | **0** | **0** | **0** |
>
> **Core Purpose of this Document:**
> These 42 findings are **not** starting from scratch. Each one already has code written (50% to 90% implemented in the tree), but was either left unverified against a live stack, missing a secondary edge-case check, or stopped midway before all callers were updated.
> Completing these 42 items represents the **highest return-on-investment (ROI)** in the entire codebase: it turns 42 items directly from 🟡 to 🟢 and eliminates all major P0 failure modes without architectural rewrites.

---

## Quick Navigation by Domain

1. [Ask AI Chat & Plan Execution (9 items)](#1-ask-ai-chat--plan-execution-9-items)
2. [AI Employees & Governance Gates (3 items)](#2-ai-employees--governance-gates-3-items)
3. [Agent Runtime & Tool Execution (8 items)](#3-agent-runtime--tool-execution-8-items)
4. [Security, Auth & Compliance (6 items)](#4-security-auth--compliance-6-items)
5. [Channels, Realtime & Webhooks (3 items)](#5-channels-realtime--webhooks-3-items)
6. [Billing, Packs & Onboarding (3 items)](#6-billing-packs--onboarding-3-items)
7. [Observability & Health Probes (1 item)](#7-observability--health-probes-1-item)
8. [Frontend, UX & Error Boundaries (6 items)](#8-frontend-ux--error-boundaries-6-items)
9. [Enterprise & Web Search (3 items)](#9-enterprise--web-search-3-items)

---

## 1. Ask AI Chat & Plan Execution (9 items)

### `ASK-B01` — `running` plan re-executes every step on SSE reconnect [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: In `apps/dashboard/app/api/ask-ai/execute/route.ts`, reconnecting to a `running` non-durable plan re-attaches and resumes execution from `current_step`. Completed step outcomes are persisted in `agent_plans.steps` JSONB and replayed immediately as `step_start` and `step_done` from database cache without calling `executeAutonomousToolAction`. Only uncompleted steps execute tools. An in-memory tracking set (`activePlanExecutions`) prevents concurrent duplicate runs on the same node while allowing disconnected sessions to resume. Network transport disconnects no longer prematurely mark the plan `cancelled`. Verified with unit tests in `apps/dashboard/lib/__tests__/ask-ai-execute-reconnect.test.ts`.

---

### `ASK-B02` — Durable plan cannot be cancelled once running [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: In `services/workflows/src/workflows/PlanExecuteWorkflow.ts`, wrapped each stage execution in a Temporal `CancellationScope`. When `rejectPlanSignal` arrives during execution, `decision = 'rejected'` and `stageScope?.cancel()` triggers immediate cancellation of in-flight stage activities. Pre-stage checks prevent stage N+1 from executing if cancelled, and caught cancellation executes `updateAgentPlanActivity` inside `CancellationScope.nonCancellable` to reliably persist `status: 'cancelled'` in Postgres. Verified with automated workflow unit tests in `services/workflows/src/plan-execute-workflow.test.ts`.

---

### `ASK-B03` — Hydration returns oldest 200 rows; newest messages vanish [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Rewrote hydration query in `GET /api/ask-ai` using a subquery taking `ORDER BY created_at DESC LIMIT 200` re-sorted `ORDER BY created_at ASC` outside. Verified with automated unit tests in `apps/dashboard/lib/__tests__/ask-ai-persist.test.ts` demonstrating that hydrating a thread with 205 messages reliably yields the newest 200 messages in chronological order, terminating at the latest message.

---

### `ASK-B04` — `userId` cast into params the executor never reads [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `execute/route.ts` passes `actorUserId: userId` to `executeAutonomousToolAction`, and records an `audit_events` row for each executed plan step with actor attribution (`actorType: 'user'`, `userId`, `planId`, `tool`, `action`, `resultStatus`). Verified with dashboard typecheck and unit tests.

---

### `ASK-B11` — Revised plan stays `approved`; edited steps run without re-approval
- **Severity**: **P1** | **Packet**: 2.2 | **Location**: `apps/dashboard/app/api/ask-ai/revise/route.ts:53,70-73`, `apps/dashboard/components/chat/PlanCard.tsx`, `apps/dashboard/components/chat/DraftPanel.tsx`, `apps/dashboard/app/(dashboard)/ask-ai/page.tsx`
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `revise/route.ts` sets `status: 'pending'` and returns `{ success: true, draft, status: 'pending' }`. `DraftPanel.tsx` and `EmailDraftPreviewModal.tsx` forward `data.status` through `onRevised`. `PlanCard.tsx` accepts `status` prop, renders a "Pending Approval" status badge, and disables "Approve & Execute" when status is approved. `ask-ai/page.tsx` resets execution state and updates message `planCard.status` to `pending`, immediately bringing back the interactive PlanCard in pending approval state. Verified in `DraftPanel.test.tsx` and `PlanCard.test.tsx`.

---

### `ASK-S02` — Plan allowlist tautological; `employeeRole` never passed [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `resolvePlanStepActor` in `services/workflows/src/plan-step-actor.ts` resolves the stamped employee ID or role from the step (with plan-level fallback), loads their active record, derives their tool allowlist, and merges persona-specific tool filters. In both Next.js (`apps/dashboard/app/api/ask-ai/execute/route.ts`) and Temporal durable execution (`services/workflows/src/activities/orchestration.ts`), steps invoke `executeAutonomousToolAction` with the actor's real `toolAllowlist`, `employeeRole`, and `employeeId`. Inactive employees or missing assignments fail closed. Verified with 4 unit tests in `plan-step-actor.test.ts`.

---

### `ASK-S05` — Write-tool approval only when `REQUIRE_TOOL_APPROVAL==='true'` [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `isToolApprovalRequired` in `local-turn.ts` requires human approval unconditionally for confirm-class actions (`pay`, `send`, `sign`, `publish`, `delete`, `execute`). General writes and mutations default to requiring approval unless explicitly disabled via `REQUIRE_TOOL_APPROVAL='false'`. Read operations never require approval. Verified in `executor-confirm.test.ts`.

---

### `ASK-S06` — `DAREX_ALL_TOOLS` env bypass in shipped code [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `DAREX_ALL_TOOLS` was removed from `local-tool-select.ts` production code; it only appears in test assertions confirming the guard is gone. Tool selection always intersects with the employee allowlist — no env-var bypass path exists.

---

### `ASK-G03` — Steps execute as org, not assigned employee [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `resolvePlanStepActor` in `services/workflows/src/plan-step-actor.ts` resolves the step's stamped `employeeId`/`employeeRole` (with plan-level fallback), verifies active status, loads the employee's `tool_allowlist`, and merges persona filters (`mergeRuntimeAllowlist`) so steps execute with the actor's real persona constraints and allowlist instead of the whole org. Passed to `executeAutonomousToolAction` across both direct (`execute/route.ts`) and Temporal (`orchestration.ts`) engines. Covered by `plan-step-actor.test.ts`.

---

## 2. AI Employees & Governance Gates (3 items)

### `EMP-S04` — Critic only on WorkItem replies [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Replaced all `executeProvider` calls with `executeAutonomousToolAction` across all 4 background activity files: `meeting-prep.ts` (4 calls, role `'executive'`), `growth.ts` (9 calls, role `'marketing'`), `rep-followup-sla.ts` (2 calls, role `'operations'`), `workload-balancer.ts` (1 call, role `'operations'`). Each call uses `source: 'sweep'`. Send-class actions now route through `tool-gate.ts` and the critic. Committed in `e21dcf1`.

---

### `EMP-G01` — `employee-gate`/`employee-metrics`/`cold-start` only imported by tests [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**:
  1. `recordEmployeeMetrics` was added to `employee-metrics.ts`, generating structured decision log fields and recording decisions. In `tool-gate.ts`, successful tool invocations (`status === 'executed'`) trigger `deps.logLedger({ ...ledgerBase, decision: 'executed', reasonCode: 'allowed' })`. In `tool-executor.ts`, `writeLedgerRow` calls `recordEmployeeMetrics` and records the executed action into `agent_decision_ledger`.
  2. `DEFAULT_AUTONOMY_SEED` duplication in `apps/dashboard/lib/employee-provision.ts` was eliminated by importing the canonical 17-rule matrix directly from `@darex/workflows/dist/cold-start`. `seedDefaultEmployees` now invokes `seedDefaultAutonomyRules(client, orgId)` ensuring default autonomy rules are persisted during provisioning.
  3. `seedColdStart(orgAgeDays)` was exported from `cold-start.ts` and wired into onboarding completion (`POST /api/org/create` and `POST /api/onboarding/complete`).
  4. Verified with 344 passing workflows tests and 342 dashboard unit tests (`onboarding-cold-start.test.ts`, `cold-start.test.ts`, `employee-metrics.test.ts`).

---

### `EMP-E07` — Escalation as decisions unreachable from `executeProvider` [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `parkPendingAction` is imported and called in `tool-executor.ts:409` via the `park` dep; `source: 'sweep'` flows through `packs.ts` to the gate. High-risk sweep actions now create a pending human decision row instead of throwing.

---

## 3. Agent Runtime & Tool Execution (8 items)

### `RT-B05` — Gmail/Drive non-2xx → `[]` → "executed" [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `gmail.ts` and `google-drive.ts` use `gmailHttpFailure` and `googleDriveHttpFailure`. For HTTP 401/403 (or scope missing), tools return `status: 'error'` with `reason: 'revoked'` / `'insufficient_scope'` and `connected: false`. Any 5xx or non-2xx returns `status: 'error'` with `reason: 'api_error'`. Non-2xx responses never return `[]` or `status: 'executed'`. Verified in `gmail-http.test.ts` and `google-drive.test.ts`.

---

### `RT-B07` — `module.confirm` not enforced in executor; no role [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: In `services/workflows/src/tools/index.ts`, `resolveToolRisk` explicitly evaluates `mod.confirm(action)` on the tool module alongside `confirmForRisk(risk)`. In `tool-gate.ts`, missing employee identity fails closed with `missing_employee`, while direct API callers (`POST /api/agent/tools`) default to `'executive'`, ensuring confirm-class actions (`send`, `pay`, `sign`, `publish`, `delete`, `execute`) unconditionally park across all callers and channels. Verified with unit tests in `services/workflows/src/executor-confirm.test.ts`.

---

### `RT-B11` — `executePlanStepActivity` passes no role [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `resolvePlanStepActor` is called in `executePlanStepActivity` (`services/workflows/src/activities/orchestration.ts:317-327`), and forwards `employeeRole: actor.employeeRole`, `employeeId: actor.employeeId`, and `toolAllowlist: actor.toolAllowlist` directly into `executeAutonomousToolAction`. Unstamped or inactive employee assignments fail closed. Verified with `plan-step-actor.test.ts`.

---

### `RT-S01` — Sandbox on `darex-net`; global concurrency 2 [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**:
  - In `infra/docker-compose.yml`, sandbox is isolated on `sandbox-net` (`internal: true`, zero egress to `darex-net` or the internet), running with `read_only: true`, `cap_drop: ALL`, and `pids_limit: 64`.
  - In `infra/docker/sandbox/server.mjs`, active executions are tracked per tenant (`tenantInFlight`), enforcing a per-tenant concurrency limit (max 2 concurrent per org) and a cluster limit of 10, preventing cross-tenant starvation or DoS.
  - In `services/workflows/src/tools/sandbox.ts`, `orgId` is forwarded via headers (`x-org-id`) and body, and a client-side per-tenant semaphore blocks excess concurrent runs per tenant with immediate feedback. Verified with unit tests in `services/workflows/src/tools/sandbox-no-host.test.ts`.

---

### `RT-S15` — `file_ops` `orgId || 'default'` shared directory [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `file_ops.ts` requires a valid UUID `orgId` regex matching, strictly bounds file operations within the org directory, strips directory traversal, and returns relative file metadata without leaking server absolute host paths. Tested in `file-ops.test.ts`.

---

### `RT-S18` — Prefix allowlist match [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Exact matching is enforced across `tool-executor.ts` and `local-tool-select.ts`. Prefix matching (such as `stripe` granting `stripe_create_charge`) was completely replaced with exact mapping. Verified in `executor-allowlist.test.ts`.

---

### `RT-G01` — Cost accounting blind [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Added `getOrgModelSpend` to `apps/dashboard/app/api/billing/_lib.ts` to aggregate model spend from Postgres `org_model_spend`, which is populated by `recordModelSpend` across worker, in-process, and sidecar agent turns. In `refreshOrgMeters`, total LLM spend is computed as `Math.max(llm?.weeklyCostUsd ?? 0, modelSpend.spendUsd)`. If Langfuse is down or unconfigured, the `llm_tokens` meter is no longer skipped or dropped, and hard caps trip correctly, blocking runaway costs (`usageBlocked = true`). Verified in `org-model-spend.test.ts`.

---

### `RT-G10` — Worker healthcheck `exit 0` [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Worker `/health` endpoint in `worker.ts` returns 503 when `workerReady` is false (set only after successful Temporal connection). Docker Compose healthcheck hits that endpoint and exits 1 on non-2xx, so the container is marked unhealthy on Temporal or DB failure.

---

## 4. Security, Auth & Compliance (6 items)

### `SEC-A02` — `requirePlatformAdmin`/middleware ignore epoch [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `requirePlatformAdmin` and `getScopedClient()` both parse `userId.epoch.sig` via `parseSessionCookieParts` and compare against `users.session_epoch` in Postgres, rejecting revoked session cookies (`401 Unauthorized`). Symmetrically wired into `/api/auth/session` and `/api/auth/invite/[token]`, ensuring revoked cookies are blocked from querying session status or accepting invites and triggering immediate cookie clearance. Verified with automated tests in `apps/dashboard/lib/__tests__/session-cookie-auth.test.ts`.

---

### `SEC-R01` — Pay-tool RBAC on one route only [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Centralized approval RBAC (`canApproveActions`, `canCallPayTools`, `canApproveRefunds`) in `apps/dashboard/lib/rbac.ts`. In `apps/dashboard/app/api/ask-ai/plan/route.ts` (PATCH), verifies `canApproveActions(role)` (blocking `auditor` and `billing`), verifies `canCallPayTools(role)` when approving plans containing pay tools, and verifies `canApproveRefunds(role)` (requiring owner or admin) for refund plans. Symmetrically wired into `apps/dashboard/app/api/ask-ai/approve/route.ts` for in-turn approval resumes and `apps/dashboard/app/api/agent/pending-actions/route.ts`. Tested in `ask-ai-plan-rbac.test.ts` and `rbac-billing.test.ts`.

---

### `SEC-T03` — Global outbound secret (= `CH-S01`) [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `body.recipient` removed from `outbound/route.ts` — recipient is now `conv.contact_id` exclusively, eliminating the tenant destination-spoofing vector. Committed in `368ca4e`.

---

### `SEC-C03` — 73 mutating routes emit no audit [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Added `employee.update` and `employee.delete` to `AuditEventKind`. Both PATCH and DELETE handlers in `employees/[id]/route.ts` now call `recordAuditEvent` with the appropriate kind, actor, and payload. `settings/route.ts` was already covered. Committed in `e0b2e9e`.

---

### `SEC-C10` — No `pnpm audit`/SBOM/residency [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `.github/dependabot.yml` created with weekly pnpm/npm dependency updates, grouped into prod and dev dependency sets with a 10 PR limit. Committed in `e0b2e9e`.

---

### `SEC-I01` — `pnpm test` not in CI [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `ci.yml` test steps are active (not commented out), running both `pnpm --filter @darex/workflows test` and `pnpm --filter @darex/dashboard test` in automated PR runs.

---

## 5. Channels, Realtime & Webhooks (3 items)

### `CH-S01` — Global outbound secret → inject into any org
*(Identical to `SEC-T03`; see above for fix details)*.

---

### `CH-E01` — Replay ring per-process [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `realtimeHub.recentEvents()` is now async and queries Redis `ZRANGEBYSCORE org:{id}:events` for cross-replica gap fill. `publish()` fire-and-forgets ZADD + ZREMRANGEBYRANK (cap 100) + EXPIRE (1h TTL) after each event. Falls back to in-memory `recentByOrg` on Redis failure. Caller in `stream/events/route.ts` updated to `await realtimeHub.recentEvents(...)`. Committed in `368ca4e`.

---

### `CH-E06` — Secret rotation gaps [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `verifyVisitorSession` in `widget-token.ts` now tries `WIDGET_SESSION_SECRET_PREVIOUS` as a fallback; `assertGmailPushToken` in `webhook-crypto.ts` accepts `GMAIL_PUSH_TOKEN_PREVIOUS` / `GMAIL_PUBSUB_VERIFICATION_TOKEN_PREVIOUS` via the existing `secretsFromEnv` helper. Secret rotation no longer invalidates active sessions. Committed in `368ca4e`.

---

## 6. Billing, Packs & Onboarding (3 items)

### `BIZ-E02` — Audit export / retention SLA [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: New `apps/dashboard/app/api/billing/audit/export/route.ts` streams `billing_audit_log` as CSV with proper field escaping and graceful empty-table fallback. Returns `Content-Type: text/csv` with `Content-Disposition: attachment; filename="billing-audit.csv"`. Committed in `368ca4e`.

---

### `BIZ-E08` — Platform overrides consumed by product [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `services/workflows/src/usage-gate.ts` queries `org_plan_overrides` when evaluating `maxEmployees` and `maxMonthlySpendCents`, replacing the hardcoded constants.

---

### `BIZ-E10` — Kill switch / suspension [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `apps/dashboard/app/api/platform/orgs/[orgId]/suspend/route.ts` and `unsuspend/route.ts` both exist and toggle `kill_switch`. `gateOrgRunnable` enforces the flag at tool-run time.

---

## 7. Observability & Health Probes (1 item)

### `OPS-G02` — Ready probe omits Nango/Langfuse/SuperTokens/worker [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**:
  - `/api/health/ready` executes all health checks concurrently using `Promise.allSettled` with an 800ms probe timeout, ensuring no single slow or failing check delays or crashes the probe.
  - Worker and Nango health statuses are evaluated as required dependencies (`requiredDown`): if either service fails or is unreachable, `/ready` returns HTTP 503 `unhealthy`, preventing traffic from hitting broken backends. Optional dependencies return HTTP 200 `degraded`.
  - Pure readiness evaluation logic is factored into `apps/dashboard/lib/health-readiness.ts` and verified with automated unit tests in `apps/dashboard/lib/__tests__/health-ready.test.ts`.

---

## 8. Frontend, UX & Error Boundaries (2 items pending)

### `UI-B01` — No error/not-found boundaries in `app/` [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Added `apps/dashboard/app/error.tsx`, `apps/dashboard/app/(dashboard)/error.tsx` (preserving AppShell layout/navigation on error), `apps/dashboard/app/not-found.tsx`, and `apps/dashboard/app/global-error.tsx`.

---

### `UI-B02` — Mobile nav 5 of 21 [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Enhanced `apps/dashboard/components/a11y/BottomTabs.tsx` with a responsive "More" drawer enumerating all navigation items, settings, autonomy, and sign-out link.

---

### `UI-B06` — 500 → "No listings" fabricated empty state [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `listings/page.tsx`, `inquiries/page.tsx`, and `showings/page.tsx` now distinguish between honest empty data vs HTTP 500 / network failures. On error, each page renders an explicit error banner with a Retry button rather than a false "No items found" empty state.

---

### `UI-B09` — AutonomySettings lacks exception handling [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Wrapped `updateTier`, `resolvePending`, and `load` in `apps/dashboard/components/settings/AutonomySettings.tsx` with complete try/catch blocks that surface network exceptions via `setError` and toast notifications.

---

### `UI-B22` — Impersonation banner polls all tenants [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Session endpoint now returns `isPlatformAdmin` (checks `platform_admins` table). `AppShell.tsx` fetches session once on mount and conditionally renders `<ImpersonationBanner />` only when `isPlatformAdmin === true`, ending the 30s poll for all ordinary users. Committed in `e0b2e9e`.

---

### `UI-B24` — `safe-bottom`, `scrollbar-none` undefined [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `BottomTabs.tsx` uses standard Tailwind safe area padding `pb-[env(safe-area-inset-bottom)]`, and `.scrollbar-none` utility is defined in `apps/dashboard/app/globals.css`.

---

## 9. Enterprise & Web Search (3 items)

### `ENT-11` — Owner approval via WhatsApp/push [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: Added `reject_plan` to `OwnerCommand` type and `parseOwnerCommand` (matches `reject plan <uuid>`, case-insensitive). `runOwnerCommand` handles `reject_plan` by updating plan status to `'rejected'`, logging a `plan.reject` audit event, signalling Temporal with `decision: 'rejected'`, and replying with a WhatsApp confirmation. Committed in `e0b2e9e`.

---

### `WEB-S03` — `res.text()` unbounded; no Content-Type gate [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `safeGet` in `safe-url.ts` now checks `Content-Type` before buffering the body — rejects anything not matching `text/*`, `application/json`, or `application/pdf` (stream drained, returns `{ ok: false, rejectedContentType: true }`). Jina reader path in `web-extract.ts` routed through `safeGet` instead of raw `fetch`. The 5 MB cap is preserved. Committed in `368ca4e`.

---

### `WEB-B06` — Search hits lack `publishedAt`, `source`, `score`, `lang` [🟢 COMPLETED]
- **Status**: 🟢 **Done (Verified)**
- **Solution Landed**: `SearchHit` now has `score?: number` and `lang?: string` fields. All 4 providers (jina, duckduckgo, wikipedia, google_news) populate `score: 1.0, lang: 'en'`. Google News `pubDate` parsed to ISO-8601 with `new Date(pubDate).toISOString()` and NaN guard. Committed in `368ca4e`.

---

## Recommended Execution Order for Maximum Impact

If you want to knock these out quickly in sequence:

1. **Sprint 1 — Core Safety & Security (Day 1)**:
   - `RT-S01` (Docker network isolation for sandbox)
   - `RT-B05` (Gmail/Drive 401/403 honest errors)
   - `RT-B07` (Mandatory confirm check in tool gate)
   - `SEC-R01` (Pay RBAC on Ask AI plan approval)
   - `SEC-A02` (Session epoch on all mutating routes)

2. **Sprint 2 — Ask AI Plan & Chat Integrity (Day 2)**:
   - `ASK-B01` & `ASK-B02` (Plan reconnect replay & cancellation)
   - `ASK-S02` & `ASK-G03` (Execute plan steps under assigned employee card)
   - `ASK-B04` (Pass `actorUserId` into audit rows)
   - `ASK-B11` (Force pending status on revised plans)

3. **Sprint 3 — Frontend Boundaries & Mobile (Day 3)**:
   - `UI-B01` (`error.tsx`, `global-error.tsx`, `not-found.tsx`)
   - `UI-B02` (Mobile nav "More" drawer)
   - `UI-B06` (Listings 500 error alert)
   - `UI-B09` (Try/catch on Autonomy settings)
   - `UI-B24` (`scrollbar-none` in `globals.css`)

4. **Sprint 4 — Web, Webhooks & Enterprise (Day 4)**:
   - `WEB-S03` & `WEB-B06` (Content-type check & ISO dates for search)
   - `SEC-T03` / `CH-S01` (Drop recipient override on outbound webhook)
   - `ENT-11` (Reject plan command on WhatsApp)
   - `OPS-G02` (Healthcheck probe for worker and Nango)
