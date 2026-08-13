# 13 — What works (verified from code + BUILD_STATE)

This is the honest “green” list. Live dates are from `BUILD_STATE.md`.

## Platform

- Full Docker stack: Postgres, Temporal, Redis + dedicated Langfuse Redis,
  Nango, Langfuse, SuperTokens, LiteLLM, atomic-agent, MCP bridge, worker,
  dashboard, inbox, sandbox (image context in this working tree).
- `pnpm build` green; dashboard / workflows / connectors / inbox typecheck.
- Phase checks last recorded: 0 = 17/17, 2 = 17/17, 3 = 6/6, auth+Nango = 3/3.

## Auth and tenancy

- Register / login with SuperTokens or Postgres scrypt.
- Per-user org (`createOrgForEmail` / `ensureUserOrg`) — not “first org in DB”.
- Session cookie stores `users.id` (not SuperTokens id).
- RLS FORCE + WITH CHECK (migration 008). Isolation test passes.
- Forgot / reset password and `/invite/[token]` (reachable while signed in).
- Invites via `org_invites`; optional Resend, always a copyable link.
- Body `org_id` rejected on org/settings APIs; webhooks resolve tenant via
  SECURITY DEFINER helpers (migration 010).

## Ask AI

- Classifier → simple NDJSON stream via atomic-agent (~6s Q&A).
- Classifier → complex plan in `agent_plans` → PlanCard → approve → SSE execute
  with parallel independent steps (~13s).
- Plan failure falls back to direct agent.
- Draft revise via LiteLLM.
- Daily per-user session key `askai-{userId}-{YYYYMMDD}` (no unbounded poisoned WAL).
- History in `messages` (`GET /api/ask-ai`); localStorage is a cache.
- Home `/ask-ai?q=` bootstrap; SSE `done` applied on the page.
- Execute 409s completed plans; instruction steps are notes, not tools.
- Org grounding in the **user** message (atomic-agent drops `system`).

## Agent runtime

- atomic-agent v0.1.73 SSE `/v1/chat/completions`.
- MCP bridge 62 tools, server name `darex`, `GET /health`.
- Temporal `AutonomousAgentWorkflow` uses `isDone`, `priorToolResults`, and
  `idempotency_keys` (max 3 durable turns).
- `CrewWorkflow` spawns up to 3 child agent loops, then manager synthesis.
  Explicit `POST /api/agent/crew` only — inbound WhatsApp stays solo.
- Direct fallback when Temporal is down (`/api/agent/run`, `/stream`, `/crew`).
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
  separate — token expired). Signature: `X-Hub-Signature-256`.
- Chatwoot HMAC ingest **and** `fireInboundAgent` (was ingest-only).
- Inbox gateway HMAC; outbound send forwards to `/api/webhooks/outbound`.
- Human agent replies on `/conversations` send back on the channel.
- SSE `needs_attention` E2E: EventSource `connected` → Chatwoot webhook →
  toast with correct conversationId.

## Integrations

- Nango source of truth; POST connect 400 without a real connection.
- Connection id `{orgId}_{provider}`.
- Gmail scopes include compose; intercom/notion scopes filled.
- WhatsApp BYOK Graph-verified into `channels.meta`.
- Razorpay per-org verified keys in `channels.meta` (env fallback).
- Disconnect deletes the Nango connection.
- Test proxy is a read-only ping by default.

## Product UI with real data

- Home KPIs from SQL (no hardcoded `99.8%`).
- Employees roster + stats + console.
- Analytics aggregates (automation %, latency, CSAT proxy, 7-day trend).
- Settings: correct WhatsApp vs Chatwoot webhook URLs.
- Langfuse ingestion schema fixed (event-level `timestamp`, 201 accepted).
- Dashboard `GET /api/health`.
