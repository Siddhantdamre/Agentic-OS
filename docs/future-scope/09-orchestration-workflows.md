# 09 — Orchestration and workflows

The Brain OS thinks in **work items and workflows**, not in isolated
chat turns. This file specifies how classify → plan → confirm →
execute grows into an event-driven company OS, still on Temporal.

---

## 1. Keep the live Ask AI contract

Already proven (`BUILD_STATE.md`):

1. `POST /api/ask-ai` → `classifyRequest` (LiteLLM JSON, reasoning off).
2. **simple** → SSE/NDJSON atomic-agent stream.
3. **complex** → `generatePlan` → `agent_plans` row → PlanCard.
4. `PATCH approve` → `GET /api/ask-ai/execute` SSE.
5. Independent steps run in **parallel** via `stageSteps`.
6. `execution_done`.

Do not send classify/plan through atomic-agent’s tool grammar (hang).
Do not fabricate tool success.

OS additions wrap this contract; they do not replace it.

---

## 2. WorkItemWorkflow (inbound everything)

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

Chatwoot path must join this (today it does not call the agent).

Session key: `darex:{org}:{workItemId}` not a shared daily org chat
(Ask AI already rotates per user/day — keep that for the console).

---

## 3. Trigger types

| Trigger | Example | Handler |
|---------|---------|---------|
| Message inbound | WhatsApp | WorkItemWorkflow |
| Owner Ask AI | Dashboard | existing + memory prefix |
| Schedule | Daily 08:00 org TZ | `OwnerBriefingWorkflow` |
| Threshold | Inquiry SLA 2h | `StaleChaseWorkflow` |
| Connector event | Stripe paid, CRM stage | `SorEventWorkflow` |
| Insight action | Button on card | named workflow from pack |
| Human signal | Approve / reject / takeover | Temporal signal |
| Pack install | Onboarding | `InstallPackWorkflow` |

All triggers carry `orgId` from verified context (session, signed
webhook, connection mapping) — never from LLM output.

---

## 4. Activity design rules

Every side-effect is an activity:

- Idempotency key: `orgId + activityName + businessKey`.
- Retry: 3× with backoff; not for HTTP 400 from provider.
- Heartbeat on long polls.
- Compensation: if `gmail.send` succeeded and `crm.write` fails,
  log + needs_attention; do not silently resend email.
- Timeout: tool-level; never hold a pooled DB client.

Sandbox and embeddings are activities too (or separate workers
signaled from Temporal).

---

## 5. Plan library vs generated plans

Generated plans are for novel asks. Packs ship **named playbooks**:

- `re.inquiry_to_showing`
- `re.new_listing_checklist`
- `pm.rent_reminder`
- `ecom.wismo`
- `core.stale_deal_chase`

When classifier matches a playbook with high confidence, skip free-
form plan generation; show the playbook steps (still confirm if any
step is irreversible). Faster, safer, eval-able.

---

## 6. Parallelism

Keep step DAG:

- Independent: parallel (already).
- Dependent: `needs` field.
- Fan-out: “message these 20 leads” → child workflows with rate
  limits (WhatsApp 24h window, provider caps).
- Never unbounded fan-out from a single model list without cap.

---

## 7. Long-running nurture

Not an agent loop for 14 days. Temporal sleep/timers:

- T+1d, T+3d, T+7d WhatsApp if no reply.
- Cancel on inbound or human takeover.
- Respect do-not-contact and channel windows (no 2am blasts unless
  emergency policy).

---

## 8. Owner briefing

Cron per org:

1. Aggregate metrics (semantic layer).
2. Pull needs_attention queue.
3. LiteLLM narrative over aggregates only.
4. Deliver: dashboard + optional Slack/email/WhatsApp-to-owner.
5. Each card can enqueue a named workflow.

---

## 9. Failure UX

| Failure | User sees |
|---------|-----------|
| Tool not connected | setupUrl, no fake data |
| Model timeout | retry / escalate human |
| Temporal down | direct fallback **only** for Ask AI simple; inbound still persist; process later |
| Critic fail | “blocked by policy: fair housing” |
| Partial execute | plan status per step (already) |

---

## 10. Workflows we will implement first (ordered)

1. WorkItemWorkflow (unify inbound).
2. MemoryRetrieve + WriteBack activities.
3. OwnerBriefingWorkflow.
4. StaleChaseWorkflow (deals/inquiries/tickets).
5. ShowingScheduleWorkflow (RE).
6. RentReminderWorkflow (PM).
7. InstallPackWorkflow.
8. InsightActionWorkflow (Phase 7).

Names live in pack YAML. Worker registers them. Dashboard never
embeds workflow logic.

