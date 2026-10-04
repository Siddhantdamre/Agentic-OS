# 13 · Master tracker — every finding in one table

> ### 📊 Master Audit Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 28 | 4.7% |
> | 🟡 **Pending / In Progress** | 34 | 5.7% |
> | 🔴 **Not Done (Open)** | 538 | 89.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 0.2% |
> | **Total Findings** | **601** | **100.0%** |

One row per finding ID from files 02–11 and 14–16. `Sev`: P0 blocks an enterprise sale or is a live safety/tenancy hole; P1 must land before GA; P2 quality. `Pkt` = packet in `12-build-plan-waves.md` (WEB packets in `14` §15; SRCH/TAB/ENG in `15` §9; TOOL in `16` §10). `Status`: 🔴 open · 🟡 in progress / partially closed · 🟢 verified (typecheck + test + live) · ⛔ blocked on a human (reason in the domain file). Flip a row only in the same commit as the fix and `BUILD_STATE.md`.

Counts at audit time: **600 findings** (ASK 47 · EMP 50 · RT 62 · MEM 51 · CH 59 · SEC 55 · BIZ 73 · OPS 34 · UI 61 · ENT 12 · WEB 52 · **SRCH 13 · TAB 10 · ENG 8 · TOOL 13**) — **68 P0** at audit time, **69 P0** as of 2026-09-28 (`OPS-B13` added, found while closing `SEC-R01`; see `09-observability-workflows-infra-tests.md`). All 🔴 unless noted.

2026-09-27 code pass (unit-tested where 🟢): ASK-S01, RT-B01, RT-B02, RT-S02, RT-S03, RT-S09 are 🟢. Yellow rows in this file are in the tree but not proven against a live stack: RT-B05, RT-B07, RT-S01, RT-S15, RT-S18, RT-G10, OPS-G02, CH-S01, SEC-T03, SEC-I01, SEC-I06, UI-B01, UI-B02, UI-B06, ASK-S05. Everything else is still 🔴.

