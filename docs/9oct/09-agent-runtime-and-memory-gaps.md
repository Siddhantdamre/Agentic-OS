# 09 — Agent Runtime, Memory and Governance: Gap Audit (2026-10-09)

> Scope: the agent runtime (TrueForge in-process engine and HTTP sidecar, MCP
> bridge, Temporal workflows, retries, timeouts, budgets, crew cap), the brain
> (Postgres memory tiers, pgvector hybrid retrieval, Cognee, Hindsight,
> write-back, per-employee memory scope, forgetting and DSR, learning from
> feedback), guardrails, autonomy tiers and approvals.
>
> Method: every claim below was checked against the code on `main` at
> `c8ad0ab1`. Where a planning document (`gap26sept/*.md`, `plan/*.md`,
> `3-employee.md`, `BUILD_STATE.md`) disagrees with the code, the code wins and
> the disagreement is called out. File references are relative to the repo
> root unless they start with a module name inside `services/workflows/src/`.
>
> Legend: **Works** = verified in code and wired. **Broken** = wired but wrong.
> **Missing** = not built, or built but not called. Priority P0 (safety, data
> loss, money, tenant isolation), P1 (product promise not met, operator
> confusion), P2 (quality, scale, polish). Effort S (under a day), M (1–3
> days), L (a week), XL (multi-week).

---

## 0. Executive summary

The runtime is in much better shape than the September audits describe. The
single ordered tool gate (`tool-gate.ts:172-371`) is the strongest part of the
system: every side effect from chat, plan steps, crews, webhooks and sweeps
goes through one function that checks org state, identity, usage cap,
entitlement, card allowlist, persona denial, payload sanity, rollout stage,
critic, confirm class, skill tier and autonomy, in that order, and parks
anything risky as a database-backed approval. Retries are idempotent at the
activity level, crews are capped at 3, and tool calls are bounded by count and
by time.

The brain is the weaker half. The retrieval SQL is good (hybrid FTS plus
cosine, staleness penalty, disabled-source filtering, per-persona token
budgets), but three of its five intended inputs are never populated:

1. **`employee_memory` has no writer anywhere in the code base.** The employee
   tier is read on every turn (`memory/retrieve.ts:276-313`) and shown in the
   Brain UI, but nothing inserts into it. Per-employee memory scope therefore
   does not exist in practice.
2. **The `facts` table has no writer.** The "facts-first" retrieval path for
   Operations and Growth (`memory/retrieve.ts:652-681`) reads a table that is
   always empty.
3. **No caller passes `entityId` into retrieval.** The entity lock, the facts
   path and the Customer persona's "never cite another customer's entity"
   filter (`memory/retrieve.ts:686-700`) all key on `entityId`, which no turn
   entry point supplies.

The learning loops are similarly half-built: `memory/playbook-proposal.ts` and
`memory/fact-conflict-route.ts` are complete modules with no callers, and the
only live "learning from feedback" is the Growth rejection-to-preference rule
(`apps/dashboard/app/api/work-items/[id]/decision/route.ts:100,344`).

Top fixes, in order:

| # | Fix | Priority | Effort |
|---|-----|----------|--------|
| 0 | Stop the MCP bridge from accepting a model-supplied `employee_role` argument when the signed role is absent (`mcp-bridge.ts:1783-1784`) — a prompt-injection path to another employee's tool card | P0 | S |
| 1 | Pass `employeeId` (not just role) from both turn engines into `executeAutonomousToolAction`; today the gate resolves identity by role name (`local-turn.ts:568`, `mcp-bridge.ts:1772-1783`) | P0 | S |
| 2 | Make a failed approval park fail the call instead of telling the user "waiting for approval" with no record (`tool-gate.ts:278-305`) | P0 | S |
| 3 | Remove the hard-coded `darex-hindsight-dev-key` fallback (`memory/hindsight-client.ts:25`); `BUILD_STATE.md` says it was not taken, but it is on `main` (commit `81f50348`) | P0 | S |
| 4 | Enforce the daily spend ceiling (`escalate_only`) on solo turns and sweeps, not only crews; crew check fails open (`activities/crew-budget.ts:51-58`) | P0 | M |
| 5 | Unify the two approval layers (harness-level pause vs gate park) and make them identical across in-process and HTTP paths (`local-turn.ts:357-391` vs `trueforge-client.ts:488-492`) | P1 | M |
| 6 | Persist in-process paused turns (today a 30-minute in-memory map, `local-turn.ts:79-106`) or stop pausing at the harness and rely on DB parking only | P1 | M |
| 7 | Write the employee tier, the `facts` table and pass `entityId` (see §6) | P1 | L |
| 8 | Wire the self-improvement loops that already exist as code (`playbook-proposal.ts`, `fact-conflict-route.ts`, `employee-metrics.ts` bands) | P1 | M |
| 9 | Fix `loadEmployeeAutonomyTier`, which picks an arbitrary rule row with no `action_type` filter (`tool-executor.ts:47-67`) | P1 | S |
| 10 | Put the eval harness (`infra/evals`, `infra/scripts/run-evals.sh`) into CI and add tool-routing and approval goldens | P1 | M |

---

## 1. Runtime architecture as built

```
Ask AI (/api/ask-ai)          Webhooks / inbound            Sweeps (14 per org)
   | retrieveMemory(role)        | WorkItemWorkflow             | Temporal long-running
   v                             v                              v
runAutonomousAgentDirect  AutonomousAgentWorkflow (MAX_TURNS 3)   activities/*
   |                             | runAgentTurnActivity          |
   |                             |  (runGuardedAgentTurn,        |
   |                             |   retrieveForEmployee,        |
   |                             |   confidence gate)            |
   v                             v                              |
runTrueForgeTurn  (trueforge-client.ts:562)                      |
   |-- 1. runLocalTurn (local-turn.ts:958)                       |
   |      in-process @truefoundry/trueforge-core                 |
   |      model cascade: override > gemini > groq > openrouter > litellm
   |      DarexLocalToolSet -> executeAutonomousToolAction       |
   |-- 2. HTTP sidecar fallback (TrueForge :8791)                |
          session per conversation, MCP bridge :8790 (HMAC)      |
          mcp-bridge -> executeAutonomousToolAction              |
                                     |                           |
                                     v                           v
                         runToolGate (tool-gate.ts:172) <--------+
                          org state, identity, usage, entitlement,
                          card allowlist, persona, payload, stage,
                          critic, confirm class, skill tier, autonomy
                                     |
                         park -> agent_pending_actions + work_items(decision)
                         or invoke -> executeProvider (timeout, rate limit,
                                       idempotency key, audit row)
```

Notes on naming:

- `agent-engine.ts` is now only a type re-export (24 lines) of the task
  contract from `@darex/shared-types`; there is no engine logic in it.
- `agent-client.ts:31-80` is a thin wrapper over `trueforge-client.ts`. It
  still imports `retrieveMemory`, `emptyMemoryResult` and
  `formatRetrievedFactsBlock` (`agent-client.ts:8-12`) without using them.
  Remove the unused imports (P2, S).
- `trueforge-client.ts` exports a second `runAgentTurn`
  (`trueforge-client.ts:1070`) with the same body as
  `agent-client.ts:31`. Keep one (P2, S).

---

## 2. Turn engines

### 2.1 What works

