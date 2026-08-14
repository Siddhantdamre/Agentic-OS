# Darex Build State

> Source of truth for agent context across sessions. Read this before starting any phase.

Plan status audit **2026-08-14:** Immediate/Near scaffolding is largely in code. Remaining work is in `docs/plan/README.md` (ops creds, inbound retrieve activity, WorkItem HITL wait, RE live-verify).

H6 public widget embed (2026-08-14): `/embed/widget.js` + Settings snippet. Persist inbound → 200 → `fireInboundAgent`. Tenant from site key hash, never body `org_id`.

---

## C6 Wave B leftovers — Zoho / Leegality / QuickBooks (2026-08-14)

- New executors: `services/workflows/src/tools/zoho.ts`, `leegality.ts`, `quickbooks.ts`.
- MCP: `mcp.darex.zoho_*`, `leegality_*`, `quickbooks_*`. Registry keys in `tools/index.ts` (allowlist same as other connectors — not always-allowed).
- Seed: `connector_defs_wave_ab.sql` keys `zoho-crm`, `leegality`, `quickbooks`. No org_connectors rows; never mark connected from seed.
- Honesty: disconnected → `status:'error'` + `connected:false` + `/connectors`. Goldens in `infra/evals/honesty-connectors.yaml`. Live module test `wave-b-c6-honesty.test.ts`.
- Connected happy path needs live Nango OAuth (Zoho/QuickBooks) or Leegality BYOK `X-Auth-Token`. No committed secrets / fake client IDs.
- C6 leftovers **done** as executors; live creds **ops-blocked**. Zoho Books / Pipedrive / FUB still out.

---

## Runtime Fixes — Tool Allowlist, Code Sandbox, Langfuse v3 (2026-08-13)

### 🔴 Tool allowlist regression — plans/agents failing "not in allowed tool list"
- **Symptom:** approved plans failed every tool step with `Tool "web_search" is not in this
  employee's allowed tool list`. Steps stayed `Pending`.
- **Root cause:** `tool-executor.ts` started enforcing an allowlist, but the fallback
  `resolveOrgToolAllowlist` used `SELECT ... FROM ai_employees WHERE status='active' LIMIT 1` —
  it grabbed **whichever employee came first** (e.g. Sarah: `[gmail,whatsapp,hubspot]`), blocking
  web_search / google-sheets / google-drive that the **org actually owns**.
- **Fixes (org-wide union, not one employee):**
  1. `resolveOrgToolAllowlist` now returns the **union of ALL active employees** tool_allowlists
     **plus** ALWAYS-allowed core tools (`web_search, web_extract, database_query, db_query,
     sql_analytics, file_ops, file_system, workspace_file, sandbox, code_execution, execute_code`).
  2. **Also unions every connector the org has connected** (`channels` where status in
     connected/active) — so google-sheets/google-drive/etc. run for the org even when no single
     employee lists them, while never-connected connectors stay gated.
  3. Plan-execute path (`ask-ai/execute/route.ts`) now passes an explicit `toolAllowlist` =
     the plan's own step tools + core tools (belt-and-suspenders).
- **Verified live (worker rebuilt):** `google-sheets sheets_create` → **executed** (real Sheet),
  `google-drive drive_list` → **executed** (27 files), `web_search` passes allowlist.

### 🟢 Sandboxed code execution — `code_execution` / `sandbox` / `execute_code`
- **Before:** pointed at dead `@agent-infra/sandbox` → `http://localhost:8080` = Temporal UI, not a
  sandbox. Code execution never worked.
- **After:** new self-hosted **`sandbox`** Docker service (`infra/docker/sandbox`, node:20 + python3).
  Runs untrusted code as an unprivileged user, hard timeout, no outbound network, no DB access,
  `POST /execute {language, code, timeoutMs}` → `{result:{stdout,stderr,exitCode}}`. Supports
  `node` / `python` / `bash`. Added `SANDBOX_API_URL=http://sandbox:8080` to worker + dashboard env.
- **Verified:** python `6*7=42`, node `1+1=2`, bash `hi there` — all real output.

### 🟡 Langfuse observations now actually land (was silently 0 traces)
- **Symptoms:** Langfuse DB always empty; "what is the agent doing" invisible.
- **Fixes:**
  1. **Ingestion payload schema (the real bug):** hand-rolled trace sent `timestamp` inside
     `body` — Langfuse v3.225 rejects that (400 / 207 with `timestamp expected string`).
     `lib/langfuse-trace.ts` now puts `timestamp` at the **event level** (correct schema).
     Verified: ingestion returns `201` and the batch is accepted.
  2. Stopped swallowing errors (`.catch(()=>{})` removed) so misconfig is visible in logs.
  3. **worker `LANGFUSE_HOST` was `http://localhost:3002`** (wrong inside Docker) →
     fixed to `http://langfuse-server:3000`.
  4. Expanded tracing: added traces to plan-generation (`PlanGenerated`), each plan-execute
     step (`PlanExecution-<tool>`), and plan summary (`PlanExecutionSummary`).
