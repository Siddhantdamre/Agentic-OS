# 07 — End-to-end: Agent runtime

Hermes and LangGraph are gone. One loop:

**Caller → (optional Temporal) → atomic-agent `:8787` → MCP `:8790` →
`executeAutonomousToolAction`.**

Ask AI **plan execute** skips atomic-agent and calls the executor per step.

## Package layout (`services/workflows`)

| File | Role |
|------|------|
| `src/worker.ts` | Temporal worker, queue `darex-agent-tasks` |
| `src/workflows/AutonomousAgentWorkflow.ts` | Solo durable wrapper |
| `src/workflows/CrewWorkflow.ts` | Parallel child spawns (cap 3) + manager synthesis |
| `src/workflows/index.ts` | Worker bundle entry (both workflows) |
| `src/activities/index.ts` | `runAgentTurnActivity`, `saveMessageActivity`, `logChannelActivity` |
| `src/workflow-client.ts` | `triggerAutonomousAgentWorkflow`, `triggerCrewWorkflow` |
| `src/crew-runner.ts` | Direct parallel spawn when Temporal is down |
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
| `POST /api/agent/crew` | `CrewWorkflow` first | `runCrewDirect` if Temporal returns null |
| WhatsApp / Chatwoot webhooks | First (`fireInboundAgent`) | Fire-and-forget after 200. **Always solo.** |
| Conversations create / message | `startAutonomousAgentWorkflow` | Persist reply locally |
| `POST /api/agent/stream` | First | Direct SSE if Temporal is down |

## AutonomousAgentWorkflow

1. Activity `runAgentTurnActivity` → `runAgentTurn()` → POST atomic-agent
   `/v1/chat/completions`.
2. atomic-agent runs its own tool loop via MCP.
3. Workflow may loop up to **3** durable turns (`isDone` / `priorToolResults`).
4. Then `logChannelActivity` + `saveMessageActivity`.

Timeouts: 12 min start-to-close, 20 min schedule-to-close, max 2 retries.
Activities use `idempotency_keys`. `isDone` and `priorToolResults` are wired
(max 3 durable turns). Worker reconnects with backoff 2s–30s.

## CrewWorkflow

Explicit spawn only (`POST /api/agent/crew`). Planner is LiteLLM JSON with a
heuristic fallback. Greetings stay solo. Fan-out is capped at **3** child
`AutonomousAgentWorkflow`s, each with its own `sessionKey` and that employee's
tool allowlist (plus core tools). Manager synthesis combines reports. Direct
fallback: `runCrewDirect`. WhatsApp/Chatwoot inbound never calls this.

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

Image: `infra/docker/atomic-agent` from AtomicBot-ai/atomic-agent **v0.1.72**.
Active provider in compose: `darex-litellm` → LiteLLM → OpenRouter.

Memory fabric (profile / notes / recall) is **on** inside atomic-agent.
Embeddings / lessons / procedures are **off**. That is **not** Darex pgvector RAG.

## MCP bridge (`mcp-bridge.ts`)

- Port `ATOMIC_BRIDGE_PORT` default **8790**, bind localhost on host.
- `GET /sse`, `POST /messages?sessionId=`.
- Server name `darex` (hyphen-free so cloud LLM tool names resolve).
- Requires a UUID `org_id` before any side effect.
- 62 tools — full list in [08-tools-catalog.md](./08-tools-catalog.md).
- `GET /health` (and `/`) for liveness.

Not on MCP historically: sandbox was executor-only. **`code_execution` is now
on MCP.** Stripe customer create/get and Intercom reply/create are on MCP.

## Custom skills (in the image)

11 playbooks under `infra/docker/atomic-agent/custom-skills/`
(gmail, calendar, drive, docs, sheets, notion, sales-crm, payments, ecommerce,
support-tickets, nango-integrations-playbook).

The Dockerfile **COPY**s them into `starter-skills`. Rebuild the atomic-agent
image after changing playbooks.

## Employee console

`/employees` embeds `AutonomousActionConsole` → `POST /api/agent/run` with that
employee’s persona + `tool_allowlist`.

`GET /api/agent/tools` returns the catalog and **requires a session**.
`POST /api/agent/tools` runs one action with session org.

## What works

- Direct Ask AI stream + Temporal E2E (`mcp.darex.database_query` → real count).
- MCP 62-tool surface for implemented executors.
- Allowlist union of employees + connected channels + core tools (fixed 2026-08-13).
- Fallback when Temporal is down, including `/api/agent/stream`.

## What does not

- Custom skills require an image rebuild after playbook edits.
- Sandbox needs the compose image built from `infra/docker/sandbox/`.
- Realtime still one Next.js process.
