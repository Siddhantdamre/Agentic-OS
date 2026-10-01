# 04 · Agent runtime, MCP bridge, tool layer

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 10 | 16.1% |
> | 🟡 **Pending / In Progress** | 6 | 9.7% |
> | 🔴 **Not Done (Open)** | 46 | 74.2% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **62** | **100.0%** |

Audit date 2026-09-27, read-only. Scope: `services/workflows/src/{agent-client,agent-engine,local-turn,trueforge-client,mcp-bridge,tool-definitions,tool-executor,circuit-breaker,usage-gate,autonomy,untrusted,worker,workflow-client,db}.ts`, `tools/**` (~70 modules), `guardrails/**`, `cost/**`, `metrics/**`, `workflows/{AutonomousAgentWorkflow,PlanExecuteWorkflow}.ts`, `apps/dashboard/lib/{litellm-client,nango-client,nango-server,connector-registry,integrations-catalog,tool-allowlist,usage-gate}.ts`, `app/api/agent/**`, `infra/docker-compose.yml`, `infra/litellm/config.yaml`. Docs: `gap26sept/{agent-runtime,connectors,integrations-connectors}.md`.

**Headline.** ~109 model-facing tools, most with real provider calls and honest `notConnected`. Around them: (1) **cost accounting is blind** — in-process turns call Gemini/Groq directly, LiteLLM has no Langfuse callback, dashboard never passes `usage`, so the `llm_tokens` hard cap can never fill; (2) the confirm class (`send/pay/sign/publish/delete`) is enforced only by TrueForge approvals, **not by `executeAutonomousToolAction`**, so `/api/agent/tools` and plan steps run writes with no gate except pay RBAC; (3) `database_query` accepts data-modifying CTEs and `set_config` in a SELECT, and its `statement_timeout` is set outside the transaction; (4) the sandbox **falls back to running model code on the worker host with the full env** and the sandbox container shares the stack network with Postgres; (5) ~85 provider `fetch` calls have no timeout/abort and no write carries an idempotency key, while model-candidate failover, local→HTTP fallthrough and Temporal retries can each re-run tools; (6) `tool-definitions.ts` is duplicated verbatim inside `mcp-bridge.ts` (1,500 lines); (7) 21 test files incl. `runtime-hardening.test.ts` are not in the test script.

---

## 1. Tool catalog reality (summary — full per-tool table in the audit transcript; rows below are the ones that matter)

Every tool in `tool-definitions.ts` is mirrored in `mcp-bridge.ts:35-1535` and has an executor in `tools/index.ts` `TOOL_MODULES`. Real provider calls everywhere except sandbox/file_ops (local) and DB tools. Legend: **NC** honest `notConnected`; **Y\*** honest but **no catalog entry → user can never connect**; **confirm** = `riskFor()` class → requires confirm.

