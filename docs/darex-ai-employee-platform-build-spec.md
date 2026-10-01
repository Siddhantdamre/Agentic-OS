# Darex-Style "AI Employees" SaaS — Full Build Spec & Agent Prompt

This document is written to be handed directly to a coding agent (Claude Code, Cursor, etc.) as its operating brief. It covers: what the app is, the architecture principles that prevent context loss, exactly which open-source repos to clone vs. build fresh, and a phased execution plan with exit criteria per phase.

---

## PART 1 — App Description

**What it is:** A multi-tenant SaaS where a business owner "hires" a roster of AI employees (Sales rep, Support specialist, Marketing assistant, etc.) instead of buying separate software tools. Each AI employee has its own persona, its own memory, its own tool access, and works across the channels the business already uses (WhatsApp, Email, Meta/Google Ads, CRM, Calendar, Payments). The owner supervises everything from one dashboard: a live conversation feed, per-employee workspaces, a business-health insight engine, and an integrations panel.

**Core user journey:**
1. Sign up → onboarding wizard (business type, team size, channels used, name)
2. "Warm-up" state — system provisions AI employees and connects integrations, shows live progress
3. Home dashboard — daily snapshot, needs-attention queue, chat-with-your-business bar
4. Conversations page — aggregate view across all employees, with human-review escalation
5. Per-employee Workspace — talk directly to a specific AI employee, see its stats
6. Insight page — AI-generated business diagnostics with recommended actions
7. Integrations page — connect/manage channels and tools

**Non-negotiable qualities:**
- **Multi-tenant from day one** — every table, every query, every cache key is org-scoped
- **No conversation ever silently drops** — a crash, timeout, or API failure must resume, not vanish
- **Modular** — every AI employee, every connector, every skill is a swappable unit, not hardcoded logic
- **Scalable horizontally** — stateless app servers, durable workflows, connection-pooled DB, queue-backed ingestion

---

## PART 2 — Architecture Principles (how we avoid context loss)

Context loss happens in **two places** in a project like this — the spec addresses both:

### 2a. Context loss in the *product* (customer-facing)
- Every conversation is a **Temporal workflow**, not a stateless function call. If the process dies mid-conversation, Temporal resumes from the last completed step — never from zero, never silently dropped.
- Memory is **hierarchical and persisted**, not held in RAM: org-level knowledge → employee-level learned patterns → conversation-level thread history, all in Postgres/pgvector. A restart of any service never erases what an employee "knows" about a customer.
- Every external tool call (CRM write, refund, calendar book) is an **idempotent Temporal activity** with automatic retry — a flaky third-party API never becomes a customer-visible failure.

### 2b. Context loss in the *build process* (agent-facing)
Long agentic builds lose track of what's done, redo work, or drift from the spec. To prevent this, the agent must:
- Maintain a `BUILD_STATE.md` file at repo root, updated at the end of every phase, containing: what's complete, what's pending, key architectural decisions made, and any deviations from this spec with reasons.
- Never start a new phase without first reading `BUILD_STATE.md` and the phase's exit criteria below.
- Commit after every completed sub-task with a message referencing the phase number (e.g., `[Phase 3] Wire Chatwoot webhook to LangGraph agent`).
- Treat this document as source of truth; if a decision here conflicts with something discovered during implementation, update `BUILD_STATE.md` with the conflict and reasoning rather than silently diverging.

---

## PART 3 — Stack & What To Clone vs. Build

