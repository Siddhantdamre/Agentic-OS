# 15 — Workflow Catalog

Every durable workflow in `services/workflows/src/workflows/`. Temporal is not
a background-job queue here — it is the execution substrate for anything that
touches the outside world, waits on a human, or must survive a restart.

## 0. Why Temporal at all

Three properties the product depends on:

1. **A human approval can take hours.** A plan that waits for confirmation
   cannot live in a request handler or a Redis job with a visibility timeout.
   `condition()` on a signal is exactly the right primitive.
2. **Sends must not double-fire.** Retries are inevitable; combined with
   `idempotency_keys`, Temporal's at-least-once activity execution becomes
   effectively-once behaviour where it matters.
3. **The state is inspectable.** "What is the agent doing right now" is a query
   against a running workflow, not a log grep.

### The workflow-isolate constraint

Workflow code runs in a deterministic V8 isolate: no Node APIs, no `pg`, no
`fetch`. This forces a discipline that turns out to be good architecture —
**pure decision logic** (`route-employee.ts`, `quiet-hours.ts`,
`crew-contract.ts`, `inbound-hitl.ts`, `plan-steps.ts`) is separated from
**effectful activities**. Each of those pure modules carries a header comment
saying it is isolate-safe, and each has unit tests that need no infrastructure.

---

## 1. `WorkItemWorkflow` — the inbound spine (583 lines, the largest)

The workflow that runs when anything arrives from the outside world.

**Input:** `orgId`, `channel` (`whatsapp | chatwoot | inbox | ask_ai | unknown`),
`conversationId`, optional `inboundEventId`, the resolved employee identity and
`toolAllowlist`, `connectedChannels`, `userMessage`, `idempotencyKey`.

**Status machine:**
`open → in_progress → waiting_approval → needs_attention → done | cancelled`

**Event log** (`work_events.kind`) — the complete observable lifecycle:

```
inbound_received → memory_retrieved → employee_routed → agent_started
   → agent_replied | agent_failed | needs_attention
   → confirm_requested → confirm_approved | confirm_rejected
   → critic_blocked
   → memory_writeback → embed_enqueued
```

**Sequence:**

1. `upsertWorkItemActivity` — persist the work item (idempotent on the key).
2. `retrieveMemoryActivity` — pull cited facts before any reasoning happens.
   Memory comes *first*, so the agent never reasons context-free.
3. `routeEmployeeActivity` — decide the owning employee. If
   `isHumanDestination()`, stop and escalate; no agent runs.
4. `resolveInboundHitlGate()` — decide whether this inbound action needs human
   approval before tools run.
5. Agent execution as a child workflow (`AutonomousAgentWorkflow`).
6. `criticCheck` — a review pass that can emit `critic_blocked` and stop the
   reply. This is a second opinion before anything leaves the building.
7. On approval-required paths: `condition()` waits on `approveWorkItem` /
   `rejectWorkItem` signals. **The owner can approve from WhatsApp** — the
   `/api/webhooks/owner-whatsapp` route signals this workflow.
8. `MemoryWriteBackWorkflow` as a child, then `enqueueEmbedActivity`.

**Design notes worth keeping:**
- Child workflows use `ParentClosePolicy` explicitly, so a completed parent does
  not orphan or kill work that should outlive it.
- Work-item types are declared **locally**, not in `@darex/shared-types`, to
  keep the workflow's contract from becoming a cross-team coupling point.
- The `critic_blocked` event class means a blocked reply is visible as a
  first-class outcome, not a silent no-op.

---

## 2. `PlanExecuteWorkflow` — durable confirm-and-execute (225 lines)

**Status:** `waiting_approval → running → completed | completed_with_errors | cancelled`

`completed_with_errors` is a deliberate third terminal state. A four-step plan
where step three fails is neither success nor failure; pretending otherwise is
how products lie to users.

**Signals and queries:**
- `approvePlan` / `rejectPlan` signals.
- `planProgressQuery` returns `{status, events[], results[], done}` — the
  dashboard polls or streams from the workflow's own state rather than from a
  side table that can drift.

**Activities:** `loadApprovedPlanActivity`, `updateAgentPlanActivity`,
`executePlanStepActivity`, with `startToCloseTimeout: 3m`,
`scheduleToCloseTimeout: 8m`, and bounded retries (3 attempts, 2s initial
interval).

**Event stream:** monotonic `seq` on every event so a reconnecting SSE client
can resume without gaps or duplicates.

### The risk-based execution split (`plan-steps.ts`)

This is one of the sharpest pieces of design in the codebase:

```ts
type ToolRisk = 'read' | 'draft' | 'send' | 'pay' | 'sign' | 'publish' | 'delete';

isDurablePlanRisk(risk)   // read, draft → false;  send, pay, sign, publish, delete → true
planRequiresDurableExecute(steps)  // any durable-risk step → whole plan goes to Temporal
```

**Rule:** `send | pay | sign | publish | delete` must run as a Temporal
workflow so a dashboard restart cannot drop a live send. `read | draft` stay on
the HTTP SSE path, which is faster and cheaper.

The resolution is defence-in-depth: first `resolveToolRisk(tool, action)` from
the registry, then a string-heuristic fallback (`send_email`, `send_whatsapp`,
`pay`, `charge`, `sign`, `publish`, `delete`, and send-verbs on messaging
tools). A tool that forgot to declare its risk class is still treated as
dangerous. Failing closed is the correct default here.

Disabled steps (`enabled === false`) are skipped in the risk scan, so
unchecking a send step in the UI genuinely downgrades the execution path.

