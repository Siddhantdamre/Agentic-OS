# 01 — Growth Employee: Comprehensive Technical Gap Analysis

> **Blueprint Target:** Tab 1 (Pages 1–31, Sections 1–28)  
> **Mandate:** *“Find opportunities for the business, identify when those opportunities are becoming valuable, and make sure the business acts on them.”*  
> **Current Status Score:** 🟢 3 Built (21.4%) | 🟡 4 Partial (28.6%) | 🔴 7 Missing (50.0%)

---

## 1. Executive Summary & Core Architectural Premise

In the blueprint, the Growth Employee is **not** a chatbot that generates marketing copy, not an autonomous agent sandbox, and not a workflow automation builder. It is an **autonomous stakeholder** that owns the top of the funnel by continually answering three questions:
1. **Why this company?** (Lookalike fit, industry alignment, size match)
2. **Why this person?** (Decision-maker role who owns the pain point)
3. **Why now?** (Buying signals: hiring, funding, website activity, executive turnover)

### Current Codebase Reality
In the DareXAI repository today:
- **Ask AI Plan Execution (`apps/dashboard/app/api/ask-ai/`):** The user can prompt *“Find companies in Mumbai”*, and the system classifies it as complex, uses LiteLLM to generate a plan with `web_search` and `apollo` steps, pauses for user approval (`PATCH /api/ask-ai`), and streams execution via SSE.
- **The Core Architectural Gap:** This is **reactive user-prompted tool calling**, not an autonomous employee. The system cannot independently analyze existing closed-won deals in CRM, cannot detect external hiring/funding signals, cannot de-anonymize website visitors, cannot revive dormant leads, and has no memory of user preferences.

---

## 2. Granular Capability-by-Capability Technical Audit

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         GROWTH EMPLOYEE AUDIT MATRIX                        │
 ├────┬───────────────────────────────────────┬────────┬───────────────────────┤
 │ #  │ Blueprint Capability Specification   │ Status │ Codebase Reality      │
 ├────┼───────────────────────────────────────┼────────┼───────────────────────┤
 │ 1  │ Natural Language Objective Intake     │ 🟢 LIVE│ /api/ask-ai + LiteLLM │
 │ 2  │ Business & Customer Context Ingestion │ 🟡 PART│ RAG + prompt injection│
 │ 3  │ Scout (Web & People Discovery)        │ 🟢 LIVE│ web_search, apollo tool│
 │ 4  │ Lookalike Cohort Profiling Engine     │ 🔴 GAP │ Not implemented       │
 │ 5  │ Buying Signal Watcher (Hiring/Funding)│ 🔴 GAP │ Not implemented       │
 │ 6  │ Website Visitor De-anonymization      │ 🟡 PART│ Widget script exists  │
 │ 7  │ 3-Pillar Opportunity Reasoning Card   │ 🔴 GAP │ Generic text only     │
 │ 8  │ Personalized Outreach Drafting        │ 🟢 LIVE│ draft_email (Gmail)   │
 │ 9  │ Continuous Background Watcher Loop    │ 🔴 GAP │ Stateless execution   │
 │ 10 │ Dormant Opportunity Reviver           │ 🟡 PART│ Real estate only      │
 │ 11 │ Confidence-Tiered Autonomy Gate       │ 🟡 PART│ All-or-nothing plan   │
 │ 12 │ Dedicated Growth Daily Briefing View  │ 🔴 GAP │ Generic stats only    │
 │ 13 │ Negative Preference Learning Engine   │ 🔴 GAP │ Feedback not persisted│
 │ 14 │ Business ROI & Outcome Ledger         │ 🔴 GAP │ Token usage only      │
 └────┴───────────────────────────────────────┴────────┴───────────────────────┘
```

---

### Detailed Analysis of Each Capability

### 1. Natural Language Objective Intake
- **Blueprint Spec (Pages 2, 5–7):** User says *“Find companies similar to our best customers and help us reach them.”* The employee decomposes this into: understand best customers $\to$ build target profile $\to$ search candidates $\to$ rank $\to$ research $\to$ recommend.
- **Current Codebase State (🟢 GREEN):**
  - Implemented in `apps/dashboard/app/api/ask-ai/route.ts` via `classifyRequest()` in `apps/dashboard/lib/classify.ts`.
  - Calls `litellm-client.ts` (`http://litellm:4000/v1`) using `deepseek-v4-flash-0731` with `reasoning: { enabled: false }` to avoid parsing hangs.
  - Correctly decomposes requests into multi-step execution plans stored in `agent_plans` table.
