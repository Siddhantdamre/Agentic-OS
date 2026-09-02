# 03 — System Architecture

## 1. The six layers

```
┌──────────────────────────────────────────────────────────────────┐
│  6. LEARNING     Langfuse traces · goldens · ask_ai_feedback ·   │
│                  playbook promotions · memory write-back         │
├──────────────────────────────────────────────────────────────────┤
│  5. GOVERNANCE   RLS · allowlists · risk classes · confirm ·     │
│                  audit_events · quiet hours · compliance         │
├──────────────────────────────────────────────────────────────────┤
│  4. ACTION       50+ tools · Nango · MCP bridge · sandbox ·      │
│                  Temporal activities · idempotency keys          │
├──────────────────────────────────────────────────────────────────┤
│  3. REASONING    classify → plan → route → crew → critic         │
├──────────────────────────────────────────────────────────────────┤
│  2. MEMORY       4 tiers · memory_edges · hybrid FTS+HNSW        │
├──────────────────────────────────────────────────────────────────┤
│  1. PERCEPTION   8 webhook routes · widget · syncs · ingest      │
└──────────────────────────────────────────────────────────────────┘
```

Every feature names the layer it belongs to. A feature spanning all six is a
product, not a feature, and needs a design doc.

## 2. Runtime topology

```
                    ┌─────────────┐
   browser ────────►│  Dashboard  │◄──── SSE ──── browser
                    │  (Next.js)  │
                    └──────┬──────┘
        ┌──────────────────┼──────────────────┬─────────────┐
        ▼                  ▼                  ▼             ▼
  ┌───────────┐     ┌────────────┐     ┌───────────┐  ┌──────────┐
  │ Supertokens│     │  LiteLLM   │     │  Temporal │  │  Nango   │
  │   (auth)   │     │ (LLM gate) │     │  (durable)│  │  (OAuth) │
  └───────────┘     └─────┬──────┘     └─────┬─────┘  └────┬─────┘
                          │                   │             │
                    ┌─────▼──────┐      ┌─────▼──────┐      │
                    │  Langfuse  │      │   Worker   │◄─────┘
                    │  (traces)  │◄─────│ (workflows)│
                    └─────┬──────┘      └──┬───┬───┬─┘
                          │                │   │   │
                    ┌─────▼─────┐   ┌──────▼┐ ┌▼───▼────┐
                    │ ClickHouse│   │Sandbox│ │MCP Bridge│
                    └───────────┘   └───────┘ └─────────┘
                          │
        ┌─────────────────┴──────────────────┐
        ▼                                     ▼
  ┌──────────┐                          ┌─────────┐
  │ PgBouncer│──► Postgres + pgvector    │  Redis  │
  └──────────┘                          └─────────┘
```

| Service | Responsibility | Failure impact |
|---|---|---|
| Dashboard | UI, ~70 API routes, SSE, confirm | No new requests; running workflows continue |
| Worker | 15 workflows, activities, tool execution | Workflows queue and resume on restart |
| Connectors | Provider OAuth/BYOK wrappers | Those providers unavailable |
| Inbox | Unified conversations | Inbound still persisted via webhook inbox |
| Atomic Agent | Agent loop with tool grammar | Agent turns fail; classify/plan unaffected (they bypass it) |
| MCP Bridge | `mcp.darex.*` | External MCP clients only |
| Sandbox | Isolated execution | `code_execution` fails honestly |
| Postgres + pgvector | Records **and** vectors | Total outage |
| PgBouncer | Pooling | Connection exhaustion under load |
| Redis | Queues, caches | Degraded; Langfuse persistence suffers first |
| Temporal | Durable execution | No new durable work; state preserved |
| Nango | Token minting | Connected tools report errors honestly |
| LiteLLM | Model routing | No reasoning at all |
| Langfuse | Traces, cost | Blind, not broken |
| Supertokens | Auth | No new sessions |

## 3. Request path — Ask AI, in full

