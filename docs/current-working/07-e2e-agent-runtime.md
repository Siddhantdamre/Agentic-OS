# 07 — End-to-end: Agent runtime

Hermes and LangGraph are gone. One loop:

**Caller → (optional Temporal) → atomic-agent `:8787` → MCP `:8790` →
`executeAutonomousToolAction`.**

Ask AI **plan execute** skips atomic-agent and calls the executor per step.

## Package layout (`services/workflows`)

| File | Role |
|------|------|
| `src/worker.ts` | Temporal worker, queue `darex-agent-tasks` |
| `src/workflows/AutonomousAgentWorkflow.ts` | Only workflow |
| `src/activities/index.ts` | `runAgentTurnActivity`, `saveMessageActivity`, `logChannelActivity` |
| `src/workflow-client.ts` | `triggerAutonomousAgentWorkflow`, `startAutonomousAgentWorkflow` |
| `src/atomic-agent-client.ts` | SSE client |
| `src/mcp-bridge.ts` | MCP SSE server |
| `src/tool-executor.ts` | All tool implementations |
| `src/agent-engine.ts` | Shared `AgentTaskInput` / `AgentTaskResult` types only |

`services/workflows/README.md` is stale (still mentions ConversationWorkflow).

## When Temporal vs direct

| Caller | Temporal | Direct fallback |
|--------|----------|-----------------|
| Ask AI simple stream | Never | Always `runAutonomousAgentDirect` |
| Ask AI execute | Never | Direct `executeAutonomousToolAction` |
| `POST /api/agent/run` | First | If Temporal returns null |
| WhatsApp webhook | First | Fire-and-forget after 200 |
| Conversations create / message | `startAutonomousAgentWorkflow` | Persist reply locally |
| `POST /api/agent/stream` | Only | **No fallback** |

## AutonomousAgentWorkflow

1. Activity `runAgentTurnActivity` → `runAgentTurn()` → POST atomic-agent
   `/v1/chat/completions`.
2. atomic-agent runs its own tool loop via MCP.
3. Workflow may loop up to **8** times if `usedTools.length > 0 && !isDone`.
4. Then `logChannelActivity` + `saveMessageActivity`.

Timeouts: 12 min start-to-close, 20 min schedule-to-close, max 2 retries.

**Gap:** `priorToolResults` is written between loops but `runAgentTurn` never
reads it. `isDone` is never set by `mapTurnToResult`. The extra loop is mostly
inert. Idempotency table exists; activities **do not** use it.

## atomic-agent client

Env: `ATOMIC_AGENT_URL` (default `http://localhost:8787`),
`ATOMIC_AGENT_API_KEY`, `ATOMIC_AGENT_MODEL` (`atomic-agent`),
`ATOMIC_AGENT_TIMEOUT_MS` (compose default 300000).

- `stream: true`, `session_id`, `X-Atomic-Extensions: on`.
- Session id: `darex:{orgId}:{conversationId|sessionKey|employeeId|chat-{day}}`.
- **System role is dropped by atomic-agent.** Org id + connected channels are
  duplicated into the user text (`buildGroundedUserMessage`).
- Parses SSE: `tool_progress`, `session_id`, `error`, content deltas.
- `sanitizeAgentReply` unwraps JSON envelopes.

Image: `infra/docker/atomic-agent` from AtomicBot-ai/atomic-agent **v0.1.73**.
Active provider in compose: `darex-litellm` → LiteLLM → OpenRouter.

Memory fabric (profile / notes / recall) is **on** inside atomic-agent.
Embeddings / lessons / procedures are **off**. That is **not** Darex pgvector RAG.

## MCP bridge (`mcp-bridge.ts`)

- Port `ATOMIC_BRIDGE_PORT` default **8790**, bind localhost on host.
- `GET /sse`, `POST /messages?sessionId=`.
- Server name `darex` (hyphen-free so cloud LLM tool names resolve).
- Requires a UUID `org_id` before any side effect.
- 49 tools — full list in [08-tools-catalog.md](./08-tools-catalog.md).

Not on MCP: `sandbox` / `code_execution` / Stripe customer ops (executor-only).

## Custom skills (not live)

11 playbooks under `infra/docker/atomic-agent/custom-skills/`
(gmail, calendar, drive, docs, sheets, notion, sales-crm, payments, ecommerce,
support-tickets, nango-integrations-playbook).

The Dockerfile does **not** COPY them. Runtime uses upstream `starter-skills`
only. Playbooks are repo docs until mounted.

## Employee console

`/employees` embeds `AutonomousActionConsole` → `POST /api/agent/run` with that
employee’s persona + `tool_allowlist`.

`GET /api/agent/tools` returns a static catalog and is **unauthenticated**.
`POST /api/agent/tools` runs one action with session org.

## What works

- Direct Ask AI stream + Temporal E2E (`mcp.darex.database_query` → real count).
- MCP 49-tool surface for implemented executors.
- Allowlist union of employees + connected channels + core tools (fixed 2026-08-13).
- Fallback when Temporal is down (except `/api/agent/stream`).

## What does not

- Workflow multi-turn loop / `priorToolResults` / idempotency keys unused.
- Custom skills not in the image.
- `/api/agent/stream` dies if Temporal is down.
- Sandbox image context missing from git (executor is ready).