- **Gaps to Polish:** Planner generates generic tool steps; needs explicit awareness of the Growth persona and domain goals.

---

### 2. Business & Customer Context Ingestion
- **Blueprint Spec (Pages 4–5):** The employee must know: What does the company sell? Who are the best customers? Which markets matter? History of past leads, won deals, failed campaigns.
- **Current Codebase State (🟡 YELLOW):**
  - Vector RAG implemented in `apps/dashboard/lib/memory-rag.ts` querying Postgres `documents` and `embeddings`.
  - Organization context is injected into agent prompts.
- **Why It Is Partial (The Gap):**
  - There is no structured entity extraction of "Best Customers". The agent reads unstructured docs, but does not query CRM tables to compute customer lifetime value, common headcount, or deal velocity.
  - Operational rules (*“Never contact companies outside India”*) are loosely held in prompt text rather than checked by a deterministic rule engine.

---

### 3. Scout: Prospect & Company Discovery
- **Blueprint Spec (Pages 8, 11–13):** Accesses external databases to identify target accounts matching target profiles and decision-maker roles.
- **Current Codebase State (🟢 GREEN):**
  - Tools exist in `services/workflows/src/tools/index.ts` and `tool-executor.ts`:
    - `web_search`: Jina AI search API with `JINA_API_KEY`.
    - `web_extract`: URL content extraction via Jina Reader.
    - `apollo`: Apollo.io search for people and companies.
  - Successfully exposed via MCP bridge (`services/workflows/src/mcp-bridge.ts`) to atomic-agent.
- **Gaps to Polish:** Apollo connector requires user-entered API keys in Settings UI instead of hardcoded environment keys.

---

### 4. Lookalike Cohort Profiling Engine
- **Blueprint Spec (Pages 8–10, 26):**
  - Analyzes successful customers:
    - Customer A: SaaS, 120 employees, India, active sales team.
    - Customer B: SaaS, 180 employees, India, growing rapidly.
    - Customer C: SaaS, 95 employees, India, raised funding.
  - Automatically forms hypothesis: *“Target companies: 80–200 employees, SaaS, active sales hiring, India.”*
  - Scores 500 candidates down to top fit scores (e.g. Acme 94/100, Nova 89/100).
- **Current Codebase State (🔴 RED - MISSING):**
  - Zero lookalike profiling code exists.
  - No database query calculates the statistical centroid of won CRM accounts.
  - No algorithmic scoring matches candidates against an ICP baseline.
- **Required Implementation:**
  - Build `services/workflows/src/growth/lookalike-profiler.ts`.
  - Queries closed-won deals from connected HubSpot/Zoho CRM accounts.
  - Extracts common features: employee range, industry NAICS/SIC, geographic hubs, tech stack tags.
  - Emits an ICP profile vector used to query Apollo/Search APIs.

---

### 5. Buying Signal Watcher (Hiring, Funding, Leadership Changes)
- **Blueprint Spec (Pages 11–12, 26):**
  - Moves from *“Who could buy?”* to *“Who is ready to buy?”*
  - Monitors external signals:
    - Hiring aggressive sales team (signals need for tooling)
    - New VP Sales joined last month (signals budget & leadership change)
    - Recent funding round or expansion into new geographies
- **Current Codebase State (🔴 RED - MISSING):**
  - `020_insight_learning.sql` has basic tables for insight actions.
  - Meta/Google Ads connectors track ad campaign data, but zero firmographic event scraping exists.
- **Required Implementation:**
  - Build `services/workflows/src/growth/signal-watcher.ts`.
  - Integrations with Apollo webhook alerts, LinkedIn company change feeds, and Google News RSS / search alerts.
  - Persists detected events into a new table: `lead_intent_signals` (`company_name`, `signal_type`, `payload`, `detected_at`).

---

