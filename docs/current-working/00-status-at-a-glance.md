# 00 — Status at a glance

**Last updated:** 2026-08-14 (commit `334b52c`)

Legend:

- **Works** — implemented in code and live-verified (or obviously complete).
- **Works if connected** — real executor exists; needs a live Nango/OAuth/env token.
- **Partial** — UI or API exists but is incomplete, stubbed, or broken in a known way.
- **Does not work** — missing files, unimplemented executor, expired creds, or not started.

## Shipping history (most recent 5 commits)

```
334b52c fix: guard undefined tool/action in ask-ai execute against required string params
ac040d9 docs: mark shipped workstreams and remaining ops-blocked gaps.
ba47fa9 feat: add RE showings, rent reminders, and live listing evals.
2466a1b feat: add org SQL connection migration and credential encryption.
23ace99 feat: wire Darex billing and SSO staging config.
```

## Product surfaces


| Surface                                           | Status                 | Notes                                                                            |
| ------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| Register / login (email+password)                 | **Works**              | SuperTokens, then Postgres `password_hash` fallback                              |
| Google / GitHub / Meta / Microsoft OAuth          | **Partial**            | Real token exchange if client IDs set; demo auto-login if `ALLOW_DEMO_AUTH=true` |
| Onboarding wizard (name → team → type → channels) | **Works**              | Creates org + channel rows via `POST /api/org/create`                            |
| Home dashboard KPIs                               | **Works**              | Real SQL from `/api/dashboard/stats`                                             |
| Ask AI — simple Q&A                               | **Works**              | NDJSON stream via atomic-agent                                                   |
| Ask AI — complex plan + approve + execute         | **Works**              | LiteLLM plan → `agent_plans` → SSE execute                                       |
| Conversations inbox                               | **Works**              | Real DB + SSE `needs_attention`                                                  |
| Employees CRUD + default roster                   | **Works**              | Auto-seeds Sarah / Emma / Marcus                                                 |
| Integrations + Connectors OAuth                   | **Works if connected** | Nango is source of truth; no fake “connected”                                    |
| Connector test page                               | **Works if connected** | 7 providers via `@darex/connectors`                                              |
| Analytics page                                    | **Works**              | Real aggregates (not Phase 7 engine)                                             |
| Insight page                                      | **Partial**            | Rule-based templates, not LLM                                                    |
| Settings (rename org)                             | **Works**              |                                                                                  |
| Settings (invite member)                          | **Works**              | `org_invites` + copyable link; Resend if `RESEND_API_KEY` set                    |
| Settings (webhook URLs)                           | **Works**              | Meta → `/api/webhooks/whatsapp`; Chatwoot → `/api/webhooks/chatwoot?org_id=`     |
| Forgot / reset password, invite accept            | **Works**              | Reachable while signed in; OAuth keeps `?invite=`                                |
| Public chat widget (embed)                         | **Works**              | Hashed site keys, `<script>` embed                                               |
| Listings page (real estate)                        | **Works**              | SQL aggregates, no synthetic data                                                |
| RE showings + rent reminders                       | **Works**              | Scheduled Temporal workflows                                                     |
| Live listing evals                                 | **Works**              | Agent-run analysis per listing                                                   |
| Billing subscriptions / meters / checkout          | **Partial**            | Darex PSP keys wired; webhook ingestion live                                     |
| SSO staging config (Github / Google)               | **Works**              | Separate oauth apps for staging                                                  |
| HITL (Human-in-loop) for inbound                   | **Works**              | Gate on inbound send/pay/sign before tools run                                   |




## Agent runtime


