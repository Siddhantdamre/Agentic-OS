# 06 — Master Implementation Roadmap: Closing the Blueprint Gaps

> **Objective:** Practical, sequenced engineering roadmap to transition all **32 🔴 RED gaps** and **24 🟡 YELLOW gaps** into **🟢 GREEN production features** in the DareXAI repository.

---

## 1. Roadmap Architecture Overview

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                       5-PHASE REMEDIATION ROADMAP                           │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ Phase 1: Core State Machine Schemas & Autonomy Engine        (Weeks 1–2)    │
 │ Phase 2: Customer Employee — Open Loops & Decision Cards     (Weeks 3–4)    │
 │ Phase 3: Operations Employee — Expected vs Actual & Stuck Work (Weeks 5–6)  │
 │ Phase 4: Growth Employee — Lookalike Profiler & Signals      (Weeks 7–8)    │
 │ Phase 5: DareXAI Connect Scoping & Business Outcome Ledger  (Weeks 9–10)   │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Core State Machine Schemas & Autonomy Engine (Weeks 1–2)

### Focus: Database Foundations & Policy Gates
*Goal: Provide persistent, multi-tenant state storage for everything the blueprint requires.*

1. **Database Migration `023_employee_state_machines.sql`:**
   - Create `operational_enquiries` (`id`, `org_id`, `channel`, `contact_id`, `intent`, `state`, `owner_id`, `sla_expires_at`, `created_at`).
   - Create `agent_open_loops` (`id`, `org_id`, `customer_id`, `promise_summary`, `status`, `target_check_at`, `assigned_employee`).
   - Create `operational_expectations` (`id`, `org_id`, `object_type`, `object_id`, `expected_state`, `expected_by`, `actual_state`, `status`).
   - Create `agent_decision_ledger` (`id`, `org_id`, `employee_id`, `action_considered`, `decision`, `reason_summary`, `confidence_score`, `created_at`).
   - Create `employee_autonomy_rules` (`id`, `org_id`, `action_type`, `autonomy_tier`, `created_at`).
   - Apply `ENABLE ROW LEVEL SECURITY` and `GRANT ... TO darex_app` on all new tables.

2. **TypeScript Domain Models & Zod Schemas:**
   - Add state machine enums and transition validators to `packages/shared-types`.
   - Update `getScopedClient()` helpers in `apps/dashboard/lib/db.ts`.

3. **Granular Autonomy Permission Guard:**
   - Update `services/workflows/src/tool-executor.ts` to evaluate action against `employee_autonomy_rules`.
   - Level 1 (Observe) / Level 4 (Autonomous) execute directly; Level 2 / 3 generate approval requests.

---

## Phase 2: Customer Employee — Open Loops & Decision Cards (Weeks 3–4)

### Focus: Autonomous Resolution & Decision Escalation
*Goal: Stop escalating raw chats; escalate actionable decisions and track promises until closed.*

1. **Obligation & Promise Extractor:**
   - In WhatsApp/Email post-turn processor, run lightweight classifier extracting promised future actions (e.g. *“Check with warehouse at 4 PM”*).
   - Automatically insert row into `agent_open_loops` with `target_check_at`.

2. **Temporal `OpenLoopMonitorWorkflow`:**
   - Workflow receives `loop_id`, sleeps until `target_check_at`, verifies system state (order/warehouse status), and resumes conversation.
   - If issue unresolved, escalates to human or updates customer proactively.

3. **Decision Escalation Card UI in Dashboard:**
   - Build `DecisionCard.tsx` component in `apps/dashboard/components/inbox/`.
   - Displays: *Customer history, detected issue, relevant policy, and recommended action*.
   - Includes 1-click actions: `[Approve Action]`, `[Modify Action]`, `[Reject Action]`.
   - Approving triggers immediate tool execution and customer notification.

4. **24-Hour Customer Recovery Workflow:**
   - On `work_item.status = 'resolved'`, schedule `CustomerRecoveryWorkflow` to fire 24h later.
   - Dispatches gentle check-in on WhatsApp: *“Hi Rahul, just checking in to make sure everything was resolved with your order.”*

---

## Phase 3: Operations Employee — Expected vs. Actual & Stuck Work (Weeks 5–6)

### Focus: Operational Hygiene & Exception Triage
*Goal: Deliver the 9:00 AM Morning Check and continuously detect stalled work.*

