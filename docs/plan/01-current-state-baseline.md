# 01 — Current state baseline

Faithful snapshot of what **exists today**, taken only from
[`docs/current-working/`](../current-working/) (especially
`00-status-at-a-glance.md`, `13-what-works.md`,
`14-what-does-not-work.md`, `16-updates-2026-08-13.md`) plus
`AGENTS.md` where it does not contradict current-working.

This file does **not** invent capabilities. If a future-scope file
still lists a hole that current-working says is closed, current-working
wins. Those contradictions are collected in
[02-gap-analysis.md](./02-gap-analysis.md) section 0 and
[execution/02-risks-and-open-questions.md](./execution/02-risks-and-open-questions.md).

Linked from [README.md](./README.md) and
[00-executive-summary.md](./00-executive-summary.md). Documentation only.

---

## 1. Product sentence

Darex is a multi-tenant AI-employee SaaS. Each signed-in user gets
their own org. AI employees (Sarah / Emma / Marcus by default) answer
questions and run tools on that org’s connected apps, and **confirm
before running multi-step plans**.

Runtime is **not** LangGraph or Hermes. The live loop is:

**atomic-agent (v0.1.72)** → **MCP bridge** (`mcp.darex.*`) →
**`tool-executor.ts`** → real provider APIs / Postgres / Jina /
sandbox.

Source: `docs/current-working/01-system-overview.md`.

---

## 2. Monorepo (what talks to what)

| Piece | Package / path | Job |
|-------|----------------|-----|
| Dashboard UI | `apps/dashboard/app/(dashboard)` | Home, Ask AI, Conversations, Employees, Insight, Analytics, Integrations, Connectors, Settings |
| Dashboard API | `apps/dashboard/app/api` | Auth, Ask AI, agents, webhooks, CRUD |
| Classifier / planner | `apps/dashboard/lib/classify.ts`, `plan-generator.ts` | LiteLLM JSON (not the agent loop) |
| LLM gateway | `darex-litellm` `:4000` | OpenRouter `deepseek-chat` as alias `atomic-agent` |
| Agent loop | `darex-atomic-agent` `:8787` | Multi-step tool calling via MCP |
| MCP bridge | `darex-atomic-bridge` `:8790` | 62 tools → `executeAutonomousToolAction` |
| Tool executor | `services/workflows/src/tool-executor.ts` | Real HTTP + Nango tokens + allowlist |
| Temporal | `darex-temporal` `:7233` + `darex-worker` | Durable wrapper (up to 3 turns) |
| Auth | SuperTokens `:3567` + Postgres fallback | Session cookie `darex_session` = `users.id` |
| OAuth vault | Nango `:3003` | Connection id `{orgId}_{provider}` |
| Traces | Langfuse `:3002` | Ask AI + plan + agent turns |
| DB | Postgres `:5432` db `darex` | RLS on every tenant table |
| Inbox gateway | `apps/inbox` `:3004` | HMAC Express proxy to dashboard Chatwoot webhook |
| Sandbox | `infra/docker/sandbox/` internal `:8080` | Unprivileged python/node/bash |

`packages/shared-types` is a placeholder README. `apps/agents/` is
gone. `@darex/connectors` is used only by `POST /api/integrations/test`.

Source: `01-system-overview.md`, `12-infrastructure.md`.

---

## 3. What works (verified)

From `13-what-works.md` and `00-status-at-a-glance.md`.

### Auth and tenancy

- Register / login with SuperTokens or Postgres scrypt. No
  auto-provision on bad password.
- Per-user org (`createOrgForEmail` / `ensureUserOrg`).
- Session cookie stores `users.id` (not the SuperTokens id).
- RLS FORCE + WITH CHECK (migration 008). Isolation test passes.
- Forgot / reset password and `/invite/[token]` (reachable while
  signed in). Invites via `org_invites`; optional Resend; always a
  copyable link.
- Body `org_id` rejected on org/settings APIs. Webhooks resolve
  tenant via SECURITY DEFINER helpers (migration 010).
- Onboarding wizard writes org + channel stubs.

### Ask AI

- Classifier → simple NDJSON stream via `runAutonomousAgentDirect`
  (~6s Q&A). Daily session key `askai-{userId}-{YYYYMMDD}`.
- Classifier → complex plan in `agent_plans` → PlanCard → approve →
  SSE execute with parallel independent steps (~13s).
