# 02 — Customer Employee: Comprehensive Technical Gap Analysis

> **Blueprint Target:** Tab 2 (Pages 32–61, Sections 1–36)  
> **Mandate:** *“The Customer Employee is not responsible for answering messages. It is responsible for resolving customer needs.”*  
> **Current Status Score:** 🟢 4 Built (25.0%) | 🟡 5 Partial (31.3%) | 🔴 6 Missing (43.8%)

---

## 1. Executive Summary & Core Architectural Premise

In the blueprint, the Customer Employee is fundamentally distinguished from a traditional customer support chatbot:
- **Chatbot Paradigm:** `Customer Question → LLM → Text Response` (Leaves the customer with instructions to execute).
- **Customer Employee Paradigm:** `Customer Need → Understand State → Retrieve Policy → Decide → Tool Action → Resolve → Escalate Decision (not chat) → Follow up → Close Open Loop → Recover Customer`.

### Current Codebase Reality
In the DareXAI repository today:
- **Inbound Webhooks (`api/webhooks/whatsapp`, `chatwoot`):** Fully decoupled. Ingests message, saves to `webhook_inbox`, returns HTTP 200 in <500ms, and fires an asynchronous Temporal workflow (`AutonomousAgentWorkflow`).
- **The Core Architectural Gap:** Once the agent answers the question, **it completely forgets future obligations**. If the agent promises *“I'll check with warehouse and get back to you at 4 PM”*, it has no durable timer to follow up. There is no concept of an **Open Loop**, no **Customer Recovery** workflow, no **Decision Escalation Card**, and no **Conversational Business Intelligence** tracking recurring failures.

---

## 2. Granular 12-Step Lifecycle Technical Audit

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                     CUSTOMER EMPLOYEE 12-STEP AUDIT                         │
 ├────┬───────────────────────────────────────┬────────┬───────────────────────┤
 │ #  │ Blueprint Step Specification          │ Status │ Codebase Reality      │
 ├────┼───────────────────────────────────────┼────────┼───────────────────────┤
 │ 1  │ Step 1 — Understand (Identity/Intent) │ 🟢 LIVE│ Webhook identity norm │
 │ 2  │ Step 2 — Identify Customer State      │ 🟡 PART│ Ephemeral sentiment   │
 │ 3  │ Step 3 — Find Answer (Trusted Data)   │ 🟢 LIVE│ Vector RAG + tools    │
 │ 4  │ Step 4 — Programmatic Confidence Gate │ 🟡 PART│ Prompt honesty rule   │
 │ 5  │ Step 5 — Resolve, Not Just Answer     │ 🟡 PART│ Calendar tools exist  │
 │ 6  │ Step 6 — Escalate Decision, Not Chat  │ 🟡 PART│ work_items table live │
 │ 7  │ Step 7 — Human Takeover & Resumption  │ 🟡 PART│ WorkItemWorkflow stub │
 │ 8  │ Step 8 — Obligation & Follow-up       │ 🔴 GAP │ No promise detector   │
 │ 9  │ Step 9 — "Open Loops" State Machine   │ 🔴 GAP │ No open loops entity  │
 │ 10 │ Step 10 — Remember (Institutional)    │ 🟡 PART│ Chat history only     │
 │ 11 │ Step 11 — Learn (Business Intel)      │ 🔴 GAP │ Volume metrics only   │
 │ 12 │ Step 12 — Proactive Customer Recovery │ 🔴 GAP │ No post-resolve check │
 └────┴───────────────────────────────────────┴────────┴───────────────────────┘
