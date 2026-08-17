# 13 — What works (verified from code + commits)

This is the honest “green” list. **Last sync:** 2026-08-14 (commit `334b52c`).

Recent additions (past 20 commits):
- Zoho CRM, Leegality, QuickBooks executors
- Real estate features (listings, showings, rent reminders, live eval)
- Public chat widget with hashed site keys
- Multiple inbound channels (Gmail, Instagram, SMS, owner WhatsApp)
- RBAC + role assignment
- Audit logs for all mutations
- DSR (export/delete personal data)
- Billing subscriptions, meters, checkout, webhook
- SSO staging config for GitHub / Google
- HITL (Human-in-Loop) gate on inbound send/pay/sign
- Memory RAG workflows (ingest, embed, retrieve, write-back)

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

- atomic-agent v0.1.72 SSE `/v1/chat/completions`.
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
| `database_query` | Ask AI / Temporal E2E; SELECT via RLS |
| `gmail` fetch / compose / send | Real emails via Nango (requires compose scope) |
| `google-docs` create / append / read | Live Nango integration |
| `google-sheets` create / append / read | Live Nango integration after allowlist fix |
| `google-drive` list / upload / download | 27+ files, real Nango |
| `google-calendar` create / list | Nango |
| `web_search` | Jina Bearer when key set; honest error when missing |
| `web_extract` | Jina scraper for URLs |
| `code_execution` (python) | 6*7=42 verified |
| `code_execution` (node) | 1+1=2 verified |
| `code_execution` (bash) | When sandbox image built |
| `github` create repo / push / PR | Real GitHub via Nango |
| `zoho_crm` query / create | Real Zoho via Nango |
| `quickbooks` sync invoices / POs | Real QBO via Nango |
| `leegality` create contract | Real Leegality API |
| `whatsapp` send message | Until token expired 2026-06-12 |
| `instagram` send DM | Via Meta Graph SDK |
| `file_ops` read / write / list | Local `workspace_storage/{orgId}` |
| `database_list_tables` | SELECT from `information_schema` |
| `analytics_report` | Google Analytics via Nango |

Honest `notConnected` when OAuth missing. No synthetic data.

## Inbox and realtime

- Conversations CRUD, human reply, agent on inbound dashboard messages.
- WhatsApp inbound: persist + SSE + agent + channel_log (outbound Graph is
  separate — token expired). Signature: `X-Hub-Signature-256`.
- Chatwoot HMAC ingest **and** `fireInboundAgent` (was ingest-only).
- Inbox gateway HMAC; outbound send forwards to `/api/webhooks/outbound`.
- Human agent replies on `/conversations` send back on the channel.
- SSE `needs_attention` E2E: EventSource `connected` → Chatwoot webhook →
  toast with correct conversationId.

## Integrations and OAuth

- Nango source of truth; POST connect 400 without a real connection.
- Connection id `{orgId}_{provider}`.
- Gmail scopes include compose; Intercom, Notion, Zendesk scopes filled.
- WhatsApp BYOK Graph-verified into `channels.meta`.
- Zoho CRM RBAC scopes enforced (Contacts, Deals, Accounts, Activities).
- QuickBooks realm id stored per-org; auto-refresh on token expiry.
- Razorpay per-org verified keys in `channels.meta` (env fallback).
- Leegality API key in `channels.meta` for contract generation.
- Disconnect deletes the Nango connection + channel config.
- Test proxy is a read-only ping by default.
- SSO staging config (GitHub / Google separate OAuth apps for non-prod).

## Product UI with real data

- Home KPIs from SQL (no hardcoded `99.8%`).
- Employees roster + stats + console (can reply on conversations).
- Listings page (real estate): SQL aggregates + filters + details view.
- RE showings: scheduled Temporal workflows, email reminders.
- Rent reminders: per-tenant follow-up automation.
- Live listing evals: agent analysis per listing with LLM.
- Conversations: inbound + human reply + agent + channel log + needs_attention.
- Analytics: real aggregates (automation %, latency, CSAT proxy, 7-day trend).
- Integrations: Nango + test proxy; honest `notConnected` if OAuth missing.
- Connectors test: real-time 7-provider test calls.
- Settings: correct WhatsApp vs Chatwoot webhook URLs; invite links.
- Billing dashboard: subscriptions + meters + checkout flow.
- Langfuse ingestion schema fixed (event-level `timestamp`, 201 accepted).
- Dashboard `GET /api/health`.

## Security & compliance

- Per-org RBAC: roles in `org_members.role` (owner, editor, viewer).
- Audit logs: all mutations via `recordAuditLog` + `audit_logs` table.
- DSR (Data Subject Request): export all personal data + delete + cascade.
- HITL gate: inbound send/pay/sign require human approval before tools execute.
- Encrypted org credentials: `channels.meta` (AES-256 in Postgres).
- RLS FORCE + WITH CHECK: no org data leaks across tenants.
- Session cookie: `darex_session` = `users.id`, httpOnly, secure in prod.

## Real estate domain

- Listings CRUD: address, property type, status, price, agent notes.
- Showings: date/time scheduling + agent attendance tracking.
- Rental flow: tenant inquiry → matching properties → rent calculation → contract.
- Live eval: agent runs analysis (market comp, risk, ROI) per listing.
- SMS / email inbound: coordinate showings, answer questions.
- Temporal workflows: scheduled tasks (daily digest, follow-up, reminder).

## Memory & RAG

- pgvector tables: org-scoped embeddings + retrieval.
- RAG ingest workflow: documents → chunks → embeddings → Postgres.
- Retrieve: context-aware search on org memory before planning.
- Write-back: agent learning stored as org facts (low-confidence marked).
- M6 live eval: org memory quality metrics (hit rate, relevance).

## Billing

- Subscriptions: monthly/annual plans per org.
- Meters: usage-based add-ons (agent turns, messages, integrations).
- Checkout: Stripe / Darex PSP integration.
- Webhook: subscription events + meter updates.
- Invoice: PDF generation + email.
- Portal: self-serve manage subscription + payment method.
