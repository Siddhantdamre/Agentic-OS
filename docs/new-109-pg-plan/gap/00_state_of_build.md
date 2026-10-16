# 00 — State of Build: What We Did vs. What We Must Do

> **Purpose:** Single deduplicated source of truth. Consolidates the per-domain
> gap files (`01`–`05`), the roadmap (`06`), and the percentage scorecard (`07`)
> into one in-depth read. Verified against the codebase on 2026-09-08
> (`infra/db/migrations` at `022_entity_graph.sql`, `services/workflows/src/workflows`,
> `apps/dashboard/app`).
>
> The per-domain files stay as the deep reference. This file is the map: read it
> first, drill into `01`–`05` for detail on any single line.

---

## 1. One-Paragraph Verdict

DareXAI has a **production-grade reactive AI-assistant platform** and **none of the
autonomous-employee state layer**. Auth, tenancy, Temporal, MCP bridge, LiteLLM,
sandbox, sub-3s webhook ingress, ~62 connector tools, and the entity-graph schema
are live and verified. What is missing is the thing the 106-page blueprint is
actually about: **explicit object state, durable timers that wake with no prompt,
expected-vs-actual tracking, and decision auditability.** Overall parity ≈ **28%
live, 31% partial, 41% not started.**

```text
 ┌──────────────────────────────┬────────┬─────────┬────────┬───────────┐
 │ Domain                       │ 🟢 Live│ 🟡 Part │ 🔴 Gap │ Readiness │
 ├──────────────────────────────┼────────┼─────────┼────────┼───────────┤
 │ 1. Growth Employee           │   3    │    4    │   7    │   21%     │
 │ 2. Customer Employee         │   4    │    5    │   6    │   27%     │
 │ 3. Operations Employee       │   2    │    4    │   9    │   13%     │
 │ 4. Shared Integrations       │   6    │    6    │   4    │   38%     │
 │ 5. Core Platform & Runtime   │   7    │    5    │   6    │   39%     │
 ├──────────────────────────────┼────────┼─────────┼────────┼───────────┤
 │ TOTAL (78 specs)             │  22    │   24    │  32    │   28%     │
 └──────────────────────────────┴────────┴─────────┴────────┴───────────┘
```

---

## 2. What We Did (🟢 verified live)

### Platform / runtime — the foundation is real
| Capability | Where | Evidence |
| :-- | :-- | :-- |
| Multi-tenant Postgres RLS | `apps/dashboard/lib/db.ts` `getScopedClient()` | migrations 001–022 all `ENABLE`+`FORCE ROW LEVEL SECURITY`, `WITH CHECK`, unprivileged `darex_app` |
| Entity Graph & Fact Model schema | `infra/db/migrations/022_entity_graph.sql` | `entities`, `entity_identifiers`, `predicate_defs`, `facts`, non-destructive merge |
| Durable Temporal cluster | `services/workflows` | worker in Docker, TS SDK, 15 workflows registered |
| Sub-3s decoupled webhook ingress | `app/api/webhooks/whatsapp/route.ts`, `chatwoot/route.ts` | payload → `webhook_inbox` → HTTP 200 in ~250ms → async `AutonomousAgentWorkflow` |
| Atomic-agent + MCP bridge | `services/workflows/src/mcp-bridge.ts` | `:8787` agent ↔ `:8790` SSE MCP, ~62 tools as `mcp.darex.*` |
| LiteLLM plain-JSON routing | `apps/dashboard/lib/litellm-client.ts` | `reasoning:{enabled:false}` for planner/classifier, avoids tool-parse hangs |
| Dockerized code sandbox | `infra/docker/sandbox` | unprivileged, hard timeout, no network, no DB |
| Plan-confirm-execute Ask AI | `app/api/ask-ai/{route,plan,execute,revise}.ts` | classify → LiteLLM plan → `agent_plans` → `PATCH approved:true` → SSE stream |

### Employee-facing capability that works today
- **Growth:** NL objective intake + plan decomposition; `web_search` (Jina), `web_extract`, `apollo` discovery tools; `draft_email`/`send_email` via Gmail connector.
- **Customer:** omnichannel ingress (WhatsApp + Chatwoot); vector RAG over Drive/Notion/Docs (`lib/memory-rag.ts`, pgvector); identity/intent resolution on inbound; tool runtime via atomic-agent.
- **Operations:** multi-system scheduling (Calendar + CRM tools run sequentially in a plan); outage buffering + Temporal retry (`webhook_inbox` + exponential backoff).
- **Connect:** Gmail, Google Calendar, WhatsApp Business, HubSpot, Zoho (C6 wave), Google Drive, Google Sheets, website widget (`public/embed/widget.js`), Google Ads — all live via Nango OAuth with auto token refresh.