- **Note (pre-existing infra):** the `langfuse-worker`'s BullMQ side-queues hit intermittent
  Redis socket timeouts under the shared Redis (100 clients); ingestion queue drains but some
  total persistence to ClickHouse is flaky. Trace *ingestion* is now correct; the upstream
  worker/Redis stability is a separate ops item (consider a dedicated Redis for langfuse).

### 🟢 web_search / web_extract
- Now send `Authorization: Bearer $JINA_API_KEY` when `JINA_API_KEY` is set (Jina now requires one;
  unset → honest error, no fake results). Set it in `infra/.env`. Added to worker/dashboard env.

### Docker / tenancy
- Compose secrets moved to `${VAR:-dev}` env-driven form; migration `008_rls_with_check.sql`
  adds `WITH CHECK` to all org policies + `darex_app` grants.
- Full rebuild (`pnpm build`) green; worker/bridge/dashboard/sandbox images rebuilt and recreated.

---



## Phase D: Plan-Confirm-Execute live + LiteLLM routing + Nango scope fixes (2026-08-11)

### Classifier/planner hang fixed — now call LiteLLM directly
- **Symptom:** complex Ask AI prompts returned `type:"simple"` or hung 90s+. Root cause: `lib/classify.ts`
  + `lib/plan-generator.ts` + `reviseDraft` called **atomic-agent's** `/v1/chat/completions`
  non-streaming. atomic-agent's agent loop injects the full GBNF tool grammar + all tool
  descriptors, so the model tried to emit real tool calls (gmail/drive) with malformed
  concatenated JSON → `Failed to parse tool call arguments` → parse/repair loop → hang.
- **Fix:** new `apps/dashboard/lib/litellm-client.ts` (OpenAI-compatible client, base URL
  `http://litellm:4000/v1` in prod / `localhost:4000` in dev, model `atomic-agent`).
  classify/plan/revise now call LiteLLM directly for plain JSON completions.
- **Second hang:** deepseek-v4-flash-0731 is a **reasoning model** — it burned the whole
  `max_tokens` budget on `reasoning_content` (returns empty `content`), and with a large
  budget it reasoned for minutes. Fix: `reasoning: { enabled: false }` in `litellm-client.ts`
  + `max_tokens: 300` (classify) / `800` (plan) / `1000` (revise).
- **Verified live:** complex prompt → `type:"complex"` (confidence 0.75) → plan with gmail
  `draft_email` step + 291-char draft → planId persisted → PATCH approve → SSE execute
  stream (`execution_start`/`step_start`/`step_done`/`execution_done`) in ~13s total.
  Simple prompt → `type:"simple"` clean answer in ~6s.
- **Remaining:** gmail `draft_email` execution returned 403 `insufficient scopes` — the
  existing gmail OAuth token was minted before `gmail.compose` was added. **Re-connect gmail
  in the browser** (disconnect + Connect OAuth on `/connectors`) to mint a token with the new
  scopes, then `draft_email`/`send_email` work.

### Nango integration config + scope fixes
- **gmail config** now includes `gmail.send gmail.readonly gmail.compose gmail.modify`
  (was missing `compose` → `drafts.create` 403). Requires the browser re-connect above.
- **intercom + notion** configs had **empty `oauth_scopes`** (OAuth would fail) — set to
  `read write`.
- **google-drive/docs/sheets** configs verified present with correct scopes (seeded from the
  gmail client creds).
- **`infra/scripts/seed-nango-configs.sql`** updated to apply all of the above idempotently
  (gmail scope repair + intercom/notion fill + drive/docs/sheets upsert). Run it, then
  `docker compose restart nango-server`.
- **Verified:** `/api/integrations` lists all 17 apps, 6 connected via real Nango OAuth
  (gmail, google-calendar, google-ads, github, google-docs, google-sheets). google-docs
  `docs_create` + google-sheets `sheets_create` still work live. google-drive correctly
  reports `simulated: google-drive not connected` (needs browser OAuth).
- **Still manual:** connect google-drive + re-connect gmail via browser OAuth on `/connectors`;
  whatsapp uses BYOK modal; slack/hubspot/stripe/notion/shopify/zendesk/intercom need real
  OAuth client IDs in the Nango UI (`http://localhost:3003`) before their popups complete.

---

## Documentation (2026-08-11)
- Created `documentation/` (11 docs: 00–10) covering how to run, architecture, docker infra, DB schema, auth,
  API reference, agent engine, realtime, verification checks, and feature roadmap — each written as
  standalone context for an AI model / new engineer. `BUILD_STATE.md` remains the live source of truth.

## Phase 3 check script fix (2026-08-11)
- `infra/scripts/check-phase3.js` regressed to 4/6 FAIL after `CHATWOOT_WEBHOOK_SECRET` was enforced: its two
  Chatwoot webhook POSTs (tests 2 + 6) sent no HMAC signature → 401 from the dashboard route.
- **Fixed:** added `crypto` HMAC-SHA256 signing — `x-chatwoot-signature: sha256=<hex>` computed over the exact
  `JSON.stringify(body)` using `CHATWOOT_WEBHOOK_SECRET` (fallback `darex-chatwoot-webhook-secret-dev`).
