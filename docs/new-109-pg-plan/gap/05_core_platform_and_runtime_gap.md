# 05 — Core Platform, Data Models & Runtime: Comprehensive Technical Gap Analysis

> **Scope:** Deep architectural audit of multi-tenancy, database models, Temporal orchestration, LLM routing, and state machine lifecycles against blueprint requirements.  
> **Current Status Score:** 🟢 7 Built (43.8%) | 🟡 5 Partial (31.3%) | 🔴 6 Missing (25.0%)

---

## 1. Executive Summary & Core Architectural Premise

The blueprint assumes an underlying operating system capable of:
1. Long-term state persistence across days/weeks.
2. Absolute data isolation between organizations.
3. Durable timer execution that survives server restarts.
4. Auditable self-explanation (*“Why did you do that?”* and *“Why didn't you do that?”*).
5. Non-blocking sub-3s webhook ingress for external channels.

### Current Codebase Reality
The DareXAI platform has a strong foundation:
- Multi-tenancy is enforced at the database session level via PostgreSQL Row-Level Security (`getScopedClient()`).
- Long-running execution is powered by Temporal in Docker.
- Agent tool execution is cleanly mediated via an SSE MCP server on port 8790.
- **The Core Architectural Gap:** The data models are currently oriented around **reactive conversations and tools** rather than **autonomous business states**. We have tables for `messages`, `channels`, and `agent_plans`, but zero tables for `open_loops`, `operational_expectations`, or `agent_decision_ledger`.

---

## 2. Platform Infrastructure & Runtime Audit

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         CORE PLATFORM AUDIT MATRIX                          │
 ├────┬───────────────────────────────────────┬────────┬───────────────────────┤
 │ #  │ Blueprint Architectural Requirement   │ Status │ Codebase State        │
 ├────┼───────────────────────────────────────┼────────┼───────────────────────┤
 │ 1  │ Multi-Tenant PostgreSQL with RLS      │ 🟢 LIVE│ WITH CHECK + FORCE RLS│
 │ 2  │ Entity Graph & Fact Model Schema      │ 🟢 LIVE│ 022_entity_graph.sql  │
 │ 3  │ Durable Temporal Workflow Cluster     │ 🟢 LIVE│ services/workflows live│
 │ 4  │ Sub-3s Decoupled Webhook Ingress      │ 🟢 LIVE│ webhook_inbox buffer  │
 │ 5  │ Atomic-Agent + 62-Tool MCP Bridge     │ 🟢 LIVE│ :8787 / :8790 live    │
 │ 6  │ Direct LiteLLM Plain JSON Routing     │ 🟢 LIVE│ litellm-client.ts live│
 │ 7  │ Dockerized Code Sandbox Isolation     │ 🟢 LIVE│ sandbox:8080 live     │
 ├────┼───────────────────────────────────────┼────────┼───────────────────────┤
 │ 8  │ Enquiry Lifecycle State Machine Schema│ 🔴 GAP │ Missing DB tables     │
 │ 9  │ "Open Loops" Customer State Table     │ 🔴 GAP │ Missing DB tables     │
 │ 10 │ Expected vs. Actual Milestone Engine  │ 🔴 GAP │ Missing DB tables     │
 │ 11 │ Self-Explanation Decision Ledger      │ 🔴 GAP │ No negative logging   │
 │ 12 │ Granular 4-Tier Autonomy Gate Policy  │ 🟡 PART│ All-or-nothing union  │
 │ 13 │ Cryptographic Approval Action Tokens  │ 🟡 PART│ Plan ID only          │
 │ 14 │ Autonomous Scheduled Cron Workflows   │ 🟡 PART│ Briefing only         │
 │ 15 │ Untrusted Prompt Injection Defense    │ 🟡 PART│ Basic prompt rules    │
 │ 16 │ Business ROI & Outcome Attribution    │ 🔴 GAP │ Token usage only      │
 └────┴───────────────────────────────────────┴────────┴───────────────────────┘
```

---

## 3. Deep Dive into Working Platform Pillars (🟢 GREEN)

### 1. Multi-Tenant Database Tenancy & RLS
- **Implementation:** `apps/dashboard/lib/db.ts` exposes `getScopedClient(orgId)`.
- **Enforcement:** Sets `SET LOCAL app.current_org_id = $1` at the session level; automatically resets on release.
- **Security:** Migrations 001–022 apply `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. All policies include `WITH CHECK` clauses, and the application connects as unprivileged user `darex_app`.

### 2. Entity Graph & Fact Model (Migration 022)
- **Implementation:** `infra/db/migrations/022_entity_graph.sql`.
- **Features:** Non-destructive entity merging (`status='merged'`, `merged_into`), deterministic identifier resolution (`entity_identifiers`), closed predicate definitions (`predicate_defs`), and typed object fact storage (`facts`).

### 3. Sub-3s Webhook Decoupling
- **Implementation:** `apps/dashboard/app/api/webhooks/whatsapp/route.ts`.
- **Latency:** Inbound WhatsApp webhook persists payload to `webhook_inbox` table, returns `HTTP 200 OK` in < 250ms, and dispatches Temporal `AutonomousAgentWorkflow` asynchronously. Complies with Meta's strict 3,000ms timeout.

### 4. Atomic-Agent & MCP Bridge
- **Implementation:** External atomic-agent Docker service on port 8787 connects via SSE to `services/workflows/src/mcp-bridge.ts` on port 8790. Exposes 62 connector, DB, and web search tools under `mcp.darex.*`.

### 5. LiteLLM Plain JSON Routing
- **Implementation:** `apps/dashboard/lib/litellm-client.ts`.
- **Optimization:** Directly invokes LiteLLM (`http://litellm:4000/v1`) with `reasoning: { enabled: false }` for planner and classifier calls. Prevents the 90-second agent-loop tool-call parsing hangs.

### 6. Sandboxed Code Execution
- **Implementation:** `infra/docker/sandbox` running Node.js 20 and Python 3. Fully unprivileged user, hard timeout, no outbound networking, no database access.

---

## 4. The 6 Missing Platform Schemas & State Machines (🔴 RED)

To support the autonomous behavior in Tabs 1, 2, and 3, DareXAI must add migration `023_employee_state_machines.sql`:

### 1. `operational_enquiries` (Enquiry Lifecycle State Machine)
```sql
CREATE TABLE operational_enquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel VARCHAR(50) NOT NULL, -- 'whatsapp', 'email', 'form', 'website'
    external_sender_id VARCHAR(255) NOT NULL,
    customer_name VARCHAR(255),
    company_name VARCHAR(255),
    intent_category VARCHAR(100) NOT NULL,
    priority VARCHAR(20) NOT NULL DEFAULT 'medium', -- 'critical', 'high', 'medium', 'low'
    state VARCHAR(50) NOT NULL DEFAULT 'new', -- 'new', 'assigned', 'contacted', 'overdue', 'escalated', 'closed'
    assigned_owner_id UUID REFERENCES users(id),
    sla_expires_at TIMESTAMPTZ,
    last_contacted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2. `agent_open_loops` (Customer Obligation & Open Loop Tracking)
```sql
CREATE TABLE agent_open_loops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id),
    customer_identifier VARCHAR(255) NOT NULL,
    promise_summary TEXT NOT NULL, -- e.g. 'Check warehouse for delayed order #4837'
    status VARCHAR(50) NOT NULL DEFAULT 'waiting', -- 'waiting', 'scheduled', 'monitoring', 'escalated', 'closed'
    target_check_at TIMESTAMPTZ NOT NULL,
    assigned_employee_role VARCHAR(50) NOT NULL,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3. `operational_expectations` (Expected vs. Actual Engine)