### 6. Website Visitor De-anonymization & Intent Tracking
- **Blueprint Spec (Pages 19–20, 26):**
  - Workflow: Website visitor $\to$ identify company $\to$ matches ICP? $\to$ check intent (visited pricing page 3×) $\to$ research company $\to$ recommend outreach.
- **Current Codebase State (🟡 YELLOW):**
  - Embeddable widget script live at `apps/dashboard/public/embed/widget.js` and `/api/widget/session/`.
  - Captures visitor IP, user-agent, session duration, and chat interactions.
- **Why It Is Partial (The Gap):**
  - Lacks **Reverse-IP Enrichment**. The system logs the raw IP address, but has no integration with Clearbit Reveal, Snitcher, or 6sense to map IP $\to$ Company Name.
  - Lacks a page-level intent counter (e.g. incrementing `pricing_page_visits` for a recognized company).

---

### 7. "Why Now / Why This Person / Why This Company" Opportunity Card
- **Blueprint Spec (Pages 12–16, 29–30):**
  - A human salesperson rejects raw lead dumps. The employee must output a structured 3-part rationale:
    1. **Why this company?** (Strong ICP fit, similar to top 3 customers)
    2. **Why this person?** (Priya Sharma, VP Sales — owns the revenue problem directly)
    3. **Why now?** (Pricing page visited 3× + hiring 8 salespeople)
  - Prepares personalized outreach email with `[Review]`, `[Edit]`, `[Send]` buttons.
- **Current Codebase State (🔴 RED - MISSING):**
  - Ask AI outputs a generic text step description (`draft an email to NovaTech`).
  - No structured JSON schema enforces the 3-question rationale.
  - No UI card component renders this rationale in `apps/dashboard`.
- **Required Implementation:**
  - Define Zod schema:
    ```typescript
    interface GrowthOpportunityPayload {
      companyName: string;
      icpScore: number;
      whyThisCompany: string;
      targetContact: { name: string; title: string; email?: string; linkedin?: string };
      whyThisPerson: string;
      buyingSignals: Array<{ type: string; summary: string; timestamp: string }>;
      whyNow: string;
      draftedMessage: { subject: string; body: string };
    }
    ```
  - Build `OpportunityCard.tsx` in `apps/dashboard/components/growth/`.

---

### 8. Automated Outreach Drafting & Personalization
- **Blueprint Spec (Pages 14–17):**
  - Prepares contextual outreach message based on expansion details.
  - Waits for human approval. Upon approval, dispatches email/LinkedIn message.
  - If no reply in 3 days, prepares follow-up. If lead replies, interprets positive interest.
- **Current Codebase State (🟢 GREEN):**
  - Implemented in Ask AI plan execution:
    - Gmail tool `draft_email` creates a real draft in user's Gmail inbox.
    - `send_email` sends after confirmation.