| Group | Tools (def line) | Real | NC | Confirm | Tests |
|---|---|---|---|---|---|
| WhatsApp | `whatsapp_send` :14 | API | Y (BYOK plaintext) | send→Y | none |
| Gmail | fetch :22, send :29, triage :41, extract_otp :49, extract_attachment :57, draft :70 | API | Y | send→Y; others N | signature parser only |
| Calendar | list :85, create :93, availability :110, update :1369 | API | Y | create/update→Y | google-calendar.test |
| GitHub | repos :125, create_repo :132, create_issue :139 | API | Y | publish/send→Y | none |
| HubSpot | create :152, update :164, list_deals :181, create_deal :188, update_deal :205, search :1333 | API | Y | **all draft→N** | sync_deal_schedule only |
| Ads | meta :224, google :232 | API | Y / dev-token ENV | N | none |
| Slack | send :240, read :247, decision_card :254 | API | Y (net err misreported) | send→Y | none |
| LinkedIn / Apollo | :268-289 | API | **Y\*** | N | honesty tests |
| Notion | :296-310 | API | Y | draft→N | none |
| Stripe | payment_link :317, charge :329, customer :696-703, refund :1317 | API | Y | pay→Y | stripe.test |
| Razorpay | :407 | API | Y (keys plaintext) | pay→Y | none |
| Shopify | :352-359 (+ hidden `update_order_address`) | API | Y | N | shopify.test |
| Zendesk / Intercom | :366-400, :710-722 | API | Y | intercom reply/create→Y; zendesk draft→N | none |
| Web | search :419, extract :426 | Serper/Jina/DDG | ENV | N | relevance only |
| DB | `database_query` :433, metrics :1167-1182, billing_usage :344 | DB | n/a | N | none |
| File / code | `file_ops` :441, `code_execution` :662, `terminal_run_command` :674, `python_execute` :685 | LOC | n/a | **draft→N (write reachable)** | none |
| Google Workspace | drive :454-508, docs :515-529, sheets :536-550, slides :564-629, forms :641, contacts :648, tasks :655, chat :734-741, meet :748-755, search console :762-769, GBP :781, cloud :788, GA :795 | API | Y | drive_share publish→Y; slides_delete→Y; chat_send→Y; rest N | drive/docs-sheets tests **not in script** |
| Microsoft | outlook :802-822, calendar :835-862 | API | Y | send/create→Y | none |
| Salesforce / Zoho | :876-936, :1029-1084 | API | **Y\*** | draft→N | zoho NC only |
| DocuSign / Leegality | :954-976, :1098-1122 | API | **Y\*** | sign→Y | leegality NC only |
| Maps | :991-998 | API | ENV | N | none |
| Twilio | :1010-1022 | API | **Y\*** | send→Y | none |
| QuickBooks | :1139-1160 | API | Y | N | NC only |
| Real estate | :1189-1279 | DB (+calendar) | n/a | showing_book send→Y | match/compliance tests |
| Growth / Customer / Ops / brief | :1240-1256, :1346-1358, :1387-1501 | DB | n/a | N (ops per `operations.ts:38-46`) | customer-ops, operations tests |
| Cognee | :1292-1305 | API | ENV | N | none |

**Hidden executor-only actions** reachable via `POST /api/agent/tools` with arbitrary `action`: `hubspot.list_contacts|sync_deal_schedule|reassign_owner`, `shopify.update_order_address` (draft, **no confirm**), `google-forms.forms_get_responses`, `google-tasks.tasks_create`, `sandbox.bash_execute|run_command`, `re.listings_sync_sheet|inquiry_list|validate_draft|charge_claim_paid|charge_close`, `billing.usage`, `daily_brief.query|get`.

## 2. Drift list

- `TOOLS` duplicated verbatim: `tool-definitions.ts:1-1513` and `mcp-bridge.ts:35-1535` (only `code_execution` description differs). Every new tool must be added twice.
- Catalog counts disagree: `AUTONOMOUS_TOOL_CATALOG` 41 providers (`tool-executor.ts:476-518`); `TOOL_MODULES` 57 (`tools/index.ts:67-121`); `INTEGRATION_CATALOG` 30 (`integrations-catalog.ts:71-631`); `CONNECTOR_REGISTRY_META` 26 (`connector-registry.ts:81-249`, missing quickbooks, microsoft-*). **Nine modules with no catalog entry** (uncontactable): salesforce, zoho, docusign, leegality, twilio, apollo, linkedin, maps, cognee.
- `CONNECTOR_RISK_CLASSES` includes `write_sor` (`connector-registry.ts:22-31`) absent from `tools/risk.ts`; `confirmPolicyFor` (`:253`) zero callers.
- **Three risk classifiers disagree:** `riskFor()` per module; `resolveActionType` regex (`shared-types/actions.ts:45-76`: `sheets_append_row`, `docs_append`, `drive_upload`, `cognee.remember`, `code_execution.execute` → `unknown` → `external_send`); `minAutonomyForTool` (`skills/catalog.ts:126-134`).
- `tool-allowlist.ts` `EXTRA_ALLOWED` aliases (`gmail_read`, `knowledge_search`, `order_lookup`, `calendar_reschedule`, `ticket_update`) validate but have no executor.
- `agent-runtime.md` row 5 "tests added" 🟢 — `runtime-hardening.test.ts` **not in test script**. Row 6 "AbortSignal / execution timeouts" — `executeWithTimeout` (`tool-executor.ts:67-82`) is a `Promise.race`, no abort. Row 8 sanitizer "before model sees tool JSON" — only on the in-process path (`local-turn.ts:436-453`); MCP bridge `formatResult` (`mcp-bridge.ts:1643-1665`) never calls `sanitizeToolOutput`.
- `docker-compose.yml:720-724` says sandbox is "fully isolated"; it is on `darex-net` (`:738-739`) with postgres, nango, mcp-bridge, trueforge, litellm, cognee.