| Area | Evidence | Notes |
|---|---|---|
| In-process first, HTTP fallback | `trueforge-client.ts:576-586` | Any local failure, disabled flag (`DAREX_INPROCESS_TURNS=false`, `local-turn.ts:63`) or empty reply falls through to the sidecar. |
| No replay after side effects | `local-turn.ts:978-995`, `sideEffectStopResult` | Once a non-read tool dispatched, the cascade stops and reports what ran instead of retrying on another model or path (RT-B03). |
| Model cascade with circuit breaker | `local-turn.ts:119-235`, `circuit-breaker.ts` | 3 failures open a provider for 60 s. |
| Tool-call cap | `local-turn.ts:439-442`, `:551-562` | 25 per turn (env `DAREX_LOCAL_MAX_TOOL_CALLS`), 3 grace refusals, then abort. |
| Identical read reuse | `local-turn.ts:546-549` | Same read with same args in one turn is served from cache. |
| Strict allowlist intersection | `local-turn.ts:500-503`, `local-tool-select.ts` | The model never sees a tool outside the turn allowlist; `callTool` rejects unknown names (`:527-538`). |
| Argument validation | `local-turn.ts:401-436` | zod `safeParse` before execution; `org_id` stripped from model args. |
| Output size cap and fencing | `local-turn.ts:585-604`, `guardrails/tool-sanitizer.ts` | 20 000 chars, then `sanitizeToolOutput`. Same on the bridge (`mcp-bridge-format.ts`). |
| Session create race | `trueforge-client.ts:28-49` | In-process mutex per external id. |
| Allowlist header packing | `trueforge-client.ts:55-82` | Dedup, prefix strip, logs every dropped tool. |
| Tenant headers signed | `trueforge-client.ts:350-375` | HMAC v3 binds org, user, timestamp, allowlist and employee role. |
| Output token cap | `trueforge-client.ts:146-150` | `AGENT_MAX_OUTPUT_TOKENS`, default 8192. |
| Spend metering | `trueforge-client.ts:562-574`, `cost/track.ts` | Every turn writes `org_model_spend` fire-and-forget. |
| Worker tracing | `langfuse-trace.ts`, `activities/index.ts:343-358` | Worker turns now traced in Langfuse. |

### 2.2 What is broken

**R-1. Gate identity is resolved by role name, not employee id (P0, S).**
`DarexLocalToolSet.callTool` calls `executeAutonomousToolAction` with `orgId`,
`employeeRole` and `toolAllowlist` only (`local-turn.ts:568-575`). The bridge
does the same (`mcp-bridge.ts:1772-1783`); its tenant headers carry
`x-employee-role` but no employee id (`trueforge-client.ts:363-367`). The gate
then calls `loadGateEmployee` with a role and falls back to
`pickEmployeeForRole` (`tool-executor.ts:207-243`), which takes the first
matching row by `created_at`.

Consequences:

- Two employees with the same role (two custom "Account Manager" hires, or a
  custom hire that copies a roster role) share whichever card was created
  first. The selected employee's allowlist is not the one enforced.
- Ask AI with no employee selected passes the role `Primary Business
  Assistant` (`apps/dashboard/app/api/ask-ai/route.ts:1309`). No row matches
  that role, roster key or persona family, so every non-core tool call is
  denied with `missing_employee` (`tool-gate.ts:204-206`) even though the
  model was offered the org-union tool list (`ask-ai/route.ts:607-612`). The
  model sees tools it can never run. Verify live; the code path is
  unambiguous.
- `userId` is held on the tool set (`local-turn.ts:478,494`) but never passed
  as `actorUserId`, so `tool_invocations` and the ledger have no human actor
  for chat-initiated calls, and the pay RBAC hook has no actor to check.

Fix: add `employeeId` and `actorUserId` to the `DarexLocalToolSet`
constructor and pass them on every call; add `x-employee-id` and
`x-user-id` to the signed bridge header material and forward them; in the
gate, refuse a role-only lookup when more than one active row matches. For
the unselected Auto case either always resolve an employee before the turn
(the router already exists) or bind turns to the Executive row.

**R-2. Two approval layers that disagree between engines (P1, M).**
The in-process engine pauses the whole turn at the harness for every write
(`isToolApprovalRequired`, `local-turn.ts:357-391`: confirm classes need
approval unless `REQUIRE_DESTRUCTIVE_APPROVAL=false`, and any write or draft
needs approval unless `REQUIRE_TOOL_APPROVAL=false`). The HTTP sidecar only
pauses `@destructive` by default (`trueforge-client.ts:488-492`). Independently
the gate parks confirm-class calls in `agent_pending_actions`
(`tool-gate.ts:348`). A chat send on the in-process path can therefore ask
twice: once in the chat (harness pause), then again as a decision card (gate
park). On the HTTP path a `hubspot_create_contact` runs without a chat pause,
on the in-process path it pauses.

Fix: pick one layer. Recommended: harness approval off for everything
(`toolCallInfo` returns `false`), gate parking is the only approval, and the
chat renders the parked `pending_approval` result as an inline approval card
that calls `/api/ask-ai/approve` → `decideApproval` → gate re-entry with
`approvedPendingActionId`. This also removes R-3.

**R-3. Paused in-process turns live in process memory for 30 minutes (P1, M).**
`activeLocalOrchestrators` (`local-turn.ts:79-106`) holds paused sessions,
evicts the oldest at 500 and deletes anything older than 30 minutes. A worker
or dashboard restart, a second replica, or an approver who answers after 30
minutes gets `resumeLocalTurn` → `null` (`local-turn.ts:1036-1037`). The
dashboard and the worker are separate processes, so a turn paused in one
cannot be resumed by the other.

Fix: with R-2 done, there is nothing to resume in memory. If harness pauses
stay, serialize thread state to Postgres (`agent_turn_checkpoints`, keyed by
org and session) and rebuild the orchestrator on resume.

**R-4. Sub-agents lose the employee persona and can choose their own model (P1, S).**
Dynamic sub-agents get `instruction: SUB_AGENT_IDENTITY`
(`local-turn.ts:740`), not the employee's system prompt, so persona rules,
hand-off rules and the safety block in `buildUnifiedSystemPrompt` do not reach
them. The tool set (and thus the gate) is inherited, so permissions hold, but
behavioural rules do not. A sub-agent request may also name any model id
(`local-turn.ts:721-731`), which is sent to the same provider base URL with
the same key; nothing restricts it to an approved list, and cost is
unbounded by model choice.

Fix: build the child instruction as `SUB_AGENT_IDENTITY + safety block +
role block` from `system-prompt-builder.ts`; allow `params.request.model`
only from an env allowlist (`DAREX_SUBAGENT_MODELS`), otherwise use the
parent model.

**R-5. Session pinned to one model id; harness model differs from in-process model (P2, S).**
The sidecar recreates a session whenever its model differs from
`TRUEFORGE_MODEL` (`trueforge-client.ts:540-551`) while the in-process engine
uses a cascade (`local-turn.ts:119-235`). The model that answers depends on
which path ran, which is invisible to the user and to Langfuse (in-process
uses `noopTracing`, `local-turn.ts:259`). Report the actual model on every
turn result (it is in `model`) into the trace and the message metadata.

**R-6. Pending-approval deadlock recovery deletes the session (P2, S).**
When TrueForge refuses a user message because approvals are pending, the
client deletes the session and creates a new one (`trueforge-client.ts:640-668`).
Any pending approval in that session is silently discarded. With R-2 done this
path goes away; until then, log the discarded approvals to the ledger.

**R-7. Timeout mismatch across layers (P2, S).**

| Layer | Timeout | Source |
|---|---|---|
| Ask AI turn | 120 s | `ask-ai/route.ts:1323` |
| In-process default | 120 s | `local-turn.ts:770` |
| HTTP turn default | 180 s | `trueforge-client.ts:126` |
| Agent turn activity | 12 min start-to-close, 20 min schedule-to-close | `workflows/AutonomousAgentWorkflow.ts:8-9` |
| Tool execution | 15 s (provider HTTP 12 s) | `tools/shared.ts`, `tool-executor.ts:342` |
| Crew synthesis | 3 min | `crew-contract.ts:18` |
| Plan step activity | 3 min, 3 attempts | `workflows/PlanExecuteWorkflow.ts:58-62` |
| Memory retrieve | 6 s (embed 400 ms) | `memory/retrieve.ts:39-40` |
| Human confirm in workflows | 24 h | `WorkItemWorkflow.ts:307,516,584`; `PlanExecuteWorkflow.ts:124` |
| Pending action expiry | 7 days | migration `023_employee_state_machines.sql:324` |

The last two rows conflict: a workflow stops waiting after 24 hours, but the
decision card stays approvable for 7 days. An approval on day 3 executes the
parked tool through `/api/decisions` (gate re-entry) while the workflow that
asked has already moved on to `needs_attention`. Fix: when a workflow's wait
times out, expire its pending action in the same activity, or extend the wait
to the expiry and let the governance sweep (`workflows/governance-sweep.ts`)
be the single expirer.

