# 02 — What We Built

Complete inventory as of 2 September, migration `021`. Every line here exists in
code with a file path or a migration number. Where something is real but blocked
on credentials, it is marked **ops-blocked** — never "done".

Detailed references: `14` (data model), `15` (workflows), `16` (API), `17`
(operations), `18` (evals).

---

## 1. Platform foundation

### 1.1 Monorepo

pnpm workspaces + turbo. `apps/dashboard` (Next.js), `apps/inbox` (Chatwoot
fork), `services/workflows` (Temporal worker + tools + agent engine),
`services/connectors` (provider OAuth/BYOK wrappers), `packages/shared-types`,
`packs/` (industry bundles), `infra/` (compose, migrations, scripts, evals).

Node ≥ 20, pnpm ≥ 9. `./start.sh` is the single entry point; `pnpm dev` runs the
dashboard on the host against containerised infra.

### 1.2 Database — 21 migrations, ~2,870 lines of SQL

`001_core_schema` → `021_org_sql_connections`. Roughly 45 tables. The schema is
where most product guarantees live: state machines as `CHECK` constraints,
idempotency as unique indexes, tenancy as RLS policies, provenance as columns.

**Tenancy is not optional anywhere.** Every tenant table carries:

```sql
ALTER TABLE t ENABLE ROW LEVEL SECURITY;
ALTER TABLE t FORCE ROW LEVEL SECURITY;
CREATE POLICY t_org_isolation ON t
  USING      (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON t TO darex_app;
```

`FORCE` closes the table-owner bypass. `WITH CHECK` (added across the board in
`008_rls_with_check`) closes the cross-tenant *write* hole that `USING` alone
leaves open. Applications connect as `darex_app`, a non-superuser role.
`002_rls_test.sql` and `infra/scripts/check-memory-rls.sql` prove isolation
across two orgs, including for vector search.

### 1.3 Runtime services

| Service | Role |
|---|---|
| Dashboard (Next.js) | UI, ~70 API routes, SSE, plan confirm |
| Worker (`services/workflows`) | Temporal worker: 15 workflows, activities, tool execution |
| Connectors | Provider OAuth/BYOK wrappers |
| Inbox (Chatwoot fork) | Unified conversations |
| Atomic Agent | Agent loop runtime with tool grammar |
| MCP Bridge | Darex tools over MCP as `mcp.darex.*` |
| Sandbox | Isolated code execution |
| Postgres + pgvector | System of record **and** vector store |
| PgBouncer | Connection pooling |
| Redis | Queues, caches |
| Temporal + UI | Durable execution |
| Nango | OAuth broker |
| LiteLLM | Model gateway |
| Langfuse | Tracing and cost |
| Supertokens | Authentication |

### 1.4 Boot and verification

`./start.sh` builds, boots, migrates, health-checks, and runs probes. Flags:
`--dev`, `--no-build`, `--seed`, `--checks`, `--down`. **`ALL CHECKS PASSED` is
the only signal that means working.** `--checks` performs a live register →
login → `/api/integrations` round trip against the real dashboard.

Current check status: Phase 0 **17/17**, Phase 2 **17/17**, Phase 3 **6/6**,
Auth + Nango **3/3**.

---

## 2. The reasoning loop

**classify → plan → confirm → execute → trace → write back.**

### 2.1 Classify

`lib/classify.ts` decides simple answer vs. multi-step job, returning a type and
a confidence. Calls LiteLLM **directly** through `lib/litellm-client.ts` (an
OpenAI-compatible client, base `http://litellm:4000/v1` in prod), not the agent
loop — because the agent loop injects the full GBNF tool grammar and every tool
descriptor, which made the model attempt real tool calls inside a plain JSON
completion, producing malformed concatenated JSON and 90-second hangs.

`reasoning: { enabled: false }` and `max_tokens: 300`. Without this, a reasoning
model burns the whole budget on `reasoning_content` and returns empty `content`.

### 2.2 Plan