- Plan failure falls back to direct agent. Draft revise via LiteLLM.
- Canonical thread is `messages` (`GET /api/ask-ai`); localStorage is
  a cache. Home `/ask-ai?q=` works. SSE `done` is applied on the page.
- Execute 409s already-completed plans. Instruction steps are notes,
  not tools. Org grounding lives in the **user** message (atomic-agent
  drops `system`).
- Honest `notConnected` when OAuth is missing (`setupUrl`).

### Agent runtime

- atomic-agent v0.1.72 SSE `/v1/chat/completions`.
- MCP bridge 62 tools, server name `darex`, `GET /health`.
- Temporal `AutonomousAgentWorkflow` uses `isDone`, `priorToolResults`,
  and `idempotency_keys` (max 3 durable turns).
- Direct fallback when Temporal is down (`/api/agent/run` and
  `/stream`).
- Tool allowlist = union of all active employees + connected channels
  + core tools (fixed 2026-08-13).
- 11 custom `SKILL.md` playbooks COPY into the atomic-agent image
  (rebuild after playbook edits).
- Code sandbox executor + compose service (image context in this
  working tree).

### Tools live-verified at least once

| Tool | Evidence |
|------|----------|
| `database_query` | Ask AI / Temporal E2E |
| `gmail` fetch | Real emails via Nango |
| `google-docs` `docs_create` | Live |
| `google-sheets` `sheets_create` | Live after allowlist fix |
| `google-drive` `drive_list` | 27 files when connected |
| `web_search` | Passes allowlist; Jina Bearer when key set |
| `code_execution` | python `6*7=42`, node `1+1=2`, bash |

Disconnected OAuth **never fabricates success**. Status is `error`,
`connected: false`, `setupUrl: '/connectors'`. `simulated` is never
returned.

### Inbox and realtime

- Conversations CRUD, human reply, agent on inbound dashboard messages.
- WhatsApp inbound: persist + SSE + agent + channel_log. Signature
  `X-Hub-Signature-256`. Outbound Graph is a separate ops problem
  (token expired 2026-06-12).
- Chatwoot HMAC ingest **and** `fireInboundAgent`.
- Inbox gateway HMAC; outbound send forwards to
  `/api/webhooks/outbound`. Human agent replies send back on the
  channel.
- SSE `needs_attention` E2E verified on a **single** Next.js process.

### Integrations

- Nango is source of truth. POST connect 400s without a real
  connection. Disconnect deletes the Nango connection.
- Connection id `{orgId}_{provider}`.
- Gmail scopes include compose; Intercom + Notion scopes filled.
- WhatsApp BYOK Graph-verified into `channels.meta`.
- Razorpay per-org verified keys in `channels.meta` (env fallback).
- Test proxy is a read-only ping by default.
- Catalog lists 27 apps. Several Google products have real executors
  even if UI copy still says `catalog_only`.

### Product UI with real data

- Home KPIs from SQL (no hardcoded `99.8%`).
- Employees roster + stats + `AutonomousActionConsole`.
- Analytics aggregates (automation %, latency, CSAT proxy, 7-day trend).
- Settings: distinct Meta vs Chatwoot webhook URLs.
- Langfuse ingestion schema fixed (event-level `timestamp`, 201
  accepted).
- Dashboard `GET /api/health`.

### Infra

- 19 compose services. Dedicated `langfuse-redis`. Sandbox context
  present in the working tree.
- Migrations 001–011 exist. Operator must apply 009–011.
- Phase checks last recorded: 0 = 17/17, 2 = 17/17, 3 = 6/6,
  auth+Nango = 3/3. Live WhatsApp inbound+LLM 5/5; outbound Meta 401.

---

## 4. What does not work (current tree)

From `14-what-does-not-work.md` and `00-status-at-a-glance.md`.

### Blocked by credentials / ops (code is ready)

| Item | Why |
|------|-----|
| WhatsApp **outbound** | `META_ACCESS_TOKEN` expired 2026-06-12 |
| Gmail draft/send on old tokens | Need browser re-connect for `gmail.compose` |
| Google Drive (some orgs) | Still needs `/connectors` OAuth |
| HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Meta Ads | Placeholder OAuth client IDs in Nango UI `:3003` |
| Google Ads metrics | Needs `GOOGLE_ADS_DEVELOPER_TOKEN` + customer id |
| Razorpay | Env empty **and** no per-org `channels.meta` keys |
| web_search reliability | `JINA_API_KEY` required |
| Meta production webhook | Must set URL in Meta Developer Console |