**R-8. `AutonomousAgentWorkflow` retry can repeat non-confirm writes (P1, S).**
`MAX_TURNS = 3` (`AutonomousAgentWorkflow.ts:26`) re-runs the turn when the
result is `retryable` (any message matching `abort|timeout|…`,
`trueforge-client.ts:1115`). The idempotency claim in `runGuardedAgentTurn`
is per activity execution, so the follow-up turn is a new claim. A timed-out
first turn reports only `Error: …` as its executed steps
(`trueforge-client.ts:1120-1130`), so `priorToolResults` does not tell the
second turn which tools already ran. Sends and payments are safe (they park),
but `hubspot_create_contact`, `sheets_append_row`, `work_item_create`,
`calendar_create_event` can run twice.

Fix: have `runAgentTurnActivity` return the tools dispatched before the error
(the in-process budget already records `sideEffects`), and pass them as
`priorToolResults`; do not retry a turn whose `sideEffects` is non-empty.

### 2.3 What is missing

| ID | Missing | Priority | Effort | Fix sketch |
|---|---|---|---|---|
| R-M1 | Per-turn token budget. Only a tool-call cap and the output token cap exist; there is no input-token or cost ceiling per turn. `maxModelCallsPerTrigger` is loaded (`cost/track.ts:27`) but never enforced. | P1 | M | Track `threadMetrics` during the stream; abort when tokens or `total_cost_in_usd` exceed a per-org per-turn cap from `org_cost_ceilings`. |
| R-M2 | Context compaction is enabled but unobserved. `contextCompaction` and `largeToolResponse` run with `noopTracing`; no metric says when compaction fired. | P2 | S | Implement `AgentTracing` that forwards to Langfuse spans. |
| R-M3 | Streaming resume after client disconnect. The turn keeps running server-side; a reconnecting client cannot reattach. | P2 | M | Publish turn events to `realtime-hub` keyed by turn id; the chat page subscribes on reload. |
| R-M4 | Per-employee model, temperature and reasoning settings. `ai_employees` has no model column (migrations add only `archived_at`, `pack_id`, version fields). | P2 | M | Add `model_profile jsonb` to `ai_employees`; feed it into `getLocalModelCandidates` as the first candidate. |
| R-M5 | Provider failover telemetry. Failover is logged with `console.warn` only (`local-turn.ts:983-990`). | P2 | S | Emit a Langfuse event and increment a counter per provider. |
| R-M6 | Turn replay / debugging. There is no stored transcript of the exact system prompt, tool list and model inputs per turn. | P2 | M | Store a hash of the system prompt and the tool list on the trace; keep full prompts in Langfuse only. |

---

## 3. MCP bridge

### 3.1 Works

- HMAC-signed tenant headers, `timingSafeEqual`, fail closed in production
  without a secret (`mcp-bridge.ts`, verified by the boot guard in
  `BUILD_STATE.md` 2026-10-05 Next 15 entry).
- `org_id` is stripped from every registered tool schema; the tenant comes
  from headers.
- Output sanitized after the size cap (`mcp-bridge-format.ts`, RT-S07).
- 154 tool definitions in `tool-definitions.ts` (counted by `name:` entries);
  the old "62 tools" figure in `AGENTS.md` §2 and the gap docs is stale.

### 3.2 Broken / missing

| ID | Issue | Priority | Effort | Fix |
|---|---|---|---|---|
| B-0 | **Model-supplied role fallback.** When the signed context has no role, the bridge uses `args.employee_role` from the model's own tool arguments (`mcp-bridge.ts:1783-1784`), and several tool schemas expose `employee_role` to the model (`mcp-bridge.ts:336,345,380,388,395,402,409`; `tool-definitions.ts:315`). The signed role is dropped whenever a caller signs with the legacy v2/v1 formats, which the bridge still accepts (`mcp-bridge.ts:1879-1883`), or sends no role (worker callers without a role). A prompt-injected tool call can then name `Finance` or `Customer Resolution` and be gated against that employee's card. The comment at `mcp-bridge.ts:1701` says the opposite. | P0 | S | Never read `employee_role` from args; remove it from all schemas; reject v1/v2 signatures in production; no role → `missing_employee`. |
| B-1 | Bridge forwards only role, not employee id or user id (see R-1). | P0 | S | Add both to the signed material (`trueforge-client.ts:369-372`) and to the bridge context (`mcp-bridge.ts:1841-1926`). |
| B-2 | Replay window is enforced (`TENANT_TS_SKEW_MS`, `mcp-bridge.ts:1876-1877`), but legacy v1 signatures without a user id are still accepted, so a header set signed for one user validates for any user in the window. | P2 | S | Drop v1/v2 acceptance after the transition; log their use until then. |
| B-3 | The `darex-ai` named agent manifest sets `iteration_limit: 100` and `require_approval_for_tools: ['@write','@destructive']` (`trueforge-client.ts:265-285`) while per-session specs use a different approval list. Two definitions of the same agent drift. | P2 | S | Generate both from one function. |
| B-4 | `AGENTS.md` still says "62 real connector+DB+web tool executors" and the bridge "exposing 62 mcp.darex.* tools". | P2 | S | Update to the generated count from `chat-coverage.ts`. |

---

## 4. Temporal workflows, retries and idempotency

### 4.1 Works

| Area | Evidence |
|---|---|
| Agent turn retry guarded by idempotency key per activity execution | `activities/index.ts` `runGuardedAgentTurn`; `agent-turn-retry.test.ts` (8 cases) |
| Inbound dedupe by event-derived `WorkItemWorkflow` id | `BUILD_STATE.md` 2026-10-05 retry entry |
| Inbound always solo, never crews | `AGENTS.md` §2 data flow; `WorkItemWorkflow.ts` |
| Route then retrieve under `patched()` | `WorkItemWorkflow.ts:187-206` |
| Provider idempotency key for Stripe writes | `tools/shared.ts` `providerIdempotencyKey`; `tool-executor.ts:332-339` |
| Sweep once-per-period claim | `activities/sweep-governance.ts:65-86` |
| Per-pass org status gate on sweeps | `workflows/sweep-gate.ts`; used by 15 workflow files |
| Decision expiry never approves | `activities/sweep-governance.ts:88-142` |

### 4.2 Broken / missing

| ID | Issue | Priority | Effort | Fix |
|---|---|---|---|---|
| T-1 | Provider idempotency only on Stripe. Razorpay, Twilio, HubSpot, Gmail and calendar writes have none (`BUILD_STATE.md` 2026-10-05). | P1 | M | Add header where the provider supports it (Razorpay supports `X-Razorpay-Idempotency`? verify), else a local `tool_invocations` dedupe on `(org, anchor, tool, action, args-hash)` within 10 minutes for non-read calls. |
| T-2 | 14 per-org long-running sweeps started for every active org regardless of which employees the org has or which connectors are connected (`periodic-registry.ts:35-54`, `:80-98`). A pure-support org runs Growth's Market Scout, Reply Sorter and Dossier sweeps. Actions are later denied by the gate (paused or missing employee), but polling and LLM calls in the sweeps still run. | P1 | M | Gate each sweep on "owning employee exists, is active and its required connectors are connected"; check every pass, like `orgSweepAllowed`. |
| T-3 | Sweeps are hand-rolled `continueAsNew` loops, not Temporal Schedules. A sweep that ends (bug, org reactivation) only restarts on worker boot or org provisioning. | P2 | L | Migrate to Temporal Schedules with per-org schedule ids; pause/resume with employee status. |
| T-4 | `maxActionsPerSweep` loaded, never enforced (`cost/track.ts:28`). A sweep can create unlimited cards or sends per pass. | P1 | S | Pass the ceiling into each sweep activity and stop after N gated actions; log `suppressed: sweep_cap`. |
| T-5 | Worker scale. One task queue `darex-agent-tasks` (`periodic-registry.ts:4`, `worker.ts:82`) carries interactive agent turns, sweeps, embeds and DSR jobs. A burst of embed jobs delays customer replies. | P1 | M | Split queues: `agent-interactive`, `agent-sweeps`, `ingest`, `dsr`; give interactive its own worker with higher `maxConcurrentActivityTaskExecutions`. |
| T-6 | Long-running background tasks are only expressible as fixed sweeps. There is no "start a durable agent task from chat" (for example "watch this deal and tell me when it moves", "every Friday send me pipeline changes"). | P1 | L | See §12.1. |

---

## 5. Budgets, usage and cost

### 5.1 Works