```sql
CREATE TABLE operational_expectations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    object_type VARCHAR(100) NOT NULL, -- 'enquiry', 'task', 'document', 'meeting'
    object_id VARCHAR(255) NOT NULL,
    expected_state VARCHAR(100) NOT NULL,
    expected_by_timestamp TIMESTAMPTZ NOT NULL,
    actual_state VARCHAR(100) NOT NULL DEFAULT 'pending',
    is_discrepancy BOOLEAN NOT NULL DEFAULT FALSE,
    discrepancy_resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4. `agent_decision_ledger` (Self-Explanation Trace Logging)
```sql
CREATE TABLE agent_decision_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    employee_role VARCHAR(50) NOT NULL,
    action_considered VARCHAR(100) NOT NULL, -- e.g. 'merge_crm_records'
    decision VARCHAR(20) NOT NULL, -- 'executed', 'deferred', 'rejected', 'escalated'
    confidence_score NUMERIC(4, 3) NOT NULL,
    reason_summary TEXT NOT NULL, -- e.g. 'Did not merge because domains matched different regional entities'
    context_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5. `employee_autonomy_rules` (Declarative 4-Tier Permission Matrix)
```sql
CREATE TABLE employee_autonomy_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    action_type VARCHAR(100) NOT NULL, -- 'read_crm', 'draft_email', 'refund_payment', 'delete_record'
    autonomy_tier INTEGER NOT NULL CHECK (autonomy_tier BETWEEN 1 AND 4),
    -- 1: Observe, 2: Recommend, 3: Execute, 4: Autonomous
    requires_human_approval BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 6. `employee_roi_metrics` (Business Outcome Attribution)
```sql
CREATE TABLE employee_roi_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    employee_role VARCHAR(50) NOT NULL,
    metric_type VARCHAR(50) NOT NULL, -- 'pipeline_influenced', 'ticket_resolved_autonomously', 'hours_saved'
    amount_numeric NUMERIC(12, 2),
    currency VARCHAR(10) DEFAULT 'USD',
    reference_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 5. Core Platform Gap Summary

To achieve 100% parity with the platform specifications implied in the blueprint, DareXAI must build:
1. **Migration 023:** Create the 6 missing state machine and ledger tables with complete RLS.
2. **Temporal Cron Registry:** Register `DailyMorningCheckCron` and `StuckWorkScanCron`.
3. **Decision Ledger Logging:** Write positive and negative decision traces during agent execution.
4. **4-Tier Autonomy Gate:** Intercept tool execution in `tool-executor.ts` using `employee_autonomy_rules`.
5. **Business Outcome Roll-up:** Aggregate real business impact ($ pipeline and hours saved) instead of raw token counts.