- **Verified:** Phase 3 → **6/6 PASS**. Full re-run: Phase 0 (17/17) ✅ · Phase 2 (17/17) ✅ · Auth+Nango (3/3) ✅.

## Nango Integration Truth Fix (2026-08-11)
- **Symptom:** Integrations page showed apps as "Connected" but the agent tools reported `connected: false`
  for Gmail, GitHub, Google Calendar, Slack, Intercom, Zendesk, Shopify, Notion, HubSpot, etc.
- **Root causes:**
  1. **Secret-key mismatch (the real bug).** Containers resolved `NANGO_SECRET_KEY=darex-nango-secret-dev-change-in-prod`
     because `infra/.env` + `services/connectors/.env` (loaded last in the `env_file` chain) overrode the real
     dev UUID (`0c2eb30a-...`) already present in `apps/dashboard/.env.local`. Nango rejects non-UUID keys
     (`invalid_secret_key_format`), so `tool-executor.ts` and the bridge could never fetch OAuth tokens →
     every tool returned `notConnected` / `connected: false`.
  2. **Fabricated connection rows.** `POST /api/integrations` `connect` upserted `status='connected'` with a
     guessed `nango_connection_id` — never creating a real Nango connection. `GET` trusted those rows → the UI
     showed 14/14 connected while Nango actually had only 4 real connections (demo org `661e8333-...`).
- **Fixes:**
  1. Aligned `NANGO_SECRET_KEY` to the Nango **dev** environment UUID (`0c2eb30a-0ecd-42ea-8918-0c73eda41a47`)
     in `infra/.env`, `services/connectors/.env`, and `infra/docker-compose.yml` (server env, inert post-seed).
  2. `services/connectors/src/client.ts`: `getConnectionId` `darex_{org}_{provider}` → `{org}_{provider}`
     (matches dashboard, tool-executor, and the real Nango connection ids).
  3. `services/workflows/src/tool-executor.ts`: Meta Ads provider config key `facebook-ads` → `meta-ads`
     (matches the Nango config key that exists in the DB).
  4. `apps/dashboard/app/api/integrations/route.ts`: GET now verifies every DB-reported connection against
     Nango in parallel (`lib/nango-server.ts`) — Nango is the source of truth. POST `connect` now returns 400
     unless a real Nango connection exists (no more fabrication).
  5. `apps/dashboard/app/api/integrations/nango-token/route.ts`: confirm (`POST`) verifies the connection
     against Nango before persisting `connected`.
  6. `apps/dashboard/app/(dashboard)/integrations/page.tsx`: removed the blind fake-connect fallback; OAuth
     errors are surfaced instead of silently marking connected. Stats card corrected to `X / 14`.
- **Verified live (containers recreated):** `gmail` tool-executor returned **3 real emails** via a Nango OAuth
  token; GET `/api/integrations` reports 4 connected (gmail/google-calendar/google-ads/github = the real
  connections for org `661e8333...`), everything else disconnected; POST connect → slack 400 / gmail 200;
  confirm route → gmail success / slack "not confirmed".
- **Rebuilt images:** `dashboard`, `worker`, `atomic-bridge`. Nango dev environment (env id 2) is the source
  of truth; the env `.env*` files are gitignored (real UUID is never committed).
- **Still manual:** providers with placeholder creds in Nango (hubspot/stripe/notion/slack/shopify/zendesk/
  intercom and meta-ads/whatsapp if re-auth needed) require real OAuth client IDs/secrets set in the Nango UI
  at `http://localhost:3003` before their OAuth popup can complete.

## Current Phase: 5 (FULLY COMPLETED) — Real-Time Delivery
- `/ask-ai` page + agent runtime ✅ (already done, verified working)
- **Real-time `needs_attention` notifications ✅ (2026-08-11):**
  - `apps/dashboard/lib/realtime-hub.ts` — in-process EventEmitter hub keyed by org (single `next start` process).
  - `apps/dashboard/app/api/stream/events/route.ts` — SSE endpoint authenticated via `darex_session` cookie, resolves org via `getScopedClient`, streams `needs_attention` + `conversation_updated` + keep-alive; auto-aborts on disconnect.
  - Publishers: WhatsApp webhook (inbound), Chatwoot webhook (inbound), `POST /api/conversations/[id]/messages` (customer message), `PATCH /api/conversations/[id]` (status change).
  - Inbox UI (`(dashboard)/conversations/page.tsx`): `EventSource('/api/stream/events')` → on `needs_attention` auto-selects the conversation, refreshes the feed, shows an amber "Needs Attention" toast.
  - **E2E verified live:** register→login→open SSE (event: connected) → trigger chatwoot webhook → `event: needs_attention` received with correct conversationId/contactId/orgId. Test data cleaned up afterward.
- Remaining for Phase 5 (external/manual, no code):
  - Configure Meta webhook URL in Meta Developer Console: `https://your-domain.com/api/webhooks/whatsapp`.
  - ~~Set `CHATWOOT_WEBHOOK_SECRET` for webhook HMAC security~~ ✅ **DONE (2026-08-11)**:
    `darex-chatwoot-webhook-secret-dev` added to root `.env` + `apps/dashboard/.env.local`, live in the
    dashboard container. Verified: no signature → 401, wrong signature → 401, valid `sha256=` HMAC →
    passes auth and reaches org resolution (400 only because 37 orgs exist — correct multi-tenant behavior).