```
POST /api/ask-ai   { message, threadId }
  │
  ├─ session → org_id → SET app.current_org_id  (every subsequent query is RLS-scoped)
  │
  ├─ retrieveMemory(orgId, message, ...)           ← 1200ms budget, hybrid
  │     ├─ entity lock (btree)   if the query names an entity
  │     ├─ FTS (GIN on body_tsv)
  │     ├─ vector (HNSW cosine)  if an embedding is available within 400ms
  │     └─ fuse → 5 tiers → 3000-token budget → citations
  │
  ├─ classify(message + memory block)              ← LiteLLM direct, no tool grammar
  │     │                                            reasoning off, max_tokens 300
  │     ├── "simple"  → answer with citations → SSE → done
  │     └── "complex" → continue
  │
  ├─ plan-generator                                ← max_tokens 800
  │     └─ persist agent_plans { summary, steps[], reasoning, draft }
  │
  ├─ render PlanCard for approval
  │     └─ (optional) /api/ask-ai/revise with feedback → new draft, same plan
  │
  ├─ PATCH approve
  │
  ├─ planRequiresDurableExecute(steps)?
  │     ├── false (read/draft only) → execute inline, stream SSE
  │     └── true  (send/pay/sign/publish/delete)
  │             → start PlanExecuteWorkflow
  │             → stream from planProgressQuery
  │
  ├─ per step: tool-executor
  │     ├─ allowlist check (org union ∪ core ∪ connected ∪ plan-explicit)
  │     ├─ Nango token for the connector, or honest notConnected
  │     ├─ idempotency key
  │     └─ execute → result
  │
  ├─ SSE: execution_start / step_start / step_done / execution_done  (monotonic seq)
  │
  └─ Langfuse: PlanGenerated, PlanExecution-<tool> ×N, PlanExecutionSummary
     audit_events: plan approved (approver_user_id), each tool call (risk_class)
     MemoryWriteBackWorkflow → enqueueEmbedActivity
```

### Why classify and plan bypass the agent loop

The agent loop injects the full GBNF tool grammar plus every tool descriptor.
Asked for a plain JSON classification, the model attempted real tool calls,
emitted malformed concatenated JSON, and entered a parse/repair loop that hung
for minutes. **Structured-output call sites get a plain client.** Tool grammars
belong only where tools will actually be called.

### Why reasoning is disabled at those call sites

A reasoning model spent its entire `max_tokens` on `reasoning_content` and
returned empty `content`; with a generous budget it reasoned for minutes.
`reasoning: { enabled: false }` plus tight budgets (300 / 800 / 1000) is the
fix. Revisit only with goldens and latency measurements, not intuition.

## 4. Request path — inbound message

```
provider POST /api/webhooks/<channel>
  │
  ├─ verify signature            (HMAC-SHA256 over exact JSON.stringify(body))
  ├─ resolve tenant              (chatwoot_inbox_map / channel key / site-key hash)
  │                               NEVER from a body org_id
  ├─ dedupe                      (messages.channel_key unique per org)
  ├─ persist to webhook inbox    (010)
  ├─ RETURN 200                  ← before any agent work
  │
  └─ fireInboundAgent → WorkItemWorkflow
        │
        ├─ upsertWorkItem                    work_events: inbound_received
        ├─ retrieveMemory                    work_events: memory_retrieved
        ├─ routeEmployee                     work_events: employee_routed
        │     ├─ greeting?    → short-circuit, no tools, no cost
        │     ├─ emergency?   → human / dispatch, never sales
        │     └─ else         → the owning employee
        ├─ resolveInboundHitlGate            does this need approval first?
        ├─ quiet-hours check                 outbound allowed right now?
        ├─ AutonomousAgentWorkflow (child)   work_events: agent_started
        ├─ criticCheck                       work_events: critic_blocked (maybe)
        ├─ if approval needed:
        │     status → waiting_approval
        │     work_events: confirm_requested
        │     condition() waits on approveWorkItem / rejectWorkItem
        │        ← signalled by the dashboard OR /api/webhooks/owner-whatsapp
        │     work_events: confirm_approved | confirm_rejected
        ├─ reply on channel                  work_events: agent_replied
        └─ MemoryWriteBackWorkflow (child)   work_events: memory_writeback
              → enqueueEmbedActivity         work_events: embed_enqueued
```

The 200-then-process split exists because providers retry aggressively; a slow
agent on the request path causes a duplicate-delivery storm.

The full `work_events` sequence means "what is the agent doing with this
message" is answerable from the database at any moment, without reading logs.

## 5. Tool execution and authorisation