## Ask AI chat (`02`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| ASK-B01 | P0 | `running` plan re-executes every step on SSE reconnect | `execute/route.ts:158-160` | 1.8 | 🟢 (2026-09-29: non-durable reconnect to running plan re-attaches and resumes from current_step; completed steps replay from agent_plans.steps DB cache without tool re-invocation; in-memory activePlanExecutions prevents duplicate concurrent runs on the same node; verified in ask-ai-execute-reconnect.test.ts) |
| ASK-B02 | P0 | Durable plan cannot be cancelled once running | `PlanExecuteWorkflow.ts:98-200` | 2.2 | 🟢 (2026-09-29: in-flight stages wrapped in Temporal CancellationScope; rejectPlan signal triggers scope cancellation and halts in-flight activities; cleanup activity executes inside CancellationScope.nonCancellable ensuring cancelled status is persisted; subsequent stages do not run; verified in plan-execute-workflow.test.ts) |
| ASK-B03 | P0 | Hydration returns oldest 200 rows; newest messages vanish | `route.ts:1440-1447` | 2.2 | 🟢 (2026-09-28: queries newest 200 by `created_at DESC LIMIT 200` in subquery and re-sorts ASC outside; verified in `ask-ai-persist.test.ts`) |
| ASK-B04 | P1 | `userId` cast into params the executor never reads | `execute/route.ts:403-414` | 2.2 | 🟢 |
| ASK-B05 | P1 | `signalPlanDecision` swallows errors; approved in DB, workflow never wakes | `plan/route.ts:139-161` | 2.2 | 🔴 |
| ASK-B06 | P1 | Durable poll 240 s then SSE ends with no terminal event | `execute/route.ts:225-243` | 2.2 | 🔴 |
| ASK-B07 | P1 | `controller.enqueue` after disconnect throws in catch/finally | `route.ts:1216-1218` | 2.2 | 🔴 |
| ASK-B08 | P1 | Crew and direct paths persist different `tool_calls` shapes | `CrewWorkflow.ts:250-259` | 2.2 | 🔴 |
| ASK-B09 | P1 | Hydration drops routing/handoff/approvalBox/usage | `page.tsx:253-365` | 2.2 | 🔴 |
| ASK-B10 | P1 | Classification LLM (≤20 s) runs before first byte on every turn | `route.ts:615,641` | 2.2 | 🔴 |
| ASK-B11 | P1 | Revised plan stays `approved`; edited steps run without re-approval | `revise/route.ts:53,70-73`, `PlanCard.tsx`, `DraftPanel.tsx` | 2.2 | 🟢 (2026-09-28: revise forces status `pending`; PlanCard/DraftPanel UI reset execution state & show Pending Approval badge; verified in `DraftPanel.test.tsx` and `PlanCard.test.tsx`) |
| ASK-B12 | P2 | User message inserted before mode validation → orphan on 400 | `route.ts:423-435` | 2.2 | 🔴 |
| ASK-B13 | P2 | `startPlanExecuteWorkflow` failure silent; durability promised, not had | `route.ts:675-681` | 2.2 | 🔴 |
| ASK-B14 | P2 | PATCH `request.json()` unguarded; DELETE non-transactional, deletes running plans | `conversations/route.ts:197,261-280` | 2.2 | 🔴 |
| ASK-B15 | P2 | Plan mutations use stale closure, ignore non-OK | `page.tsx:1828-1918` | 2.2 | 🔴 |
| ASK-B16 | P2 | `done` event omits `usage`, includes unset `partialReply` | `route.ts:1323-1349` | 2.2 | 🔴 |
| ASK-B17 | P2 | `denyAskAiIfLimited(orgId)` org-bucket vs per-user POST | `execute/route.ts:103` | 2.2 | 🔴 |
| ASK-S01 | P0 | terminal/bash/python core for every employee; host fallback runs model code with `process.env` | `tool-executor.ts:28-39`, `sandbox.ts:162-216` | 1.3 | 🟢 (2026-09-28: sandbox risk `execute`, confirm-class) |
| ASK-S02 | P0 | Plan allowlist tautological; `employeeRole` never passed → confirm gate skipped | `execute/route.ts:403-414`, `orchestration.ts:311-317` | 1.4 | 🟢 (2026-09-28: `resolvePlanStepActor` derives stamped employee card allowlist + role, applies persona filters, and passes `toolAllowlist` and `employeeRole` to `executeAutonomousToolAction` in both Next.js and Temporal routes; verified in `plan-step-actor.test.ts`) |
| ASK-S03 | P1 | Resume uses full-catalog allowlist; `conversationId` not ownership-checked | `approve/route.ts:17-27,127` | 4.5 | 🔴 |
| ASK-S04 | P1 | `canCallPayTools` never consulted in ask-ai | `lib/rbac.ts:51-65` | 1.6 | 🟢 (2026-09-29: `canApproveActions`, `canCallPayTools`, and `canApproveRefunds` enforced across Ask AI: `ask-ai/plan` PATCH checks user role, blocking non-pay roles from financial plans and non-owners/non-admins from refunds; `ask-ai/approve` validates matching RBAC on in-turn decisions; tested in `ask-ai-plan-rbac.test.ts`) |
| ASK-S05 | P1 | Write-tool approval only when `REQUIRE_TOOL_APPROVAL==='true'` | `local-turn.ts:463-477` | 1.4 | 🟢 (2026-09-28: isToolApprovalRequired requires approval unconditionally for confirm-class [pay/send/sign/publish/delete/execute]; write actions default to requiring approval; read actions run unconfirmed; verified in executor-confirm.test.ts) |
| ASK-S06 | P1 | `DAREX_ALL_TOOLS` env bypass in shipped code | `local-tool-select.ts` | 4.5 | 🟡 (2026-09-28: removed the shipped environment bypass; regression test passes after build, live chat verification still pending) |
| ASK-S07 | P1 | Specialist replies concatenated unfenced into manager prompt | `crew-contract.ts:85-120` | 4.5 | 🔴 |
| ASK-S08 | P1 | Persona claims connection-gated tools are core; "never ask permission" | `route.ts:83-97` | 4.5 | 🔴 |
| ASK-S09 | P2 | Any member promotes any plan to playbook | `feedback/route.ts:114-128` | 4.5 | 🔴 |
| ASK-S10 | P2 | Memory/prior turns injected unfenced | `trueforge-client.ts:281-322` | 4.5 | 🔴 |
| ASK-G01 | P0 | `chat-coverage.md` does not exist | — | 2.1 | 🔴 |
| ASK-G02 | P0 | One "Approve & Execute" for whole plan; no per-step risk/employee/preview | `plan/route.ts:96-163` | 2.2 | 🔴 |
| ASK-G03 | P1 | Steps execute as org, not assigned employee | `ask-mode.ts:356-392` vs `execute:403` | 1.4 | 🟢 (2026-09-28: `resolvePlanStepActor` resolves stamped `employeeId`/`employeeRole` per step, loading card allowlist and persona filters before executing step) |
| ASK-G04 | P1 | Auto-crew from chat keyword-only | `route.ts:760-778` | 2.3 | 🔴 |
| ASK-G05 | P1 | Confirm classes not applied to chat outbound | `confirm-classes.ts` | 1.4 | 🔴 |
| ASK-G06 | P1 | Hand-off is static text | `route.ts:834-903` | 2.3 | 🔴 |
| ASK-G07 | P1 | No plan history/diff/re-run/resume | `page.tsx:1611-1785` | 2.2 | 🔴 (2026-09-28: cited `retryPrompt: undefined` evidence is stale — it's now conditionally set in several places; underlying gap — no plan history/diff, no resume-from-failed-stage — still open) |
| ASK-G08 | P1 | Planner `VALID_TOOLS` 12 of 109; playbook payloads empty | `plan-generator.ts:23-33` | 2.1 | 🔴 |
| ASK-G09 | P2 | Regex synthesises founder/year claims | `tool-answer.ts:286-300` | 2.1 | 🔴 |
| ASK-G10 | P2 | `ActionPermissionCard` never receives data | `page.tsx:2355-2360` | 2.1 | 🔴 |
| ASK-G11 | P2 | `MENTION_ALLOWLIST_MODE='org-union'` contradicts locked mode | `employee-mentions.ts:1-8` | 2.3 | 🔴 |
| ASK-E01 | P0 | No audit for cancel/edit/approve/deny/mode/crew/executed tool | `audit-events.ts` one caller | 1.9 | 🟢 2026-10-05 |
| ASK-E02 | P1 | Per-process concurrency cap; no per-user quota; no `Retry-After` | `rate-limit.ts:98-99` | 3.5 | 🔴 |
| ASK-E03 | P1 | No correlation id; no stream/approval/plan metrics | `route.ts:683-690` | 0.6 / 4.1 | 🔴 |
| ASK-E04 | P1 | No retention/redaction on `messages.content`/`tool_calls` | `route.ts:423-435` | 3.2 | 🔴 |
| ASK-E05 | P1 | Tool results + resumable session id in localStorage, no TTL/wipe | `page.tsx:905-948` | 4.5 | 🔴 |
| ASK-E06 | P2 | Generic a11y labels; no live region | `PlanCard.tsx:115` | 4.9 | 🔴 |
| ASK-E07 | P2 | Hardcoded English | everywhere | 4.6 | 🔴 |
| ASK-E08 | P2 | Timeouts constants; no retry on HTTP path | `route.ts:1234-1263` | 4.9 | 🔴 |
| ASK-E09 | P2 | Zero route tests for approve/execute/plan edit | — | 0.1 | 🔴 |

## AI employees (`03`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| EMP-B01 | P0 | `EMERGENCY_RE` (fire/drive/flood) → dispatch → null → org-union allowlist | `route-employee.ts:73-82` | 2.3 | 🟢 (2026-09-28: `WorkItemWorkflow` already short-circuited dispatch/human before touching tools, but `routeEmployeeActivity` still returned a full caller-allowlist fallback attached to that result — a landmine for any future caller. New `mergeRoutedForCaller` only applies the caller-allowlist/identity fallback for a real `employee` destination; `route-employee.test.ts` covers both branches, workflows 330/330) |
| EMP-B02 | P0 | `routeEmployeeActivity` inherits webhook default allowlist when routed list empty | `activities/index.ts:606-612` | 2.3 | 🟢 2026-10-05 |
| EMP-B03 | P1 | Custom roles infer `other`; never picked; org-union fallback | `route-employee.ts:243,292-294` | 2.3 | 🔴 |
| EMP-B04 | P1 | Keyword collisions (returns/sheets/drive/lead) | `route-employee.ts:92-98` | 2.3 | 🔴 |
| EMP-B05 | P1 | Empty `toolAllowlist` ⇒ org union | `tool-executor.ts:255-259` | 2.3 | 🟢 (2026-09-28: side effect of the `tool-gate.ts` refactor — `resolveOrgToolAllowlist`'s org-union fallback no longer exists anywhere; an empty employee card now falls through to core-read-only, never a union) |
| EMP-B06 | P1 | `loadEmployeeAutonomyTier` picks any rule row | `tool-executor.ts:45-65` | 2.3 | 🔴 |
| EMP-B07 | P1 | Locked Executive/Research hand-offs mis-target | `handoffs/*.ts` | 2.3 | 🔴 |
| EMP-B08 | P1 | Calendar deadlock audit emails guests daily forever | `meeting-prep.ts:37-60` | 1.8 | 🔴 |
| EMP-B09 | P1 | Persona inferred from role/name substrings | `role-capability.ts:29-41` | 2.3 | 🔴 |
| EMP-B10 | P1 | Two `filterAllowlistForPersona` with opposite semantics | `role-scoped-tools.ts:31-36` vs `role-capability.ts:56-63` | 2.3 | 🔴 |
| EMP-B11 | P1 | Employee PATCH unvalidated; re-activates archived | `employees/[id]/route.ts:55-136` | 2.3 | 🔴 |
| EMP-B12 | P2 | automationRate = active/total employees | `employees/stats/route.ts:31-32` | 2.4 | 🔴 |
| EMP-B13 | P2 | Crew domain picker misroutes; double-assigns | `crew-planner.ts:97-105` | 2.3 | 🔴 |
| EMP-B14 | P2 | Crew spend check only when >1 specialist; fails open | `CrewWorkflow.ts:88-108` | 1.11 | 🔴 |
| EMP-B15 | P2 | Parent cancel does not cancel children | `CrewWorkflow.ts:155-233` | 4.3 | 🔴 |
| EMP-B16 | P2 | Two sweep lists (9 vs 12) | `employee-provision.ts:69-102` | 2.3 | 🔴 |
| EMP-B17 | P2 | Roster queries omit `archived_at IS NULL` | `agent/crew/route.ts:43-49` | 2.3 | 🔴 |
| EMP-S01 | P0 | Kill switch read only in outbound-budget | `outbound-budget.ts:15` | 1.5 | 🟢 (2026-09-28: `gateOrgRunnable` reads `kill_switch` off `org_runtime_controls` in the ordered tool gate; every call through `executeAutonomousToolAction` denies `kill_switch` before the provider runs — `executor-gate.test.ts`) |
| EMP-S02 | P0 | Six activities call raw `executeProvider` — no allowlist/autonomy/critic | `meeting-prep.ts:129-141`, `growth.ts:633…` | 1.5 | 🟡 enrichment gated 2026-10-05; operator alerts still raw |
| EMP-S03 | P0 | Rollout stage 0 not shadow; gate/rollout modules no callers | `employee-gate.ts`, `outage-budget.ts:16` | 1.5 | 🟢 (2026-09-28: `evaluateEmployeeGate` is now called from `tool-gate.ts` and enforced — `deny_role` blocks, `shadow` suppresses+logs and never invokes the provider, `escalate` parks — `executor-gate.test.ts`) |
| EMP-S04 | P1 | Critic only on WorkItem replies | `critic-check.ts:217` | 1.5 / 2.6 | 🟡 (2026-09-28: `guarded-send.ts` now routes through the gated `executeAutonomousToolAction`, and `tool-gate.ts` runs the critic for every `risk:'send'` action — guarded sends are critic-checked; `meeting-prep.ts`/`growth.ts`/`rep-followup-sla.ts`/`workload-balancer.ts` still call raw `executeProvider` directly, so coverage is incomplete (see `EMP-S02`)) |
| EMP-S05 | P1 | Per-customer daily cap not enforced | `guarded-send.ts:119` | 1.5 | 🔴 |
| EMP-S06 | P1 | Quiet hours ignored by Slack/MeetingPrep/RepFollowUp/chat | `guarded-send.ts:184` only | 1.5 | 🔴 |
| EMP-S07 | P1 | Action denials soft when tool on card | `role-capability.ts:79-97` | 1.4 | 🔴 |
| EMP-S08 | P1 | `sendChannelMessage` skips role denial, bypasses card | `guarded-send.ts:157-172` | 1.4 | 🔴 |
| EMP-S09 | P1 | Ledger defaults empty role to `operations` | `autonomy.ts:547` | 2.3 | 🔴 |
| EMP-S10 | P2 | `MENTION_ALLOWLIST_MODE` drift | `employee-mentions.ts:8` | 2.3 | 🔴 |
| EMP-S11 | P2 | Suspended orgs keep sweeping until restart | `periodic-registry.ts:65` | 1.5 | 🔴 |
| EMP-S12 | P2 | Four autonomy-default definitions; seeder unused | `employee-provision.ts:5-28` | 2.3 | 🔴 |
| EMP-G01 | P0 | `employee-gate`/`employee-metrics`/`cold-start` only imported by tests | — | 1.5 | 🟢 (2026-09-29: `employee-gate.ts` wired into `tool-gate.ts`; `recordEmployeeMetrics` wired into `tool-gate` and `writeLedgerRow`; `DEFAULT_AUTONOMY_SEED` and `seedColdStart` imported in `employee-provision.ts` and onboarding completion) |
| EMP-G02 | P0 | `DormantLeadRevival` never started; doc says working | `periodic-registry.ts` | 4.3 | 🔴 |
| EMP-G03 | P1 | No `employee_id` on metrics/ledger | `026:203`, `023:206` | 2.4 | 🔴 |
| EMP-G04 | P1 | Customer card lacks shopify | — | 3.6 | 🔴 |
| EMP-G05 | P1 | `outage-buffer.ts` unwired | — | 3.7 | 🔴 |
| EMP-G06 | P1 | Dedup has no real CRM merge | `dedup.ts:49-60` | 4.9 | 🔴 |
| EMP-G07 | P1 | No delegation protocol | `ask-ai/route.ts:834-903` | 2.3 | 🔴 |
| EMP-G08 | P1 | Webhook picks first-created employee | `webhooks/whatsapp/route.ts:165-172` | 2.3 | 🔴 |
| EMP-G09 | P2 | 12 hardcoded tools in picker | `employees/page.tsx:61-74` | 3.6 | 🔴 |
| EMP-G10 | P2 | `MAX_CREW_SPAWN` twice; docs say 8 | `crew-contract.ts:11` | 2.3 | 🔴 |
| EMP-E01 | — | Per-employee KPIs/SLA/scorecard | — | 2.4 | 🔴 |
| EMP-E02 | — | Per-employee approval rate / reviews | `org/rollout/route.ts:65` | 2.4 | 🔴 |
| EMP-E03 | — | Versioning / prompt history / A-B | — | 4.9 | 🔴 |
| EMP-E04 | — | Per-employee cost budgets | `029` | 2.4 | 🔴 |
| EMP-E05 | — | Marketplace / templates | — | 3.6 | 🔴 |
| EMP-E06 | — | Custom employee builder | `employees/route.ts:107-135` | 3.6 | 🔴 |
| EMP-E07 | — | Escalation as decisions unreachable from `executeProvider` paths | `autonomy.ts:414-493` | 1.5 | 🟡 |
| EMP-E08 | — | Schedules / shifts | `quiet-hours.ts:6-7` | 3.7 | 🔴 |
| EMP-E09 | — | Multi-language | — | 4.6 | 🔴 |
| EMP-E10 | — | Roster changes unaudited | `employees/route.ts` | 1.9 | 🔴 |
| EMP-E11 | — | Per-employee autonomy rules UI | `023:266` | 4.9 | 🔴 |

## Agent runtime & tools (`04`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| RT-B01 | P0 | `database_query` allows CTE writes and `set_config` | `tools/database.ts:16,42-43` | 1.3 | 🟢 |
| RT-B02 | P0 | Sandbox host fallback with `process.env` | `tools/sandbox.ts:162-216` | 1.3 | 🟢 |
| RT-B03 | P0 | Three re-execution paths, no idempotency | `local-turn.ts:814-834` | 1.8 | 🟢 failover stop + per-activity retry claim |
| RT-B04 | P0 | ~85 fetches without abort; executor 15 s < module 20 s | `tool-executor.ts:67-82` | 1.8 | 🔴 |
| RT-B05 | P0 | Gmail/Drive non-2xx → `[]` → "executed" | `tools/gmail.ts:275-288` | 1.8 | 🟢 (2026-09-28: gmailHttpFailure & googleDriveHttpFailure return status:'error' with reason:'revoked'|'insufficient_scope'|'api_error'; non-2xx never returns [] or executed; verified in gmail-http.test.ts and google-drive.test.ts) |
| RT-B06 | P0 | No zod parse; monetary/channel defaults | `local-turn.ts:407-412`, `stripe.ts:161` | 1.4 | 🔴 |
| RT-B07 | P0 | `module.confirm` not enforced in executor; no role → autonomy skipped | `tool-executor.ts:345-346` | 1.4 | 🟢 (2026-09-29: `resolveToolRisk` enforces `mod.confirm(action)` on tool modules alongside `confirmForRisk(risk)`; `tool-gate.ts` parks confirm-class actions across all callers; missing employee identity fails closed; verified in `executor-confirm.test.ts`) |
| RT-B08 | P1 | No tool-call cap on in-process turn | `local-turn.ts:612` | 4.3 | 🔴 |
| RT-B09 | P1 | 422 approvals-pending → session recreated, approvals lost | `trueforge-client.ts:514-556` | 4.3 | 🔴 |
| RT-B10 | P1 | No provider idempotency keys | all write tools | 1.8 | 🔴 |
| RT-B11 | P1 | `executePlanStepActivity` passes no role | `orchestration.ts:288-333` | 1.4 | 🟢 (2026-09-29: `executePlanStepActivity` resolves `resolvePlanStepActor(orgId, step)` and forwards real `employeeRole`/`employeeId`/`toolAllowlist` into `executeAutonomousToolAction`; covered by `plan-step-actor.test.ts`) |
| RT-B12 | P1 | Model-supplied `employee_role` used | `mcp-bridge.ts:1622-1623` | 1.4 | 🔴 |
| RT-B13 | P1 | In-process turns bypass Langfuse/LiteLLM; usage dropped | `local-turn.ts:246-262` | 1.11 | 🟡 |
| RT-B14 | P1 | Usage gate fails open | `usage-gate.ts:199-206` | 1.11 | 🔴 |
| RT-B15 | P1 | Breaker counts aborts/400s | `circuit-breaker.ts` | 4.3 | 🔴 |
| RT-B16 | P1 | In-memory provider rate limit | `tools/provider-rate-limit.ts` | 4.3 | 🔴 (2026-09-28: file moved to `tools/provider-rate-limit.ts`; re-confirmed still an in-memory `Map` per process) |
| RT-B17 | P1 | 48 Nango GETs per Google auth resolve | `tools/shared.ts:298-314` | 3.6 | 🔴 |
| RT-B18 | P1 | Session reuse ignores instruction changes | `trueforge-client.ts:431-438` | 4.3 | 🔴 |
| RT-B19 | P1 | Worker concurrency 100 vs pool 10; no heartbeat | `worker.ts:48-53` | 4.3 | 🔴 |
| RT-B20 | P2 | `idempotencyKey` includes `Date.now()`; sessions never deleted | `workflow-client.ts:55-60` | 4.3 | 🔴 |
| RT-B21 | P2 | Stream polls 4 min vs 20 min workflow | `agent/stream/route.ts:218` | 4.3 | 🔴 |
| RT-B22 | P2 | Approval token into model context | `tool-executor.ts:393` | 1.4 | 🟢 (2026-09-28: verified — `park()` (`tool-executor.ts:401-411`) returns only `pendingActionId`/`workItemId`; the raw token from `parkPendingAction` is generated but discarded before reaching the model) |
| RT-B23 | P2 | `file_ops` risk from `auto_execute` | `mcp-bridge.ts:1557-1559` | 4.5 | 🟢 (2026-09-28: verified — `file-ops.ts:7-14` declares `ACTIONS=['read_file','write_file']` with `riskFor` correctly returning `draft` for writes; `mcp-bridge.ts` resolves risk from the real action, no more `auto_execute` catch-all read as read-only) |
| RT-B24 | P2 | Lists truncated silently | only `meta-ads.ts:36` pages | 2.1 | 🔴 |
| RT-B25 | P2 | Slack network error → `notConnected` | `slack.ts:145-149` | 4.5 | 🔴 |
| RT-B26 | P2 | Persona by substring | `role-capability.ts:29-41` | 2.3 | 🔴 |
| RT-B27 | P2 | `notifyManagersOfDecisionCard` bypasses executor | `autonomy.ts:501-531` | 4.5 | 🔴 |
| RT-B28 | P2 | `type.includes('approval')` | `trueforge-client.ts:708-709` | 4.5 | 🔴 |
| RT-S01 | P0 | Sandbox on `darex-net`; global concurrency 2 | `docker-compose.yml:725-747` | 1.3 | 🟢 (2026-09-29: Verified — dedicated `sandbox-net` has `internal: true` with zero egress to `darex-net` or internet; `server.mjs` and `sandbox.ts` track active runs per tenant (`x-org-id`), enforce per-tenant limit of 2 concurrent runs preventing starvation, and forward `orgId`; tested in `sandbox-no-host.test.ts`) |
| RT-S02 | P0 | Host fallback leaks env | `sandbox.ts:186` | 1.3 | 🟢 |
| RT-S03 | P0 | RLS GUC mutable from chat | `database.ts` | 1.3 | 🟢 |
| RT-S04 | P0 | BYOK plaintext | `whatsapp.ts:51-57`, `razorpay.ts:15-23` | 3.2 | 🟢 sealed (2026-10-05) |
| RT-S05 | P1 | SSRF check string-only; no redirect/DNS/IPv6 | `web-extract.ts:11-49` | 4.5 | 🟢 (2026-09-28: same fix as `WEB-S01` — `tools/safe-url.ts` does real DNS resolution at connect time, re-checks every redirect hop, blocks non-canonical IP literals/link-local/metadata; `web-extract.ts` calls it before both Jina and direct-fetch paths; 7 unit tests + live checks) |
| RT-S06 | P1 | Gmail header CRLF injection | `gmail.ts:437-438` | 4.5 | 🔴 |
| RT-S07 | P1 | No injection fence on HTTP-sidecar path | `mcp-bridge.ts:1643-1665` | 4.5 | 🔴 |
| RT-S08 | P1 | Model-controlled role alters gating | `mcp-bridge.ts:1622-1623` | 1.4 | 🔴 |
| RT-S09 | P1 | code/terminal/python/file_ops core for all | `tool-executor.ts:28-39` | 1.3 | 🟢 |
| RT-S10 | P1 | Global env fallbacks send via platform account | `whatsapp.ts:71`, `google-ads.ts:18` | 3.2 | 🔴 |
| RT-S11 | P1 | Fail-fast skips bridge/Nango/LiteLLM/Langfuse defaults | `prod-failfast.sh:10-24` | 3.2 | 🔴 |
| RT-S12 | P1 | TrueForge HTTP API unauthenticated | `trueforge-client.ts:365,493` | 3.2 | 🔴 |
| RT-S13 | P2 | OTPs into model context | `gmail.ts:198-215` | 4.5 | 🔴 |
| RT-S14 | P2 | PaymentIntent `clientSecret` to model | `stripe.ts:71` | 4.5 | 🔴 |
| RT-S15 | P2 | `file_ops` `orgId || 'default'` | `file-ops.ts:41,62` | 1.3 | 🟢 |
| RT-S16 | P2 | Every service loads every `.env` | `compose:571-579` | 3.2 | 🔴 |
| RT-S17 | P2 | Dev DB password compiled into worker | `shared.ts:20-21` | 3.2 | 🔴 |
| RT-S18 | P2 | Prefix allowlist match | `tool-executor.ts:214-219` | 1.4 | 🟡 |
| RT-G01 | P0 | Cost accounting blind | `billing/_lib.ts:1120-1180`, `litellm/config.yaml` | 1.11 | 🟡 |

| RT-S17 | P2 | Dev DB password compiled into worker | `tools/shared.ts:16-19` | 3.2 | 🔴 (2026-09-28: file moved to `tools/shared.ts:16-19`; re-confirmed `darex_app_dev_secret` default still compiled in) |
| RT-S18 | P2 | Prefix allowlist match | `tool-executor.ts:214-219` | 1.4 | 🟢 |
| RT-G01 | P0 | Cost accounting blind | `billing/_lib.ts:1120-1180`, `litellm/config.yaml` | 1.11 | 🟢 (2026-09-29: `getOrgModelSpend` in `apps/dashboard/app/api/billing/_lib.ts` aggregates model spend from `org_model_spend` in Postgres, populated by `recordModelSpend` across all worker/in-process turns; `refreshOrgMeters` uses `Math.max(langfuse, dbSpend)` and never drops `llm_tokens` when Langfuse is down, correctly tripping hard cap circuit breakers. Verified in `org-model-spend.test.ts`.) |
| RT-G02 | P1 | No per-org concurrency/QPS on agent routes | `agent/*` | 3.5 / 4.4 | 🔴 |
| RT-G03 | P1 | Approval state process-local | `activeLocalOrchestrators` | 1.9 | 🔴 |
| RT-G04 | P1 | Two divergent approval executors | `pending-actions`, `work-items/[id]/decision:335` | 1.9 | 🔴 (2026-09-28: mechanism changed — `work-items/[id]/decision` now signals Temporal via `approveWorkItem`, `skipAutonomy` no longer used there — but the core problem is unchanged: `pending-actions/route.ts` still only flips DB status, never executes) |
| RT-G05 | P1 | No pagination contract | — | 2.1 | 🔴 |
| RT-G06 | P1 | No tool invocation audit table | — | 4.5 | 🟡 |
| RT-G07 | P1 | No token budget / compaction in-process | — | 4.3 | 🔴 |
| RT-G08 | P1 | Nango 401 not retried | gmail/hubspot/drive | 3.6 | 🔴 |
| RT-G09 | P2 | No provider SLO metrics | — | 4.1 | 🔴 |
| RT-G10 | P2 | Worker healthcheck `exit 0` | — | 0.4 | 🟡 |
| RT-G11 | P2 | Temporal client no TLS/key | — | 4.3 | 🔴 |
| RT-E01 | — | Nine tool modules without connect UI | — | 2.1 | 🔴 |
| RT-E02 | — | `agent-runtime.md` overclaims closed | — | 0.5 | 🔴 |
| RT-E03 | — | No backup for TrueForge/workspace volumes | — | 4.2 | 🔴 |
| RT-E04 | — | No per-tenant LLM key routing | `litellm/config.yaml:46` | 4.7 | 🔴 |
| RT-E05 | — | Runtime pinned to `0.2.0-rc.0` | — | 2.6 | 🔴 |

## Memory / brain (`05`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| MEM-B01 | P0 | Parent file row never `ready` | `ingest-file.ts:583,835` | 1.10 | 🟢 2026-10-05 |
| MEM-B02 | P0 | Disabling a file does not hide its chunks | `retrieve.ts:296-303` | 1.10 | 🟢 2026-10-05 |
| MEM-B03 | P0 | `pendingText` lost-write race | `embed.ts:601-631` | 1.10 | 🔴 |
| MEM-B04 | P1 | Write-back facts never embedded | `memory-writeback.ts:353-388` | 1.10 | 🔴 |
| MEM-B05 | P1 | Vector range predicate defeats HNSW | `retrieve.ts:342-343` | 2.7 | 🔴 |
| MEM-B06 | P1 | Timeout race always trips | `retrieve.ts:717-725` | 2.7 | 🔴 |
| MEM-B07 | P1 | Retrieval before routing; persona tiers never applied | `WorkItemWorkflow.ts:180-187` | 2.7 | 🔴 |
| MEM-B08 | P1 | Body stored unredacted; FTS snippets leak | `brain/route.ts:491-497` | 1.10 | 🔴 |
| MEM-B09 | P1 | Only `chunks[0]` embedded | `embed-enqueue.ts:261-273` | 2.7 | 🔴 |
| MEM-B10 | P1 | Re-embed void-fired in request | `embed-enqueue.ts:268-279` | 1.10 | 🔴 |
| MEM-B11 | P1 | Source DELETE leaves ghost memory | `brain/[id]/route.ts:235-244` | 1.10 | 🔴 |
| MEM-B12 | P1 | Drive cursor reuses stale pageToken → 400 | `ingest-file.ts:998-1019` | 2.7 | 🔴 |
| MEM-B13 | P1 | Job queued forever on start failure | `embed.ts:640-648` | 1.10 | 🔴 |
| MEM-B14 | P2 | Rename → duplicate; no tombstones | `ingest-file.ts:1041` | 2.7 | 🔴 |
| MEM-B15 | P2 | Whole file buffered; no size cap | `ingest-file.ts:447-462` | 2.7 | 🔴 |
| MEM-B16 | P2 | Sheets/HubSpot `ready` with no text | `ingest-file.ts:1115-1314` | 2.7 | 🔴 |
| MEM-B17 | P2 | Policy blocks counted as duplicates | `memory-writeback.ts:633-636` | 2.7 | 🔴 |
| MEM-B18 | P2 | One workflow per chunk; N+1 | `embed.ts:816-991` | 2.7 | 🔴 |
| MEM-B19 | P2 | Global LIMIT 48 vs documented per-tier 12 | `retrieve.ts:41` | 2.7 | 🔴 |
| MEM-B20 | P2 | English-only tsvector | `013:49-55` | 4.6 | 🔴 |
| MEM-S01 | P0 | Raw PII to Cognee/OpenRouter | `memory-writeback.ts:753-765` | 1.10 | 🔴 |
| MEM-S02 | P0 | Inbound messages org-wide memory, no policy gate | `WorkItemWorkflow.ts:253` | 1.10 | 🔴 |
| MEM-S03 | P1 | Cognee no access control | `docker-compose.yml:707` | 2.7 | 🔴 |
| MEM-S04 | P1 | Cognee never deleted on DSR/purge | `dsr/tables.ts:31-48` | 1.10 | 🔴 |
| MEM-S05 | P1 | `memory_revisions`, `pendingText` outside delete lists | `094:7-16` | 1.10 | 🔴 |
| MEM-S06 | P1 | Forged provenance persisted | `memory-writeback.ts:207-257` | 2.7 | 🔴 |
| MEM-S07 | P1 | Brain mutations unaudited | `brain/[id]/route.ts:218-266` | 1.9 | 🔴 |
| MEM-S08 | P2 | Graph citations bypass tier exclusion | `cognee-client.ts:148` | 2.7 | 🔴 |
| MEM-S09 | P2 | Timeout race leaves dirty connection | `retrieve.ts:565-571` | 1.10 | 🔴 |
| MEM-G01 | P0 | Only Drive + pasted text ingest | `ingest-file.ts:64` | 2.7 | 🔴 |
| MEM-G02 | P0 | No scheduled sync | `periodic-registry.ts:22-33` | 2.7 | 🔴 |
| MEM-G03 | P0 | Citations lose row identity | `retrieve.ts:432` | 2.7 | 🔴 |
| MEM-G04 | P1 | Per-employee memory never written | `employee-retrieve.ts:22-45` | 2.7 | 🔴 |
| MEM-G05 | P1 | Entity graph unwritten; edges unread | `retrieve.ts:625-654` | 2.7 | 🔴 |
| MEM-G06 | P1 | Learning-loop events have no caller | `memory-writeback.ts:624-627` | 2.7 | 🔴 |
| MEM-G07 | P1 | No supersedes chain | `retrieve.ts:413-417` | 2.7 | 🔴 |
| MEM-G08 | P1 | No retrieval eval | — | 2.6 | 🔴 |
| MEM-G09 | P1 | No reranker; hard-coded blend | `retrieve.ts:342,414` | 2.7 | 🔴 |
| MEM-G10 | P2 | No facets; keyword entity search | `brain/route.ts:279` | 2.7 | 🔴 |
| MEM-G11 | P2 | No bulk forget / export | — | 2.7 | 🔴 |
| MEM-G12 | P2 | Docs cite non-existent table | `brain.md:56,80` | 0.5 | 🔴 |
| MEM-E01 | P0 | DSR delete: Cognee/revisions/cursors missing | — | 3.3 | 🟡 2026-10-05 |
| MEM-E02 | P1 | Encryption at rest | — | 4.7 | 🔴 |
| MEM-E03 | P1 | Retention | `expires_at` unused | 3.2 | 🔴 |
| MEM-E04 | P1 | Audit of memory reads/writes | — | 1.9 | 🔴 |
| MEM-E05 | P1 | Quotas | — | 2.7 | 🔴 |
| MEM-E06 | P1 | Embedding cost unrecorded | `embed.ts` | 1.11 | 🔴 |
| MEM-E07 | P1 | Backup/restore for Cognee | — | 4.2 | 🔴 |
| MEM-E08 | P2 | Residency | — | 4.7 | 🔴 |
| MEM-E09 | P2 | Virus scan / parsers | — | 4.7 | 🔴 |
| MEM-E10 | P2 | RLS vector test not in `pnpm test` | — | 2.7 | 🔴 |

## Channels, conversations, realtime (`06`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| CH-B01 | P1 | `wamid` never stored → receipts dead | `channel-outbound.ts:168-175` | 2.5 | 🔴 |
| CH-B02 | P1 | SSE event schema drift hub vs routes vs pages | `realtime-hub.ts:16-25` | 2.5 | 🔴 |
| CH-B03 | P1 | Dashboard awaits 24 h HITL in-process | `inbound-agent.ts:148-172` | 2.5 | 🔴 |
| CH-B04 | P1 | Gmail history always empty; self-reply loop | `WH/gmail/route.ts:96-122` | 2.5 | 🔴 |
| CH-B05 | P1 | Widget visitors merge into one conversation | `widget/session/route.ts:39-45` | 1.7 | 🔴 |
| CH-B06 | P1 | Human replies never shown to widget | `widget/message/route.ts:93-103` | 2.5 | 🔴 |
| CH-B07 | P1 | Ring duplicates on Redis echo | `realtime-hub.ts:130-144` | 2.5 | 🔴 |
| CH-B08 | P1 | `recentByOrg` never evicted | `realtime-hub.ts:42-49` | 2.5 | 🔴 |
| CH-B09 | P1 | `cancel()` does not unsubscribe | `stream/events/route.ts:205-208` | 2.5 | 🔴 |
| CH-B10 | P1 | `ensureReady` after 200 sent | `widget/stream/route.ts:95-106` | 2.5 | 🔴 |
| CH-B11 | P1 | Webhook limits per-process | `rate-limit-core.ts:98-132` | 1.7 | 🔴 |
| CH-B12 | P1 | Human reply row before send; no failed status | `messages/route.ts:180-186` | 1.7 | 🔴 |
| CH-B13 | P1 | Find-or-create race → duplicate conversations | `channel-normalize.ts:254-310` | 1.7 | 🔴 |
| CH-B14 | P2 | GCal sync inline before 200 | `WH/google-calendar:139-143` | 2.5 | 🔴 |
| CH-B15 | P2 | Rent-payment Stripe sig no tolerance/dedupe | `WH/rent-payment:20-33` | 1.7 | 🔴 |
| CH-B16 | P2 | Message history unbounded | `messages/route.ts:79-87` | 2.5 | 🔴 |
| CH-B17 | P2 | Raw `err.message` in 500s | `conversations/route.ts:198` | 2.5 | 🔴 |
| CH-B18 | P2 | Two GROUP BY scans per list | `conversations/route.ts:152-164` | 2.5 | 🔴 |
| CH-B19 | P2 | `channelType:'unknown'` in event | `[id]/route.ts:111` | 2.5 | 🔴 |
| CH-B20 | P2 | `needs_attention` steals focus | `conversations/page.tsx:161-163` | 2.5 | 🔴 |
| CH-B21 | P2 | Outbound idempotency claim fails open | `inbound-agent.ts:290-294` | 1.8 | 🔴 |
| CH-B22 | P2 | Widget polling stops at 300 s | `widget-embed-src.ts:203-222` | 2.5 | 🔴 |
| CH-B23 | P2 | Chatwoot `account_id=''` wildcard | `channel-normalize.ts:160-166` | 2.5 | 🔴 |
| CH-B24 | P2 | Chatwoot status/edit events ignored | `WH/chatwoot:217-229` | 2.5 | 🔴 |
| CH-S01 | P0 | Global outbound secret → inject into any org | `WH/outbound/route.ts:14-18` | 1.7 | 🟡 |
| CH-S02 | P1 | Slack orgId from button payload | `slack-interact.ts:49-57` | 1.7 | 🔴 |
| CH-S03 | P1 | Cross-visitor transcript exposure | `widget/session:43-45` | 1.7 | 🔴 |
| CH-S04 | P1 | Attachment URL scheme unvalidated | `messages/route.ts:51-68` | 2.5 | 🔴 |
| CH-S05 | P1 | No RBAC on conversations/stream mutations | `conversations/route.ts:222-238` | 1.6 | 🔴 |
| CH-S06 | P1 | Plaintext channel tokens | `integrations/whatsapp:34-42` | 3.2 | 🔴 |
| CH-S07 | P1 | DLQ rows `org_id` NULL → invisible | `failed-webhooks.ts:30-39` | 1.1 | 🔴 |
| CH-S08 | P2 | WABA fallback picks newest across orgs | `WH/whatsapp:294-302` | 1.7 | 🔴 |
| CH-S09 | P2 | Owner phone suffix match | `channel-normalize.ts:435` | 2.5 | 🔴 |
| CH-S10 | P2 | No-Origin bypasses widget allowlist | `widget/_lib.ts:121-131` | 2.5 | 🔴 |
| CH-S11 | P2 | Widget dev fallback secret | `widget-token.ts:11` | 2.5 | 🔴 |
| CH-S12 | P2 | Non-prod skips signatures | `webhook-crypto.ts:78-83` | 2.5 | 🔴 |
| CH-S13 | P2 | Response echoes org_id | `WH/chatwoot:474-482` | 2.5 | 🔴 |
| CH-G01 | P1 | WhatsApp templates / 24 h / STOP | `channel-outbound.ts:144-186` | 2.5 | 🔴 |
| CH-G02 | P1 | Two-way parity (Slack only) | — | 2.5 | 🔴 |
| CH-G03 | P1 | Inbox tags/snooze/bulk/canned/CSAT | — | 2.5 | 🔴 |
| CH-G04 | P1 | Human seat / handoff protocol | — | 2.5 / 3.7 | 🔴 |
| CH-G05 | P1 | SLA only on API messages | — | 2.5 | 🔴 |
| CH-G06 | P1 | Webhook replies bypass quiet hours/budget | `inbound-agent.ts:258-260` | 1.5 | 🔴 |
| CH-G07 | P1 | Delivery receipts dead | = B01 | 2.5 | 🔴 |
| CH-G08 | P1 | Retry no jitter / Retry-After / replay | `channel-outbound.ts:123-138` | 2.5 | 🔴 |
| CH-G09 | P1 | Provider rate limits unmodelled | — | 2.5 | 🔴 |
| CH-G10 | P1 | One number/account per channel per org | `005:10-11` | 3.6 | 🔴 |
| CH-G11 | P2 | Channel health dashboard | — | 2.5 | 🔴 |
| CH-G12 | P2 | Outbound media | — | 2.5 | 🔴 |
| CH-G13 | P2 | Stock Chatwoot incompatible | — | 3.6 | 🔴 |
| CH-E01 | — | Replay ring per-process | `event-bus.ts:409-517` | 4.4 | 🟡 |
| CH-E02 | — | Customer typing / presence | — | 3.7 | 🔴 |
| CH-E03 | — | SSE connection caps | — | 4.3 | 🔴 |
| CH-E04 | — | Webhook idempotency store | — | 2.5 | 🔴 |
| CH-E05 | — | DLQ retention/ops | — | 3.2 | 🔴 |
| CH-E06 | — | Secret rotation gaps | — | 3.2 | 🟡 |
| CH-E07 | — | Channel actions unaudited | — | 1.9 | 🔴 |
| CH-E08 | — | No per-conversation ordering | — | 2.5 | 🔴 |
| CH-E09 | — | Consent / TCPA | — | 2.5 | 🔴 |

## Security, auth, tenancy, compliance, platform, infra (`07`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| SEC-A01 | P0 | All login paths mint epoch-0 cookie → permanent lockout after revoke | `auth/[[...path]]:49-70,223…` | 1.2 | 🔴 |
| SEC-A02 | P0 | `requirePlatformAdmin`/middleware ignore epoch | `platform-admin.ts:83-84` | 1.2 | 🟢 (2026-09-29: `requirePlatformAdmin`, `getScopedClient`, `/api/auth/session`, and `/api/auth/invite/[token]` all parse `userId.epoch.sig` via `parseSessionCookieParts` and enforce `cookieEpoch === sessionEpoch`, rejecting revoked cookies; verified in `session-cookie-auth.test.ts`) |
| SEC-A03 | P1 | Cookie has no `exp`; legacy format accepted | `session-cookie.ts:81-118` | 1.2 | 🔴 |
| SEC-A04 | P1 | Account linking on unverified email | `oauth/callback:102-114` | 3.1 | 🔴 |
| SEC-A05 | P1 | SSO global, not per-org; JIT creates owner orgs | `supertokens.ts:129-189` | 3.1 | 🔴 |
| SEC-A06 | P1 | In-memory rate limits (Redis only ask_ai) | `rate-limit-core.ts:98-132` | 3.1 | 🔴 |
| SEC-A07 | P1 | Lockout checked after signIn → oracle | `auth/[[...path]]:192-263` | 1.2 | 🔴 |
| SEC-A08 | P1 | TOTP no replay guard / plaintext / no recovery | `totp.ts:25-35` | 3.1 | 🔴 |
| SEC-A09 | P1 | Reset-password no epoch bump/audit | `auth/reset-password:33-41` | 1.2 | 🔴 |
| SEC-A10 | P1 | No email verification; weak policy | `auth/[[...path]]:283-338` | 3.1 | 🔴 |
| SEC-A11 | P2 | No CSRF token / Origin check; GET logout | `session-cookie.ts:36-42` | 3.1 | 🔴 |
| SEC-A12 | P2 | HMAC key falls back to dev secret | `session-cookie.ts:46,55` | 3.1 | 🔴 |
| SEC-A13 | P2 | Invite GET leaks email/role | `auth/invite/[token]:15-40` | 3.1 | 🔴 |
| SEC-A14 | P2 | `/admin` renders for any session | `(platform)/layout.tsx:7-13` | 3.1 | 🔴 |
| SEC-R01 | P0 | Pay-tool RBAC on one route only | `rbac.ts:51-65` | 1.6 | 🟢 (2026-09-29: `canApproveActions`, `canCallPayTools`, and `canApproveRefunds` enforced across all approval routes: `ask-ai/plan` PATCH blocks `auditor`/`billing` from plan approvals, blocks non-pay roles from financial plans, and blocks non-owners/non-admins from refund plans; `ask-ai/approve` and `agent/pending-actions` enforce matching pay/refund RBAC on resume. Verified in `ask-ai-plan-rbac.test.ts` and `rbac-billing.test.ts`.) |
| SEC-R02 | P1 | ~30 mutating routes with no role check | list in `07 §3` | 1.6 | 🔴 |
| SEC-R03 | P1 | Member removal hard-deletes `users` | `members/[id]/route.ts:42` | 1.6 | 🔴 |
| SEC-R04 | P2 | No ownership transfer | `members/[id]:106-110` | 3.1 | 🔴 |
| SEC-R05 | P2 | Switch allows soft_deleted/provisioning | `org/switch:79` | 3.1 | 🔴 |
| SEC-R06 | P2 | `support` role reads every org | `platform-admin.ts:126-131` | 3.1 | 🔴 (2026-09-28: cited lines now schema-missing-error handling, not the role-scoping code, which moved to ~118-121; re-confirmed live: `app/api/platform/orgs/route.ts` has zero "support" role scoping — issue still real, just at a different location) |
| SEC-T01 | P1 | `platform_send_counters` no RLS | `025:26-30` | 1.1 | 🔴 |
| SEC-T02 | P1 | Catalogs writable by any tenant | `015:119-122,308-311`, `022eg:146` | 1.1 | 🔴 |
| SEC-T03 | P1 | Global outbound secret (= CH-S01) | `WH/outbound` | 1.7 | 🟡 (2026-09-28: `outbound/route.ts:50-65` now requires the conversation's own org `meta.webhook_secret` — global-secret cross-tenant injection closed; `body.recipient`/`body.channel` overrides still work once the correct org secret is presented) |
| SEC-T04 | P1 | Worker no prod fail-fast on `DB_USER` | `wf/tools/shared.ts:17-30` | 3.2 | 🔴 |
| SEC-T05 | P1 | `orgs` INSERT `WITH CHECK (true)` | `097:31-33` | 1.1 | 🔴 |
| SEC-T06 | P2 | PII in `channel_logs.payload` | `oauth/callback:293-306` | 3.2 | 🔴 |
| SEC-T07 | P2 | `org/switch` UPDATE users likely 42501 | `org/switch:83-90` | 1.1 | 🔴 |
| SEC-T08 | P2 | Edge quota on unsigned org cookie | `rate-limit-core.ts:236-249` | 3.1 | 🔴 |
| SEC-T09 | P2 | Full prompts to Langfuse unscrubbed | `langfuse-trace.ts:146-170` | 3.2 | 🔴 |
| SEC-C01 | P0 | DSR delete omits ~40 tables + external systems | `wf/dsr/tables.ts:7-53` | 3.3 | 🟡 2026-10-05: all org tables classified; retention policy open |
| SEC-C02 | P1 | Isolation test re-grants blanket privileges | `e2e-tenant-isolation.test.js:38-49` | 0.2 | 🔴 |
| SEC-C03 | P1 | 73 mutating routes emit no audit | — | 1.9 | 🟡 (2026-09-28: `connector.connect` and `plan.approve` now emit real `recordAuditEvent` calls; `password.reset` and `logout` still emit nothing) |
| SEC-C04 | P1 | No CSP/HSTS/XFO/Referrer-Policy | `next.config.js` | 3.2 | 🔴 |
| SEC-C05 | P1 | Plaintext Meta/Razorpay/TOTP secrets | `integrations/whatsapp:35-40` | 3.2 | 🔴 |
| SEC-C06 | P1 | No retention for audit/messages/logs/DLQ | — | 3.2 | 🔴 |
| SEC-C07 | P1 | Tenant cannot see platform actions on its org | `admin_audit_log` | 3.3 | 🔴 |
| SEC-C08 | P2 | Terms consent email-signup only; no version | `auth/[[...path]]:284-286` | 3.3 | 🔴 |
| SEC-C09 | P2 | Restore drill schema-only; no data backup | `restore-drill.sh:7,52-64` | 4.2 | 🔴 |
| SEC-C10 | P2 | No `pnpm audit`/SBOM/residency | `ci.yml` | 4.8 | 🟡 (2026-09-28: `ci.yml:163` now runs `pnpm audit --audit-level=high`; still no Dependabot/SBOM/residency controls) |
| SEC-C11 | P2 | Redaction by key name only | `audit-logs/route.ts:95` | 3.2 | 🔴 |
| SEC-P01 | P0 | `darex_platform` no grants on tenant tables → console non-functional | `119`, `120:36`, `121:57` | 1.1 | ⛔ (2026-09-28: migrations 119-121 grant only 4 tables/2 functions; migrations 118-122 on disk but not applied to the live DB — infra/human blocker, not a code gap) |
| SEC-P02 | P1 | Impersonation replaces operator cookie; actor = target | `impersonation/route.ts:198-217` | 3.4 | 🔴 |
| SEC-P03 | P1 | Impersonation cookie unsigned | `impersonation:206-217` | 3.4 | 🔴 |
| SEC-P04 | P1 | End-impersonation logs the customer out | `end/route.ts:97-104` | 1.2 | 🔴 |
| SEC-P05 | P1 | Kill switch fails open on write error | `kill-switch/route.ts:74-95` | 1.1 | 🔴 |
| SEC-P06 | P2 | Purge covers 7 tables; no Cognee | `org-purge.ts:61-69` | 3.3 | 🔴 |
| SEC-P07 | P2 | No MFA/IP allow-list for platform admins | `platform-admin.ts:80-103` | 3.4 | 🔴 |
| SEC-I01 | P1 | `pnpm test` not in CI | `ci.yml:120-155` | 0.1 | 🟡 |
| SEC-I02 | P1 | Compose dev-secret defaults | `docker-compose.yml:70…` | 3.2 | 🔴 |
| SEC-I03 | P1 | Migrations as superuser with default password | `infra/db/migrate.js:20-34` | 3.2 | 🔴 |
| SEC-I04 | P1 | Worker no prod boot guard | `wf/tools/shared.ts:17-21` | 3.2 | 🔴 |
| SEC-I05 | P2 | PgBouncer `ADMIN_USERS: darex_app` | `docker-compose.yml:95-125` | 3.2 | 🔴 |
| SEC-I06 | P2 | Pre-push only dashboard tsc; docs wrong | `.husky/pre-push` | 0.1 | 🟢 (2026-09-28: confirmed `.husky/pre-push` runs workflows build+test then dashboard `tsc --noEmit` — real git-hook enforcement, matches CLAUDE.md §3) |
| SEC-I07 | P2 | 15 s statement_timeout breaks DSR loops | `115:7-15` | 3.3 | 🔴 |
| SEC-I08 | P2 | No KMS/rotation evidence | `terraform/main.tf:19-25` | 3.2 | 🔴 |

## Billing, packs, onboarding, connectors (`08`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| BIZ-B01 | P0 | Meters refresh only on `/billing` page view | `_lib.ts:1074`, `billing/route.ts:53` | 1.11 | 🔴 |
| BIZ-B02 | P0 | LLM cost traced only from dashboard routes | `local-turn.ts:245` | 1.11 | 🔴 |
| BIZ-B03 | P0 | Seat add-on quantity collapses to 1 | `_lib.ts:1986,2020` | 3.5 | 🔴 |
| BIZ-B04 | P1 | Plan from stale metadata | `_lib.ts:2012,1983` | 3.5 | 🔴 |
| BIZ-B05 | P1 | Stripe + Razorpay double subscription | `checkout/route.ts:78-90` | 3.5 | 🔴 |
| BIZ-B06 | P1 | Cancel on one provider → plan free | `_lib.ts:937-939` | 3.5 | 🔴 |
| BIZ-B07 | P1 | Dunning evaluated only on webhook | `_lib.ts:1405-1429` | 3.5 | 🔴 |
| BIZ-B08 | P1 | Seat check ignores invites; no lock | `_lib.ts:1562-1625` | 3.5 | 🔴 |
| BIZ-B09 | P1 | Skill PATCH strips pack tools | `skills/[id]/route.ts:63-65` | 3.6 | 🔴 |
| BIZ-B10 | P1 | Pack upgrade clobbers default roster | `install-pack.ts:55-72` | 3.6 | 🔴 |
| BIZ-B11 | P1 | `installed_version` constant | `install-pack.ts:14,249` | 3.6 | 🔴 |
| BIZ-B12 | P1 | Three sources disagree on pack liveness | `manifests.ts:100`, `pack.yaml:7` | 3.6 | 🔴 |
| BIZ-B13 | P1 | Autonomy PATCH rejects `visible` | `settings/autonomy/route.ts:119-122` | 3.6 | 🔴 |
| BIZ-B14 | P2 | `plan_key` column does not exist | `wf/tools/billing.ts:68-70` | 1.11 | 🔴 |
| BIZ-B15 | P2 | Razorpay fallback event id collides monthly | `webhooks/billing:26-37` | 3.5 | 🔴 |
| BIZ-B16 | P2 | INR rendered as USD | `_lib.ts:485-493` | 3.5 | 🔴 |
| BIZ-B17 | P2 | Meter rows daily, never pruned | `_lib.ts:1076-1078` | 3.5 | 🔴 |
| BIZ-B18 | P2 | `GET /api/billing` fans out to Langfuse | `_lib.ts:1123-1130` | 3.5 | 🔴 |
| BIZ-B19 | P2 | Missing meters index | `017:166` | 1.1 | 🔴 |
| BIZ-B20 | P2 | Warning cites wrong migration | `_lib.ts:1349` | 3.5 | 🔴 |
| BIZ-B21 | P2 | Uninstall unguarded, no cascade | `install-pack.ts:410-444` | 3.6 | 🔴 |
| BIZ-B22 | P2 | Pack config arbitrary JSON | `packs/[id]/config/route.ts:35-37` | 3.6 | 🔴 |
| BIZ-B23 | P2 | Backfill inline; duplicate jobs | `onboarding/backfill/route.ts:50-65` | 3.6 | 🔴 |
| BIZ-B24 | P2 | Timezone validated by length | `onboarding/settings/route.ts:59-62` | 3.6 | 🔴 |
| BIZ-B25 | P2 | Invitee role forced `member` on one path | `auth/[[...path]]:321` | 3.6 | 🔴 |
| BIZ-B26 | P2 | `channels[]` unvalidated | `org/create/route.ts:97-101` | 3.6 | 🔴 |
| BIZ-B27 | P2 | Nango unreachable → "create in Nango UI" | `integrations/route.ts:104-125` | 3.6 | 🔴 |
| BIZ-S01 | P0 | BYOK plaintext | `integrations/whatsapp:35`, `razorpay:41-43` | 3.2 | 🟢 sealed (2026-10-05) |
| BIZ-S02 | P0 | No RBAC on connector connect/disconnect/BYOK | `integrations/route.ts:228-232` | 1.6 | 🔴 |
| BIZ-S03 | P1 | `update_config` no audit/RBAC | `integrations/route.ts:460-475` | 1.6 | 🔴 |
| BIZ-S04 | P1 | Any role reads billing | `billing/route.ts:44` | 1.6 | 🔴 |
| BIZ-S05 | P1 | Suppressions fallback by client id | `settings/suppressions:106-116` | 1.6 | 🔴 |
| BIZ-S06 | P1 | Member hard delete; no revocation | `members/[id]:42` | 1.6 | 🔴 |
| BIZ-S07 | P1 | Observation GET writes | `onboarding/observation:12` | 1.6 | 🔴 |
| BIZ-S08 | P2 | No email verification | `auth/[[...path]]:283-403` | 3.1 | 🔴 |
| BIZ-S09 | P2 | Webhook no body cap | `webhooks/billing:61` | 3.6 | 🔴 |
| BIZ-S10 | P2 | Nango webhook acks unknown ids | `webhooks/nango:43-50` | 3.6 | 🔴 |
| BIZ-S11 | P2 | Requested not granted scopes stored | `integrations/route.ts:301` | 3.6 | 🔴 |
| BIZ-G01 | P0 | `orgs.plan` gates nothing | `employee-provision.ts:104-187` | 3.5 | 🔴 |
| BIZ-G02 | P0 | No credit/DWC ledger | — | 3.5 | 🔴 |
| BIZ-G03 | P1 | No Scale tier / annual / dual currency | — | 3.5 | 🔴 |
| BIZ-G04 | P1 | No trial | `_lib.ts:1661-1679` | 3.5 | 🔴 |
| BIZ-G05 | P1 | Refunds/disputes ignored | `_lib.ts:640-657` | 3.5 | 🔴 |
| BIZ-G06 | P1 | Soft-cap alerts never sent | `_lib.ts:1054-1062` | 3.5 | 🔴 |
| BIZ-G07 | P1 | Seats never reconciled with PSP | `members/[id]:42` | 3.5 | 🔴 |
| BIZ-G08 | P1 | `org_skills` never read at runtime | — | 3.6 | 🔴 |
| BIZ-G09 | P1 | Manifests hand-mirrored; workflows unscheduled | `manifests.ts:1-5` | 3.6 | 🔴 |
| BIZ-G10 | P1 | `InstallPackWorkflow` no caller | `workflows/index.ts:21` | 3.6 | 🔴 |
| BIZ-G11 | P1 | Onboarding not resumable | `org/create:104-118` | 3.6 | 🔴 |
| BIZ-G12 | P1 | No guided OAuth / demo data | `(onboarding)/*` | 3.6 | 🔴 |
| BIZ-G13 | P1 | No notification prefs / quiet hours | — | 3.7 | 🔴 |
| BIZ-G14 | P1 | Multi-account schema-only | `nango-server.ts:232` | 3.6 | 🔴 |
| BIZ-G15 | P1 | Connection health manual only | `webhooks/nango:14-16` | 3.6 | 🔴 |
| BIZ-G16 | P2 | Marketplace hardcoded | `manifests.ts:55` | 4.9 | 🔴 |
| BIZ-G17 | P2 | Autonomy no create-rule form | — | 3.6 | 🔴 |
| BIZ-G18 | P2 | Settings audit gaps | — | 1.9 | 🔴 |
| BIZ-G19 | P2 | google-ads `catalog_only` vs executor | `integrations-catalog.ts:140-157` | 2.1 | 🔴 |
| BIZ-G20 | P2 | 8 executors without catalog entry in allowlists | `employee-provision.ts:130,208` | 2.1 | 🔴 |
| BIZ-E01 | — | Per-org SSO | — | 3.1 | 🔴 |
| BIZ-E02 | — | Audit export / retention SLA | — | 4.8 | 🟡 |
| BIZ-E03 | — | Invoicing / PO / net-30 | — | 3.5 | 🔴 |
| BIZ-E04 | — | Annual contracts | — | 3.5 | 🔴 |
| BIZ-E05 | — | Seat pooling across orgs | — | 3.5 | 🔴 |
| BIZ-E06 | — | Usage alerts / spend limits | — | 3.5 | 🔴 |
| BIZ-E07 | — | Cost centres / per-employee budgets | — | 2.4 | 🔴 |
| BIZ-E08 | — | Platform overrides consumed by product | `120` | 3.4 | 🟡 |
| BIZ-E09 | — | Support access opt-in | `settings/route.ts:344-392` | — | 🟢 |
| BIZ-E10 | — | Kill switch / suspension | `116` | 0.3 | 🟡 |
| BIZ-E11 | — | White-label / custom domains | — | 4.6 | 🔴 |
| BIZ-E12 | — | Residency / regional PSP | — | 4.7 | 🔴 |
| BIZ-E13 | — | Tax compliance | — | 3.5 | 🔴 |
| BIZ-E14 | — | Procurement docs | — | 4.8 | 🔴 |
| BIZ-E15 | — | BYOK at rest | — | 3.2 | 🔴 |

## Observability, workflows, infra, tests (`09`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| OPS-B01 | P0 | Decision audit inserts fail CHECK silently | `decisions/route.ts:211-218` | 1.9 | 🔴 |
| OPS-B02 | P0 | `recordModelSpend` never invoked | `wf/cost/track.ts:34` | 1.11 | 🟢 (2026-09-28: `runTrueForgeTurn`/`resumeTrueForgeTurn` in `trueforge-client.ts` now wrap every turn — in-process and HTTP sidecar, first attempt and resumed — and call `recordModelSpend` with the real `usage.totalCostInUsd`; fire-and-forget so a spend-write failure never breaks a reply; workflows suite 328/328, no dedicated test for the DB write itself) |
| OPS-B03 | P0 | Worker turns emit no Langfuse traces | `wf/local-turn.ts:245` | 1.11 | 🔴 |
| OPS-B13 | P0 | Approving a confirm-class pending action via `/api/decisions` never executed it; route reported `success:true` regardless | `decisions/route.ts:335-398` | 1.9 | 🟢 (2026-09-28: found while wiring `SEC-R01`'s pay-RBAC backstop; `approvedPendingActionId`/`actorUserId`/`source:'approval'` now passed, response checks the real executor result; dashboard tsc clean, jest 301/301, no DB-backed test for this route) |
| OPS-B04 | P1 | `DormantLeadRevival` never started | — | 4.3 | 🔴 |
| OPS-B05 | P1 | Provision sweep list diverges from registry | `employee-provision.ts:74-84` | 4.3 | 🔴 |
| OPS-B06 | P1 | MorningCheck brief on every boot | `morning-check.ts:41-50` | 4.3 | 🔴 |
| OPS-B07 | P1 | `modifiedArgs` in optionId ignored | `decision/route.ts:314-317` | 1.9 | 🔴 |
| OPS-B08 | P1 | Audit preview truncates before redaction | `audit-logs/route.ts:95` | 4.9 | 🔴 |
| OPS-B09 | P2 | `/api/agent/explain` swallows DB errors | `explain/route.ts:28` | 4.9 | 🔴 |
| OPS-B10 | P2 | Analytics export ignores range | `export/route.ts:10-48` | 4.9 | 🔴 |
| OPS-B11 | P2 | StuckWorkDetector no orgId guard; 7 sweeps no retry | `stuck-work.ts:25` | 4.3 | 🔴 |
| OPS-B12 | P2 | prod compose defines retired atomic-bridge | `deploy/docker-compose.prod.yml:76-81` | 4.9 | 🔴 |
| OPS-S01 | P0 | `pending-actions` approves without RBAC/audit | `agent/pending-actions/route.ts:27-60` | 1.9 | 🔴 |
| OPS-S02 | P1 | Kill switch not in execution path | — | 1.5 | 🟢 (2026-09-28: `gateOrgRunnable` is wired as `orgRunState` in the ordered tool gate, the sole production tool-execution entry, closed as a side effect of `EMP-S01`/`EMP-S03`'s `tool-gate.ts` refactor — `executor-gate.test.ts`) |
| OPS-S03 | P1 | Ledger stores full payloads | `autonomy.ts:555-561` | 3.2 | 🔴 |
| OPS-S04 | P1 | Containers run as root | `infra/docker/worker/Dockerfile` | 3.2 | 🔴 |
| OPS-S05 | P2 | Langfuse dev keys as worker defaults | `docker-compose.yml:829-830` | 3.2 | 🔴 |
| OPS-S06 | P2 | Decisions PATCH executes inline, no timeout | `decisions/route.ts:308-344` | 1.9 | 🔴 |
| OPS-G01 | P0 | Expiry / SLA sweeps have zero callers | — | 1.9 | 🔴 |
| OPS-G02 | P0 | Ready probe omits Nango/Langfuse/SuperTokens/worker | `ready/route.ts:311-319` | 0.4 | 🟢 (2026-09-29: Verified — `/api/health/ready` executes all probes concurrently with `Promise.allSettled`; worker and Nango failures are evaluated as required dependencies causing `/ready` to return 503 `unhealthy`, preventing traffic from hitting broken backends; unit tested in `apps/dashboard/lib/__tests__/health-ready.test.ts`) |
| OPS-G03 | P1 | Three automation-rate formulas | `dashboard/stats:139`… | 2.4 | 🔴 |
| OPS-G04 | P1 | Alerts manual; probes unscheduled | — | 4.1 | 🔴 |
| OPS-G05 | P1 | Owner briefing not scheduled per org | `owner-whatsapp/route.ts:62` | 3.7 | 🔴 |
| OPS-G06 | P1 | Metrics snapshot on page visit | `employee-metrics-query.ts:183-194` | 2.4 | 🔴 |
| OPS-G07 | P2 | Suspended orgs keep sweeping | — | 1.5 | 🔴 |
| OPS-G08 | P2 | No heartbeatTimeout; single queue | `worker.ts:52` | 4.3 | 🔴 |
| OPS-E01 | — | SLOs / error budgets / on-call | — | 4.1 | 🔴 |
| OPS-E02 | — | Runbooks | — | 4.1 | 🔴 |
| OPS-E03 | — | Backups | — | 4.2 | 🔴 |
| OPS-E04 | — | DR plan | — | 4.2 | 🔴 |
| OPS-E05 | — | Load / chaos tests | — | 4.4 | 🔴 |
| OPS-E06 | — | Temporal versioning / replay tests | — | 4.3 | 🔴 |
| OPS-E07 | — | Structured logs / correlation ids | — | 0.6 | 🔴 |
| OPS-E08 | — | Docs overclaim (health, decisions, pre-push) | — | 0.5 | 🔴 |

## Frontend / UX (`10`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| UI-B01 | P0 | No error/not-found boundaries | `app/` | 1.12 | 🟢 |
| UI-B02 | P0 | Mobile nav 5 of 21 | `BottomTabs.tsx:14-20` | 1.12 | 🟢 |
| UI-B03 | P1 | `/plans` lacks `onUpdateStepPayload` | `plans/page.tsx:336-345` | 2.2 | 🔴 |
| UI-B04 | P1 | Optimistic without rollback | `plans/page.tsx:124-173` | 2.2 | 🔴 |
| UI-B05 | P1 | SSE loop no abort | `plans/page.tsx:204-271` | 2.2 | 🔴 |
| UI-B06 | P1 | 500 → "No listings" fabricated empty state | `listings:21-29`… | 1.12 | 🟢 |
| UI-B07 | P1 | `res.json()` without `ok` | `insight/page.tsx:55,67` | 1.12 | 🔴 |
| UI-B08 | P1 | Observability approve/reject silent failure, double submit | `observability/page.tsx:58-97` | 1.12 | 🔴 |
| UI-B09 | P1 | AutonomySettings no catch | `AutonomySettings.tsx:65-170` | 1.12 | 🟢 |
| UI-B10 | P1 | Decision cards swallow rejection | `OpportunityCard.tsx:49-61` | 1.12 | 🔴 |
| UI-B11 | P1 | `needs_attention` hijacks thread | `conversations/page.tsx:160-163` | 2.5 | 🔴 |
| UI-B12 | P1 | Search per keystroke, no debounce | `conversations/page.tsx:340-343` | 2.5 | 🔴 |
| UI-B13 | P1 | Fallback `'Sarah'` identity | `conversations/page.tsx:778…` | 1.12 | 🔴 |
| UI-B14 | P1 | Settings saves ignore `!ok`; `alert()` | `settings/page.tsx:145-229` | 1.12 | 🔴 |
| UI-B15 | P1 | Forgot-password loading stuck | `forgot-password/page.tsx:15-21` | 1.12 | 🔴 |
| UI-B16 | P1 | Onboarding `void fetch` | onboarding `name:16-20`… | 1.12 | 🔴 |
| UI-B17 | P1 | `localhost` in customer copy | `connectors/[id]/page.tsx:467,669` | 1.12 | 🔴 |
| UI-B18 | P1 | Any 500 → `migrationMissing` | `platform/api.ts:31-48` | 1.12 | 🔴 |
| UI-B19 | P1 | Archive → `window.prompt` for UUID | `employees/page.tsx:169-174` | 2.8 | 🔴 |
| UI-B20 | P2 | Nav active-state wrong | `AppShell.tsx:104` | 2.8 | 🔴 |
| UI-B21 | P2 | Fetch without unmount guard (many) | `AppShell:65-74`… | 2.8 | 🔴 |
| UI-B22 | P2 | Impersonation banner polls all tenants | `ImpersonationBanner.tsx:22-35` | 3.4 | 🟡 (2026-09-28: initial load now has a `cancelled` guard; interval-triggered `load()` still lacks one; banner still mounts unconditionally for every tenant user in `AppShell.tsx:201`) |
| UI-B23 | P2 | Non-existent Tailwind classes | `ask-ai/page.tsx:2033…` | 2.8 | 🔴 |
| UI-B24 | P2 | `safe-bottom`, `scrollbar-none` undefined | `BottomTabs.tsx:28` | 2.8 | 🟢 |
| UI-B25 | P2 | Enter without `isComposing` | `ask-ai/page.tsx:2499` | 2.8 | 🔴 |
| UI-B26 | P2 | `>= 0` always true | `page.tsx:118` | 2.8 | 🔴 |
| UI-B27 | P2 | Admin "forbidden" leaks route | `middleware.ts:15-21` | 3.4 | 🔴 (2026-09-28: page moved `app/(dashboard)/admin/page.tsx` → `app/(platform)/admin/page.tsx`, same content — still renders a client "forbidden" text, no `notFound()`; finding still valid, just at a new path) |
| UI-B28 | P2 | Export CSV ignores range/tab | `analytics/page.tsx:131-136` | 4.9 | 🔴 |
| UI-B29 | P2 | Modals no focus trap/Escape/`role` | `ConfirmReasonDialog.tsx:51-56`… | 2.8 | 🔴 |
| UI-G01 | P0 | 21 icon-only rail items; no ⌘K | `AppShell.tsx:37-60` | 2.8 | 🔴 |
| UI-G02 | P0 | No plan history | `plan/route.ts:30` | 2.2 | 🔴 |
| UI-G03 | P1 | Member management UI | `settings/page.tsx:526-583` | 2.8 | 🔴 |
| UI-G04 | P1 | MFA enrolment / sessions / password | — | 3.1 | 🔴 |
| UI-G05 | P1 | Audit filters/search/export | `audit/page.tsx:79-92` | 2.8 | 🔴 |
| UI-G06 | P1 | Work items pagination/bulk/confirm | `work-items:216` | 2.8 | 🔴 |
| UI-G07 | P1 | One shared SSE hook | — | 2.5 | 🔴 |
| UI-G08 | P1 | Two palettes | `conversations:528+` | 2.8 | 🔴 |
| UI-G09 | P1 | Assign/notes/canned/channel list | `conversations:47` | 2.5 | 🔴 |
| UI-G10 | P1 | Toast primitive; kill alert/confirm/prompt | — | 1.12 | 🔴 |
| UI-G11 | P1 | URL-addressable tabs/ranges | `settings:52` | 2.8 | 🔴 |
| UI-G12 | P1 | Org currency/locale | `listings:64`… | 4.6 | 🔴 |
| UI-G13 | P1 | Org timezone on timestamps | 36 `toLocale*` | 4.6 | 🔴 |
| UI-G14 | P2 | Real charts | `analytics:238-253` | 2.8 | 🔴 |
| UI-G15 | P2 | Employee edit; tools from catalog | `employees:61-74` | 3.6 | 🔴 |
| UI-G16 | P2 | Pack config form | `packs/page.tsx:141` | 3.6 | 🔴 |
| UI-G17 | P2 | Nav gated by pack/role | — | 2.8 | 🔴 |
| UI-G18 | P2 | Org switch full reload | `OrganizationSwitcher.tsx:108` | 2.8 | 🔴 |
| UI-G19 | P2 | Internal jargon on auth layout | `(auth)/layout.tsx:75` | 2.8 | 🔴 |
| UI-G20 | P2 | Hardcoded "DareX Executive"/"TrueForge"/"Just now" | `ask-ai:232-250` | 2.8 | 🔴 |
| UI-E01 | — | Security headers | `next.config.js` | 3.2 | 🔴 |
| UI-E02 | — | i18n | — | 4.6 | 🔴 |
| UI-E03 | — | Dark mode / tokens | — | 4.6 | 🔴 |
| UI-E04 | — | White-label | — | 4.6 | 🔴 |
| UI-E05 | — | RBAC-aware UI | 7/38 pages | 2.8 | 🔴 |
| UI-E06 | — | Idle timeout / re-auth | — | 3.1 | 🔴 |
| UI-E07 | — | Request id in errors | — | 0.6 | 🔴 |
| UI-E08 | — | Export on audit/conversations/work items | — | 3.3 | 🔴 |
| UI-E09 | — | WCAG gate | — | 2.8 | 🔴 |
| UI-E10 | — | Fonts / perf budget | — | 4.6 | 🔴 |
| UI-E11 | — | Client error reporting | — | 4.1 | 🔴 |
| UI-E12 | — | Frontend architecture doc fiction | `darex-frontend-architecture.md` | 0.5 | 🔴 |

## Enterprise-only (`11`)

| ID | Sev | Issue | Pkt | Status |
|---|---|---|---|---|
| ENT-01 | P1 | SCIM 2.0 | 3.1 | 🔴 |
| ENT-02 | P2 | Data residency | 4.7 | 🔴 |
| ENT-03 | P1 | Retention engine | 3.2 | 🔴 |
| ENT-04 | P1 | Sub-processors / DPA / privacy docs | 4.8 | 🔴 |
| ENT-05 | P1 | Per-org model policy | 4.7 | 🔴 |
| ENT-06 | P0 | Agent eval harness in CI | 2.6 | 🔴 |
| ENT-07 | P2 | SLA / SLO / error budget | 4.1 | 🔴 |
| ENT-08 | P0 | OpenTelemetry + exception tracking | 4.1 | 🔴 |
| ENT-09 | P1 | DR runbook + recorded drill | 4.2 | 🔴 |
| ENT-10 | P2 | Status page | 4.1 | 🔴 |
| ENT-11 | P1 | Owner approval via WhatsApp/push | 3.7 | 🟡 (2026-09-28: `webhooks/owner-whatsapp/route.ts:81-140` has a real, signature-verified `approve plan <id>` path wired to `agent_plans` + Temporal signal + audit event; no reject-by-reply command yet, not proven live) |
| ENT-12 | P1 | i18n / timezone / currency prefs | 4.6 | 🔴 |

## Web / search (`14`)

| ID | Sev | Issue | Where | Pkt | Status |
|---|---|---|---|---|---|
| WEB-S01 | P0 | SSRF string-only: no DNS/IPv6/redirect re-check | `safe-url.ts` (fixed 2026-09-28) | 14.1 | 🟢 |
| WEB-S02 | P1 | Jina fetches any URL; no DPA / org opt-out | `web-extract.ts:108` | 14.8 | 🔴 |
| WEB-S03 | P1 | `res.text()` unbounded; no Content-Type gate | `web-extract.ts:65-66` | 14.1 | 🟡 (2026-09-28: side effect of `WEB-S01` — direct-fetch path now goes through `safeGet`, which caps the decoded body at 5 MB; still no Content-Type gate, the Jina proxy path bypasses `safeGet` entirely, and `search-providers.ts`'s DDG/Wikipedia/Google News calls remain uncapped) |
| WEB-S04 | P1 | Page text unfenced on MCP sidecar | `mcp-bridge.ts:1643-1665` | 14.1 | 🔴 |
| WEB-S05 | P2 | Spoofed Chrome UA vs DDG | `web-search.ts:82` | 14.1 | 🔴 |
| WEB-S06 | P2 | No per-org search quota | — | 14.3 | 🔴 |
| WEB-S07 | P1 | LinkedIn people-search advertised → ToS scrape risk | `linkedin.ts` + Sarah allowlist | 14.9 | 🔴 |
| WEB-S08 | P1 | Shared platform Maps key | `maps.ts:17-19` | 14.9 | 🔴 |
| WEB-S09 | P1 | Apollo enrich treated as `read` | `apollo.ts:15-18` | 14.9 | 🔴 |
| WEB-B01 | P0 | Every provider failure → "no results" | `search-providers.ts` (fixed 2026-09-28) | 14.2 | 🟢 |
| WEB-B02 | P1 | Lexical needle filter drops valid hits | `web-search.ts:36-52` | 14.5 | 🔴 |
| WEB-B03 | P1 | Founder heuristic hard-wired into general tool | `web-search.ts:47-57,248-251` | 14.5 | 🔴 |
| WEB-B04 | P1 | News locale hard-coded US/English | `web-search.ts:160` | 14.5 | 🔴 |
| WEB-B05 | P1 | Dedupe ignores www/utm/AMP | `web-search.ts:206-216` | 14.5 | 🔴 |
| WEB-B06 | P1 | No publishedAt/source/score/lang | `web-search.ts:110-114` | 14.4 | 🟡 (2026-09-28: side effect of `WEB-B01` — every hit now carries `source`; Google News sets `publishedAt` from RSS `pubDate`; still no `score`/`lang` on any hit, `publishedAt` only populated for Google News and not ISO-parsed) |
| WEB-B07 | P1 | 8k truncate, no `truncated` flag | `web-extract.ts:118,76` | 14.4 | 🔴 |
| WEB-B08 | P1 | Regex readability; SPA shells | `web-extract.ts:67-76` | 14.4 | 🔴 |
| WEB-B09 | P2 | DDG parse via class-name regex | `web-search.ts:97-115` | 14.3 | 🔴 |
| WEB-B10 | P2 | Sequential fallbacks ~15 s | `web-search.ts:256-260` | 14.3 | 🔴 |
| WEB-B11 | P2 | Post-processor fabricates founder/year | `tool-answer.ts:286-300` | 14.2 | 🔴 |
| WEB-B12 | P2 | Docs claim Exa; code has Jina+DDG | `documentation/10-features-roadmap.md` | 14.3 | 🔴 |
| WEB-B13 | P1 | Maps `/connectors` lie; no catalog row | `maps.ts:39` | 14.9 | 🔴 |
| WEB-B14 | P1 | LinkedIn action names lie (typeahead / ACL) | `linkedin.ts:46-73` | 14.9 | 🔴 |
| WEB-B15 | P1 | Growth signals ignore search fallbacks | `growth/signals.ts:50-69` | 14.2 | 🔴 |
| WEB-B16 | P2 | Stale RERA cache returned as success | `rera.ts:61-82` | 14.10 | 🔴 |
| WEB-B17 | P2 | No `gmail_search`; last-N only | `gmail.ts` ACTIONS | 14.6 | 🔴 |
| WEB-B18 | P2 | Salesforce/Zoho list-not-search; no connect UI | `salesforce.ts` / `zoho.ts` | 14.9 | 🔴 |
| WEB-G01 | P0 | No search API (Brave/Tavily/Serper) in product | `.env.example` | 14.3 | 🔴 (2026-09-28: confirmed still absent; this is a vendor/product decision — which paid search API — not a pure code fix) |
| WEB-G02 | P1 | No query/doc cache | — | 14.3 | 🔴 |
| WEB-G03 | P1 | No research_run loop | — | 14.7 | 🔴 |
| WEB-G04 | P1 | No numbered citations / retrievedAt | `reply-from-tools.ts` | 14.4 | 🔴 |
| WEB-G05 | P1 | Web findings not persisted with provenance | `memory-writeback.ts` | 14.7 | 🔴 |
| WEB-G06 | P1 | No org domain allow/deny | — | 14.8 | 🔴 |
| WEB-G07 | P1 | No PDF/DOCX/OCR on direct path | `web-extract.ts` | 14.4 | 🔴 |
| WEB-G08 | P1 | No web_crawl | — | 14.11 | 🔴 |
| WEB-G09 | P2 | No headless browser | — | 14.11 | 🔴 |
| WEB-G10 | P2 | No web_monitor | — | 14.11 | 🔴 |
| WEB-G11 | P2 | No fetched-URL audit | — | 14.8 | 🔴 |
| WEB-G12 | P2 | No language / translate | — | 14.11 | 🔴 |
| WEB-G13 | P1 | No internal_search fan-out | — | 14.6 | 🔴 |
| WEB-G14 | P2 | GSC: no inspect/sitemap/presets | `google-search-console.ts:22-34` | 14.10 | 🔴 |
| WEB-G15 | P2 | GBP: locations only | `google-business-profile.ts:5` | 14.10 | 🔴 |
| WEB-G16 | P2 | GA: no canned reports | `google-analytics.ts` | 14.10 | 🔴 |
| WEB-G17 | P1 | Marcus card has no web_search | `employee-provision.ts:144-151` | 14.9 | 🔴 |
| WEB-G18 | P2 | No listing+RERA+maps verify recipe | RE pack | 14.10 | 🔴 |
| WEB-G19 | P1 | LinkedIn people-search on Sarah card | `employee-provision.ts:130` | 14.9 | 🔴 |
| WEB-G20 | P1 | Signals: one template, regex, hostname-as-company | `signals.ts` | 14.9 | 🔴 |
| WEB-G21 | P1 | Research card missing Cognee/maps/gmail_search | `employee-provision.ts:162` | 14.6 | 🔴 |
| WEB-G22 | P1 | No research_run workflow / UI card | — | 14.7 | 🔴 |
| WEB-E01 | P1 | Search not on ready probe or spend ledger | — | 14.3 | 🔴 |
| WEB-E02 | P2 | No sub-processor page for Jina/Brave/Apollo | — | 14.8 | 🔴 |
| WEB-E03 | P2 | No claim-subseteq-sources eval (W1-W13) | — | 14.12 | 🔴 |

---

## In-product search (`15`)

| ID | Sev | Issue | Pkt | Status |
|---|---|---|---|---|
| SRCH-G01 | P0 | No conversation/message search tool | 15.1 | 🔴 |
| SRCH-G02 | P1 | Work items: filters, no `q` | 15.2 | 🔴 |
| SRCH-G03 | P1 | Audit: no text search | 15.2 | 🔴 |
| SRCH-G04 | P2 | Employees: no search | 15.2 | 🔴 |
| SRCH-G05 | P1 | Plans: no history search | 15.2 | 🔴 |
| SRCH-G06 | P0 | No ⌘K / command palette | 15.1 | 🔴 |
| SRCH-G07 | P1 | Conversations ILIKE on latest message only | 15.1 | 🔴 |
| SRCH-B01 | P1 | listings_search loads all rows in RAM | 15.3 | 🔴 |
| SRCH-B02 | P1 | Conversations search no debounce | 15.1 | 🔴 |
| SRCH-B03 | P2 | Platform search email is prefix-only | 15.1 | 🔴 |
| SRCH-S01 | P1 | Internal find via writable `database_query` | 15.1 | 🔴 |
| SRCH-S02 | P2 | Inbox search any role | 15.1 | 🔴 |
| SRCH-E01 | P2 | No saved/recent/highlight | 15.5 | 🔴 |

## Tab → chat (`15`)

| ID | Sev | Issue | Pkt | Status |
|---|---|---|---|---|
| TAB-G01 | P0 | Decision approve/reject not from chat | 15.2 | 🔴 |
| TAB-G02 | P1 | Work-item create/decide no tool | 15.2 | 🔴 |
| TAB-G03 | P2 | Insight generate human-only | 15.4 | 🔴 |
| TAB-G04 | P1 | Growth opportunity decide human-only | 15.4 | 🔴 |
| TAB-G05 | P1 | Open-loop patch human-only | 15.4 | 🔴 |
| TAB-G06 | P1 | Employee archive no tool | 15.4 | 🔴 |
| TAB-G07 | P1 | Brain disable/delete/reindex no tool | 15.4 | 🔴 |
| TAB-G08 | P1 | Conversation pause/resolve/assign no tool | 15.4 | 🔴 |
| TAB-G09 | P1 | Connector connect/disconnect no chat twin (keep OAuth human) | 15.4 | 🔴 |
| TAB-G10 | P2 | Settings writes human-only | 15.4 | 🔴 |

## Engines (`15`)

| ID | Sev | Issue | Pkt | Status |
|---|---|---|---|---|
| ENG-B01 | P1 | Signal company = news hostname | 15.3 | 🔴 |
| ENG-B02 | P1 | MarketScout scores hardcoded | 15.3 | 🔴 |
| ENG-B03 | P2 | Dossier Slack → `#general` | 15.3 | 🔴 |
| ENG-B04 | P1 | Dormant query random by UUID | 15.3 | 🔴 |
| ENG-B05 | P2 | ReplySorter last 20 Gmail only | 15.3 | 🔴 |
| ENG-G01 | P1 | Apollo scout always page 1 | 15.3 | 🔴 |
| ENG-S01 | P1 | Scout writes HubSpot with no consent | 15.3 | 🔴 |
| ENG-S02 | P1 | Extracted page posted to Slack unfenced | 15.3 | 🔴 |

## Tool-family depth (`16`)

| ID | Sev | Issue | Pkt | Status |
|---|---|---|---|---|
| TOOL-G01 | P0 | Gmail no `q=` search | 16.1 | 🟢 2026-10-05: `gmail_fetch` takes `query` (Gmail search syntax) |
| TOOL-G02 | P1 | Calendar no delete/recurring/rooms | 16.2 | 🔴 |
| TOOL-G03 | P1 | HubSpot no companies/notes/tasks/pipelines | 16.3 | 🔴 |
| TOOL-G04 | P1 | Slack no search/threads | 16.4 | 🔴 |
| TOOL-G05 | P1 | WhatsApp no templates/media/STOP | 16.4 | 🔴 |
| TOOL-G06 | P1 | Stripe no invoices/subscriptions/disputes | 16.5 | 🔴 |
| TOOL-G07 | P1 | Shopify no fulfill/refund/inventory | 16.5 | 🔴 |
| TOOL-G08 | P2 | Notion no database query | 16.2 | 🔴 |
| TOOL-G09 | P2 | GitHub no PR/search | 16.2 | 🔴 |
| TOOL-G10 | P1 | Eight executors with no connect UI | 16.3 | 🔴 |
| TOOL-B01 | P1 | Hardcoded money/channel defaults | 1.4 | 🔴 |
| TOOL-S01 | P1 | Platform WhatsApp/Maps/Apollo keys for tenants | 3.2 | 🔴 |
| TOOL-S02 | P1 | OTP + PaymentIntent secret in model context | 4.5 | 🔴 |

---

## P0 roll-up (68)

ASK-B01 B02 B03 S01 S02 G01 G02 E01 · EMP-B01 B02 S01 S02 S03 G01 G02 · RT-B01 B02 B03 B04 B05 B06 B07 S01 S02 S03 S04 G01 · MEM-B01 B02 B03 S01 S02 G01 G02 G03 E01 · CH-S01 · SEC-A01 A02 R01 C01 P01 · BIZ-B01 B02 B03 S01 S02 G01 G02 · OPS-B01 B02 B03 S01 G01 G02 · UI-B01 B02 G01 G02 · ENT-06 ENT-08 · WEB-S01 B01 G01 · **SRCH-G01 G06 · TAB-G01 · TOOL-G01**