## Runtime Audit + Ask AI Fix (2026-08-11)
- **Ask AI was hanging >200s.** Root cause (confirmed via atomic-agent traces): the
  `ask-ai` route used one shared, never-rotating `darex:{org}:chat` session for every
  user/prompt, and a single bad turn (model hunting for `org_id` via
  `memory.notes.recall`/`memory.profile.list`/`mcp.resource.list`) poisoned that
  session permanently — every later ask resumed the hanging loop.
- **Fixes applied:**
  1. `AgentTaskInput.sessionKey` added; `buildSessionId` now honors it and rotates the
     bare fallback daily (`darex:{org}:chat-YYYYMMDD`) so a session can never grow unbounded.
  2. `ask-ai` route passes `sessionKey = askai-{userId}-{YYYYMMDD}` (per-user + daily rotation).
  3. **atomic-agent drops the OpenAI `system` role entirely** (verified in its
     `openai-chat-completions.js`: `systemPrompt` is parsed but never forwarded to
     `runTurn`). So org grounding is now embedded in the **user message**
     (`buildGroundedUserMessage`) — the only content guaranteed to reach the LLM prompt.
     This stops the model from asking the user for `org_id` / searching memory for it.
  4. Cleared leftover debug profile fact (`magic_word: BLUEBERRY`) and stale session WAL/traces.
- **Verified end-to-end via deployed dashboard:** DB query → answer "43" in ~7s
  (was: >200s hang). GitHub query → honest "not connected via Nango" reply in ~15s,
  no org_id loop.
- **Langfuse stack was down + `langfuse-worker` crash-looped**: missing
  `REDIS_CONNECTION_STRING` (langfuse reads this, not `REDIS_URL`). Added
  `REDIS_CONNECTION_STRING: redis://redis:6379` + redis depends_on for
  `langfuse-server`/`langfuse-worker`. Worker now stays up; health OK.
- **Credential audit (read-only):** OpenRouter ✓, Groq ✓, Gemini ✓, Mistral ✓ all return
  200. **`META_ACCESS_TOKEN` is EXPIRED** (session ended 2026-06-12; Graph API 401) —
  needs rotation/reissue before outbound WhatsApp works. Google Ads / Shopify / Zendesk /
  Razorpay keys are empty in dashboard `.env.local` (only needed when those connectors
  are connected).
- **`channel_logs` insert bug fixed** (2026-08-11 follow-up). Two callers inserted with
  columns `(org_id, channel_id, log_type, payload)`, but schema (migration 003) has no
  `channel_id`/`log_type` (it uses `channel_type, event_type, status, status_code, message,
  payload, response`). Fixed in `services/workflows/src/activities/index.ts`
  (`logChannelActivity`) and `apps/dashboard/app/api/agent/run/route.ts`. All other writers
  already used correct columns.
- **Temporal E2E verified after redeploy:** fresh `AutonomousAgentWorkflow`
  (`agent-task-...-1786425113962`) returned correct answer ("52" = channel count) with
  `mcp.darex.database_query`, and `logChannelActivity` wrote a clean `e2e/AGENT_EXECUTION`
  row. A transient `fetch failed` on the MCP tool was a stale atomic-agent→bridge SSE
  session (both healthy; handshake 200 now). Worker/dashboard images rebuilt → all suites
  PASS (17/17, 17/17, 5/5, 3/3).

## Docker Runtime (the project now runs fully via `docker compose`)
> All components are containerized in `infra/docker-compose.yml`; the host no longer
> needs `pnpm dev`/`worker-launcher.js`.
- `worker` service (`infra/docker/worker/Dockerfile`): Temporal worker built from the
  monorepo (`@darex/workflows`), connects to `temporal:7233`, DB `postgres`, agent
  `atomic-agent:8787`. `worker.ts` now passes `NativeConnection` address from
  `TEMPORAL_ADDRESS` (previously hardcoded `localhost:7233`).
- `dashboard` service (`infra/docker/dashboard/Dockerfile`): Next.js production build
  (workspace deps compiled in-image: connectors + workflows), served via `next start`
  on `:3000`. Env (`environment` block overrides `env_file`) wired to service names:
  `postgres`, `supertokens:3567`, `temporal:7233`, `atomic-agent:8787`,
  `nango-server:3003`, `langfuse-server:3000`.
- atomic-agent healthcheck switched from `node -e` HTTP probe (timeouts in node:25
  container) to fast bash TCP check `</dev/tcp/127.0.0.1/8787`.
- `ATOMIC_AGENT_TIMEOUT_MS` default raised to 300000 for worker + dashboard (SSE
  client turns can exceed 180s on resumed long sessions).
- **E2E PASSED (all-Docker):** Temporal `AutonomousAgentWorkflow` → worker activity →
  atomic-agent (OpenRouter `deepseek/deepseek-v4-flash-0731`) → `mcp.darex.database_query`
  → Postgres → reply "1" in ~6s.

