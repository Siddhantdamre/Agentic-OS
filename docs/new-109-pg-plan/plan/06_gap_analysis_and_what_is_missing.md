# 06 — Master Gap Analysis, Architectural Bridges & Production Roadmap

> **Document Type:** Master Engineering Audit & Gap Remediation Blueprint  
> **Source:** Synthesized from `DareXAI One_ Employee Blueprint.pdf`, comprehensive codebase audits (`apps/dashboard`, `services/workflows`, `services/connectors`, `infra/`), and the 24 engineering gap specifications (`gap/00`–`gap/23`).  
> **Core Objective:** Bridge the 106-page product blueprint into hardened, multi-tenant production software by resolving all 7 architectural gaps and 5 critical implementation seams.

---

## 1. Executive Scorecard: Blueprint Vision vs. Codebase Reality

DareXAI has built a world-class foundational substrate:
- **Authentication & Tenancy:** SuperTokens multi-tenant session auth with PostgreSQL Row-Level Security (`app.current_org_id`).
- **Durable Orchestration:** Temporal worker infrastructure (`services/workflows`) running long-running jobs.
- **Agentic Runtime:** Atomic-agent (v0.1.72) communicating via Model Context Protocol (MCP) SSE bridge (`:8790`) with 62 tool executors.
- **Model Routing:** LiteLLM proxy with streaming plan-confirm-execute architecture.