- Hard usage cap checked inside the gate on every tool call
  (`tool-gate.ts:237-238`, `usage-gate.ts:151-251`), failing closed unless
  `DAREX_USAGE_GATE_FAIL_OPEN=true` (`usage-gate.ts:230-233`).
- Turn spend recorded per org per day (`cost/track.ts`), and
  `escalate_only` is flipped when the daily ceiling is breached
  (`cost/track.ts:85-88`).
- Crew pre-flight spend check (`activities/crew-budget.ts`).

### 5.2 Broken / missing

| ID | Issue | Priority | Effort | Fix |
|---|---|---|---|---|
| C-1 | `escalate_only` is read only by the crew check. Solo chat turns, inbound turns and sweeps ignore it. The flag's name promises "the org now only escalates", but nothing changes for 95% of turns. | P0 | M | In `runToolGate`, after usage: when `escalate_only`, park every non-read call with reason `spend_ceiling`. In `runAgentTurnActivity` and Ask AI, refuse new turns above the ceiling with a clear message. |
| C-2 | The crew spend check fails open on any error (`activities/crew-budget.ts:51-58`). | P1 | S | Fail closed for multi-specialist crews; allow solo. |
| C-3 | Usage-cap check runs on every tool call, but not before the model call. An org over its hard cap still pays for the model turn, then every tool is refused. | P1 | S | Call `assertUsageAllowed` before `runTrueForgeTurn` in all entry points (dashboard routes already do on `/api/agent/*`; confirm Ask AI and worker). |
| C-4 | Per-employee cost attribution. `recordTurnSpend` receives `employeeId` (`trueforge-client.ts:571`) but `org_model_spend` is keyed by org and day only. | P2 | M | Add `org_employee_spend (org_id, employee_id, spend_date, …)`. |
| C-5 | Sub-agent model choice uncapped (R-4). | P1 | S | Model allowlist. |
| C-6 | No per-turn cost ceiling (R-M1). | P1 | M | As above. |

---

## 6. Memory and the brain

### 6.1 Tiers and stores as built

| Store | Table / service | Written by | Read by |
|---|---|---|---|
| Org memory | `org_memory` (+ `embedding`, `body_tsv`) | Embed pipeline (`activities/embed.ts:391`), Brain create/upload, Drive/Notion ingest | Hybrid SQL (`memory/retrieve.ts:342-370`), Brain UI |
| Employee memory | `employee_memory` | **Nothing.** No `INSERT INTO employee_memory` anywhere in `apps/` or `services/` | Hybrid SQL employee branch (`memory/retrieve.ts:276-313`), Brain UI (`api/brain/route.ts:164-170`) |
| Entity memory | `entity_memory` | Memory write-back (`activities/memory-writeback.ts:406,443`), real-estate tools (`tools/realestate/index.ts:134,473`), onboarding observation (`lib/onboarding-observation-query.ts:65`) | Hybrid SQL entity branch |
| Conversation memory | `conversation_memory` | Embed pipeline (`activities/embed.ts:356`), policy-gated | Hybrid SQL conversation branch (thread-only for Customer persona) |
| Facts | `facts` (migration `022_entity_graph.sql`) | **Nothing** | `retrieveFactsFirst` (`memory/retrieve.ts:652-681`) |
| Fact conflicts | `fact_conflicts` | **Nothing found** | `memory/fact-conflict-route.ts` (no caller) |
| Edges | `memory_edges` | Memory write-back (`activities/memory-writeback.ts:471`) | Not read by retrieval |
| Preferences | `org_preferences` | Growth decision route and growth activities | Growth activities only (`activities/growth.ts:237,436`) |
| Graph (Cognee) | dataset `org_<id>` | `rememberCognee` from write-back and the `cognee_memory_remember` tool | `searchCognee` in every retrieve (`memory/retrieve.ts:533-551`) and the `cognee_memory_search` tool |
| Graph (Hindsight) | bank `org_<id>` | `retainHindsight` from write-back and the remember tool | `searchHindsight` in every retrieve (`memory/retrieve.ts:554-566`) |

### 6.2 What works

- Hybrid ranking: `0.4 * ts_rank_cd + 0.6 * cosine`, minus 0.15 when stale,
  with entity-lock and same-thread boosts, cosine cut-off 0.45
  (`memory/retrieve.ts:415-421`).
- Embedding happens before the DB client is checked out
  (`memory/retrieve.ts:569-574`), honouring the pool rule.
- Per-statement timeout and HNSW iterative scan inside a transaction
  (`memory/retrieve.ts:578-596`).
- Disabled knowledge sources and their chunks are filtered in all four tiers
  (`memory/retrieve.ts:298-305` and siblings; MEM-B02).
- Expiry honoured (`expires_at`) in all four tiers.
- Persona token budgets (`memory/retrieve.ts:27-34`) and tier filters
  (`memory/retrieve.ts:683-728`); Customer limited to its own thread in SQL
  (`$10` thread-only, `memory/retrieve.ts:392-395`).
- Cognee and Hindsight run in parallel with the SQL search and fail to "SQL
  only" (`memory/retrieve.ts:533-566`). Cognee is skipped for orgs with no
  dataset, with careful cache semantics (`memory/cognee-client.ts:135-174`).
- Redaction before Cognee (`memory/cognee-client.ts:267-269`) and before
  embedding (`apps/dashboard/lib/embed-enqueue.ts`).
- Each embed job carries its own text (migration 208), chunked files roll up
  (`activities/embed.ts` `rollupChunkedSource`).
- Write-back policy: only five events may write memory, model-generated text
  alone may not (`memory/writeback-policy.ts:1-36`); price and legal fields
  are protected from model world knowledge
  (`activities/memory-writeback.ts:39-40`).
- Refund-eligibility citation computed from the real last Stripe charge for
  Customer refund questions (`memory/employee-retrieve.ts:22-45`).

### 6.3 What is broken

**M-1. Per-employee memory scope does not exist (P1, M).**
`employee_memory` is never written. The employee branch of the hybrid query
always returns nothing, so "employee memory scope" in every
`gap26sept/employees/*.md` spec is in practice "org memory with a different
token budget and tier filter".

Fix, step by step:
1. Decide what belongs in employee memory: the employee's own SOPs and
   playbooks, its learned preferences ("Growth: never pitch SOC2 to fintech"),
   and corrections made to its output.
2. Add `tier: 'employee'` with `employeeId` to the embed target union
   (`activities/embed.ts:41-42`) and an insert branch next to
   `conversation_memory`/`org_memory` (`activities/embed.ts:353-420`).
3. Brain create/upload: let an admin target an employee
   (`POST /api/brain` `create` with `employeeId`).
4. Decision outcomes: when a human edits or rejects an employee's draft
   (`work-items/[id]/decision`), write a short "correction" memory to that
   employee's tier (event `human_correction`, already allowed by
   `writeback-policy.ts`).
5. Add `employee_memory` to the DSR export list if it is not there
   (`dsr/tables.ts:36` lists it for delete).

**M-2. Facts-first retrieval reads an empty table (P1, M).**
`retrieveFactsFirst` (`memory/retrieve.ts:652-681`) selects from `facts`,
which no code inserts into. The memory write-back extracts facts
(`MemoryWriteBackFact`) but stores them as `entity_memory` rows and
`memory_edges`, not in `facts`.

Fix: in `activities/memory-writeback.ts`, after the entity row, upsert typed
facts into `facts (subject_id, predicate, object_*, status='current',
valid_from)`, closing the previous current fact for the same subject and
predicate (`valid_to = NOW()`, `status='superseded'`). When the new value
conflicts with a human-sourced fact, insert `fact_conflicts` instead and let
`routeActionImpactConflicts` (M-4) create a review card.

**M-3. `entityId` never reaches retrieval (P1, S).**
No turn entry point passes `entityId`/`entityType`
(`ask-ai/route.ts:1294-1301`, `activities/index.ts:281-288`,
`activities/index.ts:646-653`). Entity lock, facts-first and the Customer and
Sales entity filters (`memory/retrieve.ts:693-712`) never apply.

Fix: resolve the contact at the start of inbound turns (the
`customer/account-profile.ts` lookup already resolves by email/phone) and pass
`entityType: 'contact', entityId`. In Ask AI, resolve an entity when the
message names a known contact or when the conversation is linked to one.