---

## 11. Why Temporal stays (research, 2026)

Durable-execution round-ups in 2026 still split the same way:

| Engine | Pitch | Darex |
|--------|-------|-------|
| **Temporal** | Mature, polyglot, signals, timers, MIT, self-host | **KEEP.** Already in webhooks and agent/run. |
| Restate | Single Rust binary; virtual object per entity | WATCH if Temporal ops hurt. `work_item` as a virtual object is a nice *idea*. |
| Inngest + AgentKit | TS events, AgentKit router, MCP | STUDY the router. Serverless gravity fights our self-host kernel. |
| Hatchet / DBOS | Workflows in Postgres | Philosophically close; not a migration. |
| n8n / Windmill | OSS iPaaS | Customer automation later, not WorkItemWorkflow. |

The Temporal 2026 slogan “your agent is a workflow” is our
WorkItemWorkflow. Isolate every LLM and tool call in an **activity**
(we already must: no model await in webhooks; no pooled client across
SSE). PydanticAI and the OpenAI Agents SDK both learned to sit *on*
Temporal rather than replace it. We do the same with atomic-agent.

HITL confirm is a **Temporal signal**, not a LangGraph interrupt. Same
user-visible PlanCard; different engine. Do not dual-run.

Catalog: `15` §5.

---

## 12. Alternatives in the world (instead of Temporal WorkItemWorkflow)

**What Darex does:** classify → plan-confirm-execute on Temporal;
inbound = persist + 200 + workflow; HITL = signal.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **LangGraph interrupts** | First-class HITL, Studio, checkpoint | Temporal already live; do not dual-run | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) |
| 2 | **Restate** | Lighter ops; virtual object = work_item | BSL; migration; Temporal MIT | [restatedev/restate](https://github.com/restatedev/restate) |
| 3 | **Inngest AgentKit** | TS, events, MCP, no cluster | Serverless gravity; we self-host | inngest.com AgentKit |
| 4 | **Hatchet / DBOS** | Workflows in Postgres we already run | Less mature HITL/signals | hatchet-dev/hatchet; dbos-inc/dbos-transact |
| 5 | **Windmill / Trigger.dev / Prefect** as job runners | Fast TS/Python jobs | Not confirm-class OS; embed-worker later. n8n is `06` | This file GitHub list |

**Five things to steal anyway**

1. Isolate LLM/tool in activities (Temporal “agent is a workflow” 2026).
2. Restate virtual-object id → `darex:{org}:{workItemId}` session key.
3. Inngest router → our employee router, not a new engine.
4. Playbook matcher (skip free-form plan) — CrewAI Flows idea.
5. Never unbounded fan-out from a model-produced list.

### Open-source GitHub — this file only (durable jobs)

Temporal KEEP → `15` §1. n8n → `06`. pg-boss / Graphile → `02`.

| Repo | Similar to | We take |
|------|------------|---------|
| [temporal-community/temporal-ai-agent](https://github.com/temporal-community/temporal-ai-agent) | Agent + MCP inside Temporal | Activity wrap + goals dir |
| [temporal-sa/durable-agentic-harness](https://github.com/temporal-sa/durable-agentic-harness) | Temporal under an agent SDK | Same pattern we use |
| [restatedev/restate](https://github.com/restatedev/restate) | Virtual objects | WATCH; BSL |
| [inngest/inngest](https://github.com/inngest/inngest) | TS durable steps + AgentKit | Router ideas |
| [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet) | PG-native jobs | STUDY if Temporal ops explode |
| [windmill-labs/windmill](https://github.com/windmill-labs/windmill) | Script jobs | embed-worker later |
| [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev) | TS background | Same |
| [PrefectHQ/prefect](https://github.com/PrefectHQ/prefect) | Python flows | Sync/embed DAGs |
| [dagster-io/dagster](https://github.com/dagster-io/dagster) | Asset jobs | Ingest lineage |
| [uber/cadence](https://github.com/uber/cadence) | Temporal ancestor | HITL signal ideas |
| [riverqueue/river](https://github.com/riverqueue/river) | PG jobs (Go) | Compare with `02` pg-boss |
| [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq) | Redis jobs | Not HITL; skip for confirm |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | Interrupt/HITL graphs | Pattern only; do not dual-run |
| [Netflix/conductor](https://github.com/Netflix/conductor) | Microservice workflows | WATCH |
| [argoproj/argo-workflows](https://github.com/argoproj/argo-workflows) | K8s DAGs | Only if we k8s the workers |
| [dbos-inc/dbos-transact-py](https://github.com/dbos-inc/dbos-transact-py) | Workflows in Postgres | STUDY with Hatchet |
