# 11 — TrueForge Agent Harness & Runtime Integration

## 1. Overview

Darex integrates **TrueForge** (`v0.2.0-rc.0`) as its high-performance, enterprise-grade autonomous agent harness, modernizing and replacing the external single-tenant `atomic-agent` runtime.

TrueForge provides:
- **True Multi-Tenancy & Header Isolation:** Dynamic per-tenant context propagation over MCP transports, preventing prompt injection attacks and eliminating the requirement for models to hallucinate or manually manage `org_id` values. Tenant HMAC binds `org.user.ts.allowlist` (v2; v1 accepted during rollout); the bridge rejects unsigned sessions per-tool and per-message when `MCP_BRIDGE_SECRET` is set.
- **Durable Session Persistence:** Native PostgreSQL session store with deterministic `darex:{orgId}:{key}` external IDs and automatic model migration.
- **Dynamic Tool Discovery & Execution:** On-demand MCP tool discovery and schema loading (`list_tools`, `get_tool_info`, `call_tool`) supporting the Darex SaaS and business tools (bridge `TOOLS` count is authoritative — docs saying 94 have drifted).
- **Native Context Management & Compaction:** Automated context compaction and large tool response handling, preventing context-window exhaustion during deep tool execution loops. Bridge additionally caps MCP payloads (`MCP_BRIDGE_MAX_RESULT_CHARS`, default 20000).
- **Sub-Second Streaming & Observability:** Real-time token streaming (`model.message.delta`), full tool-result capture into `executedSteps`, surfacing of `approval_required`/`user-input-required` pauses, and `approvalsRequested` in Langfuse traces. atomic-agent was decommissioned — there is no legacy fallback.

---

## 2. System Architecture & Topology

```
┌─────────────────────────────────────────────────────────────┐
│                 Darex Next.js Dashboard                     │
│                (Port 3000 / apps/dashboard)                 │
│                                                             │
│   POST /api/ask-ai      POST /api/agent/run      Webhooks   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Darex Workflows Runtime                   │
│                    (services/workflows)                     │
│                                                             │
│   runAutonomousAgentDirect()  ──►  runAgentTurn()           │
│                      (pure TrueForge; no fallback)          │
└─────────────────────────────────────────────────────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      TrueForge Server                       │
│              (in-compose `trueforge`:8790)                  │
│                                                             │
│   - POST /api/internal/sessions/get-or-create-by-external-id│
│   - POST /api/v1/sessions/:id/turns (SSE streaming)         │
│   - Header Forwarding: x-org-id & x-tfg-mcp-headers         │
│   - Model: openrouter/gemini-2-5-flash                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
            Tool execution over SSE MCP Transport
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Darex MCP SSE Bridge                      │
│                  (Port 8790 / container)                    │
│                                                             │
│   - Server: http://0.0.0.0:8790/sse                         │
│   - Resolves tenant org_id from transport headers           │
│   - Executes 94 Darex tools with Postgres RLS & Nango OAuth │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Key Components

### 3.1 Darex MCP Bridge (`services/workflows/src/mcp-bridge.ts`)
- **Transport Security:** Exposes the SSE server on `http://127.0.0.1:8790/sse`.
- **Tenant Context Extraction:** Parses `x-org-id` and `x-tfg-mcp-headers` from incoming HTTP connection and message headers via `parseTenantHeaders()`.
- **Optional `org_id` in Schemas:** Makes `org_id` optional in tool schemas so LLMs are never forced to supply org identifiers; the bridge automatically supplies the verified session tenant from transport headers.
- **Row-Level Security Enforcement:** Passes the verified `orgId` to `executeAutonomousToolAction`, strictly enforcing Postgres RLS policies.

### 3.2 TrueForge Standalone Header Forwarding (`packages/trueforge`)
- Enhanced `McpServerWithAuthStore` and `main.ts` in TrueForge to accept `perServerHeaders` in standalone mode.
- Incoming turn headers (`x-tfg-mcp-headers`) are mapped directly to outbound MCP client connections (`darex`), preserving tenant identity without requiring external cloud auth.