---

## 3. What Is Half-Done (🟡 scaffolding exists, not wired end-to-end)

| Area | What exists | What's missing to go green |
| :-- | :-- | :-- |
| Context ingestion (Growth) | RAG over unstructured docs | structured CRM query for ICP traits (LTV, headcount, velocity); deterministic rule engine for hard constraints |
| Website visitor intent | widget logs IP, UA, session, chat | reverse-IP → company (Clearbit/Snitcher); per-page intent counters |
| Dormant lead reviver | `StaleChaseWorkflow.ts` (real-estate only) | generalize to B2B CRM closed-lost scan cross-referenced with signals |
| Autonomy gate | org tool allowlist + all-or-nothing plan approval | per-action tiering: reads auto-run, writes/sends pause |
| Customer state | sentiment scored per turn | persist as state machine on the customer/conversation record |
| Confidence gate | prompt says "say you don't know" | deterministic: sim < 0.72 + no tool hit → force escalation branch |
| Decision escalation | `work_items` table + list/patch API | reliable structured `payload`; 1-click `[Approve]/[Reject]/[Modify]` card that fires the tool |
| Human takeover resume | `WorkItemWorkflow.ts` signals | post-approval customer callback on WhatsApp — partially wired, untested |
| Entity Graph ingestion | `022` schema live | `FactExtractWorkflow` to populate `entities`/`facts` from conversations |
| Morning intake (Ops) | per-message webhooks | 9:00 AM cron batch sweep as a cohort |
| SLA chaining (Ops) | Temporal timers available | `EnquirySLAChainingWorkflow` (reminder → escalate → auto-close) |
| Task health (Ops) | `work_items` status | blocker/dependency model |
| Owner briefing | `OwnerBriefingWorkflow.ts` (raw stats) | 3-tier triage filter (Critical/High/Medium), drop the noise |
| Approval tokens | plan ID | cryptographically signed per-step tokens + `workflow.condition` pause |
| Autonomous crons | briefing only | no `ScheduleClient`/cron usage anywhere — ops/growth crons unregistered |
| Prompt-injection defense | basic prompt framing | untrusted-content isolation |
| Connector rate limiting | Nango handles refresh | token-bucket + 429 backoff in `tool-executor.ts` for batch sweeps |
| Slack/Teams | message send works | interactive Block Kit `[Approve]/[Reject]` |
| Outlook / MS365 | Graph API client scaffolded | live Azure AD multi-tenant consent test |

---

## 4. What We Must Do (🔴 not started) — grouped by theme

### 4a. The state layer — Migration `023_employee_state_machines.sql`
None of these tables exist in code (grep-verified). This is the keystone; most red
items below depend on it.

| Table | Purpose |
| :-- | :-- |
| `operational_enquiries` | enquiry lifecycle: `new → assigned → contacted → overdue → escalated → closed`, `sla_expires_at` |
| `agent_open_loops` | customer promises: `waiting/scheduled/monitoring/escalated/closed`, `target_check_at` |
| `operational_expectations` | expected state + `expected_by_timestamp` vs `actual_state`, `is_discrepancy` |
| `agent_decision_ledger` | every decision incl. **not acting**: `executed/deferred/rejected/escalated`, `reason_summary`, `confidence_score` |
| `employee_autonomy_rules` | declarative 4-tier permission matrix per `action_type` |
| `employee_roi_metrics` | `pipeline_influenced / ticket_resolved_autonomously / hours_saved` |

Full RLS (`ENABLE`+`FORCE`+`WITH CHECK`), `GRANT ... TO darex_app`, Zod enums +
transition validators in `packages/shared-types`.

