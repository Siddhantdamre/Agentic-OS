# Workstream 02 — Orchestration and workflows

The Brain OS thinks in **work items and workflows**, not isolated
chat turns. Ask AI classify → plan → confirm → execute stays. The
OS wraps it; it does not replace it.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/03-e2e-ask-ai.md`,
`07-e2e-agent-runtime.md`, `06-e2e-webhooks-inbox.md`,
`16-updates-2026-08-13.md`. Future-scope `09` §1.

- Ask AI complex: LiteLLM `generatePlan` → `agent_plans` → PlanCard
  PATCH approve → `GET /api/ask-ai/execute` SSE. `wireDependencies`
  + `stageSteps` run independent steps in **parallel**. Execute 409s
  completed plans and finishes after SSE disconnect.
- Classify/plan/revise go through LiteLLM with reasoning off. Do
  not send them through atomic-agent (hang class in BUILD_STATE).
- Only Temporal workflow: `AutonomousAgentWorkflow` on queue
  `darex-agent-tasks`. Max 3 turns, idempotency keys, worker
  reconnect backoff 2s–30s.
- WhatsApp and Chatwoot persist, return 200, then
  `fireInboundAgent` (Temporal then direct). Chatwoot **does**
  start the agent (future-scope `09` §2 “today it does not” is
  stale).
- Ask AI simple and Ask AI execute never use Temporal.
- No scheduled crons, no WorkItem table, no Temporal signal for
  PlanCard approve, no nurture timers, no named playbook matcher.

---

## 2. Target

Sources: `docs/future-scope/09-orchestration-workflows.md`,
`02` §6, `13` Phases 6/8/13.

```
webhook 200 after persist
  → Temporal WorkItemWorkflow
       → retrieveMemory
       → route employee
       → if simple FAQ: employee turn; if send-risk: critic; maybe HITL
       → if complex: generate plan → wait for approval signal
       → execute activities (idempotent)
       → memory write-back
       → event-bus notify UI