## Atomic-Agent Migration Track (replaces Hermes)
> Branch: `feat/atomic-agent-integration`. Goal: remove Hermes entirely; run the
> full agent loop in AtomicBot-ai/atomic-agent v0.1.73 (Docker, node:25) with a
> self-hosted MCP tool bridge over the existing connector stack.
- ✅ **Migration Phase 1 — atomic-agent service** (`193f0b9`): Docker service `atomic-agent`
  (OpenAI-compatible HTTP serve on :8787), config rendered from env at boot, memory fabric on,
  cloud LLM providers (OpenRouter/Groq/Gemini). Session continuity verified.
- ✅ **Migration Phase 2 — MCP bridge** (`8ad26d4`, `45079f6`): `atomic-bridge` Docker service
  (SSE MCP on :8790) exposing 24 `mcp.darex.<tool>` connectors backed by `executeAutonomousToolAction`;
  `.dockerignore`; per-connection `McpServer`. Fixed cloud-LLM tool naming: MCP server is
  hyphen-free (`darex`) so both dotted and `__`-escaped tool names resolve. Default provider is
  OpenRouter (`deepseek/deepseek-v4-flash-0731`).
- ✅ **Migration Phase 3 — Temporal workflow swap** (this commit): new `atomic-agent-client.ts`
  (streaming OpenAI-compatible client with SSE `tool_progress` harvest, multi-tenant session IDs);
  `activities` expose `runAgentTurnActivity`; `AutonomousAgentWorkflow` drives one atomic-agent
  turn then persists. `hermes-agent.ts` deleted. E2E PASSED via Temporal: deepseek emitted
  `mcp.darex.database_query` → Postgres → reply "1".
- ✅ **Migration Phase 4 — dashboard routes** (this commit): `apps/dashboard/app/api/agent/run`,
  `ask-ai`, `conversations`, `conversations/[id]/messages`, whatsapp webhook now call the atomic-agent
  client directly (`runAutonomousAgentDirect`, fallback behind Temporal); LangGraph removed —
  `agent-engine.ts` reduced to the shared `AgentTaskInput`/`AgentTaskResult` contract;
  `apps/dashboard/lib/hermes-agent.ts` and `app/api/agent/hermes/route.ts` deleted; `agent/tools`
  lists Atomic Agent tools instead of Hermes suites. Dashboard production build passes.
- ⬜ **Migration Phase 5 — WhatsApp webhook wiring**.
- ⬜ **Migration Phase 6 — worker launcher**: pass `ATOMIC_AGENT_URL`/`ATOMIC_AGENT_API_KEY`
  explicitly; update env docs.

## Phases Completed
- ✅ **Phase 0 — Foundations** (Completed: 2026-08-05)
- ✅ **Phase 1 — Multi-Tenant Core** (Completed: 2026-08-05)
- ✅ **Phase 2 — Connector Layer (100% Real Data & Execution)** (Completed: 2026-08-06)
- ✅ **Phase 3 — Conversation Ingestion & Multi-Channel Inbox** (Completed: 2026-08-07)
- ✅ **Phase 4 — Critical Audit Hotfixes** (Completed: 2026-08-09)
- ✅ **Phase 4.5 — Security & Hardening Audit** (Completed: 2026-08-10)

---

## Phase 4.5 — Security & Hardening Audit

**Status:** ✅ FULLY COMPLETED

### Scope
Full codebase audit for: dead/third-party code, hardcoded secrets, broken installs,
missing endpoints, auth gaps, and fake-data fallbacks. All app source now compiles
and builds cleanly (`pnpm build` green).

### Issues Fixed

#### 🔴 CRITICAL — Broken Hermes Agent Runtime
- **Before:** `HERMES_MODULE_PATH` in `services/workflows/src/activities/index.ts` pointed
  at a nonexistent path, so `hermes_plan`/`hermes_reply` Temporal activities always returned
  canned fallbacks. The Python engine (`services/hermes-agent/`, 233MB third-party repo) was
  dead code — `usePythonEngine` was never set.
- **After:** Hermes adapter moved to `services/workflows/src/hermes-agent.ts` (self-contained,
  JS-only), imported statically. Dashboard re-exports it. Python repo + compiled artifacts deleted.
- **Files:** `services/workflows/src/hermes-agent.ts` (new), `services/workflows/src/activities/index.ts`

#### 🔴 CRITICAL — Auth Fallback Accepted ANY Password
- **Before:** Postgres fallback login auto-provisioned a session for any email/password pair.
- **After:** scrypt password hashing (`hashPassword`/`verifyPassword`), fallback login verifies
  `password_hash`, registration stores the hash. Missing hash / wrong password → 401. No auto-provision.
- **Files:** `apps/dashboard/app/api/auth/[[...path]]/route.ts`, `infra/db/migrations/004_password_hash.sql` (new)

