# 02 — Architecture Overview

Darex is a **multi-tenant AI-employee SaaS**. Each organization gets its own AI employees (personas with tool access and memory) that operate across the org's connected channels (WhatsApp, Gmail, etc.). The product is an owner dashboard where a small business owner configures AI employees, monitors conversations, connects integrations, and "asks" their business anything.

## Big-picture flow

```
Customer message (WhatsApp/Meta, Chatwoot, Email)
        │
        ▼
[inbox gateway :3004]  ──proxy──►  [dashboard /api/webhooks/* :3000]
                                          │
                        ┌─────────────────┼──────────────────┐
                        ▼                 ▼                  ▼
              [conversations+    [channel_logs       [realtimeHub.publish
               messages rows]     audit rows]         → SSE to dashboard UI]
                        │
                        ▼
              AI response path:
              [Temporal worker :7233]  ──(AutonomousAgentWorkflow)──►
                        │
                        ▼
              [atomic-agent :8787]  ──MCP tools──►  [atomic-bridge :8790]  ──► [tool-executor] ──► [Nango OAuth / DB / web]
                        │
                        ▼
              reply persisted + real outbound send (WhatsApp via Meta)
```

## The three agent-execution entry points

1. **`/api/ask-ai`** (dashboard) — org-level "Ask anything". Uses `runAutonomousAgentDirect` (direct, no Temporal). Session key rotates per user per day to prevent session poisoning.
2. **`/api/agent/run`** (dashboard) — per-employee chat. Tries **Temporal first**, falls back to **direct** atomic-agent. Persists user + assistant messages.
3. **`/api/webhooks/whatsapp`** (dashboard) — real inbound WhatsApp. Resolves org from channel meta, upserts conversation, runs the AI (Temporal → direct fallback), sends the real reply back via Meta, logs everything.

## Key architectural decisions (do not regress these)

- **Multi-tenant from day one.** Every core table has `org_id` + RLS policy. The DB pool sets `app.current_org_id` before queries; RLS filters to the tenant.
- **atomic-agent replaces LangGraph.** The runtime agent loop (reasoning + tool dispatch + memory fabric) runs in the pinned **atomic-agent** container (v0.1.72), OpenAI-compatible HTTP API. `apps/agents/` is a **legacy placeholder**; LangGraph was removed from the runtime path.
- **MCP bridge exposes connectors as tools.** `atomic-bridge` runs an MCP SSE server (`/sse` on :8790) exposing 24 `mcp.darex.*` tools. atomic-agent is configured with this server and calls tools with `org_id` in the args.
- **atomic-agent drops the `system` role message.** So org grounding (org_id, don't-search-memory) is embedded in the **user message** (`buildGroundedUserMessage`), never only in the system prompt. Violating this caused the Ask AI hang (model looped searching memory for org_id).
- **SSE realtime works because the dashboard is a single process.** The in-process `EventEmitter` hub (`lib/realtime-hub.ts`) is sufficient for one `next start`; scaling to multiple instances requires a shared bus (Redis pub/sub) — flagged in the roadmap.
- **Session cookie = `users.id` PK**, not the SuperTokens id. All scoped DB access goes through `getScopedClient()`, which resolves the user, ensures an org exists, and sets RLS.

## Service responsibilities

| Component | Container | Responsibility |
|---|---|---|
| Dashboard | `darex-dashboard` (:3000) | Next.js app: auth routes, webhooks, agent run, ask-ai, conversations/integrations/employees APIs, SSE stream, inbox UI |
| Temporal server | `darex-temporal` (:7233) | Durable workflow orchestration |
| Temporal UI | `darex-temporal-ui` (:8233) | Workflow browser |
| Temporal worker | `darex-worker` | Runs `AutonomousAgentWorkflow` + activities (`runAgentTurn`, `saveMessage`, `logChannelActivity`) |
| atomic-agent | `darex-atomic-agent` (:8787) | The LLM agent loop (reasoning, memory, tool calls) |
| atomic-bridge | `darex-atomic-bridge` (:8790) | MCP SSE server exposing connector/DB/web tools |
| Inbox gateway | `darex-inbox` (:3004) | Thin Express proxy: `/webhook/inbound` → dashboard webhook; `/api/inbox/send` stub |
| Nango | `darex-nango` (:3003) | OAuth token store + connector platform |
| SuperTokens | `darex-supertokens` (:3567) | Identity provider (email/password) |
| Postgres | `darex-postgres` (:5432) | Primary store (10 databases; pgvector enabled) |
| Redis | `darex-redis` (:6379) | Queues (Nango, Langfuse) |
| Langfuse (+worker) | `darex-langfuse-server/worker` (:3002) | LLM observability |
| ClickHouse | `darex-langfuse-clickhouse` (:8123/9000) | Langfuse trace storage |
| MinIO | `darex-langfuse-minio` (:9090/9091) | Langfuse S3 event/media uploads |
| LiteLLM | `darex-litellm` (:4000) | Unified LLM gateway (placeholder; atomic-agent talks to providers directly, not through LiteLLM) |

## Port map (host → container)

| Host | Container | Note |
|---|---|---|
| 3000 | dashboard | main app |
| 3002 | langfuse-server | UI+API |
| 3003 | nango-server | API+dashboard |
| 3004 | inbox | gateway |
| 3567 | supertokens | API |
| 4000 | litellm | gateway |
| 5432 | postgres | DB |
| 6379 | redis | cache/queue |
| 7233 | temporal | gRPC |
| 8233 | temporal-ui | UI |
| 8123/9000 | langfuse-clickhouse | HTTP/native |
| 9090/9091 | langfuse-minio | S3/console |
| 8787 | atomic-agent | **127.0.0.1 only** |
| 8790 | atomic-bridge | **127.0.0.1 only** |

## Data & control flow details

- **Webhook org resolution** — Chatwoot: `?org_id=` query OR `Authorization: Bearer <webhook_secret>` (matches `orgs.meta->>'webhook_secret'`) OR `X-Darex-Org-Id` header, with single-tenant fallback. WhatsApp: match channel by `meta->>'phone_number_id'`, then by `meta->>'whatsapp_business_account_id'`, then single-tenant fallback.
- **Webhook auth** — Chatwoot route verifies HMAC-SHA256 signature `x-chatwoot-signature: sha256=<hex>` over the raw body when `CHATWOOT_WEBHOOK_SECRET` is set. WhatsApp route returns 200 unconditionally (Meta retry-storm avoidance) and has a GET verify-token challenge.
- **Agent execution** — `worker` uses `ATOMIC_AGENT_URL=http://atomic-agent:8787`, calls `/v1/chat/completions` with `stream: true`, `X-Atomic-Extensions: on`, and a session id `darex:{org}:{conversationId|sessionKey|employeeId|chat-date}`. Tool-call steps arrive as SSE `tool_progress` events; the client aggregates reply + tools.

## Deployment model

- All services are defined in `infra/docker-compose.yml`. Everything runs locally on one Docker network `darex-net`.
- Images are built from repo-root Dockerfiles; workspace packages (`@darex/connectors`, `@darex/workflows`) are compiled inside the Docker build.
- No production deployment config exists yet (Phase 8 concern). `infra/terraform/` is an empty placeholder.