### 4b. Durable autonomous workflows (Temporal) — none exist today
| Workflow | Trigger | Behaviour |
| :-- | :-- | :-- |
| `OpenLoopMonitorWorkflow` | row in `agent_open_loops` | sleep to `target_check_at` → verify system state → resume customer or escalate |
| `CustomerRecoveryWorkflow` | `work_item → resolved` | sleep 24h → WhatsApp check-in → update sentiment |
| `DailyMorningCheckCron` | 9:00 AM org-local | sweep 24h of all channels → fuzzy dedup vs CRM → persist 3-tier brief |
| `StuckWorkDetectorWorkflow` | hourly | scan CRM deals / `work_items` / calendar vs `operational_expectations` → flag dormancy |
| `EnquirySLAChainingWorkflow` | new enquiry | 2h → remind owner → 2h → escalate manager → auto-close on reply |
| `SystemReconciliationWorkflow` | daily | count/ID diff `webhook_inbox` vs CRM contacts → flag missing/dupe/stale |
| `MeetingPrepWorkflow` | 6:00 PM | tomorrow's calendar → no briefing doc → LLM compiles history → Drive doc |
| `GrowthContinuousWatcherWorkflow` | every ~4h | scan signals → evaluate accounts → queue high-confidence opps |
| `ConversationalInsightWorkflow` | nightly | embed + cluster customer inquiries → spike detection → FAQ proposals |

### 4c. Engines / services (non-Temporal)
- `growth/lookalike-profiler.ts` — statistical centroid of closed-won CRM accounts → ICP vector → Apollo/search query.
- `growth/signal-watcher.ts` — hiring/funding/leadership feeds → `lead_intent_signals` table.
- `growth/preference-synthesizer.ts` — consume `agent_feedback` (already logged, nothing reads it) → negative rules in `org_preferences`.
- `customer/obligation-extractor.ts` — post-turn classifier for time-bound promises → `agent_open_loops`.
- `operations/expected-vs-actual-engine.ts` — write expectations on object creation, verify on schedule.
- `operations/dedup-engine.ts` — `pg_trgm` similarity; 0.60–0.85 → `ambiguous_duplicate_reviews` queue.
- 4-tier autonomy check in `tool-executor.ts` — evaluate action vs `employee_autonomy_rules` before dispatch.
- Role-scoped tool filtering — `resolveOrgToolAllowlist(orgId, employeeRole)`: today it unions **every** connected tool for **every** employee (Customer Employee can delete the sales pipeline). Filter against a role-capability matrix.
- `GET /api/agent/explain` — read `agent_decision_ledger` for "why didn't you…".

### 4d. UI
- `components/inbox/DecisionCard.tsx` — customer decision escalation, 1-click actions.
- `components/growth/OpportunityCard.tsx` — Why this company / person / now, `[Review]/[Edit]/[Approve & Send]`.
- Role dashboards: `app/(dashboard)/employees/{growth,customer,operations}/page.tsx` (only a single `employees/page.tsx` exists).
- ROI scorecard on `/dashboard/stats` from `employee_roi_metrics`.

### 4e. Connect
- LinkedIn signal ingestion (no integration at all).
- Interactive Slack Block Kit approval buttons.
- Token-bucket rate limiter (also listed 🟡 — the backoff half is missing entirely).

---

## 5. Build Order (from `06` roadmap + `07` priority)

```text
 Phase 1  Wk 1–2   Migration 023 + Zod models + 4-tier autonomy guard in tool-executor
 Phase 2  Wk 3–4   Customer: obligation-extractor → OpenLoopMonitorWorkflow → DecisionCard.tsx → CustomerRecoveryWorkflow
 Phase 3  Wk 5–6   Ops: DailyMorningCheckCron + dedup-engine → expected-vs-actual + StuckWorkDetector → /api/agent/explain
 Phase 4  Wk 7–8   Growth: lookalike-profiler → signal-watcher + lead_intent_signals → OpportunityCard.tsx → preference-synthesizer
 Phase 5  Wk 9–10  Connect role-scoping + Migration 024 ROI ledger + /dashboard/stats + end-to-end YC demo run
```

Single highest-leverage move: **Phase 1**. Without `023` and the autonomy guard,
every autonomous workflow has nowhere to persist state and no rule to check before
acting.

---

## 6. Cross-Reference

| Detail on… | See |
| :-- | :-- |
| Growth capability-by-capability (14 rows) | `01_growth_employee_gap.md` |
| Customer 12-step lifecycle audit | `02_customer_employee_gap.md` |
| Operations 15-row workflow audit | `03_operations_employee_gap.md` |
| Connector tier-1/tier-2 table + role-scope problem | `04_shared_integrations_gap.md` |
| Migration 023 full DDL + platform pillars | `05_core_platform_and_runtime_gap.md` |
| Phase-by-phase engineering roadmap | `06_master_implementation_roadmap.md` |
| Percentage math per domain | `07_completion_percentages_and_next_build.md` |
| Blueprint's own 7 architectural gaps | `../plan/06_gap_analysis_and_what_is_missing.md` |