#### 🔴 CRITICAL — Hardcoded Secrets Removed From App Source
Removed all dev-secret fallbacks from shipped code (now fail-closed / env-only):
- `darex_dev_secret` DB password (OAuth routes, org/create, integrations test/webhooks → now shared `@/lib/db` pool or `getScopedClient`)
- `darex-supertokens-api-key-dev` (`lib/supertokens.ts` — set `SUPERTOKENS_API_KEY` to match server)
- `darex-nango-public-key-dev` (`lib/nango-client.ts`, nango-token route, integrations page)
- `pk-lf-darex-dev-public` / `sk-lf-darex-dev-secret` (`lib/langfuse-trace.ts` — skips when unset)
- `darex_wh_2024` verify token (`app/api/settings/route.ts` — returns null when unset)
- Demo login autofill creds (`login/page.tsx` — now gated behind `NEXT_PUBLIC_DEMO_EMAIL`/`NEXT_PUBLIC_DEMO_PASSWORD`)

#### 🟡 — Unauthenticated Conversation PATCH + Tenant Isolation
- **Before:** `PATCH /api/conversations/[id]` used the FIRST org in DB (no session check).
- **After:** Uses `getScopedClient()` — requires session + per-user org scoping via RLS.
- **File:** `apps/dashboard/app/api/conversations/[id]/route.ts`

#### 🟡 — WhatsApp Token Plaintext in Wrong Column
- **Before:** Manual Meta access token stuffed into `channels.nango_connection_id` as
  `manual_json:{...}` — abusing the column name and mixing credential storage.
- **After:** Creds stored in `channels.meta` JSONB (org-isolated by RLS); `nango_connection_id`
  reserved for real Nango ids. Tool executor reads `meta` (with legacy `manual_json:` fallback).
- Added migration `005_channels_unique_org_type.sql` — the `ON CONFLICT (org_id, channel_type)`
  upserts required a unique index that never existed (latent runtime bug).
- **Files:** `apps/dashboard/app/api/integrations/whatsapp/route.ts`, `services/workflows/src/tool-executor.ts`, `infra/db/migrations/005_channels_unique_org_type.sql` (new)

#### 🟡 — Shared "DareX Demo Org" for All Users (Tenancy)
- **Before:** `ensureOrgExists()` assigned every new user the first org in the table.
- **After:** `ensureUserOrg()` / `createOrgForEmail()` in `lib/db.ts` create a fresh per-user org.
  Used by auth + OAuth routes. Demo OAuth auto-provision now gated behind `ALLOW_DEMO_AUTH=true`.

#### 🟢 — Dead Code & Broken Install Cleanup
- Deleted: `services/hermes-agent/` (233MB), `mem0-*` leftovers, root `docker-compose.yml`,
  `nul` redirect artifact, compiled `lib/hermes-agent.js/.d.ts`, `test-api.ts`, dead middleware block.
- Removed broken `transpilePackages: ["@darex/shared-types"]` from `next.config.js`.
- `pnpm install` repaired all broken workspace symlinks; `.gitignore` expanded
  (`.turbo`, `*.tsbuildinfo`, `nul`, `workspace_storage`, `sandbox/`).
- `sandbox/` dir contents deleted but the empty dir is EBUSY-locked by a system process — gitignored.

#### 🟢 — Infra Fixes
- `infra/docker-compose.yml` postgres init mount was `./infra/db/init` (wrong path from `infra/`) → `./db/init`.
- `infra/db/init/00_create_databases.sql` started with `#` comment lines (invalid SQL) → `--` comments.

### 🔧 Runtime-Only Bugs Found & Fixed (2026-08-10 verification run)
- **Session cookie used SuperTokens id, not `users.id` PK** — when SuperTokens was running, register/login
  set `darex_session` to the SuperTokens user id while `getScopedClient`/session-GET look up `users.id`,
  causing 401 on every authenticated API call. Now both SuperTokens login/register paths use the DB row id.
  (Only surfaced once the SuperTokens container is actually up.)
- **Chatwoot webhook SQL type error** — `chatwoot_conv_id = $2` with a text-inferred param raised
  `operator does not exist: integer = text`. Fixed with `chatwoot_conv_id::text = $2::text`.
- **`infra/scripts/check-phase{2,3}.js` / `check-auth-nango.js`** now authenticate (register/login a throwaway
  user, reuse the session cookie) and preserve query strings in `makeRequest` (`pathname + search`), since
  the hardened endpoints require a session. Phase 3 webhook check passes `?org_id=` from its own session.

### Verification Results (2026-08-10, stack running)
- RLS isolation test: ✅ PASS
- Phase 0 (17/17) ✅ · Phase 2 (17/17) ✅ · Phase 3 (6/6) ✅ · Auth+Nango (3/3) ✅
- Dashboard `next build` ✅ · all 4 workspaces typecheck ✅
- **LIVE E2E (WhatsApp inbound → Temporal → real LLM → AI reply persisted): 5/5 ✅**

### Phase 4.6 — Live E2E (2026-08-10)

**Status:** ✅ FULLY COMPLETED — full live flow verified against real LLM + Temporal.

### Bugs Found & Fixed During Live E2E
1. **WhatsApp channel meta key mismatch** — the connect route stored
   `{ accessToken, phoneNumberId, wabaId }` (camelCase) while the webhook route read
   `meta->>'phone_number_id'` / `meta_access_token` (snake_case), so a connected channel
   never resolved its org in `/api/webhooks/whatsapp`. Now both key styles are written.
   - Files: `apps/dashboard/app/api/integrations/whatsapp/route.ts`