`lib/plan-generator.ts` (`max_tokens: 800`) emits ordered steps
`{id, description, tool, action, payload, enabled}` persisted in
`agent_plans.steps JSONB` with a `planId`, a `summary`, `reasoning`, and a
`draft` for the artifact to be produced.

### 2.3 Confirm

The plan renders for approval. `PATCH` approves. `agent_plans.feedback` carries
a revision instruction into `/api/ask-ai/revise` (`max_tokens: 1000`), so the
human can edit the draft and re-plan without starting over. `current_step`
makes partial execution observable.

### 2.4 Execute — with a risk-based split

`plan-steps.ts` classifies each step:

```
read, draft                          → HTTP SSE path (fast, cheap)
send, pay, sign, publish, delete     → PlanExecuteWorkflow (Temporal, durable)
```

Any single durable-risk step sends the **whole plan** to Temporal. Resolution
uses `resolveToolRisk(tool, action)` from the registry first, then a
string-heuristic fallback on send/pay/sign/publish/delete verbs — an
unclassified tool still fails closed. Disabled steps are excluded from the scan.

SSE emits `execution_start` / `step_start` / `step_done` / `execution_done` with
monotonic `seq` for resumable streaming. `PlanExecuteWorkflow` exposes
`planProgressQuery`, so the UI reads workflow state directly rather than a side
table that can drift. Terminal states: `completed`, `completed_with_errors`,
`cancelled`.

### 2.5 Trace and write back

Langfuse receives `PlanGenerated`, per-step `PlanExecution-<tool>`, and
`PlanExecutionSummary`, with per-org attribution. `MemoryWriteBackWorkflow`
persists durable conclusions; `enqueueEmbedActivity` schedules embedding.

**Verified live:** complex prompt → `type:"complex"` (confidence 0.75) → plan
with a Gmail `draft_email` step and a 291-char draft → `planId` persisted →
PATCH approve → streamed execution in ~13s. Simple prompt → clean answer in ~6s.

---

## 3. Agent runtime

| Component | File | Role |
|---|---|---|
| Agent engine | `agent-engine.ts` | The employee execution loop |
| Employee router | `route-employee.ts` | Who owns this request |
| Crew runner | `crew-runner.ts`, `crew-contract.ts` | Multi-agent under contract |
| Tool executor | `tool-executor.ts` | Allowlist enforcement, connector tokens, execution |
| MCP bridge | `mcp-bridge.ts` | `mcp.darex.*` |
| Inbound HITL | `inbound-hitl.ts` | Escalate rather than guess |
| Quiet hours | `quiet-hours.ts` | Outbound restraint |
| Plan steps | `plan-steps.ts` | Risk classification and durable routing |
| Memory retrieve | `memory/retrieve.ts` | Cited recall |
| Packs | `packs/install-pack.ts`, `manifests.ts` | Pack installation |

### 3.1 Routing (`route-employee.ts`)

Pure and isolate-safe — no Node, no `pg`, no `fetch`. Returns
`{destination, employeeId, confidence, reason, locked}` where destination is
`employee | human | dispatch`.

Rules encoded:
- **Explicit mention wins.** `ASK_TO_RE` (`ask @name to …`) and `AT_MENTION_RE`.
- **Greetings never fan out.** `GREETING_RE` matches hi/hello/namaste/thanks and
  short-circuits — no crew, no tools, no cost.
- **Emergencies route to a human.** `EMERGENCY_RE` matches gas leak, carbon
  monoxide, burst pipe, flood, fire, smoke, sparks, no heat, no power,
  electrical fire, after-hours emergency. These go to `human`/`dispatch`,
  **never** to an ISA or sales employee.
- **Roster keys** (`sales | support | ops | research | finance | dispatch |
  other`) with weighted keyword matching, not hardcoded employee ids.
- **Always solo.** A single request never fans out to multiple employees;
  crews are explicit.
- `preferredEmployeeId` is a hint from the prior assignee, explicitly **not a
  name lock**.

### 3.2 Tool allowlist resolution

```
org allowlist = ⋃ (tool_allowlist of ALL active ai_employees)
              ∪ core tools (web_search, web_extract, database_query, db_query,
                            sql_analytics, file_ops, file_system, workspace_file,
                            sandbox, code_execution, execute_code)
              ∪ every connector the org has actually connected
```

