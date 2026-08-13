# 00 — Status at a glance

Legend:

- **Works** — implemented in code and live-verified (or obviously complete).
- **Works if connected** — real executor exists; needs a live Nango/OAuth/env token.
- **Partial** — UI or API exists but is incomplete, stubbed, or broken in a known way.
- **Does not work** — missing files, unimplemented executor, expired creds, or not started.

## Product surfaces

| Surface | Status | Notes |
|---------|--------|-------|
| Register / login (email+password) | **Works** | SuperTokens, then Postgres `password_hash` fallback |
| Google / GitHub / Meta / Microsoft OAuth | **Partial** | Real token exchange if client IDs set; demo auto-login if `ALLOW_DEMO_AUTH=true` |
| Onboarding wizard (name → team → type → channels) | **Works** | Creates org + channel rows via `POST /api/org/create` |
| Home dashboard KPIs | **Works** | Real SQL from `/api/dashboard/stats` |
| Ask AI — simple Q&A | **Works** | NDJSON stream via atomic-agent |
| Ask AI — complex plan + approve + execute | **Works** | LiteLLM plan → `agent_plans` → SSE execute |
| Conversations inbox | **Works** | Real DB + SSE `needs_attention` |
| Employees CRUD + default roster | **Works** | Auto-seeds Sarah / Emma / Marcus |
| Integrations + Connectors OAuth | **Works if connected** | Nango is source of truth; no fake “connected” |
| Connector test page | **Works if connected** | 7 providers via `@darex/connectors` |
| Analytics page | **Works** | Real aggregates (not Phase 7 engine) |
| Insight page | **Partial** | Rule-based templates, not LLM |
| Settings (rename org) | **Works** | |
| Settings (invite member) | **Partial** | Inserts a user row, no email |
| Settings (webhook URLs) | **Partial** | Meta URL points at Chatwoot route (bug) |

## Agent runtime

| Piece | Status | Notes |
|-------|--------|-------|
| atomic-agent v0.1.73 on `:8787` | **Works** | OpenAI-compatible SSE |
| MCP bridge on `:8790` (49 tools) | **Works** | `mcp.darex.*` → `executeAutonomousToolAction` |
| LiteLLM classify / plan / revise | **Works** | Reasoning disabled; JSON completions |
| Temporal `AutonomousAgentWorkflow` | **Works** | Used by agent/run, WhatsApp, conversations |
| Direct agent fallback | **Works** | Used when Temporal is down; Ask AI always direct |
| Tool allowlist (org union + connected channels) | **Works** | Fixed 2026-08-13 |
| Code sandbox (`code_execution`) | **Partial** | Executor + compose service exist; **`infra/docker/sandbox/` is not in git** |
| Custom skill playbooks (11 SKILL.md) | **Does not work** | Files exist; **not copied into atomic-agent image** |
| Langfuse traces | **Partial** | Ingestion schema fixed; ClickHouse persistence flaky |
| pgvector RAG / org memory | **Does not work** | Extension enabled; Phase 6 not built |
| Billing | **Does not work** | Phase 9 |

## Connectors (agent path = `tool-executor.ts`)

| Connector | Executor | Live if | Blocker |
|-----------|----------|---------|---------|
| Gmail (fetch/triage/OTP/draft/send) | Real | Nango token with `gmail.compose` | Re-connect Gmail for compose scope |
| Google Calendar | Real | Nango | |
| Google Drive / Docs / Sheets | Real | Nango | Drive may still need browser OAuth |
| Google Slides / Forms / Contacts / Tasks | Real | Nango | |
| GitHub | Real | Nango | |
| WhatsApp send | Real | Meta token + phone_number_id | **Token expired 2026-06-12** |
| HubSpot / Slack / Notion / Stripe / Shopify / Zendesk / Intercom | Real | Nango + extra ids | Need real OAuth client IDs in Nango UI |
| Meta Ads / Google Ads | Real | Token + account/customer id | Extra env (`META_AD_ACCOUNT_ID`, Ads developer token) |
| Razorpay | Real | `RAZORPAY_KEY_ID/SECRET` | **Not per-org Nango** |
| web_search / web_extract | Real | `JINA_API_KEY` | Honest error if unset |
| database_query | Real | Always (RLS SELECT) | |
| file_ops | Real | Local `workspace_storage/{orgId}` | |
| sandbox / code_execution | Real HTTP | `SANDBOX_API_URL` | Image context missing from repo |
| Google Analytics `analytics_report` | **Stub** | — | MCP exposed, executor returns unhandled |
| Google Chat / Meet / Search Console / Business / Cloud | **Stub** | — | Listed in UI catalog, no executor |

Disconnected OAuth **never fabricates success**. Tools return `status: 'error'`, `connected: false`, `setupUrl: '/connectors'`.

## Inbound channels

| Path | Status | Notes |
|------|--------|-------|
| WhatsApp GET verify (Meta challenge) | **Works** | `VERIFY_TOKEN` |
| WhatsApp POST inbound → persist → agent → outbound | **Partial** | Inbound+LLM verified; outbound 401 on expired token |
| Chatwoot webhook ingest + HMAC | **Works** | **Does not call the AI agent** |
| Inbox gateway `:3004` inbound proxy | **Works** | Forwards to `/api/webhooks/chatwoot` |
| Inbox gateway outbound `/api/inbox/send` | **Does not work** | Returns `{success:true}` without sending |
| SSE `/api/stream/events` | **Works** | In-process EventEmitter only (one Node process) |

## Infra

| Service | Status |
|---------|--------|
| Postgres 16 + pgvector, 8 migrations, RLS + WITH CHECK | **Works** |
| Temporal + UI | **Works** |
| Redis | **Works** (shared; Langfuse worker timeouts) |
| Nango | **Works** |
| LiteLLM | **Works** |
| SuperTokens | **Works** (app falls back to Postgres if API key mismatch) |
| Langfuse server | **Works** |
| Langfuse worker persistence | **Partial** |
| atomic-agent + atomic-bridge | **Works** |
| dashboard + worker containers | **Works** |
| sandbox container | **Does not work** until `infra/docker/sandbox/` is committed |
| Production Terraform / HTTPS / multi-instance | **Does not work** |

## Verification scripts (last recorded green)

| Script | Last recorded |
|--------|----------------|
| `check-phase0.js` | 17/17 PASS |
| `check-phase2.js` | 17/17 PASS |
| `check-phase3.js` | 6/6 PASS |
| `check-auth-nango.js` | 3/3 PASS |
| `e2e-live-llm.js` | 5/5 inbound+LLM; outbound Meta 401 |

## Phases

| Phase | Code | Meaning |
|-------|------|---------|
| 0 Foundations | Done | Docker + DBs |
| 1 Multi-tenant core | Done | Auth + RLS |
| 2 Connector layer | Done | Nango + test proxy |
| 3 Inbox ingestion | Done | Webhooks + conversations |
| 4 / 4.5 / 4.6 Agent + security + live E2E | Done | atomic-agent, not Hermes |
| 5 Realtime SSE | Done | Single-process hub |
| 6 Memory & RAG | **Not started** | |
| 7 Insight & analytics engine | **Not started** | Pages exist with simpler SQL / templates |
| 8 Scale / Terraform / alerting | **Not started** | |
| 9 Polish, mobile, a11y, billing | **Not started** | Onboarding wizard already exists |