2. **Worker had NO env** — the worker was launched as `node dist/worker.js` from
   `services/workflows`, where no `.env` exists, so `dotenv/config` loaded nothing
   (no API keys, no DB password) and activities returned canned fallbacks.
   - Fix: `infra/scripts/worker-launcher.js` (new) merges root `.env`, dashboard
     `.env.local`, and `infra/.env` before starting the worker.
3. **Meta message id broke `messages` insert** — `chatwoot_msg_id` was `integer` but
   Meta sends string ids like `wamid.1786359347590`, so the whole per-message
   transaction threw and no message/AI reply persisted (conversation was still created).
   - Fix: migration `006_messages_chatwoot_msg_id_text.sql` → column is now `text`.
4. **Webhook org resolution ambiguity** — channel lookup used `LIMIT 1` without ordering,
   so with multiple orgs sharing a phone number it matched a random (older) org.
   - Fix: `ORDER BY connected_at DESC NULLS LAST` in both channel-match queries in
     `apps/dashboard/app/api/webhooks/whatsapp/route.ts`.
5. **Duplicate assistant message** — Temporal workflow's `saveMessageActivity` persists
   the reply AND the webhook step 9 inserted it again (2 assistant rows per turn).
   - Fix: webhook only inserts when the workflow did not run (`savedByWorkflow` flag).

### Live E2E Results (5/5 PASS)
1. Register fresh user → per-user org created ✅
2. Connect WhatsApp with real `META_ACCESS_TOKEN` / phone number id from env ✅
3. Meta-format inbound webhook accepted (HTTP 200, ~11s — includes LLM round-trip) ✅
4. Conversation + `user` message + **contextual real-LLM `assistant` reply** persisted ✅
   (reply text directly answers the enterprise-pricing question — not the canned fallback)
5. Outbound send attempted & logged to `channel_logs` (Meta returned HTTP 401
   OAuthException — the env `META_ACCESS_TOKEN` appears expired/invalid; pipeline
   correctly logged the failure as `error`) ✅

### Notes
- `META_ACCESS_TOKEN` in env returns 401 from Meta Graph API — needs rotation/reissue
  for real outbound delivery. Inbound+LLM+persistence path is fully verified regardless.
- New scripts: `infra/scripts/worker-launcher.js`, `infra/scripts/e2e-live-llm.js`
- Worker now runs via launcher with merged env; restart command:
  `powershell Start-Process node infra/scripts/worker-launcher.js ...`

### TypeScript Compile Status
- Dashboard: ✅ 0 errors (plus full `next build` ✅)
- Services/workflows: ✅ 0 errors
- Services/connectors: ✅ 0 errors
- Apps/inbox: ✅ 0 errors

### Open Items (require Docker/DB or real credentials)
- Rotate real API keys found in untracked/gitignored env files (Groq, Gemini, OpenRouter, Meta).
- SuperTokens path now works end-to-end, but the app must set `SUPERTOKENS_API_KEY` to match the
  SuperTokens server's `API_KEYS` (docker-compose uses `darex-supertokens-api-key-dev`); without it the
  SDK calls fail and auth falls back to Postgres (password_hash) — still functional.
- Users created before migration 004 have NULL `password_hash` and must re-register (SuperTokens path unaffected).

---

## Phase 4 — Critical Audit & Hotfixes

**Status:** ✅ FULLY COMPLETED

### Issues Fixed

#### 🔴 CRITICAL — Fake/Dummy Data Removed
- **Dashboard hardcoded stats** — `+18%`, `1.4s`, `99.8% AI automated`, hardcoded `3` needs attention — ALL replaced with real DB-computed values from `/api/dashboard/stats`
- **Needs Attention widget** — was showing 2 static hardcoded cards; now fetches real `needs_attention` conversations from `/api/conversations?status=needs_attention`
- **Ask AI input** — was using `alert()` as placeholder; now redirects to `/ask-ai?q=...`
- **Toggle View demo button** — removed entirely (was a demo artifact)
- **Employees page stats** — `99.4%` and `1.2s` hardcoded values removed; now computed from real employee data

#### 🔴 CRITICAL — Agent Engine: Real LLM Integration
- **Before:** `runAutonomousAgentLoop` returned hardcoded template strings based on keyword matching. No LLM was ever called.
- **After:** Real cascading LLM API calls — Groq (primary) → Gemini (fallback) → OpenRouter (fallback). System prompt includes employee name, role, persona, and tool execution history.
- **File:** `services/workflows/src/agent-engine.ts`

#### 🔴 CRITICAL — Hermes Agent: Real LLM Integration
- **Before:** `HermesAgentAdapter.executeTask()` returned hardcoded fake trajectory. No LLM was called.
- **After:** Real Groq → Gemini → OpenRouter cascading calls with proper system prompt. Memory search queries real DB for past assistant messages.
- **`hermes_python_sandbox`:** Now implemented as a safe JS Function-based evaluator for simple math/string expressions (no imports, no IO).
- **File:** `apps/dashboard/lib/hermes-agent.ts`