| Piece                                           | Status                 | Notes                                                                   |
| ----------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| atomic-agent v0.1.72 on `:8787`                 | **Works**              | OpenAI-compatible SSE                                                   |
| MCP bridge on `:8790` (62 tools)                | **Works**              | `mcp.darex.`* + `GET /health`                                           |
| LiteLLM classify / plan / revise                | **Works**              | Reasoning disabled; JSON completions                                    |
| Temporal `AutonomousAgentWorkflow`              | **Works**              | Used by agent/run, WhatsApp, conversations                              |
| Temporal `CrewWorkflow`                         | **Works**              | Explicit `POST /api/agent/crew`; child spawns cap 3; inbound stays solo |
| Direct agent fallback                           | **Works**              | Used when Temporal is down; Ask AI always direct                        |
| Tool allowlist (org union + connected channels) | **Works**              | Fixed 2026-08-13                                                        |
| Code sandbox (`code_execution`)                 | **Works if connected** | `infra/docker/sandbox/` restored in this tree; needs compose build      |
| Custom skill playbooks (11 SKILL.md)            | **Works**              | Dockerfile COPY into `starter-skills` (rebuild atomic-agent image)      |
| Langfuse traces                                 | **Partial**            | Ingestion schema fixed; ClickHouse persistence flaky                    |
| pgvector RAG / org memory                       | **Partial**            | Tables + retrieve + /brain; M6 live eval + inbound activity gap |
| Billing                                         | **Partial**            | `/billing` APIs; Darex PSP keys                                 |




## Connectors (agent path = `tool-executor.ts`)


| Connector                                                        | Executor  | Live if                                         | Blocker                                                 |
| ---------------------------------------------------------------- | --------- | ----------------------------------------------- | ------------------------------------------------------- |
| Gmail (fetch/triage/OTP/draft/send)                              | Real      | Nango token with `gmail.compose`                | Re-connect Gmail for compose scope                      |
| Google Calendar                                                  | Real      | Nango                                           |                                                         |
| Google Drive / Docs / Sheets                                     | Real      | Nango                                           | Drive may still need browser OAuth                      |
| Google Slides / Forms / Contacts / Tasks                         | Real      | Nango                                           |                                                         |
| GitHub                                                           | Real      | Nango                                           |                                                         |
| WhatsApp send                                                    | Real      | Meta token + phone_number_id                    | **Token expired 2026-06-12**                            |
| HubSpot / Slack / Notion / Stripe / Shopify / Zendesk / Intercom | Real      | Nango + extra ids                               | Need real OAuth client IDs in Nango UI                  |
| Meta Ads / Google Ads                                            | Real      | Token + account/customer id                     | Extra env (`META_AD_ACCOUNT_ID`, Ads developer token)   |
| Razorpay                                                         | Real      | Per-org `channels.meta` then env                | Empty keys → `notConnected`                             |
| Zoho CRM                                                         | Real      | Nango + OAuth                                   | RBAC scopes enforced                                     |
| Leegality (legal docs)                                           | Real      | API key via env / channel config                | Real estate contracts                                    |
| QuickBooks Online                                                | Real      | Nango OAuth + realm id                          | Sync invoices + POs                                      |
| web_search / web_extract                                         | Real      | `JINA_API_KEY`                                  | Honest error if unset                                   |
| database_query                                                   | Real      | Always (RLS SELECT)                             |                                                         |
| file_ops                                                         | Real      | Local `workspace_storage/{orgId}`               |                                                         |
| sandbox / code_execution                                         | Real HTTP | `SANDBOX_API_URL`                               | Image context in working tree (`infra/docker/sandbox/`) |
| Google Analytics `analytics_report`                              | Real      | Nango + `propertyId`                            |                                                         |
| Google Chat / Meet / Search Console / Business / Cloud           | Real      | Nango OAuth (Cloud uses `cloud-platform` scope) | Honest `notConnected` if no token                       |


Disconnected OAuth **never fabricates success**. Tools return `status: 'error'`, `connected: false`, `setupUrl: '/connectors'`.

## Inbound channels