| Layer | Use | Clone/self-host from | Build fresh |
|---|---|---|---|
| **Conversation inbox & channel UI** | Multi-channel inbox (WhatsApp/Email/FB/IG), agent assignment, conversation history | **Chatwoot** — `github.com/chatwoot/chatwoot` (fork this; it already solves 70% of the Conversations + Employee list UI you sketched in Figma) | AI-agent automation hooks on top of Chatwoot's webhook/API layer |
| **Connector/OAuth layer** | Token storage, refresh, multi-tenant credential isolation, tool execution | **Nango** — `github.com/NangoHQ/nango` (self-host) | Custom TypeScript integration functions per app (HubSpot, Razorpay, Google Ads, Meta Ads, Calendar) |
| **Durable execution** | Conversation-as-workflow, retries, human-in-the-loop pause/resume | **Temporal** — `github.com/temporalio/temporal` (self-host via docker-compose) | Your workflow/activity definitions |
| **Agent harness** | Per-employee reasoning graphs, tool routing, escalation logic | `langchain-ai/langgraph` (library, not a fork) | All employee skill graphs — this is your core IP, build fresh |
| **LLM gateway** | Unified interface across model providers, fallback routing | **LiteLLM** — `github.com/BerriAI/litellm` (self-host) | Config only |
| **Vector memory / RAG** | Org/employee/conversation memory tiers | **pgvector** — `github.com/pgvector/pgvector` (Postgres extension, not a separate service) | Retrieval + memory-write logic |
| **Auth & multi-tenant identity** | Org/user/role management, SSO-ready | **SuperTokens** — `github.com/supertokens/supertokens-core` (self-host, open source) or Ory Kratos | Org onboarding wizard flow |
| **Observability / LLM tracing** | Per-call tracing, cost per tenant, prompt debugging | **Langfuse** — `github.com/langfuse/langfuse` (self-host) | Dashboards for the Insight page (custom, reads from Langfuse + Postgres) |
| **Sandboxed per-org execution** | Custom logic/code an org configures | **E2B** — `github.com/e2b-dev/e2b` (open source, Firecracker-based) | Only wire this in Phase 7+, not needed early |
| **Dashboard UI components** | Insight cards, analytics charts, onboarding wizard | `shadcn/ui` + `tremor` (component libraries, not full clones) | All Darex-specific screens (Home, Insight, Integration pages) |

**Why Chatwoot specifically:** it already has org/agent model, multi-channel WhatsApp+Email+FB+IG ingestion, conversation assignment, canned responses, and a dashboard shell — nearly a 1:1 match with your Figma "Conversation" and "Employee" screens. Forking it saves months versus building an inbox from scratch. Your job is then to make each "agent" in Chatwoot's model actually be a LangGraph-powered AI employee instead of a human, triggered via Chatwoot's webhook/automation API.

**Why not Composio:** already flagged — closed-source credential runtime, and a May 2026 breach exposed ~10,242 customer credentials. Nango keeps token storage self-hosted and inspectable.

---

## PART 4 — Phased Build Plan

### Phase 0 — Foundations
- Monorepo structure: `/apps/inbox` (Chatwoot fork), `/apps/agents` (LangGraph services), `/apps/dashboard` (Darex-specific UI), `/services/connectors` (Nango config), `/services/workflows` (Temporal), `/infra` (docker-compose / Terraform)
- Postgres with RLS enabled from the first migration — every table gets `org_id` and a policy, no exceptions
- `BUILD_STATE.md` created
- **Exit criteria:** `docker-compose up` boots Postgres + Temporal + Nango + Langfuse locally, empty but healthy

### Phase 1 — Multi-tenant core
- SuperTokens integration: org creation, user invite, role (owner/admin/agent)
- Onboarding wizard screens (matches Figma: name → team size → business type → channels)
- Org-scoped everything from here on
- **Exit criteria:** a new signup creates an isolated org; two orgs' data never cross in a query, verified with an automated RLS test

### Phase 2 — Connector layer
- Self-host Nango, wire OAuth for: WhatsApp Business (official Meta Cloud API), Gmail, Google Calendar, HubSpot, Razorpay, Meta Ads, Google Ads
- Each connector = a versioned TypeScript function in `/services/connectors`, callable by name from the agent layer
- **Exit criteria:** each integration in the Figma "Integration" page can be connected end-to-end and shows "Connected" + live sync status

### Phase 3 — Conversation ingestion (Chatwoot fork)
- Fork Chatwoot, strip/rebrand UI to match Darex, keep the inbox/channel/conversation data model
- Wire WhatsApp Cloud API + Email as inbound/outbound channels through Chatwoot
- Webhook out of Chatwoot on every new inbound message
- **Exit criteria:** a real WhatsApp message from a test number appears in the inbox and a human can reply manually — no AI yet, just plumbing

### Phase 4 — Agent harness (the AI employees)
- Define LangGraph graphs per role: Sales, Support, Marketing — each with its own prompt, tool allowlist, escalation node
- LiteLLM gateway sits between LangGraph and model providers, with fallback config
- Route Chatwoot's inbound webhook → correct employee's graph → response posted back via Chatwoot API
- **Exit criteria:** a WhatsApp message to a test number gets an AI-generated reply from the correct employee persona, end-to-end

