# apps/agents — LangGraph AI Employee Services (Phase 4)

This directory contains the core AI-employee agent harness — **Darex's primary IP**.

**Status:** Placeholder. Populated in **Phase 4**.

## What goes here
- LangGraph graph definitions per employee role (Sales, Support, Marketing)
- Tool definitions + tool registry (org-scoped, employee-scoped allowlists)
- LiteLLM gateway client wrapper
- Agent orchestrator: routes Chatwoot webhook events → correct employee graph → posts reply
- Escalation logic: when to pause and surface in "Needs Attention"

## Design constraints (from spec Rule 7)
> An employee is a config + a LangGraph graph + a tool allowlist.
> Adding a new employee role requires **zero changes** to the connector, durability, or memory layer.

## Directory structure (Phase 4)
```
apps/agents/
  src/
    employees/
      sales/       → SalesAgent LangGraph graph
      support/     → SupportAgent LangGraph graph
      marketing/   → MarketingAgent LangGraph graph
    tools/
      registry.ts  → tool name → tool function mapping
      crm.ts       → HubSpot tools (wrapped in Temporal activities)
      calendar.ts  → Google Calendar tools
      payments.ts  → Razorpay tools
    orchestrator/
      router.ts    → webhook → employee selection → graph invocation
    llm/
      client.ts    → LiteLLM wrapper with org_id tagging
  package.json
  tsconfig.json
```