- **Gaps to Polish:** Chaining automated 3-day follow-ups is currently not wired to durable Temporal timers (falls into Gap #9).

---

### 9. Continuous Background Watcher Loop
- **Blueprint Spec (Pages 17–18, 30–31):**
  - The employee does not wait for user prompts. Once hired, it continuously watches:
    `Business Signals → Growth Employee → Find New & Monitor Existing → Act → Outcome → Learn`.
- **Current Codebase State (🔴 RED - MISSING):**
  - Agent runtime is strictly request/response (invoked via HTTP API or inbound webhook).
  - No long-running background worker continuously monitors and evaluates accounts.
- **Required Implementation:**
  - Create Temporal workflow: `GrowthContinuousWatcherWorkflow.ts` in `services/workflows/src/workflows/`.
  - Runs on a scheduled cadence (e.g. every 4 hours), scans new signals, evaluates accounts, and queues high-confidence opportunities into `agent_plans` or `work_items`.

---

### 10. Dormant Lead / Opportunity Reviver
- **Blueprint Spec (Pages 18–19, 27):**
  - A business has 8,000 old leads in CRM. Sales forgot them.
  - Growth Employee discovers 147 inactive leads that showed fresh activity (funding, new VP, pricing page visit) and triggers revival outreach.
- **Current Codebase State (🟡 YELLOW):**
  - `services/workflows/src/workflows/StaleChaseWorkflow.ts` exists, but is hardcoded for **Real Estate brokerages** (monitoring inactive property listings).
  - No generalized B2B CRM scanner checks HubSpot/Zoho closed-lost deals.
- **Required Implementation:**
  - Generalize `StaleChaseWorkflow` into `DormantLeadRevivalWorkflow.ts`.
  - Queries CRM contacts where `last_activity_date > 180 days` and cross-references them against `lead_intent_signals`.

---

### 11. Confidence-Tiered Autonomy Gate (Ask / Review / Execute)
- **Blueprint Spec (Pages 21–23):**
  - Low-Risk (Research company) $\to$ *Autonomous*.
  - Medium-Risk (Create CRM record) $\to$ *Autonomous if permitted*.
  - Higher-Risk (Draft outreach) $\to$ *Prepare automatically*.
  - High-Risk (Send external communication) $\to$ *Human approval strictly required*.
- **Current Codebase State (🟡 YELLOW):**
  - `tool-executor.ts` enforces an org tool allowlist.
  - Ask AI enforces plan approval (`PATCH /api/ask-ai` with `approved: true`).
- **Why It Is Partial (The Gap):**
  - Plan approval is **all-or-nothing**. If a plan has 4 steps, all 4 are approved or none.
  - The blueprint specifies **per-action dynamic autonomy**: read steps execute immediately without asking; only write/send steps pause for review.

---

### 12. Dedicated Growth Employee Daily Briefing View
- **Blueprint Spec (Pages 23–24):**
  - User opens Growth tab:
    ```text
    Growth — Finding opportunities for you
    Today:
    • 3 opportunities need attention
    • 12 new high-fit companies found
    • 4 dormant leads became active
    • 7 outreach messages prepared
    • 2 follow-ups due
    ```
- **Current Codebase State (🔴 RED - MISSING):**
  - `/dashboard` shows generic system metrics (`apps/dashboard/app/(dashboard)/dashboard/page.tsx`).
  - No role-specific dashboard exists for the Growth Employee.
- **Required Implementation:**
  - Build `apps/dashboard/app/(dashboard)/employees/growth/page.tsx`.

---

### 13. Institutional Memory & Negative Preference Learning
- **Blueprint Spec (Pages 24–25):**
  - When user rejects: *“Don't target companies this small”*, system learns: *“Avoid companies < 50 employees.”*
  - Correlates user approvals with specific industry tags.
- **Current Codebase State (🔴 RED - MISSING):**
  - Feedback endpoint `/api/ask-ai/feedback/route.ts` logs thumbs up/down and text comments to `agent_feedback` table.
  - **No pipeline consumes this feedback** to adjust agent system prompts, ICP parameters, or tool query filters.
- **Required Implementation:**
  - Build `services/workflows/src/growth/preference-synthesizer.ts`.
  - Uses LiteLLM to distill rejection comments into JSON rule constraints saved in `org_preferences` table.

---

### 14. Business ROI & Outcome Attribution Ledger
- **Blueprint Spec (Pages 24–25):**
  - Measures performance by: Opportunities created, Qualified ops, Conversations started, Meetings generated, Revenue influenced, Hours saved.
  - Never measures performance by: number of prompts, token usage, or workflow steps.
- **Current Codebase State (🔴 RED - MISSING):**
  - `/api/analytics/cost/route.ts` tracks LiteLLM token usage and dollar API costs.
  - Zero attribution to business pipeline, bookings, or closed deals.
- **Required Implementation:**
  - Migration `024_growth_outcomes.sql`: `growth_pipeline_attribution` table linking `opportunity_id`, `crm_deal_id`, `stage`, and `estimated_value`.

---

## 3. Growth Employee Gap Summary

To achieve 100% parity with Tab 1 of the Blueprint, DareXAI must build:
1. **Lookalike Profiler:** Statistical analysis of CRM closed-won accounts.
2. **Signal Watcher:** Webhook & scraper pipeline for hiring/funding/intent events.
3. **Reverse-IP Engine:** Clearbit/Snitcher enrichment on `/embed/widget.js`.
4. **Opportunity Card UI:** Structured display of *Why this company, person, now?*
5. **Durable Temporal Watcher:** `GrowthContinuousWatcherWorkflow.ts`.
6. **Negative Rule Synthesizer:** Converting user rejections into persistent constraints.
7. **Pipeline Attribution Ledger:** Tracking dollar value created instead of tokens spent.