**M-4. Turn-time fallback retrieval ignores role (P2, S).**
When a caller does not prefetch, both engines call `retrieveMemory` without
`employeeRole` (`local-turn.ts:649-660`, `trueforge-client.ts:593-605`), so
persona tier filters and the Customer thread-only rule do not apply. The main
callers prefetch, but `crew-runner.ts` (direct crew path, `:163,186,234`) does
not.

Fix: pass `employeeRole: input.employeeRole` in both fallbacks; prefer
`retrieveForEmployee` so the refund citation also applies.

**M-5. Graph memory bypasses persona filters through the tool (P1, S).**
Retrieval drops `graph` citations for Customer, Operations, Growth and
Marketing (`memory/retrieve.ts:690-721`, MEM-S08). The `cognee_memory_search`
tool returns graph citations unfiltered (`tools/cognee.ts:60-115`). Any
employee with `cognee` on its card (Executive today) sees cognified transcripts
from every customer.

Fix: run `filterCitationsForPersona` inside the tool with the gate's
employee role (available in the tool context once R-1 passes it).

**M-6. Model-written memory is unverified (P1, M).**
`cognee_memory_remember` writes whatever text the model sends into Cognee and
Hindsight (`tool-definitions.ts:1457-1466`). This contradicts the write-back
policy (`writeback-policy.ts`: generated text alone may not write memory) and
the plan's "self-citation memory drift" fix (`plan/06…md` §3 seam 5). The tool
is not core (`tool-gate.ts:33`), so only cards with `cognee` can call it, which
today is Executive only, even though the Customer, Emma and Research personas
and the shared system prompt tell the model to "prefer cognee_memory_remember"
(`employee-provision.ts:67,95`; `system-prompt-builder.ts:139`). The prompt
and the cards disagree.

Fix: make "remember" a draft-risk action that creates a pending memory
(`memory_proposals` table) shown in the Brain for one-click accept; accepted
items go to `org_memory` or `employee_memory` and then to Cognee/Hindsight.
Update the prompt to say "propose to remember". Add `cognee` to the cards
whose personas mention it, once remember is a proposal.

**M-7. Brain and graph stores drift (P2, M).**
Correcting an `org_memory` row re-embeds it (brain.md row 1) but does not
update Cognee or Hindsight, which may hold the old fact. Deleting a row does
not delete the corresponding graph nodes.

Fix: on correction or delete, call Cognee's per-data delete when available,
or re-cognify the org dataset nightly from authoritative Postgres rows only.

**M-8. Contradictions are not arbitrated (P2, M).** Two org memories that
disagree are both returned; ranking only prefers fresher rows by the stale
penalty. Fix: when two top citations share a subject/predicate with different
values, prefer human-sourced, then newer, and add a "conflicting memory"
line to the facts block so the model says so.

**M-9. Hindsight dev key fallback on `main` (P0, S).**
`memory/hindsight-client.ts:25` uses `'darex-hindsight-dev-key'` when
`HINDSIGHT_API_KEY` is unset. `BUILD_STATE.md` (2026-10-05, Cognee search
entry) states this fallback "was not taken", but commit `81f50348` added it.
It breaks rule 5 in `AGENTS.md` §3 (no dev-key fallbacks in shipped code).
Fix: no fallback; when unset in production, Hindsight is disabled with one
warning.

**M-10. Cognee server auth is still off (P0, human).** brain.md row 7: the
server auth is wired but disabled until a Cognee API key is minted and
`COGNEE_REQUIRE_AUTHENTICATION=true` is set. Any process on the Docker network
can read every org's graph. Mark 🔴 Blocked (human) until done.

### 6.4 What gets written, and when

| Event | Where | Store | Gate |
|---|---|---|---|
| Ask AI reply finished | `ask-ai/route.ts:1381` → `MemoryWriteBackWorkflow` | entity memory, edges, Cognee, Hindsight | `writeback-policy` event check, min confidence 0.75 (`memory-writeback.ts:36`) |
| Approve in chat | `ask-ai/approve/route.ts:206` | same | same |
| Conversation closed / updated | `conversations/[id]/route.ts:163` | same | same |
| Inbound message | `activities/index.ts` `enqueueEmbedActivity` | conversation memory (policy-gated, MEM-S02) | embed policy |
| Brain create/upload/correct | `api/brain`, `api/brain/[id]` | org memory (+ revisions) | owner/admin |
| Drive/Notion sync | `IngestWorkflow`, `SyncWorkflow` | org memory chunks | connector |
| Growth reject `wrong_fit` | `work-items/[id]/decision/route.ts:344` | `org_preferences.rules` | human decision |
| Model remember tool | `tools/cognee.ts` | Cognee + Hindsight | card allowlist only (M-6) |

Not written anywhere: employee memory, facts, fact conflicts, playbooks,
procedural memory, outcome labels on decisions.

### 6.5 Forgetting and DSR

Works:
- DSR delete covers 61 tables and names 28 retained ones with a reason;
  a test fails when a new `org_id` table is in neither list
  (`dsr/tables.ts`, `tables.test.ts`).
- Cognee dataset and Hindsight bank deletion for DSR, with the dataset marker
  kept until the delete succeeds (`memory/cognee-client.ts:327-349`,
  `memory/hindsight-client.ts:180-193`).
- `memory_revisions` cleared by org purge.

Missing:

| ID | Gap | Priority | Effort | Fix |
|---|---|---|---|---|
| F-1 | Per-subject DSR. Deletion is per org. A request from one customer ("forget me") cannot remove that person's rows across `entity_memory`, `conversation_memory`, `messages`, Cognee and Hindsight. | P0 (GDPR/DPDP for end customers of tenants) | L | Subject-scoped DSR: resolve all identifiers (email, phone, contact ids), delete rows by `entity_id`/`conversation_id`, call Hindsight memory delete by id and re-cognify Cognee without that subject. |
| F-2 | Export covers fewer tables than delete (`BUILD_STATE.md` DSR entry). | P1 | M | Drive export and delete from the same table list. |
| F-3 | Org purge does not call Cognee/Hindsight, Nango, Langfuse, SuperTokens or MinIO (`BUILD_STATE.md` DSR entry). | P1 | M | Add purge steps with retries, mirroring DSR delete. |
| F-4 | Time-based forgetting. `expires_at` exists on all tiers, but nothing sets it except where callers choose to; conversation memory lives forever. | P2 | S | Default `expires_at` for conversation memory (for example 180 days, per-org setting). |
| F-5 | Langfuse traces contain user prompts and outputs and are not part of DSR. | P1 | M | Store traces with a subject id and delete via Langfuse API on DSR, or redact inputs before ingest. |

### 6.6 Learning from feedback

| Loop | State | Evidence |
|---|---|---|
| Growth rejection → ICP preference rule | **Works** | `growth/preferences.ts` `ruleFromRejection`; decision route `:344`; read by `activities/growth.ts:237,436` |
| Growth suppressions | **Works** | decision route `:100` |
| Knowledge-gap clustering for Customer | **Works** (surfacing only) | `customer/knowledge-gap-clusters.ts`; `/api/employees/customer` |
| Playbook proposal after N similar completed work items | **Built, not wired** | `memory/playbook-proposal.ts:22` has no caller |
| Fact conflict → review card | **Built, not wired** | `memory/fact-conflict-route.ts:8` has no caller; `fact_conflicts` has no writer |
| Employee health bands (approval-rate too high = rubber-stamping, etc.) | **Partly**: computed in the dashboard (`lib/employee-metrics-query.ts:320` writes `org_employee_metrics_daily`) but the worker's `recordEmployeeMetrics` only returns log fields and persists nothing (`employee-metrics.ts:100-112`) | |
| Draft edit → style learning for Customer/Sales | **Missing** | Edits to drafts in approvals (`modifiedPayload`) are stored but never learned from |
| Approval outcome → autonomy suggestion | **Missing** | No job proposes raising or lowering a tier from approval history |
| Confidence calibration | **Missing** | Confidence is a constant 0.7 at the gate unless the caller passes one (`tool-gate.ts:276`; `autonomy.ts:22`) |

Fix plan (P1, M overall):
1. Call `maybeProposePlaybook` from the work-item completion path
   (`api/work-items/[id]` status → done) with `shapeKey = type + tool sequence`.
2. Call `routeActionImpactConflicts` from `GovernanceSweepWorkflow` each pass,
   once M-2 writes `fact_conflicts`.