Plus an explicit per-plan `toolAllowlist` on the execute path.

This replaced a fallback that selected one arbitrary active employee and
therefore blocked tools the org genuinely owned. Verified after the fix:
`google-sheets sheets_create` executed against a real Sheet, `google-drive
drive_list` returned 27 real files, `web_search` passed the allowlist.

### 3.3 Crews

`MAX_CREW_SPAWN = 3`, deterministic child workflow ids, and a synthesis prompt
that instructs the manager not to redo specialist tool work, **to say so
honestly when a specialist hit `notConnected`**, and never to mention Temporal
or internal routing.

### 3.4 The critic

`WorkItemWorkflow` calls a `criticCheck` activity and can emit a
`critic_blocked` work event. A reply can be stopped by a review pass before it
leaves the building, and the block is a first-class observable outcome rather
than a silent no-op.

---

## 4. Tools and connectors

**50+ executor modules** in `services/workflows/src/tools/`:

- **Google (17):** Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks,
  Contacts, Chat, Meet, Maps, Analytics, Search Console, Business Profile, Ads,
  Cloud.
- **Microsoft (2):** Outlook, Calendar.
- **CRM / support (5):** HubSpot, Salesforce, Zoho, Intercom, Zendesk.
- **Messaging (4):** WhatsApp, Slack, Twilio, Google Chat.
- **Commerce / finance (4):** Stripe, Razorpay, Shopify, QuickBooks.
- **Docs / signing (3):** Notion, DocuSign, Leegality.
- **Engineering (2):** GitHub, Sandbox.
- **Data / web (6):** database query, `sql_analytics`, org SQL connections, web
  search, web extract, file ops, metrics, risk.
- **Vertical:** `tools/realestate/` (MLS + realestate), `tools/public/rera.ts`.

### 4.1 Risk classification (`tools/risk.ts`)

```ts
type ToolRisk = 'read' | 'draft' | 'send' | 'pay' | 'sign' | 'publish' | 'delete';
confirmForRisk(risk)  // read, draft → false; everything else → true
```

Exhaustiveness is enforced with a `never` check, so adding a risk class without
deciding its confirm behaviour is a compile error.

### 4.2 Connector registry (`014`)

`connector_defs` is data: `nango_key`, `auth_mode`, `risk_class`,
`confirm_policy`, `vertical_tags`, `mcp_tools`, `extra_connect_fields`,
`extra_test_fields`, `executor_status`, `testable`, `scopes`, `env_vars`,
`webhook_events`. Adding a connector to the UI needs no dashboard deploy, and
`executor_status` stops the UI advertising an executor that does not exist.

### 4.3 The honesty guarantee

A tool whose connector is not connected returns:

```json
{"status":"error","data":{"connected":false},"setupUrl":"/connectors"}
```

Enforced by `infra/evals/honesty-connectors.yaml` (which writes down the exact
plausible lie as `negativeOutput` and asserts it never appears),
`disconnected-sheets-mls.yaml`, and the live module test
`wave-b-c6-honesty.test.ts`. `connected` cannot pass without a recorded provider
fixture.

### 4.4 Sandbox

`infra/docker/sandbox` (node 20 + python 3). `POST /execute {language, code,
timeoutMs}` → `{result:{stdout,stderr,exitCode}}`. Unprivileged user, hard
timeout, **no outbound network, no DB access**. Verified: python `6*7=42`, node
`1+1=2`, bash `hi there`.

### 4.5 Ops-blocked

Slack, HubSpot, Stripe, Notion, Shopify, Zendesk, Intercom, Zoho and QuickBooks
need real OAuth client IDs in Nango. Leegality needs a BYOK token. Executors and
registry rows are complete; this is an operations task.

---

## 5. Channels and perception

