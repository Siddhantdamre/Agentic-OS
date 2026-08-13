# 07 — Agent Engine

The agent engine lives in **`services/workflows`** (workspace package `@darex/workflows`) and the **`atomic-agent`** container. `apps/agents/` is a **legacy placeholder** (LangGraph plan) that is NOT wired into the runtime — ignore it.

## Architecture

```
API routes / webhooks (dashboard)
        │  import @darex/workflows/dist/{workflow-client,atomic-agent-client}
        ▼
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ Temporal worker (darex-worker)│        │ Direct path (no Temporal)     │
│ task queue darex-agent-tasks │        │ runAutonomousAgentDirect()    │
│ AutonomousAgentWorkflow      │        └──────────────┬───────────────┘
└──────────────┬──────────────┘                        │
               ▼                                       │
   activities (runAgentTurnActivity)                   │
               │                                       │
               └──────────► runAgentTurn() ◄───────────┘
                                 │
                                 ▼
                    atomic-agent HTTP :8787
                    /v1/chat/completions (stream)
                                 │
                                 ▼  (calls MCP tools)
                    atomic-bridge MCP SSE :8790/sse
                                 │
                                 ▼
                    executeAutonomousToolAction() (tool-executor)
                                 │
                    Nango OAuth tokens / DB (RLS) / HTTP APIs
```

## Key modules (`services/workflows/src/`)

### `agent-engine.ts` — shared types
- `AgentTaskInput`: `orgId`, `conversationId?`, `channelId?`, `employeeId?`, `employeeName`, `employeeRole`, `employeePersona`, `toolAllowlist`, `userMessage`, `sessionKey?` (caller-scoped session bucket for stateless callers like Ask AI).
- `AgentTaskResult`: `success`, `replyMessage`, `executedSteps[]` (`{step, action, toolUsed?, result, selfCorrected?}`), `usedTools[]`.

### `atomic-agent-client.ts` — the streaming client
- `runAgentTurn(input)`: POSTs to `$ATOMIC_AGENT_URL/v1/chat/completions` with `Authorization: Bearer $ATOMIC_AGENT_API_KEY`, `X-Atomic-Extensions: on`, `stream:true`, and `session_id`.
- **Session id** = `darex:{orgId}:{conversationId | sessionKey | employeeId | chat-YYYYMMDD}` (daily fallback rotation).
- **Prompt construction**:
  - `buildSystemPrompt` — persona/role/system instructions (org_id given; never re-derive).
  - `buildGroundedUserMessage` — **critical**: atomic-agent's OpenAI-compatible handler **drops the `system` role message**, so org facts (org_id, "don't search memory for it") are embedded in the **user** message so they always reach the LLM. This is the fix for the Ask AI hang.
- `readSseStream`: parses SSE events → accumulates `reply`, collects `tool_progress` steps, tracks `session_id`, surfaces `error` events.
- `mapTurnToResult`: turns a `AgentTurnResult` into `AgentTaskResult` (steps + usedTools + reply).
- `runAutonomousAgentDirect`: wraps `runAgentTurn` + `mapTurnToResult`; never throws — returns `{ success:false, replyMessage:'I encountered an issue...' }` on failure.

### `worker.ts` — Temporal worker
- Connects to `$TEMPORAL_ADDRESS` (default localhost:7233), registers `AutonomousAgentWorkflow` + all activities on task queue **`darex-agent-tasks`**, runs forever. Host launcher: `node infra/scripts/worker-launcher.js`.

### `workflows/AutonomousAgentWorkflow.ts` — the workflow
1. `runAgentTurnActivity(input)` (5-min startToClose timeout, retry 3×, backoff 2s).
2. `logChannelActivity({orgId, channelId, logType:'AGENT_EXECUTION', payload})`.
3. `saveMessageActivity({orgId, conversationId, role:'assistant', content, toolCalls})` when `conversationId` present.
4. Returns `AgentTaskResult`.

### `activities/index.ts` — Temporal activities
- `runAgentTurnActivity(input)` → `runAgentTurn` + `mapTurnToResult`.
- `saveMessageActivity(params)` → INSERT into `messages` (RLS-scoped), returns `{messageId}` (or `fallback_<ts>`).
- `logChannelActivity(params)` → INSERT into `channel_logs` with columns `(org_id, channel_type, event_type, status, status_code, message, payload)` — matches the current schema (no `channel_id`/`log_type`).