3. Learn from `modified_payload`: when an approver edits a draft, store
   `(original, edited)` as a `human_correction` in the employee tier and
   include the last 3 corrections for that employee and action type in the
   prompt as "Recent corrections from your manager".
4. Autonomy suggestion job: per employee and action type, if the last 20
   approvals were approved unmodified, create a decision card "Allow Emma to
   send FAQ replies without approval?"; never change tiers automatically.

---

## 7. Guardrails

### 7.1 Works

| Guardrail | Evidence |
|---|---|
| Tool-output fencing and injection redaction (both engines) | `guardrails/tool-sanitizer.ts`; `local-turn.ts:599-602`; `mcp-bridge-format.ts` |
| Persona fenced as untrusted card text | `prompts/system-prompt-builder.ts:20-25,118` |
| Untrusted customer content fencing and obligor-sender check | `untrusted.ts:25-43`; `customer/obligation-checks.ts` |
| Critic before any send (fresh and approved) | `tool-gate.ts:315-317,341-344`; `activities/critic-check.ts` |
| No invented money or Slack channel | `tool-gate.ts:128-147` |
| Quiet hours for unattended sends | `tool-gate.ts:318-321`; `quiet-hours.ts`; `activities/guarded-send.ts:178-180` |
| Inbound HITL pre-turn and post-reply | `inbound-hitl.ts`; `WorkItemWorkflow.ts:270,544-556` |
| Customer low-RAG confidence gate → holding reply + decision card | `activities/index.ts:292-339`; `customer/confidence-gate.ts` |
| SSRF guard for URL fetch | `tools/safe-url.ts` (+ test) |
| Sandbox without host access | `tools/sandbox.ts`, `sandbox-no-host.test.ts` |
| Read-only SQL tool | `tools/database.ts`, `database-readonly.test.ts` |
| Header-injection-safe email build | `tools/gmail.ts` `buildRawEmail` |

### 7.2 Broken / missing

| ID | Issue | Priority | Effort | Fix |
|---|---|---|---|---|
| G-1 | Regex injection list is short and English-only (`guardrails/tool-sanitizer.ts`). It is a tripwire, not a defence. | P2 | M | Keep fencing as the main defence; add a cheap classifier pass for high-risk tool outputs (email bodies, web pages) when the next step is a write. |
| G-2 | No output guardrail on the final reply: PII echo (card numbers, national ids) and secrets are not scrubbed before customer channels. | P1 | M | Run `redactForEmbed`-style scrubbing on outbound customer-channel replies; block replies that contain API-key patterns. |
| G-3 | `employee-gate` role deny lists are effectively unreachable. The gate passes a surface type (`external_send`, `pay`, `delete`, `observe`) as `actionType` (`tool-gate.ts:165-170,327-333`), but `roleAllowsTool` looks for `refund`, `ads_insights`, `apollo_search`, `draft_email` substrings (`employee-gate.ts:7-23`). Only the `refund` and `delete_record` patterns could ever match, and only when risk is null. Persona denial (`role-capability.ts`) is the real role gate. | P2 | S | Delete the deny lists from `employee-gate.ts` and keep it as the stage gate only, or pass the real action name. |
| G-4 | Persona action denials are soft when the tool is on the card (`role-capability.ts:78-97`). Operations has `gmail`/`slack` on its card and `send_email`/`send_channel` in its deny list; the deny is skipped. Sends still park (confirm class), so the risk is a human approving an Operations-authored customer email. | P1 | S | Make action denials hard for send classes; Operations should draft and hand off. |
| G-5 | `confidence` at the gate is a constant 0.7 for chat (`tool-gate.ts:276`). Autonomy rules with `confidence_threshold` are therefore decided by a constant. | P1 | M | Derive confidence from evidence: top RAG similarity, whether the target entity was resolved, tool read before write, model self-report; store the breakdown (the ledger already has `confidenceBreakdown`, `autonomy.ts:501-525`). |
| G-6 | Hallucinated identifiers. Nothing checks that an id passed to a write (deal id, event id, message id) was returned by a read earlier in the turn. | P2 | M | Keep a per-turn set of ids seen in tool results; for update/delete actions, require the id to be in that set or ask. |
| G-7 | No jailbreak/abuse screening on public widget and inbound channels before the agent runs. | P2 | M | Lightweight classifier on inbound text; route abusive or prompt-attack messages to `needs_attention` without a model turn. |

---

## 8. Autonomy tiers and approvals

### 8.1 How it actually decides

1. Confirm-class tools (`risk` in pay/send/sign/publish/delete/execute, or
   `confirm: true`) **always** park (`tool-gate.ts:348`). No tier lets them run
   unattended from any path, including sweeps.
2. Below the skill minimum tier, non-read non-draft calls park
   (`tool-gate.ts:262-269,349`).
3. Rollout stage 0 runs reads only and records everything else as shadow;
   stages 1–3 escalate by surface (`employee-gate.ts:24-36`,
   `tool-gate.ts:327-338`).
4. `checkAutonomy` then decides by reversibility, `requires_human_approval`,
   confidence threshold and blast radius (`autonomy.ts:185-220`). The
   `autonomy_tier` number is reported but does not change the decision.
5. Finance `confirmClasses: ['pay']` and `create_charge`/`payout` force
   approval (`autonomy.ts:299-332`).

### 8.2 Works

- Irreversible always asks, first (`autonomy.ts:204-206`).
- Approvals re-enter the gate with the stored call, not the caller's copy
  (`tool-gate.ts:213-221`), and still check pay RBAC, critic and quiet hours
  (`tool-gate.ts:307-322`).
- One approval function for all three surfaces (`lib/decide-approval.ts`):
  role gate, dual approval for refunds, expiry, execute on final approval,
  16 KB `modifiedPayload` cap (decisions.md rows 5–8).
- Expiry sweep every 15 minutes, never approves, audited
  (`activities/sweep-governance.ts:88-142`).
- Slack push of new decision cards (`autonomy.ts:472-499`).

### 8.3 Broken / missing

| ID | Issue | Priority | Effort | Fix |
|---|---|---|---|---|
| A-1 | Failed park is reported as "Waiting for approval" with null ids (`tool-gate.ts:278-305`). The user believes a card exists; nothing will ever run or expire. | P0 | S | If `park` throws or returns no `pendingActionId`, return `status: 'error'`, reason `park_failed`, and say nothing was queued. |
| A-2 | `loadEmployeeAutonomyTier` picks one arbitrary rule row for the role with no `action_type` filter and no deterministic order beyond `employee_role NULLS LAST` (`tool-executor.ts:47-67`); it returns tier 2 on any error. The skill-tier check thus compares against a random rule's tier. | P1 | S | Look up the rule for the bucket of the call (`bucketRuleKey(bucket)`), fall back to the default rule; on DB error, treat as tier 1 (park). |
| A-3 | `autonomy_tier` has no effect inside `evaluateAutonomy`. The Settings → Autonomy tier editor (autonomy.md row 1) edits a number that only the skill-tier check reads (A-2). Operators think they changed behaviour. | P1 | M | Either drive `evaluateAutonomy` by tier (tier 1 observe, 2 draft-only, 3 act reversible, 4 act visible within thresholds) or remove the tier field from the UI and keep reversibility/approval/confidence. Recommended: tier drives it. |
| A-4 | Four definitions of default rules: `autonomy.ts` `DEFAULT_RULES` (5 buckets, also used as fallback), `autonomy.ts` `seedDefaultAutonomyRules` (no caller), `cold-start.ts` `DEFAULT_AUTONOMY_SEED`, and the dashboard copy now imported from cold-start (agent-governance.md rows 3–4). | P2 | S | Keep `cold-start.ts` as the only seed; delete `autonomy.ts:seedDefaultAutonomyRules`; document that `DEFAULT_RULES` is the runtime fallback. |
| A-5 | Pending actions are not keyed to an employee id. `agent_pending_actions` stores `employee_role`; the employee id is only inside `payload` (`tool-gate.ts:289`, `autonomy.ts:419-440`); the decision work item has no `assignee_employee_id` (`autonomy.ts:399-414`). Per-employee approval rate must parse JSON. | P1 | S | Add `employee_id` column (migration), set it in `parkPendingAction`, set `assignee_employee_id` on the decision work item. Migration 205 did this for the ledger only. |
| A-6 | Blueprint "Level 3/4 autonomy" (CE-04 rescheduling and CE-06 address edit "100% automatic", OE-08 Meet link injection "autonomous") cannot be reached for actions classed as send/publish because confirm class always parks. Either the blueprint claims are wrong or the gate needs a bounded exception. | P1 | M | Introduce per-org "pre-approved action templates" (tool, action, argument constraints, e.g. calendar update within ±7 days for an existing event the customer attends) that an owner approves once; the gate executes matching calls without a card and logs `pre_approved_template`. |
| A-7 | Two approval surfaces still exist in the UI: Ask AI inline approval (harness pause) and decision cards (DB). See R-2. | P1 | M | One surface. |
| A-8 | No approval delegation, routing or escalation chain (who approves Finance vs Customer actions, backup approver when the owner is away, SLA reminders). | P2 | M | `approval_policies (org, action_bucket, approver_role, backup_user, remind_after)`; governance sweep sends reminders. |