| Path                                               | Status      | Notes                                                     |
| -------------------------------------------------- | ----------- | --------------------------------------------------------- |
| WhatsApp GET verify (Meta challenge)               | **Works**   | `VERIFY_TOKEN`                                            |
| WhatsApp POST inbound → persist → agent → outbound | **Partial** | Inbound+LLM verified; outbound 401 on expired token       |
| WhatsApp (owner account)                           | **Works**   | Alternative to customer-facing channel                    |
| Gmail inbound (via Nango OAuth)                    | **Works**   | Fetch + triage; persistent Nango token                    |
| Instagram DMs (Facebook Graph)                     | **Works**   | Via Meta SDK; same token as WhatsApp                      |
| SMS (Twilio / Plivo)                               | **Works**   | Route inbound to `/api/webhooks/sms`                      |
| Chatwoot webhook ingest + HMAC                     | **Works**   | Persist → 200 → `fireInboundAgent` (Temporal then direct) |
| Inbox gateway `:3004` inbound proxy                | **Works**   | HMAC-signs and forwards to `/api/webhooks/chatwoot`       |
| Inbox gateway outbound `/api/inbox/send`           | **Works**   | Forwards to `/api/webhooks/outbound` → channel send-back  |
| SSE `/api/stream/events`                           | **Works**   | In-process EventEmitter only (one Node process)           |




## Infra


| Service                                                           | Status                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Postgres 16 + pgvector, 14 migrations (001–014), RLS + WITH CHECK | **Works**                                                                      |
| Temporal + UI + Workflows (12+)                                   | **Works**                                                                      |
| Redis (sessions + rate limit)                                     | **Works**                                                                      |
| Nango OAuth vault                                                 | **Works**                                                                      |
| LiteLLM (classify + plan + revise)                                | **Works**                                                                      |
| SuperTokens + Postgres fallback                                   | **Works**                                                                      |
| Langfuse server + event ingestion                                 | **Works**                                                                      |
| Langfuse worker persistence (ClickHouse)                          | **Partial** (schema fixed, still flaky)                                        |
| atomic-agent v0.1.72 + atomic-bridge (62 tools)                   | **Works**                                                                      |
| dashboard + worker + inbox containers                             | **Works**                                                                      |
| sandbox container                                                 | **Works** if image built from `infra/docker/sandbox/`                          |
| RBAC + role assignment                                            | **Works**                                                                      |
| Audit logs (all mutations)                                        | **Works**                                                                      |
| DSR (export/delete personal data)                                 | **Works**                                                                      |
| Production Terraform / PgBouncer / alerting                       | **Partial** (scripts in tree, not auto-deployed)                               |




## Verification scripts (last recorded green)


| Script                | Last recorded                      |
| --------------------- | ---------------------------------- |
| `check-phase0.js`     | 17/17 PASS                         |
| `check-phase2.js`     | 17/17 PASS                         |
| `check-phase3.js`     | 6/6 PASS                           |
| `check-auth-nango.js` | 3/3 PASS                           |
| `e2e-live-llm.js`     | 5/5 inbound+LLM; outbound Meta 401 |




## Phases


| Phase                                     | Code            | Meaning                                  |
| ----------------------------------------- | --------------- | ---------------------------------------- |
| 0 Foundations                             | Done            | Docker + DBs                             |
| 1 Multi-tenant core                       | Done            | Auth + RLS                               |
| 2 Connector layer                         | Done            | Nango + test proxy                       |
| 3 Inbox ingestion                         | Done            | Webhooks + conversations                 |
| 4 / 4.5 / 4.6 Agent + security + live E2E | Done            | atomic-agent, not Hermes                 |
| 5 Realtime SSE                            | Done            | Single-process hub                       |
| 6 Memory & RAG                            | **Partial**     | Tables + retrieve + /brain |
| 7 Insight & analytics engine              | **Partial**     | Named-workflow enqueue     |
| 8 Scale / Terraform / alerting            | **Partial**     | Redis + PgBouncer; TF scripts |
| 9 Polish, mobile, a11y, billing           | **Partial**     | Packs + billing APIs       |