### `workflow-client.ts` — client side
- `getTemporalClient()`: lazily connects to `$TEMPORAL_ADDRESS`.
- `triggerAutonomousAgentWorkflow(input)`: starts `AutonomousAgentWorkflow` on `darex-agent-tasks`, awaits result. Returns `null` if Temporal is unreachable → callers fall back to direct.

### `mcp-bridge.ts` — the MCP SSE server (container `darex-atomic-bridge`, :8790)
- HTTP server with `GET /sse` (SSEServerTransport per connection) and `POST /messages?sessionId=`.
- **24+ MCP tools** registered (server name `darex-connectors`). Each tool handler calls `executeAutonomousToolAction({tool, action, payload, orgId})` and formats `{status, message, data}` as text content. Rejects missing / non-UUID `org_id`.

### `tool-executor.ts` — the tool dispatcher
Resolves Nango access tokens (`NANGO_HOST`/`NANGO_SECRET_KEY`), then executes per tool:

| Tool (MCP name) | action(s) | Real call |
|---|---|---|
| `whatsapp_send` | send_whatsapp_message | Meta Graph v18.0 `${phoneNumberId}/messages` (channel meta → Nango fallback) |
| `gmail_fetch` / `gmail_send` | fetch_latest_emails / send_email | Gmail API (raw RFC2822 base64url) |
| `calendar_list_events` / `calendar_create_event` | list_events / create_event | Google Calendar v3 (+Google Meet) |
| `github_fetch_repos` / `github_create_repo` | fetch_user_repos / create_repo | GitHub REST |
| `hubspot_create_contact` | create_crm_contact | HubSpot CRM v3 |
| `meta_ads_metrics` | fetch_campaign_metrics | Meta Graph insights (last_7d) |
| `google_ads_metrics` | fetch_campaign_metrics | Google Ads API (GAQL) |
| `slack_send` | send_channel_message | Slack chat.postMessage |
| `notion_create_page` / `notion_search` | create_page / search_workspace_docs | Notion v1 |
| `stripe_create_payment_link` | create_payment_link (or customer) | Stripe payment_links |
| `shopify_fetch_products` / `shopify_fetch_orders` | fetch_products / fetch_orders | Shopify Admin 2024-01 |
| `zendesk_fetch_tickets` / `zendesk_create_ticket` | fetch_tickets / create_support_ticket | Zendesk API v2 |
| `intercom_fetch_conversations` | fetch_conversations | Intercom v2.11 |
| `razorpay_create_payment_link` | create_payment_link | Razorpay (env keys, amount in paise) |
| `web_search` | search | Jina `s.jina.ai` (sends `Bearer $JINA_API_KEY` when set) |
| `web_extract` | extract | Jina Reader `r.jina.ai` (sends `Bearer $JINA_API_KEY` when set) |
| `database_query` | query | **read-only SELECT** against `darex` DB (RLS-scoped, max 25 rows; rejects non-SELECT) |
| `file_ops` | read_file / write_file | workspace_storage dir under `services/workflows` (basename-sanitized) |
| sandbox / code_execution / execute_code | code exec | self-hosted `sandbox` service (`POST /execute`, `SANDBOX_API_URL=http://sandbox:8080`) |

- **Per-org allowlist enforcement:** before any tool runs, `executeAutonomousToolAction` checks the
  tool against the org's effective allowlist = **always-allowed core tools** (`web_search`, `web_extract`,
  `database_query`, `db_query`, `sql_analytics`, `file_ops`, `file_system`, `workspace_file`, `sandbox`,
  `code_execution`, `execute_code`) **∪ union of all active employees' tool_allowlists** **∪ every
  connector the org has connected (`channels`)**. This guarantees tools the org *owns* execute even when
  no single employee names them, while never-connected connectors stay gated. The plan-execute path
  additionally passes an explicit allowlist = the plan's own step tools + core tools.
- **Not-connected handling:** tools without a Nango token return `status:'simulated'` with `{connected:false, setupUrl:'/connectors'}` — they never fake success.
- **`database_query` security:** only `SELECT` allowed; runs under `app.current_org_id` RLS context.