### Code / product holes

Audit **2026-08-14**. Many 13 Aug rows below are **closed** — see
[02-gap-analysis.md](./02-gap-analysis.md) §0.1. Remaining:

| Item | Detail |
|------|--------|
| WorkItem `retrieveMemoryActivity` | Calls `retrieveMemory` (org-scoped; empty if none) |
| WorkItem HITL wait | Inbound send/pay/sign `condition()`-waits **before tools**; conversation `needs_attention` while waiting; greetings/read-only skip |
| Virus-scan | Ingest scanner stub always-clean |
| Public widget embed | **done** — `/embed/widget.js` + Settings snippet; API ignores body `org_id` |
| Zoho CRM / Leegality / QuickBooks | Executors shipped 2026-08-14 (honest notConnected). Live OAuth/BYOK ops. FUB / MLS still not built. |
| Wave 2–4 packs | RFC only |
| Langfuse persistence | Ingestion OK; ClickHouse can still be flaky |
| Terraform / alerting | Scripts exist; not applied to staging |
| Insight / billing / Redis / darex_app / RAG / sandbox | **Shipped in code** — do not rebuild (see gap §0.1) |

### Security leftovers

- `ALLOW_DEMO_AUTH` is refused at boot when `NODE_ENV=production`
  (`boot-guards.ts`). Keep it off in staging too.
- Pre-004 users have NULL `password_hash` (Postgres login path).
- SuperTokens works only if `SUPERTOKENS_API_KEY` matches compose
  `API_KEYS`.
- Rotate keys that live in gitignored `.env` files.

---

## 5. Phases already in code

| Phase | Code | Meaning |
|-------|------|---------|
| 0 Foundations | Done | Docker + DBs |
| 1 Multi-tenant core | Done | Auth + RLS |
| 2 Connector layer | Done | Nango + test proxy |
| 3 Inbox ingestion | Done | Webhooks + conversations |
| 4 / 4.5 / 4.6 Agent + security + live E2E | Done | atomic-agent, not Hermes |
| 5 Realtime SSE | **Done** | Hub + Redis bus |
| 6 Memory & RAG | **Partial** | Tables + retrieve + /brain + parent activity; M6 live eval |
| 7 Insight & analytics engine | **Partial** | Named-workflow enqueue exists |
| 8 Scale / Terraform / alerting | **Partial** | Redis + PgBouncer + darex_app; TF/alerting scripts |
| 9 Polish, mobile, a11y, billing | **Partial** | Packs + billing APIs; PSP keys / 375px pass |
| 10 Connector registry + Wave A/B | **Partial** | Registry + Outlook/SF/DocuSign/Maps/Twilio |
| 11 RE brokerage IN | **Partial** | Pack + UI + goldens; quality bar not live-verified |
| 12–18 | **Deferred** | RFC / pull |

---

## 6. House rules already encoded in code

From `01-system-overview.md` and `AGENTS.md`:

1. Never trust `org_id` from a request body. Resolve from session.
2. Webhooks return 200 first; never await the LLM inline.
3. Release the DB client before opening SSE / long LLM calls (pool
   `max: 10`).
4. Missing OAuth → `connected: false` + `/connectors`, never fake data.
5. Env-only secrets; no hardcoded keys in shipped source.
6. LiteLLM for JSON classify/plan/revise; atomic-agent only for the
   tool loop. Reasoning disabled where only the final answer matters.
7. atomic-agent drops `system` — org facts go in the user message.

---

## 7. What this baseline is not

- Not a Chatwoot fork. `apps/inbox` is a thin Express proxy.
- Not Hermes / LangGraph. Those files were deleted.
- Not a full Brain OS yet. Memory exists; inbound parent retrieve
  is still a no-op; Wave 2 packs are RFC; WhatsApp outbound is
  ops-blocked.
- Not multi-cloud production. Compose + Terraform starter; staging
  apply not recorded.
- `packages/shared-types` is no longer a placeholder README — it
  exports memory, work-item, pack, and billing types.

Next: [02-gap-analysis.md](./02-gap-analysis.md).