## 3. Bugs

| ID | Sev | Where | What happens | Fix sketch | Status |
|---|---|---|---|---|---|
| RT-B01 | **P0** | `tools/database.ts:16,42-43` | Guard is `startsWith('select'|'with')`; `WITH d AS (DELETE FROM … RETURNING *) SELECT …` or `SELECT set_config('app.current_org_id',…)` passes. `SET LOCAL statement_timeout` runs **before** `BEGIN` → no-op. | `BEGIN READ ONLY` + `SET LOCAL` inside txn; deny `set_config|pg_|delete|update|insert` after literal stripping; or `darex_readonly` role. | 🟢 |
| RT-B02 | **P0** | `tools/sandbox.ts:162-216` (`:186 env:{...process.env}`) | Sandbox unreachable → model code runs on the **worker host** with all secrets in env; `payload.timeoutMs` unbounded. | Delete fallback; return error; clamp timeout. | 🟢 |
| RT-B03 | **P0** | `local-turn.ts:814-834`; `trueforge-client.ts:458-464`; `AutonomousAgentWorkflow.ts:5-16` + `activities/index.ts:152-251` | Three re-execution paths with no per-turn idempotency: next model candidate after a failure that already ran tools; local→HTTP fallthrough; Temporal `maxAttempts:2`. Sends/charges can double. | Mark "tools executed" → stop failover; `claimIdempotent` per (conversationId, inboundEventId); provider `Idempotency-Key` (B10). | 🔴 |
| RT-B04 | **P0** | `tool-executor.ts:67-82`; raw `fetch` without signal in gmail ×7, hubspot ×12, drive ×10, slides ×8, docs ×5, sheets ×5, github ×4, calendar ×4, shopify ×4, slack ×3, notion ×3, zendesk ×3, whatsapp | Executor resolves an error at 15 s but the request keeps running and can commit after the model was told it failed → model retries → duplicate. `TOOL_HTTP_TIMEOUT_MS=20_000` > executor 15 s. | Pass `AbortSignal` via `ToolActionContext`; module timeout ≤ executor timeout. | 🔴 |
| RT-B05 | **P0** | `tools/gmail.ts:30,155→275-288`; also `:41,126,174`; `google-drive.ts:122` | `!res.ok → []` then `status:'executed'`, "Fetched 0 real live emails" — 401/403/429 reported as success. | Return `apiError`/`revoked`; never coerce to empty. | 🟢 (2026-09-28: `gmailHttpFailure` & `googleDriveHttpFailure` return `status: 'error'` with `reason: 'revoked'|'insufficient_scope'|'api_error'`; non-2xx never returns `[]` or executed; verified in `gmail-http.test.ts` and `google-drive.test.ts`) |
| RT-B06 | **P0** | `local-turn.ts:407-412`; `stripe.ts:161 amount || 5000`; `razorpay.ts:34 amount || 50000`; `slack.ts:14 '#general'` | Malformed model JSON → `rawArgs = {}` silently; no zod parse against `def.schema`. Garbled call can charge ₹500/$50 or post to #general. | `def.schema.safeParse`; remove monetary/channel defaults. | 🔴 |
| RT-B07 | **P0** | `api/agent/tools/route.ts:39-41,68-74`; `tool-executor.ts:345-346` | Direct call with no `employeeRole` → `checkAutonomy` skipped; `ToolModule.confirm` never enforced by `executeAutonomousToolAction` (only by MCP `destructiveHint` and `local-turn.ts:464-478`). Any `send/sign/publish/delete` and hidden actions run unconfirmed; only pay RBAC. | Enforce `module.confirm(action)` in the executor regardless of caller; require approval token; validate payload. | 🟢 (2026-09-29: `resolveToolRisk` enforces `mod.confirm(action)` on tool modules alongside `confirmForRisk(risk)`; `tool-gate.ts` parks confirm-class actions across all callers; missing employee identity fails closed; verified in `executor-confirm.test.ts`) |
| RT-B08 | P1 | `local-turn.ts:612` (120 s), no max-iterations | In-process turn has no tool-call cap. | `maxIterations` + per-turn budget. | 🔴 |
| RT-B09 | P1 | `trueforge-client.ts:514-556` | 422 "approvals pending" → session deleted and recreated; pending approvals vanish; model re-plans the same write. | Resume/reject approvals via API. | 🔴 |
| RT-B10 | P1 | all write tools (`rg Idempotency-Key tools/` → 0) | No provider idempotency keys. | Derive from `sideEffectKey`; send to Stripe/Razorpay/Twilio/HubSpot. | 🔴 |
| RT-B11 | P1 | `activities/orchestration.ts:288-333` | `executePlanStepActivity` passes no `employeeRole` → autonomy skipped (pairs with ASK-S02). | Pass role; abort-aware. | 🟢 (2026-09-29: `executePlanStepActivity` resolves `resolvePlanStepActor(orgId, step)` and forwards real `employeeRole`/`employeeId`/`toolAllowlist` into `executeAutonomousToolAction`; covered by `plan-step-actor.test.ts`) |
| RT-B12 | P1 | `mcp-bridge.ts:1622-1623,1879-1883` | Model-supplied `args.employee_role` used when header role absent; `/messages` re-eval never updates `ctx.employeeRole`. | Header-only. | 🔴 |
| RT-B13 | P1 | `local-turn.ts:246-262` `noopTracing`; `:119-221` direct Gemini/Groq/OpenRouter | In-process turns emit no Langfuse spans, bypass LiteLLM; `result.usage` dropped (`ask-ai/route.ts:1268-1281`). | Langfuse generation with `usage` per candidate. | 🔴 |
| RT-B14 | P1 | `usage-gate.ts:199-206` | Meter read error → fail-open. | Fail-closed for hard limits; cache last state. | 🔴 |
| RT-B15 | P1 | `circuit-breaker.ts` | Client aborts and 400s count as provider failures. | Count 5xx/timeouts/network only. | 🔴 |
| RT-B16 | P1 | `provider-rate-limit.ts` (now `tools/provider-rate-limit.ts`) | In-memory per process → N× configured limit. Still real: `buckets = new Map()` module-local (2026-09-28 re-check). | Redis token bucket. | 🔴 (2026-09-28: file moved to `tools/provider-rate-limit.ts`; re-confirmed still an in-memory `Map` per process) |
| RT-B17 | P1 | `tools/shared.ts:298-314` | `resolveGoogleAuth` probes up to 48 Nango GETs per call behind a 60 s cache. | Persist resolved connection id. | 🔴 |
| RT-B18 | P1 | `trueforge-client.ts:431-438` | Session reuse never compares `instructions`; prompt/allowlist changes don't propagate. | Hash into session key. | 🔴 |
| RT-B19 | P1 | `worker.ts:48-53`; `shared.ts:23-30` | Default 100 concurrent activities × 12 min vs pool `max:10` and 384 MB → exhaustion/OOM; no heartbeat. | Concurrency ≈ pool size; heartbeats. | 🔴 |
| RT-B20 | P2 | `workflow-client.ts:55-60`; `agent/run:119`, `agent/stream:117` | `idempotencyKey` includes `Date.now()`; adhoc TrueForge sessions never deleted. | Client request id; TTL cleanup. | 🔴 |
| RT-B21 | P2 | `agent/stream/route.ts:218` | Polls 4 min; workflow may run 20 min. | Poll to workflow timeout / push. | 🔴 |
| RT-B22 | P2 | `tool-executor.ts:393` | `pending_approval` returns raw approval `token` into model context. | Return id only. **🟢 (2026-09-28: verified — `park` in `defaultGateDeps` (`tool-executor.ts:401-411`) destructures only `pendingActionId`/`workItemId` from `parkPendingAction`'s result and discards the raw `token`; `autonomy.ts:414-422` still generates the token but it never reaches the caller).** | 🟢 (2026-09-28: verified — `park()` (`tool-executor.ts:401-411`) returns only `pendingActionId`/`workItemId`; the raw token from `parkPendingAction` is generated but discarded before reaching the model) |
| RT-B23 | P2 | `mcp-bridge.ts:1557-1559`; `file-ops.ts:11-14,31` | `file_ops` risk computed from `auto_execute` → `readOnlyHint:true`, yet `write_file` writes. | Risk from remapped action. **🟢 (2026-09-28: verified — `file-ops.ts:7-14` now declares `ACTIONS=['read_file','write_file']` with `riskFor` returning `draft` for `write`/`create`; `mcp-bridge.ts:1557-1559` resolves risk from the real action name, no more `auto_execute` catch-all reading as always-read-only).** | 🟢 (2026-09-28: verified — `file-ops.ts:7-14` declares `ACTIONS=['read_file','write_file']` with `riskFor` correctly returning `draft` for writes; `mcp-bridge.ts` resolves risk from the real action, no more `auto_execute` catch-all read as read-only) |
| RT-B24 | P2 | only `meta-ads.ts:36` returns paging | Lists silently truncated to first page; model says "all". | `{items,nextCursor,truncated}` envelope. | 🔴 |
| RT-B25 | P2 | `slack.ts:145-149` | Network error → `notConnected` → user told to reconnect working Slack. | Distinguish. | 🔴 |
| RT-B26 | P2 | `role-capability.ts:29-41` | Persona by substring: `'isa'` matches "Lisa", `'ops'` "DevOps", `'lead'` "Team Lead". | Canonical enum. | 🔴 |
| RT-B27 | P2 | `autonomy.ts:501-531` | `notifyManagersOfDecisionCard` calls `executeProvider` bypassing allowlist/rate limit/timeout. | Through executor. | 🔴 |
| RT-B28 | P2 | `trueforge-client.ts:708-709` | `type.includes('approval')` broad match. | Exact list. | 🔴 |

## 4. Security

| ID | Sev | Where | Issue | Fix | Status |
|---|---|---|---|---|---|
| RT-S01 | **P0** | `docker-compose.yml:725-747` | Sandbox on `darex-net`: untrusted code reaches `postgres:5432`, `mcp-bridge:8790`, `trueforge:8790`, `litellm:4000`, `cognee:8000`, `nango-server:3003`. `SANDBOX_MAX_CONCURRENT=2` global → cross-tenant DoS. | Dedicated internal network `sandbox-net` (`internal: true`, no access to `darex-net` or internet), `read_only: true`, `cap_drop: ALL`, `pids_limit: 64`. Per-tenant semaphore & concurrency tracking (max 2 concurrent per org) in `sandbox.ts` and `server.mjs`. | 🟢 (2026-09-29: Verified — dedicated `sandbox-net` has `internal: true` with zero egress to `darex-net` or internet; `server.mjs` and `sandbox.ts` track active runs per tenant (`x-org-id`), enforce per-tenant limit of 2 concurrent runs preventing starvation, and forward `orgId`; tested in `sandbox-no-host.test.ts`) |
| RT-S02 | **P0** | `sandbox.ts:186` | Host fallback leaks `process.env` to model code. | See B02. | 🟢 |
| RT-S03 | **P0** | `database.ts` | RLS GUC mutable via `set_config` in SELECT; CTE writes → cross-tenant read/write from chat. | Read-only role + txn; deny `set_config`/`pg_*`. | 🟢 |
| RT-S04 | **P0** | `whatsapp.ts:51-57`, `razorpay.ts:15-23` | BYOK tokens plaintext in `channels.meta` / `nango_connection_id='manual_json:{…}'`. | Envelope-encrypt per org. | 🔴 |
| RT-S05 | P1 | `web-extract.ts:11-49,102-131` | SSRF check hostname-string only: no DNS resolution (rebinding), no redirect re-check, no IPv6, no decimal/octal IPs; body unbounded; Jina proxies arbitrary URLs. | Resolve + check every hop, `redirect:'manual'`; block link-local/metadata; cap body. **🟢 (2026-09-28: verified — new `tools/safe-url.ts` (`assertPublicUrl`/`safeGet`, see `WEB-S01` in `14-web-search-extract-tabs-engine.md`) rejects non-canonical IP literals, resolves every A/AAAA record inside the connecting socket's DNS lookup (no rebind gap), re-checks every redirect hop (max 5), and caps the decoded body at 5 MB; `web-extract.ts:1-4,42-52` now calls `assertPublicUrl` before both the Jina and direct-fetch paths. 7 unit tests in `safe-url.test.ts` plus live checks per `BUILD_STATE.md`).** | 🟢 (2026-09-28: same fix as `WEB-S01` — `tools/safe-url.ts` does real DNS resolution at connect time, re-checks every redirect hop, blocks non-canonical IP literals/link-local/metadata; `web-extract.ts` calls it before both Jina and direct-fetch paths; 7 unit tests + live checks) |
| RT-S06 | P1 | `gmail.ts:437-438,516-518` | `To:`/`Subject:` raw into RFC-822 → CRLF header injection (extra `Bcc:`). | Strip CRLF; RFC 2047. | 🔴 |
| RT-S07 | P1 | `mcp-bridge.ts:1643-1665`; `guardrails/tool-sanitizer.ts:6-12` | HTTP-sidecar path has **no** prompt-injection fence; sanitizer is 5 regexes. | Sanitize in `formatResult`; instruction filter. | 🔴 |
| RT-S08 | P1 | `mcp-bridge.ts:1622-1623` | Model-controlled `employee_role` alters capability gating. | Header-only. | 🔴 |
| RT-S09 | P1 | `tool-executor.ts:28-39` | `ALWAYS_ALLOWED_CORE_TOOLS` includes `code_execution`, `terminal_run_command`, `python_execute`, `file_ops` for **every** employee. | Opt-in per plan and employee. | 🟢 |
| RT-S10 | P1 | `whatsapp.ts:71`, `google-ads.ts:18` | Global env fallbacks let one tenant send/read via the platform's own account; `payload.phoneNumberId` model-controlled. | Bind sender to org connector row. | 🔴 |
| RT-S11 | P1 | `infra/docker/prod-failfast.sh:10-24` | Fail-fast skips `MCP_BRIDGE_SECRET`, `NANGO_SECRET_KEY`, `LITELLM_MASTER_KEY` (default `sk-darex-litellm-dev-key`), Langfuse dev keys. | Assert non-default. | 🔴 |
| RT-S12 | P1 | `trueforge-client.ts:365,493` | TrueForge HTTP API has no auth header; anything on `darex-net` can drive sessions. | Auth token. | 🔴 |
| RT-S13 | P2 | `gmail.ts:198-215` | `extract_otp` returns OTPs into model context/transcripts. | Mask. | 🔴 |
| RT-S14 | P2 | `stripe.ts:71` | Returns PaymentIntent `clientSecret` to model. | Strip. | 🔴 |
| RT-S15 | P2 | `file-ops.ts:41,62` | `orgId || 'default'` shared dir; absolute host path returned. | Require orgId. | 🟢 |
| RT-S16 | P2 | `compose:571-579`, `worker.ts:6-17` | Bridge/worker load `apps/dashboard/.env.local` and `services/connectors/.env` → every service holds every secret. | Per-service env. | 🔴 |
| RT-S17 | P2 | `shared.ts:20-21` (now `tools/shared.ts:16-19`) | Dev DB password default compiled into worker. Still real: `runtimeDbPassword` falls back to `'darex_app_dev_secret'` (2026-09-28 re-check). | Fail at startup. | 🔴 (2026-09-28: file moved to `tools/shared.ts:16-19`; re-confirmed `darex_app_dev_secret` default still compiled in) |
| RT-S18 | P2 | `tool-executor.ts:214-219` | `isToolAllowed` prefix fallback: allowlisting `stripe` grants `stripe_create_charge`. | Exact match. | 🟢 |

## 5. Functional / enterprise gaps

| ID | Gap | Evidence | Status |
|---|---|---|---|
| RT-G01 | **Cost accounting is blind.** `llm_tokens` = Langfuse weekly cost (`billing/_lib.ts:1120-1180`); in-process turns bypass LiteLLM + Langfuse; `infra/litellm/config.yaml` has no `callbacks: [langfuse]`; dashboard traces omit `usage`; `recordModelSpend` 0 callers. Hard cap can never trip. | Fix B13; LiteLLM Langfuse callback with `user_id=orgId`; call `recordModelSpend`. | 🟢 (2026-09-29: `getOrgModelSpend` in `apps/dashboard/app/api/billing/_lib.ts` aggregates model spend from `org_model_spend` in Postgres, populated by `recordModelSpend` across all worker/in-process turns; `refreshOrgMeters` uses `Math.max(langfuse, dbSpend)` and never drops `llm_tokens` when Langfuse is down, correctly tripping hard cap circuit breakers. Verified in `org-model-spend.test.ts`.) |
| RT-G02 | No per-org concurrency/QPS on `agent/run|stream|crew|tools` (no `assertUsageAllowed`, no rate limit). | Shared limiter middleware. | 🔴 |
| RT-G03 | Approval state process-local: `activeLocalOrchestrators` (500 cap / 30 min) — lost on restart or second replica. | Persist in `agent_pending_actions`. | 🔴 |
| RT-G04 | `agent/pending-actions` approves without executing; `work-items/[id]/decision:335-344` executes with `skipAutonomy`. Divergent. (2026-09-28 re-check: `skipAutonomy` no longer exists in `work-items/[id]/decision/route.ts` — that route now signals the Temporal workflow via `approveWorkItem`, a different mechanism than described, but the two paths still diverge: `pending-actions/route.ts` still only flips DB status to approved/rejected and never executes the parked action itself.) | One approval executor (pairs with OPS approvals map). | 🔴 (2026-09-28: mechanism changed — `work-items/[id]/decision` now signals Temporal via `approveWorkItem`, `skipAutonomy` no longer used there — but the core problem is unchanged: `pending-actions/route.ts` still only flips DB status, never executes) |
| RT-G05 | No pagination contract, no `truncated` beyond 20 k cut. | Standard envelope. | 🔴 |
| RT-G06 | No structured audit of tool invocations (console only). | Append-only `tool_invocations` (org, employee, tool, action, risk, args hash, status, latency, cost). | 🔴 |
| RT-G07 | No token-budget/context management on in-process path. | Budget + compaction. | 🔴 |
| RT-G08 | Nango 401 during call not retried with fresh token (gmail/hubspot/drive). | Invalidate + retry once. | 🔴 |
| RT-G09 | No provider SLO metrics (breaker state, failover, latency). | Export. | 🔴 |
| RT-G10 | Worker healthcheck `process.exit(0)`. | Heartbeat probe. | 🟡 |
| RT-G11 | Temporal client no TLS/API key. | Env-driven. | 🔴 |
| RT-E01 | Nine tool modules have no connect UI → dead capability contradicting "never fabricate". | Catalog entries or drop defs. | 🔴 |
| RT-E02 | `agent-runtime.md` "Status: closed" while B01–B07 open. | Reopen rows 5, 6, 8. | 🔴 |
| RT-E03 | No backup/DR for `trueforge-data`, `workspace_storage`. | Backups + drill. | 🔴 |
| RT-E04 | No per-tenant LLM key routing (LiteLLM single team, `config.yaml:46`); BYOK not isolated. | LiteLLM virtual keys per org. | 🔴 |
| RT-E05 | Runtime pinned to `@truefoundry/trueforge-core@0.2.0-rc.0`. | Pin GA or vendor; eval gate before upgrade. | 🔴 |

## 6. Dead / duplicate

- `mcp-bridge.ts:35-1535` — import `TOOLS` from `tool-definitions.ts`.
- `cost/track.ts recordModelSpend` — 0 callers. **(2026-09-28: no longer dead — `trueforge-client.ts:456` `trackTurnSpend` now calls it after every turn; see RT-G01.)**
- `connector-registry.ts:253 confirmPolicyFor`, `write_sor`.
- `agent-engine.ts` — LangGraph re-export shim.
- `tool-allowlist.ts EXTRA_ALLOWED` aliases.
- `AUTONOMOUS_TOOL_CATALOG` vs `INTEGRATION_CATALOG` vs `TOOL_MODULES`.
- Three risk classifiers; `plan-steps.ts:40-58` re-implements keyword risk.
- `trueforge-client.ts:245-270` v1/v2/v3 signature candidates — retire v1/v2.
- `sandbox.ts:18-22` hardcoded candidate URLs; `:43-53` numeric heuristic.

## 7. Test coverage

Runtime core: `runtime-hardening.test.ts` **not in script**; `local-tool-select`, `autonomy`, `untrusted`, `prompts/system-prompt` ✓. **No tests**: `tool-executor.ts` (allowlist, timeout, gate, pending token), `mcp-bridge.ts` (HMAC, org_id strip, session caps), `trueforge-client.ts`, `local-turn.ts` (arg parsing, failover, approval), `agent-client`, `workflow-client`, `usage-gate`, `provider-rate-limit`, `db.ts` idempotency, `AutonomousAgentWorkflow`, `PlanExecuteWorkflow`, `worker`.

Tools with tests in script: gmail (parser), calendar, hubspot (one action), shopify, stripe, customer-ops, web-search (relevance), zoho/leegality/quickbooks (NC only), linkedin/apollo (honesty), realestate, role-capability, operations. **21 present but never run** (see 09 §7). **No tests at all**: whatsapp, github, meta/google ads, slack, notion, zendesk, intercom, razorpay, web-extract (SSRF), database (SQL guard), file-ops (traversal), sandbox, most Google Workspace live paths, microsoft-*, salesforce, docusign, maps, twilio, metrics, growth, daily-brief, cognee, billing. Dashboard: `litellm-client`, `nango-client`, `nango-server`, `connector-registry`, `integrations-catalog`, `tool-allowlist`, `usage-gate` — none.

## 8. Fix order for this domain

1. **RT-B02 / S01 / S02 / S09** — sandbox: no host fallback, isolated network, opt-in per employee.
2. **RT-B01 / S03** — `database_query` read-only transaction + token denylist + read-only role.
3. **RT-B07 + RT-B11** — enforce `module.confirm` in `executeAutonomousToolAction` for every caller (pairs with ASK-S02, EMP-S02).
4. **RT-B04 + RT-B10 + RT-B03** — AbortSignal through every fetch; provider idempotency keys; per-turn idempotency across failover/retry.
5. **RT-B05 / B06** — non-2xx is never success; zod-parse tool args; delete monetary defaults.
6. **RT-G01 / B13** — usage through LiteLLM with Langfuse callback keyed by org + employee; `recordModelSpend` on every call; fail-closed hard caps (B14).
7. **RT-S04** — encrypt BYOK at rest; remove env fallbacks (S10).
8. **RT-S05 / S06 / S07 / S08** — SSRF hardening, header injection, sanitizer on bridge path, header-only role.
9. **Drift** — single `TOOLS` source; one risk classifier; catalog entries for the nine orphan providers or drop them.
10. **RT-G06** — `tool_invocations` audit table; **RT-B19** — worker concurrency/heartbeats; tests for executor, bridge, sandbox, database, web-extract before calling any row done.