```
org allowlist = ⋃ (tool_allowlist of ALL active ai_employees)
              ∪ core tools (web_search, web_extract, database_query, db_query,
                            sql_analytics, file_ops, file_system,
                            workspace_file, sandbox, code_execution,
                            execute_code)
              ∪ every connector with org_connectors.status ∈ (connected, active)
```

Plus a plan-specific `toolAllowlist` derived from the plan's own steps.

**Why a union.** The previous fallback selected one arbitrary active employee
(`... WHERE status='active' LIMIT 1`) and inherited that employee's narrow list,
blocking tools the org genuinely owned. The correct semantic: an org's
capability is the sum of its employees plus its connections.

**Trade-off accepted:** an employee can transitively reach a tool another
employee owns. At current scale this is right; when per-employee isolation
matters, the per-employee list remains authoritative on that employee's turns.

**Three independent gates**, all server-side: human role → employee allowlist →
org connection. Prompt content grants nothing.

## 6. The workflow-isolate constraint as architecture

Temporal workflow code runs in a deterministic V8 isolate: no Node APIs, no
`pg`, no `fetch`. This forced a split that turned out to be the right design:

| Pure module (isolate-safe, unit-testable) | Effectful counterpart |
|---|---|
| `route-employee.ts` | `routeEmployeeActivity` |
| `quiet-hours.ts` | scheduling activities |
| `crew-contract.ts` | `crew-runner.ts` |
| `inbound-hitl.ts` | HITL persistence activities |
| `plan-steps.ts` | `executePlanStepActivity` |
| `memory/retrieve.ts` (logic) | `retrieveMemoryActivity` |

Every one of these carries a header comment declaring it isolate-safe, and each
has tests that need no database, no network, and no containers. **Determinism
requirements produced testability.** Preserve this deliberately: new decision
logic goes in a pure module, new side effects go in an activity.

## 7. Tenancy enforcement, end to end

1. Session → `org_id` (`009_auth_tenancy`).
2. Connection sets `app.current_org_id`.
3. Every query is filtered by the RLS policy — reads *and* writes.
4. `FORCE ROW LEVEL SECURITY` closes owner bypass.
5. Applications connect as `darex_app`, never the owner.
6. The widget's one exception is a **hash lookup** of a site key, not a
   caller-supplied id.
7. `002_rls_test.sql` and `check-memory-rls.sql` prove two-org isolation
   including vector search.

A missing GUC yields empty results rather than an error. That is the known
debugging sharp edge of this design, and it is the correct failure direction.

## 8. Data stores

| Store | Contents | Notes |
|---|---|---|
| Postgres | ~45 tables: orgs, users, employees, plans, work items, conversations, messages, connectors, packs, audit, billing, insight, vertical | System of record |
| pgvector | 4 memory tiers, `vector(1536)` | Same database — RLS applies to vectors |
| Redis | Queues, caches, Langfuse side-queues | SSE pub/sub not yet migrated here |
| ClickHouse (Langfuse) | Traces, cost | Behind Langfuse |
| Object storage | Uploads, generated artifacts | |

Keeping vectors **in Postgres** rather than a separate vector database is a
deliberate tenancy decision: an external vector store needs its own isolation
model, backup story, and synchronisation problem. RLS covers vectors for free.

## 9. Known sharp edges

| Edge | Detail | Status |
|---|---|---|
| Compose `--env-file` | Compose derives the project dir from the compose file's folder, so root `.env` silently falls back to in-file defaults | Wrapped by `start.sh` / `compose-cmd.sh` |
| Postgres password | `POSTGRES_PASSWORD` applies only on first init of an empty volume | `ALTER USER` documented in `17` |
| Langfuse + shared Redis | BullMQ side-queues time out at ~100 clients; ingestion correct, persistence flaky | Needs dedicated Redis |
| SSE single-process | Two replicas do not both receive `needs_attention` | Needs Redis pub/sub; `check-two-replica-sse.js` is ready |
| Scope drift | A token minted before a scope was added 403s at execution time | `connector_defs.scopes` makes it detectable; no golden yet |
| Embedding dimension | `vector(1536)` must equal `EMBEDDING_DIM`; mixing dims is unrecoverable in place | Migration + re-embed required to change |
| Reasoning models | Burn the budget on `reasoning_content` | Disabled at structured call sites |