### 3.3 TrueForge Client Adapter (`services/workflows/src/trueforge-client.ts`)
- **Session Mapping:** Converts task input (`conversationId`, `sessionKey`, `employeeId`) into durable external IDs formatted as `darex:${orgId}:${baseKey}`.
- **Self-Healing Model Migration:** Checks existing sessions returned by `/api/internal/sessions/get-or-create-by-external-id`. If an existing session is pinned to a deprecated model, it is automatically purged and recreated with the active `TRUEFORGE_MODEL`.
- **Pre-Prompt Memory Grounding:** Calls `retrieveMemory()` to enrich user queries with relevant tenant facts before submission.
- **SSE Stream Translation:** Translates TrueForge `model.message.delta`, `tool.response`, and `turn.done` events into Darex NDJSON `chunk` and `done` events.

---

## 4. Configuration & Environment Variables

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `TRUEFORGE_URL` | `http://trueforge:8790` (compose)<br>`http://127.0.0.1:8791` (host override) | Base URL for TrueForge API server (in-compose service since 2026-09-14). |
| `COGNEE_URL` | `http://cognee:8000` (compose)<br>`http://127.0.0.1:8000` (host override) | Base URL for Cognee memory server (in-compose service since 2026-09-14). |
| `TRUEFORGE_MODEL` | `openrouter/gemini-2-5-flash` | Model identifier in TrueForge model provider catalog. |
| `TRUEFORGE_TIMEOUT_MS`| `180000` | Turn execution timeout in milliseconds. |

---

## 5. End-to-End Verification

The harness is verified by `infra/scripts/test-trueforge-harness.js`:

```bash
node --env-file=.env infra/scripts/test-trueforge-harness.js
```

### Verified Scenarios:
1. **Direct Turn:** `runAgentTurn` invokes TrueForge, receives streaming token deltas (`model.message.delta`), and completes with zero hallucinations.
2. **Tool Execution:** Tool calls (`web_search`, `database_query`) execute through the MCP bridge with verified `org_id` context and return authentic status.
3. **Ask AI Streaming:** Dashboard `POST /api/ask-ai` executes through TrueForge and streams NDJSON events (`type: 'chunk'` and `type: 'done'`) to the client.

---

## 6. Execution Hands & Zero-API OSINT Architecture

### 6.1 Containerized Isolated Sandbox (`services/workflows/src/tools/sandbox.ts`)
- **Container Environment:** The `darex-sandbox` service provides safe execution of untrusted scripts without outbound network or host filesystem access.
- **Dynamic Endpoints:** Configured via `SANDBOX_API_URL` (default `http://127.0.0.1:8080` on host, `http://darex-sandbox:8080` within docker). No hardcoded container IPs.
- **Available Tool Hands:**
  - `terminal_run_command` / `bash_execute`: Runs shell pipelines equipped with `curl`, `jq`, and `bc`.
  - `python_execute`: Runs Python 3 scripts for mathematical algorithms, statistics, and data transformation.
- **Verification Scripts:** `infra/scripts/test-terminal-hands.js` and `infra/scripts/test-agent-hands-e2e.js`.

### 6.2 Zero-API OSINT & Scraping Resiliency (`web-search.ts` & `web-extract.ts`)
- **DuckDuckGo Anti-Bot Handling:** When DuckDuckGo returns anti-bot challenges, the system automatically pivots to zero-API Google News HTML extraction before Wikipedia fallback, guaranteeing live web data retrieval without paid API subscriptions.
- **SSRF Hardening:** `web_extract` enforces `isSafePublicUrl`, denying requests targeting loopback addresses (`127.0.0.1`, `localhost`), private RFC-1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), or cloud metadata IPs (`169.254.169.254`).

---

## 7. Executive Visual Trajectory (`AgentTrajectory.tsx`)

Execution states and tool calls are rendered in real time using Darex's warm executive light design system:
- **Categorized Tool Icons:** Dynamic Lucide icons (`Terminal`, `Code2`, `Search`, `Globe`, `Database`, `Mail`, `Calendar`, `Users`, `Folder`, `Bot`) replace generic icons.
- **Human-Readable Action Names:** Replaces raw snake_case technical identifiers (`terminal_run_command`) with clean titles (*"Terminal Command"*, *"Web Search"*).
- **Extracted Result Summaries:** `parseStepSummary` extracts human-readable output snippets (`✅ Found 5 live web results...`, `12 rows returned`, `Executed in container: exit code 0`) directly beneath step titles.
- **Collapsible Formatted Payloads:** Expandable `JsonBlock` viewer pretty-prints structured JSON with syntax indentation and one-click clipboard copying.