---

## 9. Crew runtime

### 9.1 Works

- Cap 3 in shared types, crew contract, Ask AI team mode
  (`packages/shared-types/src/crew.ts:6`, `crew-contract.ts:11`,
  `CrewWorkflow.ts:64`).
- `Promise.allSettled` isolation, failed specialist reports, 2 500-char report
  truncation, 3-minute synthesis timeout (`CrewWorkflow.ts:155-194`,
  `crew-contract.ts:18-27`).
- Fixed-member Team mode never collapses to solo (`CrewWorkflow.ts:65-86`).
- Client abort cancels the Temporal crew (crew-workflows.md row 4).
- Crew dispatch audited (`BUILD_STATE.md` 2026-10-05 audit entry).

### 9.2 Broken / missing

| ID | Issue | Priority | Effort | Fix |
|---|---|---|---|---|
| W-1 | Specialists run with `conversationId: undefined` (`CrewWorkflow.ts:159`), so their memory retrieval loses the thread and they cannot see prior messages. | P1 | S | Pass the conversation id for retrieval but keep `skipPersist: true`. |
| W-2 | No dependencies between specialists; all run in parallel and blind to each other. "Research then Sales drafts" cannot be expressed. | P1 | M | Allow the planner to return stages; run stage N with stage N-1 reports in `priorToolResults`. |
| W-3 | No shared scratchpad; two specialists can write the same CRM record concurrently. The `agent_entity_leases` table exists (migration 023, 5-minute expiry) with precedence rules (`autonomy.ts:64-80`) but no caller takes a lease. | P1 | M | Take a lease in the gate for write calls that name an entity id; deny or wait on conflict. |
| W-4 | Crew spend check fails open (C-2). | P1 | S | — |
| W-5 | No per-specialist cost or trace. | P2 | S | Pass `employeeId` into `recordTurnSpend` (already), and tag Langfuse traces per child. |
| W-6 | Synthesis retries (2 attempts) re-run the full synthesis, which may call tools again (it is a normal agent turn). | P2 | S | Give the manager synthesis turn an empty allowlist (core reads only). |

---

## 10. Observability and evaluation

| Area | State | Gap / fix | Priority | Effort |
|---|---|---|---|---|
| Langfuse traces | Dashboard and worker turns traced; in-process engine uses `noopTracing` for inner events (`local-turn.ts:259`) | Implement tracing to get per-tool spans and sub-agent spans | P2 | S |
| Tool audit | Append-only `tool_invocations` for every gate call (`tool-audit.ts`, migration 126) | Add `employee_id` and `actor_user_id` once R-1 lands | P1 | S |
| Decision ledger | `agent_decision_ledger` with employee id since migration 205 | Counterfactual non-actions from sweeps are logged inconsistently | P2 | M |
| Eval harness | `infra/evals` with YAML suites (honesty, empty org, obligations, real-estate, custom skills) and `run-evals.sh` (comment: "WS-01 should add CI job") | Not in CI (no workflow references it). No suites for routing accuracy, tool selection, approval behaviour, hand-off, or memory isolation. | P1 | M |
| Online quality | None | Sample 1% of turns for an LLM-judge score on grounding and policy; feed `grounding_rejection_rate` band | P2 | M |

Eval harness plan:
1. Add a CI job that runs `run-evals.sh` against a seeded Postgres with
   `EVAL_ALLOW_MISSING_MEMORY=0` and a recorded-model provider
   (`infra/evals/providers`), so it is deterministic and free.
2. New suites: `routing.yaml` (message → employee, reuse
   `employee-capabilities.test.ts` rows), `approval.yaml` (every confirm-class
   tool parks; reads never park), `isolation.yaml` (Customer never cites
   another thread; Growth never cites conversation tier), `handoff.yaml`
   (locked employee offers hand-off for out-of-scope asks).
3. A nightly job against the real model cascade, reporting pass rates per
   suite to a dashboard; fail the build only on the deterministic suites.

---

## 11. Documentation drift found during this audit

| Doc says | Code says |
|---|---|
| `AGENTS.md` §2: 62 tools in executor and bridge | 154 definitions (`tool-definitions.ts`) |
| `gap26sept/agent-governance.md`: `employee-gate.ts` and `employee-metrics.ts` unwired | Gate is called from `tool-gate.ts:327`; metrics function is called (`tool-executor.ts:270`) but persists nothing |
| `gap26sept/employees/growth.md`, `sales-lead-gen.md`: runtime crew cap 8 | 3 (`packages/shared-types/src/crew.ts:6`) |
| `gap26sept/employees/executive.md`: narrow allowlist, no send | Executive card now also has gmail, calendar, drive, docs, sheets, slides, slack (`employee-provision.ts:132-146`, migration 210) |
| `BUILD_STATE.md` 2026-10-05: Hindsight dev-key fallback not taken | Present at `memory/hindsight-client.ts:25` |
| `gap26sept/brain.md`: `memory_embeddings` table, cascading FK | Vectors are columns on each `*_memory` table; no separate table |
| Persona text and system prompt: "prefer `cognee_memory_remember`" for Customer, Emma | Neither card has `cognee`; the tool is never-core |
| `3-employee.md` CE-04/CE-06: "100% automatic", Level 4 | Gate parks every send-class call; see A-6 |

---

## 12. Future architecture upgrades

### 12.1 Long-running background tasks from chat

Today: only fixed per-org sweeps (§4.2 T-6). Target: a user can say "watch
the Acme deal and tell me when it moves" or "every Monday 9am send me
churn-risk accounts" and get a durable task owned by an employee.

Design:
- `agent_tasks (id, org_id, employee_id, created_by, kind 'watch'|'recurring'|'one_off', spec jsonb, schedule, status, last_run_at, next_run_at, budget jsonb)`.
- `AgentTaskWorkflow` per task: sleeps until `next_run_at` (or Temporal
  Schedule), runs one agent turn with the task spec as the message and the
  owning employee's card, compares the result with the last stored result,
  notifies only on change.
- Chat tools: `task_create`, `task_list`, `task_pause`, `task_cancel` (draft
  risk; creation needs approval when the task can send).
- Every run goes through the same gate; per-task budget (max runs per day,
  max cost) enforced in the workflow.
- UI: "Tasks" tab on the employee profile.
- Effort: L. Priority: P1 (it is the product promise "works 24/7").

### 12.2 Scheduled agents

Replace hand-rolled sweep loops (§4.2 T-3) with Temporal Schedules:
- One schedule per (org, sweep) with spec from a registry that also names the
  owning employee and required connectors.
- Pause the schedule when the employee is paused or archived, or the
  connector disconnects; resume on reconnect.
- Per-org overrides of cadence (Settings → Employees → Schedule).
- Effort: L. Priority: P2.

### 12.3 Self-improvement loops

Ordered by value and safety:
1. **Correction memory** (M-1 step 4, §6.6 step 3): manager edits become
   few-shot examples for that employee and action. Low risk, high value. M.
2. **Playbook proposals** (`playbook-proposal.ts`): repeated successful
   tool sequences become a proposed skill/playbook card; on accept, saved as
   an employee-scoped SOP in `employee_memory`. M.
3. **Autonomy suggestions** (§6.6 step 4): never auto-promote; always a card.
   S.
4. **Prompt variants per employee** with A/B on approval rate and edit
   distance; the winning variant becomes default after N samples. L.