## How agent execution is invoked from the dashboard

- **`/api/ask-ai`**: classifies the prompt (`apps/dashboard/lib/classify.ts`) via **LiteLLM direct**
  (`apps/dashboard/lib/litellm-client.ts`, `reasoning: {enabled:false}`) — not atomic-agent, whose
  agent loop injects the tool grammar and tries to execute tools for what should be a bare JSON tag.
  - `simple` → `runAutonomousAgentDirect` (streaming agent loop). Session key `askai-{user}-{day}-{uuid8}` rotates per request.
  - `complex` → `apps/dashboard/lib/plan-generator.ts` (LiteLLM direct) → persists an `agent_plans` row
    (`status='pending'`) → returns the plan + draft for user approval.
  - `PATCH /api/ask-ai/plan` approves/cancels/toggles steps; `GET /api/ask-ai/execute` streams the
    approved plan step-by-step through `tool-executor.ts` (`execution_start`/`step_start`/`step_done`/`execution_error`/`execution_done`).
  - `POST /api/ask-ai/revise` regenerates a draft from feedback (`reviseDraft`).
- **`/api/agent/run`**: `triggerAutonomousAgentWorkflow` first; if it returns null, `runAutonomousAgentDirect`. Persists user + assistant messages when `conversationId` is given, logs `AGENT_EXECUTION` to `channel_logs`, and traces to Langfuse.
- **`/api/webhooks/whatsapp`**: resolves org → upserts conversation → runs AI (Temporal first, direct fallback) → sends the real reply via Meta → logs inbound/outbound.

## Langfuse tracing

`logLangfuseTrace` in `apps/dashboard/lib/langfuse-trace.ts` POSTs a `trace-create` event to `LANGFUSE_HOST/api/public/ingestion` (Basic auth `pk:sk`). **Note (Langfuse v3):** the `timestamp` field must sit at the **event level**, not inside `body`, or ingestion rejects the batch with 400 (fixed 2026-08-13). Errors surface in logs instead of being swallowed. Traces recorded: `AskAI-AutonomousExecution`, `AskAI-PlanFallback`, `AgentExecution-<name>`, `PlanGenerated`, `PlanExecution-<tool>` (per step), `PlanExecutionSummary`.

## LiteLLM routing for the dashboard

- LiteLLM (`http://litellm:4000/v1`, master key `sk-darex-litellm-dev-key`) owns model failover:
  `atomic-agent` → `deepseek/deepseek-v4-flash-0731` primary, fallbacks `nemotron-3-super-120b:free`
  then `nemotron-3-ultra-550b:free` (`infra/litellm/config.yaml`).
- `apps/dashboard/lib/litellm-client.ts` is used by classify/plan/revise. It sends
  `reasoning: {enabled:false}` — deepseek-v4-flash otherwise burns the token budget on
  `reasoning_content` (empty `content` on small budgets, multi-minute "reasoning" on large ones).

## Troubleshooting

- **Temporal workflow "fetch failed"**: usually a stale atomic-agent↔bridge SSE session. Restart `atomic-agent` + `atomic-bridge` and retry. Fresh runs succeed (verified E2E: answer `52` via `mcp.darex.database_query`).
- **Ask AI hangs**: check the session isn't accumulating (should be `askai-{user}-{day}-{uuid8}`). If the model is looping searching memory for org_id, the grounding in the user message was stripped — don't rely on the system message.
- **Complex prompts return `simple` or hang**: the classifier must reach LiteLLM (check dashboard `NODE_ENV=production` → base URL `http://litellm:4000/v1`). If atomic-agent is being called instead, the tool grammar + parse loop stalls it. Never route classify/plan/revise through atomic-agent.
- **Tool returns `simulated/not connected`**: the org's Nango connection for that provider is missing; authorize at `/connectors` (Nango OAuth). For `database_query`/`web_search`/`web_extract`/`file_ops` no Nango is needed.
- **Gmail `draft_email` 403 insufficient scopes**: the stored token predates `gmail.compose`. Re-connect gmail (disconnect → Connect OAuth on `/connectors`) after `infra/scripts/seed-nango-configs.sql` has updated the config, then retry.
