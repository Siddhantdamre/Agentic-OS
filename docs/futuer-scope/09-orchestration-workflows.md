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