#### 🔴 CRITICAL — Tenant Isolation Bug in Chatwoot Webhook
- **Before:** `ensureOrgExists()` did `SELECT id FROM orgs LIMIT 1` — would write ALL incoming webhooks to a random org (first one in DB).
- **After:** Webhook resolves org via: (1) `?org_id=` query param, (2) `Authorization: Bearer <token>` matching org webhook_secret, (3) `X-Darex-Org-Id` header. Falls back to single-org-only shortcut for dev. Multi-org setups require explicit org identification.
- Added HMAC-SHA256 signature verification when `CHATWOOT_WEBHOOK_SECRET` is set.
- **File:** `apps/dashboard/app/api/webhooks/chatwoot/route.ts`

#### 🟡 — Stats API: Duplicate Pool Removed
- **Before:** `stats/route.ts` created its own `Pool` duplicating the shared pool.
- **After:** Uses shared `pool` from `lib/db.ts`. Added real computed stats: `conversationChangePct`, `needsAttentionCount`, `avgResponseMs`, `aiAutomationRate`.
- **File:** `apps/dashboard/app/api/dashboard/stats/route.ts`

#### 🟢 — WhatsApp (Meta Cloud API): REAL Integration
- **Tool Executor WhatsApp:** Was returning fake `wamid.HBgL...`. Now calls real `https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages` using `META_ACCESS_TOKEN`.
- **WhatsApp Webhook:** Created `/api/webhooks/whatsapp/route.ts` — handles Meta's real webhook format, verifies challenge, processes inbound messages, triggers AI agent loop, sends AI reply back via Meta Cloud API.
- **File created:** `apps/dashboard/app/api/webhooks/whatsapp/route.ts`

#### 🟡 — Tool Executor: Real OAuth for Calendar & HubSpot
- **Google Calendar:** Now tries Nango OAuth token before simulating. Returns `status: 'simulated'` (not fake `'executed'`) when not connected.
- **HubSpot:** Now tries Nango OAuth token before simulating. Returns `status: 'simulated'` when not connected.
- **File:** `services/workflows/src/tool-executor.ts`

### What Is Still Simulated (by design)
- Slack, Notion, Stripe, Shopify, Zendesk, Intercom, Razorpay — simulated until Nango OAuth connections are established
- Google Calendar / HubSpot — simulated until connected via `/connectors` page

### TypeScript Compile Status
- Dashboard: ✅ 0 errors
- Services/workflows: ✅ 0 errors

---

## Next Phase: Phase 5 — Real-Time Delivery & Production Readiness

**Start with:**
1. Configure Meta webhook URL in Meta Developer Console: `https://your-domain.com/api/webhooks/whatsapp`
2. Set `CHATWOOT_WEBHOOK_SECRET` for webhook security
3. Add org webhook URL format to onboarding: `?org_id={orgId}` in Chatwoot webhook config
4. Implement `/ask-ai` page that uses Hermes agent for business intelligence queries
5. Add real-time notification for `needs_attention` conversations (WebSocket or SSE)

---

## Architecture Log

| Decision | Rationale | Phase |
|---|---|---|
| Postgres + pgvector as single DB | Avoids extra vector DB service; pgvector handles all 3 memory tiers | 0 |
| Temporal via auto-setup image | Bundles Temporal server + worker + UI in one container for local dev | 0 |
| Nango for all OAuth | Self-hosted, inspectable credential storage; avoids Composio | 0 |
| Langfuse for LLM tracing | Self-hosted; per-tenant cost tagging via org_id metadata on every trace | 0 |
| RLS policy pattern | `current_setting('app.current_org_id', true)::UUID` — enforced at DB level | 0 |
| Idempotency keys table | Temporal activities use this to ensure exactly-once semantics for external side-effects | 0 |
| Graphify for context persistence | Knowledge graph built from docs + code, queryable across build sessions | 0 |
| SuperTokens for Auth | Open-source multi-tenant auth with built-in Session & User Management | 1 |
| Figma Design System Tokens | Custom Tailwind theme palette (`#FAF9F0`, `#F0C05A`, `#1E2B27`) | 1 |
| Nango Connector Pattern | Versioned TypeScript function per app in `services/connectors`, zero agent infra coupling | 2 |
| RLS Channel Logs (`channel_logs`) | Real-time audit trail for API proxies, webhooks, and sync stats per tenant | 2 |
| Dedicated Inbox Container | `darex-inbox` docker service running on port 3004 for clean containerized Chatwoot gateway | 3 |
| 3-Pane Inbox Architecture | Filter Sidebar + List Feed + Canvas/Context Drawer with manual human reply dock | 3 |
| Groq→Gemini→OpenRouter LLM fallback | Zero downtime AI responses — always has a working provider | 4 |
| Webhook org resolution via query param | `/api/webhooks/chatwoot?org_id={id}` enables per-tenant webhook URLs | 4 |
| Meta Cloud API for WhatsApp | Direct integration — no Chatwoot dependency for WhatsApp delivery | 4 |
| Safe JS sandbox for Hermes tools | No Python process spawning; safe arithmetic/string eval in server context | 4 |