5. **Knowledge-gap closure**: when a knowledge-gap cluster gets an
   admin-written answer, re-run the failed questions as an eval and report
   the improvement. M.

Guardrails for all loops: every learned artefact is visible in the Brain,
attributed, revertible (revisions), and scoped to an employee; nothing
changes permissions without a human decision.

### 12.4 Eval harness

See §10. Add: per-employee scorecards (routing precision, tool success rate,
approval rate, edit distance on approved drafts, grounding rejection rate),
regression gate on deterministic suites, nightly live suite, and a
"replay a production turn against a new prompt" tool using stored Langfuse
inputs (redacted).

### 12.5 Multi-model routing

Today: a static cascade (override → Gemini → Groq → OpenRouter → LiteLLM),
one model per turn, and a different default on the HTTP path
(`openrouter/deepseek-v4-1-flash`, `trueforge-client.ts:117`).

Target:
- **Route by task class**, not by provider availability: classification and
  routing on a small fast model; tool-heavy turns on a model with strong
  function calling; long-document synthesis on a long-context model;
  customer-facing replies on the model with the best measured grounding score
  in evals.
- **Per-employee model profile** (R-M4): Research on a long-context model,
  Finance on a deterministic low-temperature profile, Marketing drafts with
  higher temperature.
- **Send everything through LiteLLM** so budgets, keys, retries with jitter
  and spend logs live in one place; keep direct providers only as an
  emergency fallback. Today in-process turns call providers directly and only
  `recordTurnSpend` counts them.
- **Cost-aware fallback**: when the daily spend crosses 80% of the ceiling,
  route non-customer turns to the cheapest passing model.
- **Measure**: per model, tool-call validity rate, approval rate of drafts,
  latency, cost; store on the trace and feed the router weights weekly.
- Effort: L. Priority: P2, except "all traffic through LiteLLM" which is P1
  for cost control.

### 12.6 Memory architecture

- Make Postgres the source of truth and the graph stores derived views,
  rebuilt from accepted memory nightly (fixes M-7 and simplifies DSR F-1).
- Add a `memory_proposals` inbox (M-6) as the only path for model-originated
  memory.
- Add typed facts with validity intervals (M-2) and use them first for
  structured questions ("what is Acme's renewal date").
- Add per-employee memory (M-1) and entity resolution at turn start (M-3).
- Evaluate dropping one of Cognee/Hindsight: both feed the same `graph` tier,
  both are filtered out for four of six personas, and both cost RAM on a small
  VM (`BUILD_STATE.md` 2026-10-01 lite entry). Keep the one that scores better
  on the memory eval suite.

### 12.7 Runtime simplification

- One engine. The in-process engine already does everything the sidecar does
  except durable session storage. Once approvals move to the DB (R-2) the
  sidecar is only a fallback that behaves differently. Plan to retire the HTTP
  path, or make it the only path; do not keep two with different approval and
  model semantics.
- One approval surface, one identity (employee id end to end), one budget
  check point (before the model call and inside the gate).

---

## 13. Consolidated tracker

| ID | Area | Gap | Priority | Effort | Files |
|---|---|---|---|---|---|
| B-0 | Bridge | Model-supplied `employee_role` used when signed role absent | P0 | S | `mcp-bridge.ts:1783-1784`, tool schemas |
| R-1 / B-1 | Runtime | Gate identity by role, no employee/user id | P0 | S | `local-turn.ts:568`, `mcp-bridge.ts:1772-1926`, `trueforge-client.ts:350-375`, `tool-executor.ts:207-243` |
| A-1 | Approvals | Failed park reported as pending | P0 | S | `tool-gate.ts:278-305` |
| M-9 | Memory | Hindsight dev-key fallback | P0 | S | `memory/hindsight-client.ts:25` |
| C-1 | Budget | `escalate_only` ignored outside crews | P0 | M | `tool-gate.ts`, `activities/index.ts`, `ask-ai/route.ts` |
| M-10 | Memory | Cognee server auth off | P0 | human | compose, env |
| F-1 | DSR | No per-subject deletion | P0 | L | `dsr/*`, memory clients |
| R-2 / A-7 | Approvals | Two approval layers, engines disagree | P1 | M | `local-turn.ts:357-391,617-631`, `trueforge-client.ts:488-492` |
| R-3 | Runtime | Paused turns in memory 30 min | P1 | M | `local-turn.ts:79-106,1032+` |
| R-4 | Runtime | Sub-agents lose persona; free model choice | P1 | S | `local-turn.ts:721-750` |
| R-8 | Workflows | Retry can repeat non-confirm writes | P1 | S | `AutonomousAgentWorkflow.ts:36-67`, `trueforge-client.ts:1110-1131` |
| R-7 | Workflows | 24 h wait vs 7 day expiry | P1 | S | `WorkItemWorkflow.ts`, `PlanExecuteWorkflow.ts`, migration 023 |
| T-1 | Workflows | Idempotency only on Stripe | P1 | M | `tools/*` |
| T-2 | Sweeps | Sweeps run for absent employees/connectors | P1 | M | `periodic-registry.ts`, sweep workflows |
| T-4 | Sweeps | `maxActionsPerSweep` unused | P1 | S | `cost/track.ts`, sweeps |
| T-5 | Scale | One task queue for everything | P1 | M | `worker.ts` |
| C-2, C-3 | Budget | Crew check fails open; usage checked after model call | P1 | S | `crew-budget.ts`, entry points |
| R-M1 | Budget | No per-turn token/cost cap | P1 | M | `local-turn.ts` |
| M-1 | Memory | `employee_memory` never written | P1 | M | `activities/embed.ts`, `api/brain`, decision route |
| M-2 | Memory | `facts` never written | P1 | M | `activities/memory-writeback.ts` |
| M-3 | Memory | `entityId` never passed | P1 | S | Ask AI, `activities/index.ts` |
| M-5 | Memory | Graph tool bypasses persona filter | P1 | S | `tools/cognee.ts` |
| M-6 | Memory | Model remember unverified; prompt vs card mismatch | P1 | M | `tools/cognee.ts`, prompt, roster |
| F-2, F-3, F-5 | DSR | Export narrower than delete; purge misses services; Langfuse | P1 | M | `dsr/*`, `lib/org-purge.ts` |
| §6.6 | Learning | Playbook/conflict loops unwired; no correction memory | P1 | M | `memory/playbook-proposal.ts`, `memory/fact-conflict-route.ts` |
| G-2 | Guardrails | No outbound PII/secret scrub | P1 | M | channel send path |
| G-4 | Guardrails | Soft persona action denials | P1 | S | `role-capability.ts:78-97` |
| G-5 | Autonomy | Constant confidence | P1 | M | `tool-gate.ts:276` |
| A-2 | Autonomy | Arbitrary tier row | P1 | S | `tool-executor.ts:47-67` |
| A-3 | Autonomy | Tier number has no effect | P1 | M | `autonomy.ts:185-220` |
| A-5 | Approvals | No employee id on pending actions | P1 | S | migration, `autonomy.ts` |
| A-6 | Autonomy | Blueprint L3/L4 unreachable for sends | P1 | M | `tool-gate.ts`, new templates table |
| W-1..W-3 | Crew | No thread context, no stages, no leases | P1 | M | `CrewWorkflow.ts`, `crew-runner.ts`, gate |
| §10 | Evals | Harness not in CI, missing suites | P1 | M | `infra/evals`, CI |
| R-5, R-6, R-M2..M6 | Runtime | Model visibility, session reset, tracing, resume, per-employee model | P2 | S–M | various |
| M-4, M-7, M-8, F-4 | Memory | Fallback role, store drift, contradictions, TTL | P2 | S–M | `retrieve.ts`, memory clients |
| G-1, G-3, G-6, G-7 | Guardrails | Regex list, dead deny lists, id provenance, inbound screening | P2 | S–M | guardrails, `employee-gate.ts` |
| A-4, A-8 | Autonomy | Duplicate seeds; no approval routing | P2 | S–M | `autonomy.ts`, `cold-start.ts` |
| W-5, W-6 | Crew | Per-specialist cost; synthesis tools | P2 | S | crew files |
| B-2..B-4 | Bridge | Timestamp age, manifest drift, docs | P1–P2 | S | `mcp-bridge.ts`, `trueforge-client.ts`, `AGENTS.md` |