| Channel | Route | Notes |
|---|---|---|
| WhatsApp | `/api/webhooks/whatsapp` | BYOK credentials, inbound + outbound |
| Owner WhatsApp | `/api/webhooks/owner-whatsapp` | **Signals approve/reject on a running workflow** |
| Chatwoot / inbox | `/api/webhooks/chatwoot` | HMAC-SHA256 `x-chatwoot-signature` |
| Gmail | `/api/webhooks/gmail` | Push notifications |
| Instagram | `/api/webhooks/instagram` | Present |
| SMS | `/api/webhooks/sms` | Present |
| Outbound status | `/api/webhooks/outbound` | Delivery receipts |
| Billing | `/api/webhooks/billing` | Stripe / Razorpay |
| Public widget | `/embed/widget.js`, `/api/widget/*` | Tenant from **site-key hash**, never body `org_id` |

All inbound follows: verify signature → persist to the webhook inbox (`010`) →
return 200 → `fireInboundAgent`. Deduplication on `messages.channel_key`
(`018`).

Sync and ingest: `SyncWorkflow` with `sync_cursors` per `(org_id,
connector_key)`; `IngestWorkflow` driving `ingestion_jobs` over
`knowledge_sources`.

---

## 6. Memory (`013_memory_rag`, 381 lines)

Four tiers plus a relation graph, all RLS-scoped:

| Table | Scope | Retrieved when |
|---|---|---|
| `org_memory` | org | Every turn — SOP, brand, FAQ, area book, policy |
| `employee_memory` | `employee_id` | That employee's turns |
| `entity_memory` | `(entity_type, entity_id)` | Entity in scope — confirmed facts |
| `conversation_memory` | `conversation_id` | Same thread and similar threads |
| `memory_edges` | `rel`, `weight` | Multi-hop expansion |

**Hybrid from day one.** Every tier has a GIN index on a generated `body_tsv`
**and** a partial HNSW cosine index on `embedding IS NOT NULL`. Rows are
lexically searchable the instant they land and become semantically searchable
when the embed worker catches up. Scope btrees enable lock-first retrieval when
the query names an entity.

**Idempotent ingest:** unique index on `(org_id, source, source_ref,
content_hash)`; unchanged content is a no-op and re-embedding is skipped.

**`retrieveMemory`** (`memory/retrieve.ts`): five citation tiers (`org`,
`employee`, `entity`, `conversation`, `working`), token budget default 3000
(clamped 256–4000), `MEMORY_RETRIEVE_TIMEOUT_MS` default **1200ms**, embedding
timeout 400ms, staleness at 21 days, 12 rows per tier, 480-char snippets.
Candidate rows carry `fts_rank`, `vec_sim`, `entity_lock` and `same_thread` as
separate ranking signals.

The empty state is a constant, not an improvisation:

```
Retrieved facts (cite ids, do not invent):
no stored memory
If a fact is missing, say it is missing. Tools still run.
```

**Deliberately absent:** KYC / PAN / Aadhaar columns, documented in the
migration. The vertical handles identity documents; the vector store refuses to
be where they live.

---

## 7. Insight, learning and analytics (`020`)

- `ask_ai_feedback` — `vote` CHECK-constrained to up/down, joined to
  conversation, plan and message. Explicit human judgement per plan.
- `org_playbook_promotions` — **the "always do this" table.** A user promotes a
  working plan into a named playbook. `playbook_id LIKE 'org.%'` so org
  playbooks can never collide with platform ones; unique per org; name 3–80
  chars; `named_by_user_id ON DELETE RESTRICT` preserves authorship.
- `InsightActionWorkflow` (220 lines) — an insight card names a **specific
  workflow**, and "Review Action" enqueues real durable execution.
- `/api/analytics` and `/api/analytics/cost` read the same metrics registry the
  insight cards do, so the two surfaces cannot disagree.

---

## 8. Governance

- RLS with `FORCE` + `WITH CHECK` everywhere; `darex_app` role.
- `audit_events` (`016`) with `actor_type`, `actor_user_id`,
  `actor_employee_id`, `actor_component`, `work_item_id`, `plan_id`,
  `confirm_id`, **`approver_user_id`**, `tool`, `action`, `risk_class`,
  `model`, `prompt_hash`, `langfuse_trace_id`, `result_status`.