```

---

### Deep Technical Breakdown by Step & Component

### 1. Omnichannel Inbound Ingestion (Sub-3s Decoupling)
- **Blueprint Spec (Pages 33, 36, 55):** Inbound messages arrive via WhatsApp, Email, or Web Chat. System must ingest without dropping messages or timing out.
- **Current Codebase State (🟢 GREEN):**
  - Live in `apps/dashboard/app/api/webhooks/whatsapp/route.ts` and `chatwoot/route.ts`.
  - Implements the strict DareX architecture rule: **Never await an LLM call inside a webhook**.
  - Persists payload to `webhook_inbox` table, returns `HTTP 200 OK` in ~250ms, and dispatches Temporal `AutonomousAgentWorkflow` asynchronously.

---

### 2. Authority Boundaries & Policy Rules
- **Blueprint Spec (Pages 35–38):**
  - Explicit boundaries:
    - *I can answer:* product, pricing, availability, policy.
    - *I can do:* check orders, book appointments, reschedule, create tickets.
    - *I cannot do:* approve refunds, make policy exceptions.
    - *I must escalate:* angry customers, refund requests, legal threats, low confidence.
- **Current Codebase State (🟡 YELLOW):**
  - Authority rules are embedded as prose inside system prompt strings in `services/workflows/src/workflows/AutonomousAgentWorkflow.ts`.
- **Why It Is Partial (The Gap):**
  - Hardcoded in code. If an organization wants to allow refunds under $50, an engineer must edit code.
  - Needs a database-backed table: `employee_authority_policies` with columns: `(org_id, employee_id, action_name, policy_type: 'allowed' | 'restricted' | 'escalate_strictly')`.

---

### 3. Step 1: Understand (Identity & Intent Resolution)
- **Blueprint Spec (Pages 38–39):** Maps phone number $\to$ Rahul Sharma $\to$ past order yesterday $\to$ asking for delivery status.
- **Current Codebase State (🟢 GREEN):**
  - Contact resolution is handled in `api/webhooks/whatsapp/route.ts` linking to `conversations` table.
  - LiteLLM classifies message intent into categories.

---

### 4. Step 2: Customer Operational State Identification
- **Blueprint Spec (Pages 39–40):** Differentiates *Intent* (what they want) from *State* (what is happening with them: New customer, Existing, Waiting for response, Unresolved problem, Frustrated, VIP account, At risk of churn).
- **Current Codebase State (🟡 YELLOW):**
  - Basic sentiment scoring exists in analytics (`/api/analytics`), but is not attached to the customer record or conversation session.
- **Why It Is Partial (The Gap):**
  - The customer's state is recalculable on each message turn, but **never stored as a persistent state machine**. If a customer was angry yesterday, the agent today treats them as brand new unless full chat history fits in context.
  - Needs `customer_operational_states` column in `conversations` or `entities` table (`status: 'at_risk' | 'escalated' | 'resolved' | 'waiting'`).

---

### 5. Step 3: Find the Answer (Knowledge Retrieval)
- **Blueprint Spec (Pages 40–42):** Queries CRM, Order system, and Delivery system without exposing RAG complexity to the user.
- **Current Codebase State (🟢 GREEN):**
  - Implemented via `lib/memory-rag.ts` (semantic vector search over Postgres pgvector embeddings) and tool executor queries (`hubspot`, `zoho`, `google-drive`).

---

### 6. Step 4: Programmatic Confidence Gate
- **Blueprint Spec (Pages 40–42):**
  - High confidence $\to$ Answer directly.
  - Medium confidence $\to$ Clarify / Investigate.
  - Low confidence $\to$ Escalate to human without guessing.
- **Current Codebase State (🟡 YELLOW):**
  - Prompt instructs the LLM: *“If you do not know, say you don't know.”*
- **Why It Is Partial (The Gap):**
  - Relies entirely on the LLM's own self-policing (which frequently hallucinates or over-confidently guesses).
  - Needs a **deterministic confidence scoring gate**: if vector search similarity is $< 0.72$ and no tool returns matching entity data, the system must **programmatically force an escalation branch** before generating a response.

---

### 7. Step 5: Resolve, Not Just Answer
- **Blueprint Spec (Pages 43–44, 52–54):**
  - A customer asks: *“Can I move my appointment to tomorrow?”*
  - Chatbot response: *“Please visit our portal at example.com/reschedule.”* (Terrible).
  - Customer Employee: Checks calendar, finds 11 AM and 3 PM open, asks customer, moves event in calendar, updates CRM, confirms on WhatsApp.
- **Current Codebase State (🟡 YELLOW):**
  - Showing schedule tool exists for real estate (`ShowingScheduleWorkflow.ts`); Google Calendar `create_event` exists in `tool-executor.ts`.
- **Why It Is Partial (The Gap):**
  - Calendar rescheduling is fragmented across real estate packs; there is no general-purpose slot-negotiation and rescheduling state machine for generic B2B/SaaS clients.

---

### 8. Step 6: Escalate a Decision, Not a Conversation
- **Blueprint Spec (Pages 44–46):**
  - **Wrong AI:** *“Human needed. Customer is waiting in chat.”*
  - **DareXAI Spec:** The AI performs the complete investigation and generates an actionable **Decision Card**:
    ```text
    Human Attention Required
    Customer: Rahul Sharma
    Issue: Refund Request
    Order: #4837 (Delayed 5 days)
    Customer Sentiment: Frustrated
    Policy: Refunds require human approval
    Recommended Action: Approve $120 refund
    [Approve] [Reject] [Modify]
    ```
- **Current Codebase State (🟡 YELLOW):**
  - `work_items` table (migration `012_work_items.sql`) exists with columns: `id`, `org_id`, `type`, `title`, `description`, `status`, `assigned_to`, `payload`.
  - `apps/dashboard/app/api/work-items/route.ts` allows listing and patching work items.
- **Why It Is Partial (The Gap):**
  - The agent loop in `AutonomousAgentWorkflow` does not reliably package the decision into the structured `payload` JSON.
  - The UI (`/inbox` or `/work-items`) lacks the interactive 1-click `[Approve] / [Reject]` decision component that triggers the tool execution callback.

---

### 9. Step 7: Human Takes Over & Autonomous Loop Resumption
- **Blueprint Spec (Page 46):** Human clicks `[Approve]`. The employee sees the approval, executes the refund tool, and messages the customer on WhatsApp: *“Your refund has been approved and processed.”*
- **Current Codebase State (🟡 YELLOW):**
  - `WorkItemWorkflow.ts` defines signals for human completion.
  - However, the callback that notifies the customer on WhatsApp after human approval is partially wired and lacks live integration testing.

---

### 10. Step 8: Obligation & Follow-up Tracking
- **Blueprint Spec (Pages 46–47):**
  - If the employee says: *“I'll check with the warehouse and get back to you at 4 PM”*, it creates a binding obligation.
  - At 4 PM, it wakes up, queries the warehouse API, and proactively messages the customer with the latest status.
- **Current Codebase State (🔴 RED - MISSING):**
  - Zero obligation detection in the codebase.
  - If an agent generates a promise in a WhatsApp chat turn, that promise evaporates from execution memory the moment the turn completes.
- **Required Implementation:**
  - Build `services/workflows/src/customer/obligation-extractor.ts`.
  - Runs post-generation: extracts any time-bound commitments.
  - Inserts row into `agent_open_loops` and schedules Temporal timer.

---

### 11. Step 9: The "Open Loops" State Machine
- **Blueprint Spec (Page 47):**
  - Every customer interaction must map to an explicit loop state:
    - **`Closed`:** Issue fully resolved.
    - **`Waiting`:** External third party or customer action required.
    - **`Scheduled`:** Follow-up scheduled at a specific timestamp.
    - **`Monitoring`:** Actively polling for an event (e.g. shipping update).
    - **`Escalated`:** Waiting for human manager decision.
- **Current Codebase State (🔴 RED - MISSING):**
  - Conversations table (`conversations`) tracks threads, but has no concept of an Open Loop lifecycle or target resolution SLA.
- **Required Implementation:**
  - Migration `023_employee_state_machines.sql`: create `agent_open_loops` table.
  - Build `OpenLoopMonitorWorkflow.ts` in Temporal to enforce loop closure SLAs.

---

### 12. Step 10: Institutional Memory & Entity Graph Integration
- **Blueprint Spec (Page 48):** Next time Rahul contacts the business, the employee immediately knows: *“Rahul experienced a delivery delay on Sept 7 and received a refund.”*
- **Current Codebase State (🟡 YELLOW):**
  - Raw chat messages are stored in `messages` table.
  - Migration `022_entity_graph.sql` created `entities` and `facts` tables, but the ingestion workflow (`FactExtractWorkflow`) is not active.
- **Why It Is Partial (The Gap):**
  - The model must re-read raw chat transcripts on every turn rather than querying structured facts from the Entity Graph.

---

### 13. Step 11: Conversational Business Intelligence
- **Blueprint Spec (Pages 48–49, 57):**
  - Detects macro patterns across 300 customer chats:
    - *“Delivery timeline questions rose 32% this week; customers need clearer delivery tracking.”*
    - *“18 customers reported confusion during checkout.”*
- **Current Codebase State (🔴 RED - MISSING):**
  - `/api/analytics` aggregates basic numbers (message count, active users, token cost).
  - Zero semantic clustering of customer friction points or FAQ gap recommendations.
- **Required Implementation:**
  - Scheduled nightly cron: `ConversationalInsightWorkflow.ts`.
  - Embeds and clusters customer inquiry topics, identifies spikes, and drafts FAQ update proposals in `apps/dashboard`.

---

### 14. Step 12: Proactive Customer Recovery Loop
- **Blueprint Spec (Pages 49–50):**
  - 24 hours after a manager approves a refund or fixes a severe complaint, the employee proactively contacts the customer:
    *“Hi Rahul, just checking in to verify that your delivery arrived safely today.”*
  - Updates customer health: `Issue → Resolved` | `Customer → Recovered`.
- **Current Codebase State (🔴 RED - MISSING):**
  - No post-resolution check-in exists. Once a ticket is marked resolved, the system goes silent.
- **Required Implementation:**
  - Create Temporal workflow: `CustomerRecoveryWorkflow.ts`.
  - Triggered automatically on `work_items` transition to `resolved`.
  - Schedules a 24-hour sleep timer, sends WhatsApp check-in, and updates customer sentiment.

---

### 15. Customer Manager Morning Briefing
- **Blueprint Spec (Pages 57–58):**
  - Roll-up briefing card on Monday morning:
    ```text
    Customer Employee — Good morning.
    • 47 customer conversations handled
    • 41 resolved automatically
    • 4 require your attention (decision cards ready)
    • 2 customers appear at risk of churn
    • Delivery questions increased 32% this week
    ```
- **Current Codebase State (🔴 RED - MISSING):**
  - No dedicated Customer Manager dashboard view exists.
- **Required Implementation:**
  - Build `apps/dashboard/app/(dashboard)/employees/customer/page.tsx`.

---

## 3. Customer Employee Gap Summary

To achieve 100% parity with Tab 2 of the Blueprint, DareXAI must build:
1. **Open Loops State Machine:** Database table `agent_open_loops` + Temporal monitor.
2. **Obligation Extractor:** Automatic promise detection from natural language chat.
3. **Decision Escalation Card UI:** Interactive `[Approve] / [Reject]` decision component in dashboard.
4. **Fact Extraction into Entity Graph:** Ingesting customer context into `022_entity_graph.sql`.
5. **24-Hour Recovery Workflow:** `CustomerRecoveryWorkflow.ts` follow-up after resolution.
6. **Conversational Business Intelligence:** Nightly clustering of customer friction and FAQ gaps.
