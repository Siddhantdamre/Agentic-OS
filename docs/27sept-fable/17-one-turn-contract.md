# 17 · One turn — the contract that makes chat, employees, and tools one system

> ### 📊 Master Audit Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 20 | 3.3% |
> | 🟡 **Pending / In Progress** | 42 | 7.0% |
> | 🔴 **Not Done (Open)** | 538 | 89.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 0.2% |
> | **Total Findings** | **601** | **100.0%** |

Audit date 2026-09-27. This file is the implementation contract behind files `02`, `03`, and `04`. Those files list holes. This file is the machine an implementer builds so a message, a plan step, a webhook, a crew child, and a nightly sweep all obey the same rules. Every step below names the function that exists today, the order it must run in, and the finding IDs it closes.

**Done means:** there is exactly one function that can cause a side effect, every caller uses it, and the tests in §9 are green.

---

## 1. Five entries, one exit

Today a side effect can start from five places, and four of them skip the gate.

| Entry | Starts at | What it passes into the executor | What it skips |
|---|---|---|---|
| Ask AI simple / locked turn | `ask-ai/route.ts` `streamSimpleAnswer` → in-process or Temporal turn | `employeeRole`, locked allowlist (`route.ts:546-580`) | Kill switch, rollout stage, `evaluateEmployeeGate`, zod, `module.confirm` |
| Ask AI plan step | `execute/route.ts:403-414`, `orchestration.ts:311-317` | Allowlist = core ∪ tools named **in the plan**; **no** `employeeRole` | `checkAutonomy` entirely (`tool-executor.ts:345-346` requires `employeeRole`), employee card, pay RBAC |
| Webhook / work item | `WorkItemWorkflow` → `runAgentTurnActivity` | Default employee's allowlist; `routeEmployeeActivity` can substitute it when the routed card is empty (`activities/index.ts:606-612`) | Same gate holes; critic only on the work-item reply path (`critic-check.ts:217` ← `WorkItemWorkflow.ts:438`) |
| Crew child | `CrewWorkflow` / `crew-runner.ts` | Per-specialist allowlist when Team mode; spend check only if `specialists.length > 1` (`crew-budget.ts:49-56`) | Kill switch, stage, per-child spend |
| Periodic activity | `activities/{growth,meeting-prep,rep-followup-sla,workload-balancer,customer,enrichment,open-loop-sweep}.ts` | Calls `executeProvider` **directly** (`tools/index.ts:354`) | Allowlist, autonomy, critic, quiet hours, ledger, kill switch, idempotency |

`autonomy.ts:515` (`notifyManagersOfDecisionCard`) also calls `executeProvider({tool:'slack'})` with no employee and no gate. A parked approval can post to Slack while the kill switch is on.

**Rule.** After this contract lands, the only production caller of `executeProvider` is `executeAutonomousToolAction`. Activities, autonomy notifications, and plan steps call the executor. A grep for `executeProvider(` outside `tools/index.ts` and `tool-executor.ts` is empty.

---

## 2. `executeAutonomousToolAction` — required order

The function already exists (`tool-executor.ts:222`). Keep the name. Replace the body so the checks run in this order and **none is skippable by omitting a field**. A missing field is a denial, not a default.