### Phase 5 — Durability (Temporal)
- Wrap each conversation thread in a Temporal workflow (not per-message — per-thread)
- Every tool call (CRM write, refund, booking) becomes a retry-safe, idempotent Activity
- Human-in-the-loop: approval-required actions (discount approval, refund) pause the workflow and surface in "Needs Attention" until a human signals resume
- **Exit criteria:** kill the agent service mid-conversation; on restart, the conversation resumes exactly where it left off, no duplicate or lost messages, verified with a chaos test

### Phase 6 — Memory & RAG
- pgvector schema: `org_memory`, `employee_memory`, `conversation_memory` — each tier scoped by RLS
- Retrieval logic: conversation-level context first, fall back to employee-level, fall back to org-level knowledge base
- Write-back: after each resolved conversation, employee-level memory updates with what was learned (with a cap/decay policy, not unbounded growth)
- **Exit criteria:** a returning customer's context (name, past issue, preferences) is retrieved correctly in a new conversation thread

### Phase 7 — Insight & Analytics engine
- Aggregation service reads across Langfuse traces + Postgres conversation data
- Generates the Insight page cards: Business Health score, Revenue Opportunity, Critical Issues, recommended actions
- This is a scheduled/batch job (not real-time), keep it decoupled from the live conversation path so a slow analytics query never blocks a customer reply
- **Exit criteria:** Insight page populates with real numbers from real conversation data, recommended-action buttons trigger real workflows (e.g., "Start automated follow-up" enqueues a Temporal workflow)

### Phase 8 — Observability, security, scale hardening
- Langfuse wired to every LLM call with org_id tag for per-tenant cost tracking
- Rate limiting per org at the API gateway
- E2B sandboxing wired in only for the "Ask anything" power-user flow if/when custom per-org logic is needed
- Load test: simulate concurrent conversations across multiple orgs, verify no cross-tenant leakage under load, verify Temporal + Postgres connection pooling holds
- **Exit criteria:** documented runbook for on-call, dashboards for latency/error-rate/cost per tenant, a passed load test at target concurrency

### Phase 9 — Polish & launch readiness
- Home page "coming online" progress state wired to real provisioning status (employees created, integrations connected)
- Full onboarding-to-first-AI-reply flow tested with a real new signup, zero manual steps
- **Exit criteria:** a stranger can sign up, connect WhatsApp, and get a working AI employee replying to real customers within the estimated setup window shown on screen

---

## PART 5 — The Agent Prompt (paste this to your coding agent)

```
You are building "Darex" — a multi-tenant AI-employee SaaS platform. Full spec is in this
repo at /docs/darex-ai-employee-platform-build-spec.md. Read it in full before writing any code.

Rules for this entire build:
1. Work phase by phase, in order, exactly as defined in Part 4 of the spec. Do not skip ahead.
2. Before starting any phase, read BUILD_STATE.md at repo root. If it doesn't exist, create it.
3. At the end of every phase, update BUILD_STATE.md with: what was completed, key decisions
   made, any deviation from the spec and why, and what the next phase should start with.
4. Every table you create must include org_id and a corresponding RLS policy. No exceptions,
   no "I'll add it later."
5. Every external side-effect (sending a message, writing to a CRM, charging a payment,
   booking a calendar slot) must be implemented as an idempotent Temporal Activity, not a
   bare API call. If you're tempted to call an API directly from agent code, stop and wrap
   it in an Activity instead.
6. Clone, don't rebuild, for: Chatwoot (inbox/channels), Nango (connectors/OAuth), Temporal
   (workflow engine), Langfuse (tracing). Build fresh for: LangGraph agent definitions,
   Darex-specific dashboard screens, the Insight/analytics engine.
7. Never hardcode a specific AI employee's logic into shared infrastructure code. An employee
   is a config + a LangGraph graph + a tool allowlist — adding a new employee role should
   require zero changes to the connector layer, the durability layer, or the memory layer.
8. After each phase, run and report the exit criteria defined for that phase in the spec
   before moving to the next phase. If exit criteria fail, fix before proceeding — do not
   move on with a known-broken phase.
9. Commit frequently with messages prefixed [Phase N]. Keep commits scoped to one logical
   change each.
10. If you are ever unsure whether something belongs in this build or is out of scope, default
    to the narrowest interpretation of the current phase's exit criteria and note the
    ambiguity in BUILD_STATE.md rather than guessing broadly.

Start now with Phase 0.
```

---

**Next steps for you:** drop this file into your Hermes repo as `/docs/darex-ai-employee-platform-build-spec.md`, then hand the Part 5 prompt to Claude Code in that repo. It'll read the spec, create `BUILD_STATE.md`, and start Phase 0.