However, a comprehensive audit against the 106-page blueprint reveals that **28% of blueprint behaviors are live, 31% are partially built, and 41% are missing**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DAREXAI ONE READINESS MATRIX                        │
├────────────────────────────────┬─────────┬──────────┬─────────┬─────────────┤
│ Functional Domain              │ 🟢 Live │ 🟡 Partial│ 🔴 Gap  │ Readiness   │
├────────────────────────────────┼─────────┼──────────┼─────────┼─────────────┤
│ 1. Growth Employee             │    3    │    4     │    7    │    21.4%    │
│ 2. Customer Employee           │    4    │    5     │    6    │    26.7%    │
│ 3. Operations Employee         │    2    │    4     │    9    │    13.3%    │
│ 4. Shared Integrations         │    6    │    6     │    4    │    37.5%    │
│ 5. Core Platform & Runtime     │    7    │    5     │    6    │    38.9%    │
├────────────────────────────────┼─────────┼──────────┼─────────┼─────────────┤
│ TOTALS                         │   22    │   24     │   32    │    28.2%    │
└────────────────────────────────┴─────────┴──────────┴─────────┴─────────────┘
```

---

## 2. The 7 Architectural Bridges: From Blueprint to Code

The 106-page blueprint defines *what* the employees do; software engineering must define *how* they do it reliably at scale. To ship DareXAI One, engineering must implement **7 foundational architectural bridges**:

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         THE 7 ARCHITECTURAL BRIDGES                         │
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 1. Database Schema & Multi-Tenant RLS Policy Engine                         │
 │ 2. Temporal Durable Workflows & Deterministic Timer Infrastructure          │
 │ 3. Real-Time Webhook Ingress & Rate-Limiting Decoupler                      │
 │ 4. LLM Structured Output Schemas & Deterministic Post-Validators            │
 │ 5. Autonomy Permission Gate & Cryptographic Action Token Ledger             │
 │ 6. Auditable Thought & Counterfactual Decision Trace Ledger                 │
 │ 7. Connector Token Lifecycle & Multi-Tenant Nango OAuth Bridge              │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

### Bridge 1: Database Schema & Multi-Tenant RLS Policy Engine
- **The Gap:** The blueprint assumes entities have "State", but specifies no database tables, foreign keys, or tenant boundaries.
- **The Solution:** Implemented migrations `023` and `024` adding:
  - `agent_open_loops` (Tracking multi-day promises with SLA timestamps).
  - `operational_exceptions` (Expected vs. Actual discrepancy store).
  - `agent_pending_actions` (Approval token gate).
  - `agent_decision_ledger` (Complete trace of positive and negative decisions).
  - `growth_opportunities` & `lead_intent_signals` (Pipeline intelligence).
  - Full PostgreSQL Row-Level Security (RLS) policies on every table:
    ```sql
    CREATE POLICY table_isolation ON <table_name>
        FOR ALL USING (org_id = current_setting('app.current_org_id', true));
    ```

---

### Bridge 2: Temporal Durable Workflows & Deterministic Timers
- **The Gap:** The blueprint specifies delays across hours and days (*"Check with warehouse at 4:00 PM"*, *"Follow up with lead in 3 days"*). A standard HTTP server or LLM loop cannot survive server restarts or process crashes.
- **The Solution:** Durable Temporal Workflows:
  - `CustomerInteractionWorkflow` & `CustomerFollowUpWorkflow` using `workflow.sleep('72 hours')`.
  - `OperationsMorningIntakeWorkflow` running on a scheduled cron at 9:00 AM org time via `continueAsNew`.
  - **Determinism Boundary:** LLM calls, network I/O, and current timestamp queries are strictly isolated inside **Activities**; workflow functions remain purely deterministic.

---

### Bridge 3: Real-Time Webhook Ingress & Rate Limiting Engine
- **The Gap:** Meta WhatsApp Cloud API requires an `HTTP 200 OK` response within **3,000ms**; otherwise, it retries the webhook, creating duplicate message storms. An LLM agent checking CRM + SOPs takes 4–8 seconds.
- **The Solution:** Decoupled Ingress Architecture:
  1. Next.js route `/api/webhooks/whatsapp` persists the raw payload to PostgreSQL and returns `200 OK` in **<400ms**.
  2. Ingress triggers a fire-and-forget Temporal workflow execution.
  3. Worker pulls the payload, executes the 12-step resolution loop, and dispatches the reply via outbound API.

---

### Bridge 4: Structured Output Schemas & Deterministic Post-Validators
- **The Gap:** LLMs hallucinate schema keys, invent invalid date strings (*"next Tuesday afternoonish"*), or return conversational commentary when JSON is expected.
- **The Solution:**
  - TypeScript Zod / Pydantic schemas enforced via LiteLLM structured outputs (`response_format: { type: "json_object" }`).
  - **Deterministic Post-Validators:** Every model response passes through code-level validation:
    - Verifies date/time resolution against org timezone.
    - Confirms extracted phone numbers match E.164 format.
    - Halts execution if required keys are missing or confidence scores are below threshold.

---

### Bridge 5: Autonomy Permission Gate & Action Token Ledger
- **The Gap:** How does the system pause safely while waiting for a human to review a cold email draft or refund?
- **The Solution:**
  1. Staging: Action proposal is saved to `agent_pending_actions` with a cryptographically signed approval token (`HMAC-SHA256`).
  2. Temporal Pause: The workflow pauses at `workflow.condition(() => actionDecided, '7 days')`.
  3. Dashboard UI: Renders a Decision Card with `[Approve]`, `[Reject]`, `[Edit]`, and `[Feedback]`.
  4. Signal Resume: User click sends `approveActionSignal(token)`, resuming workflow execution.
  5. **Golden Rule:** **A timeout never defaults to approval.** If 7 days elapse without human action, the item is cancelled and logged.

---

### Bridge 6: Auditable Thought & Counterfactual Decision Trace Ledger
- **The Gap:** When a founder asks *"Why didn't you merge these two CRM records?"*, an LLM without historical negative logging must guess or hallucinate.
- **The Solution:** The `agent_decision_ledger` records **counterfactual non-actions**:
  - `action_considered`: `'crm_merge_duplicate'`
  - `decision_outcome`: `'counterfactual_no_action'`
  - `confidence_score`: `0.81`
  - `primary_reasoning`: *"Confidence below 95% threshold due to conflicting phone country codes (+44 vs +1)."*

---

### Bridge 7: Connector Token Lifecycle & Multi-Tenant OAuth Bridge
- **The Gap:** Third-party OAuth tokens (Gmail, HubSpot) expire every 60 minutes. Tool calls fail unpredictably if tokens are stale.
- **The Solution:**
  - Managed OAuth via Nango.
  - Automatic pre-expiry token rotation.
  - Per-tenant rate-limiting token buckets (e.g., HubSpot 100 calls/10 seconds).

---

## 3. The 5 Critical Seams & Failure Modes (Audit Findings)

During the deep architectural audit (`gap/11`–`gap/16`), five critical implementation seams were identified and corrected:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        THE 5 CORRECTED CODE SEAMS                           │
├──────────────────────┬──────────────────────────────────────────────────────┤
│ 1. External Send     │ Outbound emails/messages were calling API tools      │
│    Bypass Seam       │ directly, bypassing the autonomy gate entirely.      │
│                      │ Fix: Routed all sends through guardedSendActivity.   │
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 2. Action Taxonomy   │ Pending action types did not match database seed     │
│    Mismatch          │ rules, causing foreign key failures on review.       │
│                      │ Fix: Standardized unified ActionTaxonomy enum.       │
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 3. Timeout Semantics │ Some draft workflows defaulted to auto-approve on    │
│    Vulnerability     │ timeout. Fix: Strict rule: Timeout = Cancel/Escalate.│
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 4. DB Pool Deadlock  │ Long-running SSE streaming routes held PostgreSQL    │
│    Risk (max: 10)    │ clients open, exhausting the pool.                   │
│                      │ Fix: Scoped clients released before opening streams. │
├──────────────────────┼──────────────────────────────────────────────────────┤
│ 5. Self-Citation     │ Agent memory wrote back unverified model outputs,    │
│    Memory Drift      │ citing its own past hallucinations as ground truth.  │
│                      │ Fix: Memory writes require verified external state.  │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

---

## 4. Master Engineering Remediation Plan (Phases 1 to 5)

```
  Phase 1: Hardened Foundation & Guarded Core (Weeks 1–3)
  ├── Execute Migrations 023 & 024 (agent_open_loops, exceptions, pending_actions, ledger)
  ├── Implement guardedSendActivity enforcing Autonomy Level 2
  ├── Fast-ACK webhook ingress for WhatsApp Cloud API (<500ms response)
  └── Wire Decision Card stream in Dashboard with HMAC token validation
  
  Phase 2: Operational Engine & Expected vs. Actual (Weeks 4–6)
  ├── 9:00 AM Morning Intake Cron Workflow with entity deduplication (<95% review)
  ├── Daily Morning Brief generated and delivered to Slack / Dashboard
  ├── Continuous daytime monitoring for lead response time (<180 min SLA)
  └── Counterfactual decision ledger recording "Why didn't you act"
  
  Phase 3: Customer Resolution & Open Loops (Weeks 7–9)
  ├── Complete 12-step resolution engine with hybrid RAG policy retrieval
  ├── Open Loop state machine with Temporal durable timers (hours to days)
  ├── Real-time sentiment scoring & frustration keywords (Lawyer/Refund)
  └── Multi-calendar rescheduling engine with 15-minute buffer enforcement
  
  Phase 4: Growth Opportunity & Lookalike Engine (Weeks 10–12)
  ├── Vector embedding similarity search for closed-won lookalike hunting
  ├── Intent signal poller (Hiring spikes, tech changes, funding news)
  ├── Dormant CRM lead revival sweep (>90 days idle)
  └── Rejection feedback learning loop (updates ICP weights in memory)
  
  Phase 5: Multi-Employee Swarm & Self-Healing Platform (Weeks 13–16)
  ├── Cross-employee context coordination (Growth deal → Operations onboarding)
  ├── Procedural memory & playbook generation from human edits
  ├── Autonomous FAQ and low-risk self-healing (Level 3/4 Autonomy)
  └── Full YC Demo acceptance test verification
```

---

## 5. The 7-Point Production Definition of Done (DoD)

No feature or workflow in DareXAI One is considered "Done" until it satisfies all 7 production standards:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    7-POINT DEFINITION OF DONE (DoD)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Tenancy Isolation: Every query and mutation enforces org_id RLS.         │
│ 2. Durable Resilience: Survives process restarts; no state lost on crash.   │
│ 3. Autonomy Gated: Irreversible actions enforce Level 2 Decision Cards.     │
│ 4. Fast-ACK Ingress: Webhooks return 200 OK within 500ms; async execution.  │
│ 5. Auditable Trace: Decisions and non-decisions logged in decision_ledger.  │
│ 6. Deterministic Validation: Model outputs validated by Zod post-checks.    │
│ 7. Automated Acceptance Test: Covered by end-to-end integration test suite. │
└─────────────────────────────────────────────────────────────────────────────┘
```