1. **Daily Morning Check Cron (`DailyMorningCheckCron`):**
   - Scheduled Temporal cron running at 9:00 AM org local time.
   - Sweeps all inbound channels (Website forms, WhatsApp, Email) from past 24 hours.
   - Executes fuzzy deduplication against CRM records (flags exact matches vs ambiguous duplicates).
   - Generates and persists the 3-tier morning operational brief:
     - 🔴 High priority (uncontacted > 2h)
     - 🟠 Overdue tasks
     - 🟡 Ambiguous records needing review

2. **"Stuck Work" Continuous Detector (`StuckWorkDetectorWorkflow`):**
   - Hourly scan comparing `operational_expectations` against actual database timestamps.
   - Surfaces:
     - Leads stalled in stage > 5 days.
     - Unapproved documents / quotes pending > 48 hours.
     - Tomorrow's calendar meetings missing an executive preparation brief.

3. **Self-Explanation Query API (`GET /api/agent/explain`):**
   - Reads from `agent_decision_ledger`.
   - Allows users to ask: *“Why didn't you merge Acme Technologies and Acme Tech Solutions?”*
   - Returns logged rationale: *“Domain match was uncertain; confidence 0.58 below 0.85 threshold.”*

---

## Phase 4: Growth Employee — Lookalike Profiler & Signals (Weeks 7–8)

### Focus: Proactive Opportunity Discovery
*Goal: Transform Growth from a reactive chat tool into a continuous pipeline engine.*

1. **CRM Won-Deals Lookalike Profiler:**
   - Query top 20 closed/won accounts in CRM (HubSpot/Zoho).
   - Extract shared traits: industry, headcount range, tech stack, geography.
   - Query Apollo & Web Search for matching companies; rank fit score (0–100).

2. **Signal Watcher & Ingestion (`GrowthWatcherWorkflow`):**
   - Daily scanner monitoring hiring signals, funding announcements, and website pricing page visits.
   - Filters out accounts with zero active signals to prevent outreach fatigue.

3. **Opportunity Card UI (*Why this company, person, now?*):**
   - Build `GrowthOpportunityCard.tsx`.
   - Renders 3-part rationale:
     - **Why this company?** (Lookalike fit score 94/100)
     - **Why this person?** (VP Sales, joined 3 weeks ago)
     - **Why now?** (Pricing page visited 3× this morning)
   - Action buttons: `[Review Email]`, `[Edit]`, `[Approve & Send]`.

4. **Negative Feedback Preference Learner:**
   - When user rejects opportunity with comment (*“Don't target companies under 50 employees”*), synthesize negative rule into `tenant_preferences`.

---

## Phase 5: DareXAI Connect Scoping & Business Outcome Ledger (Weeks 9–10)

### Focus: Unified Multi-Employee Access & ROI Tracking
*Goal: Connect tools once; enforce role scopes and track real business impact.*

1. **Role-Scoped Connector Tool Filtering:**
   - Refactor `tool-executor.ts` from global union to **employee-scoped capability mapping**:
     - *Growth Employee:* Lead search, account enrichment, draft email, ad analytics.
     - *Customer Employee:* FAQ search, order lookup, appointment reschedule, ticket update.
     - *Operations Employee:* Record deduplication, task auditing, meeting brief generation, internal ping.

2. **Business Outcome ROI Attribution Ledger:**
   - Migration `024_business_outcomes.sql`: `growth_outcomes` and `efficiency_metrics`.
   - Tracks:
     - Opportunities created & downstream deal revenue.
     - Support issues resolved without human touch.
     - Human operational hours saved.
   - Renders live ROI scorecard on `/dashboard/stats`.

3. **End-to-End YC Demo Hardening:**
   - Execute live verification run:
     1. Connect Gmail + WhatsApp + HubSpot + Calendar once.
     2. Morning 9:00 AM check processes 28 enquiries and reports 3 exceptions.
     3. User clicks *“Take care of #1”* $\to$ autonomous resolution.
     4. User asks *“Why didn't you merge #2?”* $\to$ instantaneous reasoned explanation.

---

## Summary of Deliverables

By executing this 5-phase roadmap, DareXAI achieves **100% alignment** with the 106-page blueprint, moving from an AI plan-executor into a true **Autonomous AI Employee Platform**.
