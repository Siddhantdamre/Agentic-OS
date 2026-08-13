# 01 — System overview

Darex (“brain of the organization”) is a **multi-tenant AI-employee platform**.
Each signed-in user gets their own org. AI employees (Sarah / Emma / Marcus by
default) answer questions and run tools on that org’s connected apps.

Runtime is **not** LangGraph or Hermes. The live loop is:

**atomic-agent (v0.1.73)** → **MCP bridge** (`mcp.darex.*`) → **`tool-executor.ts`**
→ real provider APIs / Postgres / Jina / sandbox.

## Monorepo

pnpm workspaces + Turbo. Root `package.json` workspaces: `apps/*`, `services/*`,
`packages/*`.

```
Agentic-Os-SaaS/
├── apps/dashboard          @darex/dashboard   Next.js 14 (UI + all API routes)
├── apps/inbox              @darex/inbox       Express Chatwoot webhook proxy :3004
├── services/workflows      @darex/workflows   Temporal worker, MCP bridge, tool executor
├── services/connectors     @darex/connectors  Nango SDK wrappers (test proxy only)
├── packages/shared-types   placeholder README only
└── infra/                  docker-compose, migrations, LiteLLM, atomic-agent image
```

**Not in the tree:** `apps/agents/` (old LangGraph plan). Do not rebuild it.

## Runtime pieces (what talks to what)

| Piece | Package / service | Job |
|-------|-------------------|-----|
| Dashboard UI | `apps/dashboard/app/(dashboard)` | Pages: Home, Ask AI, Conversations, Employees, Insight, Analytics, Integrations, Connectors, Settings |
| Dashboard API | `apps/dashboard/app/api` | Auth, Ask AI, agents, webhooks, CRUD |
| Classifier / planner | `apps/dashboard/lib/classify.ts`, `plan-generator.ts` | LiteLLM JSON (not the agent loop) |
| LLM gateway | `darex-litellm` `:4000` | OpenRouter `deepseek-chat` as alias `atomic-agent` |
| Agent loop | `darex-atomic-agent` `:8787` | Multi-step tool calling via MCP |
| MCP bridge | `darex-atomic-bridge` `:8790` | 62 tools → `executeAutonomousToolAction` |
| Tool executor | `services/workflows/src/tool-executor.ts` | Real HTTP + Nango tokens + allowlist |
| Temporal | `darex-temporal` `:7233` + `darex-worker` | Durable wrapper (up to 3 turns) |
| Auth | SuperTokens `:3567` + Postgres fallback | Session cookie `darex_session` = `users.id` |
| OAuth vault | Nango `:3003` | Connection id `{orgId}_{provider}` |
| Traces | Langfuse `:3002` | Ask AI + plan + agent turns |
| DB | Postgres `:5432` db `darex` | RLS on every tenant table |
| Inbox gateway | `darex-inbox` `:3004` | Forwards Chatwoot payloads to dashboard |

## Two agent invocation styles

1. **Ask AI simple** — dashboard streams NDJSON from `runAutonomousAgentDirect`
   (no Temporal). atomic-agent decides tools via MCP.
2. **Ask AI complex** — LiteLLM writes a plan into `agent_plans`. Human approves.
   `GET /api/ask-ai/execute` runs each step with `executeAutonomousToolAction`
   **directly** (bypasses atomic-agent). Independent steps run in parallel.
3. **Inbound / employee console** — try Temporal `AutonomousAgentWorkflow`, fall
   back to `runAutonomousAgentDirect`.

## House rules encoded in code

1. **Tenancy:** never trust `org_id` from a request body. Resolve from session
   (`getScopedClient` → `users.org_id`) then `SET app.current_org_id`.
2. **Webhooks:** return 200 first; never await the LLM inline.
3. **Pool:** release the DB client before opening SSE / long LLM calls.
4. **Honesty:** missing OAuth → `connected: false` + `/connectors`, never fake data.
5. **Env-only secrets:** no hardcoded keys in shipped source.
6. **atomic-agent drops `system` role** — org facts go in the **user** message
   (`buildGroundedUserMessage`).

## What this is not

- Not a Chatwoot fork. `apps/inbox` is a thin Express proxy (README is stale).
- Not Hermes / LangGraph. Those files were deleted.
- Not a full RAG product. `pgvector` is enabled; no embeddings pipeline yet.
- Not multi-instance. Realtime hub is in-memory in one Next.js process.