| # | Check | Inputs | Deny result | Closes |
|---|---|---|---|---|
| 1 | **Identity** | `orgId` from session/workflow only. `employeeId` (UUID) required. `employeeRole` loaded from `ai_employees` for that id, never from model args or `autonomyRun` if they disagree. `actorUserId` from the session when a human started the turn; null for sweeps. | `status:'error'`, `reason:'missing_employee'` | ASK-S02, EMP-S09 |
| 2 | **Org runnable** | Read `org_runtime_controls` + `orgs.status` for this org, uncached (or ≤5 s). Deny when `kill_switch`, `status ∈ {suspended, soft_deleted}`, or org missing. | `reason:'kill_switch'` or `'org_not_runnable'`. Shadow: write a ledger row, do not call the provider. | EMP-S01, EMP-S11 |
| 3 | **Rollout stage** | `evaluateEmployeeGate` (`employee-gate.ts:24`) with the real stage (default 0). `shadow` → ledger only. `escalate` → park approval, no provider call. `deny_role` → error. `allow` → continue. | Stage 0 never reaches step 12. | EMP-S03, EMP-G01 |
| 4 | **Usage** | `assertUsageAllowed` reads `org_model_spend` (not a page-view meter). Hard cap **fails closed** (DB error = deny, not allow). | `reason:'usage_blocked'` | RT-G01, BIZ-B02 |
| 5 | **Allowlist** | Exact match on the **resolved tool id**, not a prefix (`stripe` must not allow `stripe_create_charge` — RT-S18). Source of the list, in order: (a) locked turn's card, (b) the stamped `employeeId` on a plan step, (c) the sweep's owning employee. **Never** `resolveOrgToolAllowlist`. Empty card = `CORE_READ_TOOLS` only (§3). `undefined` is not "look up the org". | `reason:'not_in_allowlist'` | EMP-B05, ASK-S02, RT-S18 |
| 6 | **Persona denial** | One module: `services/workflows/src/tools/role-capability.ts`. Delete the dashboard copy (`role-scoped-tools.ts`) — it has the opposite meaning (EMP-B10). Denial wins even when the tool is on the card (EMP-S07). | `reason:'persona_denied'` | EMP-B10, EMP-S07 |
| 7 | **Payload** | `def.schema.safeParse(payload)`. No schema ⇒ deny in prod (`reason:'no_schema'`), not "run it". No monetary default, no `#general` default. | `reason:'invalid_args'` + zod issues | RT-B06 |
| 8 | **Confirm class** | `riskFor(tool, action)` then `confirmForRisk` (`tools/risk.ts:15`). Classes `send \| pay \| sign \| publish \| delete` always park, including when the caller is a plan step, a sweep, or `REQUIRE_TOOL_APPROVAL` is unset. Pay tools also require `canCallPayTools(actor)` (owner/admin). Sweeps have no actor ⇒ pay/send/delete always park. | `status:'pending_approval'`, no `token` in the model-visible payload | RT-B07, ASK-S05, SEC-R01, EMP-S08 |
| 9 | **Autonomy** | `checkAutonomy` **always**, using the DB role from step 1. `skipAutonomy: true` is rejected in production code paths (delete the flag or restrict it to tests). | existing `approval_required` / `execute` | ASK-S02 |
| 10 | **Critic + quiet hours** | Any action whose risk is `send` (and WhatsApp/SMS/email/Slack post) runs `critic-check` then quiet-hours. Fail or quiet ⇒ park or defer, do not send. Per-customer daily cap from `agent_outbound_budget`, keyed by recipient, not `LIKE '%send%'`. | `reason:'critic'` or `'quiet_hours'` or `'customer_cap'` | EMP-S04, EMP-S05, EMP-S06 |
| 11 | **Idempotency claim** | Insert `tool_invocations` row `(org_id, side_effect_key)` before the provider call. Conflict ⇒ return the stored result, do not call again. Key = sha256(orgId, employeeId, conversationOrWorkflowId, inboundEventId or stepId, tool, action, canonicalJson(payload)). | second call returns the first result | RT-B03, RT-B10, ASK-B01 |
| 12 | **Provider** | `executeProvider` with `AbortSignal` whose deadline is `min(moduleTimeout, TOOL_EXECUTION_TIMEOUT_MS)`. The timeout **aborts the fetch**; it does not race-and-abandon. Non-2xx, 401, 403 ⇒ `status:'error'`, `reason:'revoked' \| 'api_error'`. Never `status:'executed'` with `[]`. | honest error | RT-B04, RT-B05 |
| 13 | **Ledger + audit** | `logAutonomyDecision` with the real `employee_id` (not a default of `'operations'`). Mutating tools also `recordAuditEvent`. Spend, if the tool metered credits (Apollo), debits in the same transaction as the claim. | — | EMP-S09, EMP-G03, ASK-E01 |

`parkPendingAction` still creates the work item and the Slack card, but the Slack post goes through steps 2–12 as employee `operations` or the org's notification employee, risk `send`, and **the raw `token` is stored hashed only** (`autonomy.ts` already hashes; stop returning `token` to the model at `tool-executor.ts:393`).

---

## 3. Allowlist algorithm

```
CORE_READ_TOOLS = web_search, web_extract, cognee_search, database_query (read-only role), metrics
NEVER_CORE      = sandbox, terminal, bash, python, file_ops write, cognee_remember, maps

resolveTurnAllowlist(employee):
  card = employee.tool_allowlist            # exact ids, archived employee → []
  if card is empty: return CORE_READ_TOOLS
  return (card ∪ CORE_READ_TOOLS) minus persona denials minus NEVER_CORE
         plus connected channels that are named on the card
```

