# 13 — What works (verified from code + BUILD_STATE)

This is the honest “green” list. Live dates are from `BUILD_STATE.md`.

## Platform

- Full Docker stack (minus sandbox context in git): Postgres, Temporal, Redis,
  Nango, Langfuse, SuperTokens, LiteLLM, atomic-agent, MCP bridge, worker,
  dashboard, inbox.
- `pnpm build` green; dashboard / workflows / connectors / inbox typecheck.
- Phase checks last recorded: 0 = 17/17, 2 = 17/17, 3 = 6/6, auth+Nango = 3/3.

## Auth and tenancy

- Register / login with SuperTokens or Postgres scrypt.
- Per-user org (`createOrgForEmail` / `ensureUserOrg`) — not “first org in DB”.
- Session cookie stores `users.id` (not SuperTokens id).
- RLS FORCE + WITH CHECK (migration 008). Isolation test passes.
- Onboarding wizard writes org + channel stubs.

## Ask AI

- Classifier → simple NDJSON stream via atomic-agent (~6s Q&A).
- Classifier → complex plan in `agent_plans` → PlanCard → approve → SSE execute
  with parallel independent steps (~13s).
- Plan failure falls back to direct agent.
- Draft revise via LiteLLM.
- Daily per-user session key (no unbounded poisoned WAL).
- Org grounding in the **user** message (atomic-agent drops `system`).

## Agent runtime

- atomic-agent v0.1.73 SSE `/v1/chat/completions`.
- MCP bridge 49 tools, server name `darex`.
- Temporal `AutonomousAgentWorkflow` → `mcp.darex.database_query` live
  (counts like “1”, “43”, “52”).
- Direct fallback when Temporal is down (most callers).
- Tool allowlist = union of all active employees + connected channels + core
  tools (fixed 2026-08-13; sheets_create and drive_list executed live after).

## Tools live-verified at least once

| Tool | Evidence |
|------|----------|
| `database_query` | Ask AI / Temporal E2E |
| `gmail` fetch | Real emails via Nango |
| `google-docs` `docs_create` | Live |
| `google-sheets` `sheets_create` | Live after allowlist fix |
| `google-drive` `drive_list` | 27 files when connected |
| `web_search` | Passes allowlist; Jina Bearer when key set |
| `code_execution` | python `6*7=42`, node `1+1=2`, bash (when sandbox image present) |

Honest `notConnected` when OAuth missing (GitHub example ~15s, no fake data).

## Inbox and realtime

- Conversations CRUD, human reply, agent on inbound dashboard messages.
- WhatsApp inbound: persist + SSE + agent + channel_log (outbound Graph is
  separate — token expired).
- Chatwoot HMAC ingest.
- SSE `needs_attention` E2E: EventSource `connected` → Chatwoot webhook →
  toast with correct conversationId.

## Integrations

- Nango source of truth; POST connect 400 without a real connection.
- Connection id `{orgId}_{provider}`.
- Gmail scopes include compose; intercom/notion scopes filled.
- WhatsApp BYOK into `channels.meta`.

## Product UI with real data

- Home KPIs from SQL (no hardcoded `99.8%`).
- Employees roster + stats + console.
- Analytics aggregates (automation %, latency, CSAT proxy, 7-day trend).
- Langfuse ingestion schema fixed (event-level `timestamp`, 201 accepted).