---

## 3. `AutonomousAgentWorkflow` (98 lines)

The agent loop as a durable workflow: reason, select a tool, execute, observe,
repeat, within a bounded step count. Used as the child of `WorkItemWorkflow`
and for scheduled autonomous runs.

## 4. `CrewWorkflow` (166 lines)

Multi-employee collaboration under an explicit contract (`crew-contract.ts`):

- **`MAX_CREW_SPAWN = 3`.** `capCrewSpecialists()` truncates. A hard cap, not a
  soft suggestion — unbounded agent fan-out is how token budgets die.
- Deterministic child ids via `crewChildWorkflowId(parentId, index, employeeId,
  employeeName)`, sanitised and length-capped, so a replay addresses the same
  children.
- `buildCrewSynthesisPrompt()` composes specialist reports into one answer with
  three explicit instructions: do not redo their tool work; **if a specialist
  hit `notConnected`, say so honestly**; do not mention Temporal, crews, or
  internal routing.

The honesty rule appears inside the synthesis prompt itself, not only in the
tool layer — because the synthesis step is exactly where a model is tempted to
smooth over a failed specialist.

## 5. `NurtureWorkflow` (150 lines)

Long-running lead nurture. Governed by `quiet-hours.ts`:

- `MAX_NURTURE_FANOUT = 3` — a lead receives at most three nurture touches.
- Quiet hours default 21:00 → 08:00 in the org's timezone, with wrap-around
  handling and `hoursUntilQuietEnd()` used to schedule the next touch rather
  than skip it.
- Cancel reasons are typed:
  `inbound | takeover | do_not_contact | rejected | emergency_stop`.

A nurture sequence that cannot be stopped is a spam cannon. Five named stop
conditions, including a human takeover and a global emergency stop, is the
minimum bar for automated outbound.

## 6. `StaleChaseWorkflow` (106 lines)

Chases threads that have gone quiet. `MAX_STALE_CHASE = 10` caps how many
threads a single run may touch, which bounds both cost and the blast radius of
a bad chase heuristic.

## 7. `OwnerBriefingWorkflow` (111 lines)

The daily brief. Triggered `daily` by `core-b2b`. The seed of the proactivity
layer described in `04` §5 — what it lacks today is baselines and ranking.

## 8. `InsightActionWorkflow` (220 lines)

Turns an insight card into executed work. The product rule: an insight names a
**specific workflow** the user can run, not a vague recommendation. "Review
Action" enqueues real durable execution.

## 9. `ShowingScheduleWorkflow` (62 lines)

Triggers: `inquiry.book_showing`, `calendar.conflict`. Books property viewings
against the real calendar, handling conflicts rather than double-booking.

## 10. `RentReminderWorkflow` (63 lines)

Trigger: `pm.charge.due` from `pm_charges`. The property-management pack's
recurring-revenue workflow.

## 11. `SyncWorkflow` (151 lines)

Incremental connector sync using `sync_cursors` keyed `(org_id,
connector_key)`. Resumes from the cursor; never refetches history.

## 12. `IngestWorkflow` (81 lines)

Drives `ingestion_jobs` against `knowledge_sources`, honouring `content_hash`
to skip unchanged content and writing `cursor` for resumable paging.

## 13. `EmbedWorkflow` (61 lines)

Fills `embedding` columns. Fails fast if `EMBEDDING_MODEL` / `EMBEDDING_DIM`
are unset rather than silently writing nulls that make retrieval quietly worse.

## 14. `MemoryWriteBackWorkflow` (53 lines)

Writes durable conclusions after a task. Runs as a child of
`WorkItemWorkflow`, so learning is part of the inbound path rather than an
optional extra someone forgets to call.

## 15. `InstallPackWorkflow` (40 lines)

Installs a pack into an org, moving `org_packs.status` through
`installing → installed | failed`. Short, because the pack manifest does the
work — which is the point of the pack architecture.

---

## Cross-cutting patterns

| Pattern | Where | Why |
|---|---|---|
| Pure module + activity split | `route-employee`, `quiet-hours`, `crew-contract`, `plan-steps`, `inbound-hitl` | Isolate-safe, unit-testable without infrastructure |
| Hard fan-out caps | `MAX_CREW_SPAWN=3`, `MAX_NURTURE_FANOUT=3`, `MAX_STALE_CHASE=10` | Bounded cost and blast radius |
| Signals for human decisions | `approvePlan`, `approveWorkItem` | Approval can take hours without holding a connection |
| Queries for progress | `planProgressQuery` | UI reads workflow state directly; no drift |
| Monotonic `seq` on events | `PlanExecuteEvent` | Resumable streaming |
| Typed cancel reasons | `NurtureCancelReason` | Every stop is attributable |
| Explicit `completed_with_errors` | `PlanExecuteStatus` | Partial failure is not reported as success |
| Bounded retries with timeouts | every `proxyActivities` block | No infinite retry storms against a rate-limited provider |

## Gaps in the workflow layer

- **No compensation.** `completed_with_errors` is honest but there is no
  defined undo for steps that already succeeded.
- **Cost is not a first-class budget.** Fan-out is capped by count, not by
  spend; a single expensive step can exceed any reasonable budget.
- **No workflow versioning strategy documented.** Long-running workflows
  (nurture sequences spanning weeks) will eventually need Temporal patching.
- **Watchers do not exist yet** — `OwnerBriefingWorkflow` runs on a schedule but
  evaluates no standing conditions against a baseline.