`ALWAYS_ALLOWED_CORE_TOOLS` (`tool-executor.ts:28-39`) is the bug: it puts `terminal_run_command`, `bash_execute`, `python_execute`, `file_ops`, and `cognee_remember` on every employee. Replace it with `CORE_READ_TOOLS`. Sandbox tools are opt-in per employee and per plan, and they have no host fallback (`sandbox.ts` returns `notConnected` when the sandbox is down — ASK-S01, RT-B02).

`DAREX_ALL_TOOLS` (`local-tool-select.ts:86-88`) is deleted from shipped code (ASK-S06).

Auto mode with no routed employee (emergency false positive, custom-only roster) returns **Executive's card or `CORE_READ_TOOLS`**, never the union of every card (EMP-B01, EMP-B03). The emergency regex (`route-employee.ts:73-82`) applies only to inbound channel text with at least two signals, not to "fire off an email".

---

## 4. Ask AI turn — state machine

`POST /api/ask-ai` (`route.ts:333`) in this order. The pool client is released before any LLM call (already true at `:539`).

| Step | Do | Fail |
|---|---|---|
| 1 | Session → `orgId`, `userId`. Reject body `org_id`. | 401 |
| 2 | `assertOrgRunnable`. | 403 `kill_switch` / `org_suspended` |
| 3 | Rate limit + usage gate, per user, `Retry-After` on 429. | 429 / 402 |
| 4 | Validate mode **before** inserting the user message (ASK-B12). Unknown employee, other org, archived → 400. Paused → auto + `fallbackNotice`. | 400, no orphan row |
| 5 | Persist mode on `conversations.ask_mode`. `@Name` overrides this message only. | — |
| 6 | Resolve employee (§3). Locked hand-off runs **only if** the locked employee lacks the tool the utterance needs (EMP-B07), and offers "continue as X" as a button, not a dead-end paragraph (ASK-G06). | hand-off event, no tools |
| 7 | Emit SSE `routing` **before** `classifyRequest`. Skip the classifier LLM when heuristics already decided (ASK-B10). | — |
| 8 | Branch: simple → agent loop; complex → `generatePlan` over **this employee's allowlist**, not 12 hardcoded tools (ASK-G08); team → crew, cap 3, spend check even for one specialist, fail closed (EMP-B14). | — |
| 9 | Every tool call inside the loop is §2. | `pending_approval` event with argument preview, no token |
| 10 | Fence tool text, web pages, prior turns, and specialist reports before they re-enter the model (ASK-S07, ASK-S10, WEB-S04). | — |
| 11 | `done` includes `usage` and omits `partialReply` (ASK-B16). Write-back goes through the memory contract (`19`). | — |
| 12 | Audit: mode change, crew dispatch, each executed tool, each approval. | — |

### Plan lifecycle

States: `pending → approved → running → completed | failed | cancelled`. `revise` always returns to `pending` (ASK-B11).

| Event | Required behaviour | Closes |
|---|---|---|
| Approve | Atomic `UPDATE … WHERE status='pending'`. Stamped `employeeId` per step is the employee §2 step 1 uses. Per-step risk badge; pay steps need a pay-capable actor. | ASK-G02, ASK-G03, ASK-S04 |
| Execute while `running` | Attach to the existing stream or return 409. Never re-run steps. | ASK-B01 |
| Cancel | Signal `cancelPlan`. Workflow re-reads `agent_plans.status` before each stage and stops. Does not overwrite `cancelled` with `completed`. | ASK-B02 |
| Revise | Status `pending`. Edited steps do not run until a new approve. | ASK-B11 |
| Durable poll timeout | SSE `still_running`; client re-opens. Never a silent end. | ASK-B06 |
| Temporal down at approve | API returns the error; status reverts to `pending` or surfaces `needs_execute`. | ASK-B05 |
| Hydrate thread | `ORDER BY created_at DESC LIMIT 200`, then reverse. Cursor for older. Restore `routing`, `handoff`, `approvalBox`, `usage`. A `running` plan opens the poll SSE. One `tool_calls` JSON shape for crew and direct. | ASK-B03, ASK-B08, ASK-B09 |

Persona text in `buildPersona` (`route.ts:68`) must not claim Gmail/Slack/HubSpot/Stripe are core, and must not say "never ask permission" (ASK-S08).

---

## 5. Sweeps

`PERIODIC_SWEEPS` is the only list. `kickPeriodicSweeps` calls `startSweepsForOrg` (EMP-B16). Each tick:

1. Re-read org status. Suspended / soft-deleted → return without sending (EMP-S11).
2. Resolve the owning employee id (Growth, Customer, or Operations row). No row → skip.
3. Every external call is §2 with that employee id. MeetingPrep guest mail, MarketScout HubSpot create, WorkloadBalancer owner reassignment, and RepFollowUp Slack are not special.
4. Idempotency key includes the business subject: `(eventId, guestEmail, day)` for deadlock pings (EMP-B08), `(leadId, signalHash)` for scout creates, `(workItemId, chaseDate)` for open-loop sends.
5. DormantLeadRevival is in the registry (EMP-G02).

Stage 0 records what the sweep *would* have done in the ledger and sends nothing.

---

## 6. Crew

| Rule | Detail |
|---|---|
| Cap | `MAX_CREW_SPAWN = 3` in one module. Delete the duplicate. |
| Members | Explicit ids from Team mode, or planner output scored by `rosterKey` (not `roleHints.find` — EMP-B13). Each member gets a scoped `task`, not a copy of the full user message. |
| Allowlist | Each child uses §3 for **its** employee. Manager synthesis runs with `toolAllowlist: []` and fenced specialist reports. |
| Spend | Check before start, including solo-via-crew. Fail closed. Record `org_model_spend` per child with `employee_id`. |
| Cancel | Parent cancel cancels `runAgentTurnActivity` via `CancellationScope`. Heartbeat so a dead worker fails the activity. |
| Inbound | Webhooks never spawn a crew. |

---

## 7. Tool result envelope

Every module returns this shape. The model and the UI both read it. Post-processors may format citations; they may not invent names, years, prices, or registration numbers (ASK-G09, WEB-B11).

```
{
  status: 'executed' | 'pending_approval' | 'error',
  reason?: 'kill_switch' | 'org_not_runnable' | 'shadow' | 'usage_blocked'
         | 'missing_employee' | 'not_in_allowlist' | 'persona_denied'
         | 'invalid_args' | 'no_schema' | 'not_connected' | 'revoked'
         | 'api_error' | 'rate_limited' | 'provider_unavailable'
         | 'critic' | 'quiet_hours' | 'customer_cap' | 'policy_denied',
  items?: Array<{ id, title, url?, snippet?, source, fetchedAt }>,
  nextCursor?: string,
  truncated?: boolean,
  approval?: { pendingActionId, workItemId, summary },  // never token
  message: string
}
```

`pending_approval` is not an error and not a success. The chat renders the summary and an Approve / Reject control. Approve calls the single approval executor (`12` packet 1.9), which re-runs §2 steps 11–13 with the stored payload, not a model-supplied one.

---

## 8. What "a working turn" is

A stranger in a new org, after connecting Gmail, can:

1. Open `/ask-ai`, leave mode on Auto, type "draft a reply to the latest email from Jane".
2. See a routing line naming Emma or Customer **before** the draft appears.
3. See a draft, not a sent message. Send requires Approve, and Approve writes one audit row.
4. Reload the thread and see the same draft and the routing line.
5. Turn the kill switch on, ask again, and get `kill_switch` with no Gmail call.
6. Set rollout stage to 0, ask a read ("what did Jane say"), and get a shadow ledger row and no live send — reads at stage 0 are also shadow until the org advances (the gate is one function; do not special-case reads in the route).

If any of those six fail, the contract is not landed, regardless of which finding rows are flipped.

---

## 9. Tests that define done

| Test | Asserts |
|---|---|
| `executor-gate.test.ts` | Omitting `employeeId` denies. Empty allowlist is core-read, not org-union. Prefix `stripe` does not allow `stripe_create_charge`. `skipAutonomy` is ignored. Stage 0 returns shadow and does not call the provider fake. Kill switch denies chat, plan, and sweep the same way. |
| `executor-confirm.test.ts` | `gmail.send_email` and `stripe.create_charge` return `pending_approval` with no token from a plan step, a sweep, and `/api/agent/tools`. |
| `executor-idempotency.test.ts` | Same `side_effect_key` calls the provider once. Timeout aborts the fetch (provider fake sees abort). 401 becomes `revoked`, not `executed`+`[]`. |
| `ask-ai-plan-lifecycle.test.ts` | Reconnect on `running` does not re-execute. Revise forces `pending`. Cancel stops the workflow. Hydration returns the newest 200. |
| `router-safety.test.ts` | "Fire off an email" does not take the emergency path. "balance sheet" does not route to Operations on the word "sheet". Custom employee with tools is routable. |
| `sweep-gate.test.ts` | MeetingPrep, MarketScout create, WorkloadBalancer, RepFollowUp go through the executor fake. Suspended org sends nothing. Deadlock ping does not repeat the same guest the next day. |

No finding in `02`–`04` that this file closes is marked 🟢 until the matching test and the six checks in §8 pass.