```

Triggers: message inbound, owner Ask AI, schedule (daily briefing),
threshold (SLA), connector event, Insight action, human signal,
pack install. All carry `orgId` from verified context — never from
LLM output.

Named playbooks (`re.inquiry_to_showing`, `core.stale_deal_chase`)
skip free-form plan generation when confidence is high; still
confirm irreversible steps.

HITL confirm is a **Temporal signal**, same PlanCard UX. Do not
dual-run LangGraph interrupts.

First workflows (future-scope `09` §10): WorkItemWorkflow,
MemoryRetrieve + WriteBack, OwnerBriefingWorkflow,
StaleChaseWorkflow, ShowingScheduleWorkflow, RentReminderWorkflow,
InstallPackWorkflow, InsightActionWorkflow.

---

## 3. Gaps

**Audit 2026-08-14:** O1–O6 **done**. O7 **done** (PlanExecute + WorkItem inbound `condition()` wait **before send/pay/sign tools**; conversation `needs_attention` while waiting). Compensation still `needs_attention`.

| Item | Status |
|------|--------|
| Ask AI plan-confirm-execute + parallel steps | **done** |
| AutonomousAgentWorkflow 3-turn + idempotency | **done** |
| Chatwoot → agent | **done** (not WorkItem yet) |
| `work_items` / `work_events` | **missing** |
| WorkItemWorkflow | **missing** |
| Temporal signal for approve | **done** (PlanExecute + WorkItem inbound `condition()`) |
| Scheduled briefing / stale chase | **missing** |
| Playbook matcher | **missing** |
| Nurture timers + cancel on reply | **missing** |
| Compensation (send then CRM fail) | **missing** — log + needs_attention |
| Ask AI execute via Temporal for send/pay/sign | **missing** |

---

## 4. Work items

### O1 — `work_items` + `work_events` schema

- **What:** Additive migration. Conversations remain; each inbound
  conversation gets a work_item (`type=conversation` initially).
  RLS + WITH CHECK. Packs later register `re.inquiry`, etc.
- **Where:** `infra/db/migrations/012_work_items.sql`.
- **Depends on:** operator has applied 009–011.
- **DoD:** Two-org insert isolation. Existing inbox still lists
  conversations. No body `org_id`.

### O2 — WorkItemWorkflow

- **What:** New Temporal workflow: retrieveMemory → route
  (default first active employee until workstream 08) → employee
  turn → write-back stub → event. WhatsApp/Chatwoot
  `fireInboundAgent` starts this instead of (or wrapping)
  `AutonomousAgentWorkflow`. Persist + 200 still first.
- **Where:** `services/workflows/src/workflows/WorkItemWorkflow.ts`;
  `apps/dashboard/lib/inbound-agent.ts`.
- **Depends on:** O1; memory retrieve can no-op until M3.
- **DoD:** Chatwoot HMAC probe still 6/6. WhatsApp inbound still
  persists then replies. Session key `darex:{org}:{workItemId}`.

### O3 — Activity rules on every side-effect

- **What:** Enforce: idempotency `orgId + activityName + businessKey`;
  retry 3× except HTTP 400; no pooled client across the activity;
  compensation = log + `needs_attention`, never silent resend.
- **Where:** `services/workflows/src/activities/`.
- **Depends on:** O2.
- **DoD:** Duplicate webhook event id does not double-send. Partial
  plan status remains per-step.

### O4 — Plan execute: Temporal when risk ≥ send

- **What:** If any approved step is `send`/`pay`/`sign`/`publish`/
  `delete`, run execute as a Temporal workflow. Read/draft-only
  plans may stay direct SSE for latency.
- **Where:** `apps/dashboard/app/api/ask-ai/execute/route.ts`;
  new `PlanExecuteWorkflow`.
- **Depends on:** R5 risk metadata.
- **DoD:** Gmail draft-only plan still SSE. A `send_email` plan
  survives dashboard restart mid-run.

### O5 — OwnerBriefingWorkflow + StaleChaseWorkflow

- **What:** Per-org Temporal cron (org TZ). Briefing aggregates
  metrics + needs_attention; LiteLLM narrative over
  **pre-aggregated** numbers only. Stale chase: no outbound in SLA.
- **Where:** `services/workflows/src/workflows/`.
- **Depends on:** O2.
- **DoD:** One org receives a briefing card with real counts. LLM
  does not scan `messages` raw. Disconnected CRM → honest gap.

### O6 — Playbook matcher + nurture timers

- **What:** Classifier may return a named playbook id. High
  confidence → show those steps (still confirm irreversible).
  Nurture: Temporal sleep T+1/3/7d; cancel on inbound or takeover;
  respect do-not-contact and quiet hours.
- **Where:** `apps/dashboard/lib/classify.ts`; new workflows.
- **Depends on:** O2, O5, pack files (workstream 13).
- **DoD:** “hi” does not spawn 8 agents. Fan-out is capped. No 2am
  blasts unless emergency policy.

### O7 — HITL Temporal signal

- **What:** PlanCard approve/reject also signals the waiting
  workflow when one exists. Same user-visible card.
- **Where:** `apps/dashboard/app/api/ask-ai/plan/route.ts`.
- **Depends on:** O4.
- **DoD:** Approve from UI unblocks a waiting WorkItemWorkflow.
  Do not add LangGraph.

---

## 5. End-to-end connections

- Memory retrieve/write-back (03) are activities inside O2.
- Channels (06) are the triggers. Event bus (11) notifies UI.
- Employees router/critic (08) sit between retrieve and act.
- Insight “Review Action” (10) enqueues a **named** workflow.
- Packs (13) register workflow names only.

---

## 6. Non-goals

- Replacing Temporal with Restate/Inngest/Hatchet (WATCH only).
- n8n/Windmill as the kernel executor.
- Unbounded fan-out from a model-produced list.
- Awaiting the model inside the webhook.

---

## 7. Verification

- Keep: Ask AI complex ~13s execute; Phase 3 Chatwoot 6/6; WhatsApp
  inbound+LLM 5/5; Temporal UI shows workflows.
- New: O1 RLS; O2 no double agent; O4 restart-safe send; O5
  briefing numbers match SQL; O6 cancel-on-reply.
- Failure UX (future-scope `09` §9): notConnected + setupUrl;
  timeout → retry/escalate; Temporal down → Ask AI simple may
  direct-fallback, inbound still persists; critic fail names the
  policy; partial execute shows per-step status.

Related: [01-runtime-and-agent-loop.md](./01-runtime-and-agent-loop.md),
[03-memory-rag-brain.md](./03-memory-rag-brain.md),
[06-channels-and-surfaces.md](./06-channels-and-surfaces.md).