- `human_roles` (`019`).
- `dsr_requests` + `/api/dsr/export` and `/api/dsr/delete`.
- `idempotency_keys` with expiry.
- Quiet hours: default 21:00–08:00, wrap-around aware, with
  `hoursUntilQuietEnd()` used to reschedule rather than drop.
- Typed nurture cancel reasons: `inbound | takeover | do_not_contact |
  rejected | emergency_stop`.
- Billing (`017`): provider-agnostic subscriptions, and meters carrying
  `soft_limit`, `hard_limit`, and `truncated`.

`prompt_hash` + `model` + `approver_user_id` in one audit row means "which
prompt version produced this action, and who authorised it" always has an
answer.

---

## 9. Packs

| Pack | State | Contents |
|---|---|---|
| `core-b2b` | Shipped, `live: true`, markets `[IN, US, AE, GB]` | Sarah / Emma / Marcus; 7 entities; OwnerBriefing + StaleChase; 2 KPIs; compliance |
| `re-brokerage-in` | Shipped | Aisha / Kabir / Meera; `MARKETS.md`; ShowingSchedule + RentReminder; RERA compliance |
| `real-estate-pm` | RFC only | Specified, not built |

`core-b2b` compliance block, verbatim in shape:

```yaml
compliance:
  extraConfirmClasses: [send, pay, sign]
  bannedPhrases: [guaranteed returns, assured returns]
  blockedDataClasses: [kyc, pan, aadhaar]
  marketModules: [GDPR, DPDP]
```

Every employee persona carries an explicit refusal: *"never invent pipeline
amounts"*, *"never invent order status"*, *"never invent KPIs"*, *"never invent
inventory, price, or RERA"*. Honesty is written into the roster, not only the
platform.

`packs` supports `extends` for inheritance; `org_packs.status` is CHECK-
constrained through `pending → installing → installed | failed → uninstalling
→ disabled | uninstalled`.

---

## 10. Workflows — 15 types, 2,194 lines

`WorkItemWorkflow` (583) · `PlanExecuteWorkflow` (225) ·
`InsightActionWorkflow` (220) · `CrewWorkflow` (166) · `SyncWorkflow` (151) ·
`NurtureWorkflow` (150) · `OwnerBriefingWorkflow` (111) ·
`StaleChaseWorkflow` (106) · `AutonomousAgentWorkflow` (98) ·
`IngestWorkflow` (81) · `RentReminderWorkflow` (63) ·
`ShowingScheduleWorkflow` (62) · `EmbedWorkflow` (61) ·
`MemoryWriteBackWorkflow` (53) · `InstallPackWorkflow` (40).

Full detail in `15`.

---

## 11. Dashboard

Pages: `ask-ai`, `employees`, `brain`, `conversations`, `connectors`,
`integrations`, `plans`, `skills`, `insight`, `analytics`, `listings`,
`inquiries`, `billing`, `settings`. Route groups for `(auth)`, `(dashboard)`,
`(onboarding)`, plus `/embed`.

~70 API routes across reasoning, agents, employees, brain, conversations,
integrations, webhooks, widget, vertical surfaces, work items, insight,
analytics, packs, auth (including SSO), org, settings, audit, DSR, billing,
stream and health. Full detail in `16`.

---

## 12. Quality tooling

- 6 promptfoo golden suites with fixtures and providers.
- Pure unit tests: `route-employee.test.ts`, `retrieve.test.ts`,
  `inbound-hitl.test.ts`; live module test `wave-b-c6-honesty.test.ts`.
- 10+ verification scripts (`check-phase0/2/3`, `check-auth-nango`,
  `check-phase6-memory`, `check-retrieve-memory`, `check-memory-rls.sql`,
  `check-two-replica-sse`, `e2e-live-llm`).
- 5 alerting scripts: connector 401s, queue lag, Langfuse ingest, RLS job, and
  a combined runner.
- `restore-drill.sh` + `restore-drill.md`.
- Pre-push typecheck guard.
- `OPERATOR_HYGIENE.md`.
