# 02 — Architecture evolution (core OS, not a rewrite)

Darex already has the right skeleton: Next.js dashboard, Temporal worker,
atomic-agent, MCP bridge, Nango, LiteLLM, Postgres+RLS, Langfuse. The
Brain OS is **more modules on that skeleton**, not a greenfield monorepo.

---

## 1. Target runtime (logical)

```
                    ┌──────── owner UI / mobile / owner-WhatsApp ────────┐
                    │  dashboard (Next.js)  │  SSE/event bus (Redis)     │
                    └────────────┬──────────┴──────────┬─────────────────┘
                                 │ APIs                │ events
                    ┌────────────▼─────────────────────▼─────────────────┐
                    │                 Darex Brain Kernel                 │
                    │  classify │ plan │ confirm │ route │ memory query  │
                    └─┬─────────────┬──────────────┬──────────┬──────────┘
                      │             │              │          │
              LiteLLM JSON    atomic-agent    Temporal     pgvector
              (plan/classify)  (tool loop)    (durable)    + graph
                      │             │              │          │
                      └──────┬──────┴──────┬───────┴────┬─────┘
                             │             │            │
                        MCP bridge    connector     ingest
                        tool-exec     registry      workers
                             │             │            │
                             └──────┬──────┴────────────┘
                                    │
                    Nango OAuth │ BYOK secrets │ public APIs │ webhooks
```

Kernel rules stay the ones in `AGENTS.md`:

- Never trust `org_id` from the body.
- Never await the model inside a webhook.
- Never deadlock the pool (`max: 10` today — raise with architecture, do
  not hold clients across SSE).
- Never fabricate connector data.
- Env-driven URLs/keys; prod fail-fast.

---

## 2. What we keep unchanged (invariants)

1. **Postgres + RLS** as the system of record. pgvector in the same
   database. Optional later: read replica, warehouse sync (BigQuery /
   ClickHouse) for Insight — never as the tenant source of truth.
2. **Nango** as OAuth broker. Connection id convention stays
   `{orgId}_{provider}` unless a migration is explicit.
3. **atomic-agent** as the tool-using employee. MCP names stay
   `mcp.darex.*`.
4. **LiteLLM** for structured JSON (classify/plan/revise/embed-proxy).
5. **Temporal** for anything that must survive death or wait on a human.
6. **Langfuse** for traces. Fix Redis isolation rather than swapping the
   product.
7. **SuperTokens** for session. Add SAML/SSO on top; do not replace.
8. **Plan-confirm-execute** as the irreversible-action protocol.
9. **Monorepo workspaces** (`apps/dashboard`, `services/workflows`,
   `services/connectors`, `packages/shared-types`).

---

## 3. New services (add, do not merge into dashboard)

Dashboard already does too much (API + UI + SSE hub + webhook ingest).
The OS splits **slow / streaming / ingest** off the request path.

| Service | Responsibility | Talks to | Notes |
|---------|----------------|----------|-------|
| `event-bus` | Redis pub/sub (or NATS later) for `needs_attention`, sync events, memory-updated | dashboard, worker, ingest | Replaces in-process hub |
| `ingest-worker` | Channel webhooks → normalize → persist → enqueue Temporal | Postgres, Temporal | Dashboard returns 200 after enqueue only |
| `sync-worker` | Incremental CRM/Drive/Gmail/MLS sync, watches, cursors | Nango, Postgres | Idempotent cursors per org+provider |
| `embed-worker` | Chunk + embed + upsert vectors; reindex on update | LiteLLM/embed API, pgvector | Back-pressure; never on webhook thread |
| `connector-runtime` | Extract growing `tool-executor.ts` switch into registry + per-provider modules | Nango, sandbox | Versioned tool defs |
| `eval-runner` | Golden conversations per pack, CI + nightly | Langfuse, LiteLLM | Blocks skill deploys |
| `sandbox` | Already designed; **commit the Docker context** | worker | No egress, no DB |
| `atomic-agent` | Keep; **mount custom skills** | MCP bridge | Image build copies `custom-skills/` |

Optional later (Phase 12+):

| Service | When |
|---------|------|
| `graph-service` | Entity graph too heavy for recursive CTE (Apache AGE in Postgres first; Neo4j only if proven) |
| `warehouse-sync` | Insight queries threaten OLTP |
| `media-service` | Voice, Matterport, listing photos at scale (S3/R2 + virus scan) |
| `browser-runner` | Confirmed last-resort web UI automation (Playwright in locked sandbox) |

---

## 4. Data model evolution (additive)

Do **not** break existing `conversations`, `messages`, `channels`,
`ai_employees`, `agent_plans`, `channel_logs`. Add:

### 4.1 Memory & knowledge

```
org_memory            (org_id, kind, text, embedding, source, source_ref, metadata, expires_at)
employee_memory       (org_id, employee_id, ...)
entity_memory         (org_id, entity_type, entity_id, ...)  -- contact, listing, ticket, sku
conversation_memory   (org_id, conversation_id, summary, embedding, ...)
memory_edges          (org_id, from_id, to_id, rel, weight)  -- optional graph
knowledge_sources     (org_id, connector, path, hash, last_synced, status)
ingestion_jobs        (org_id, source_id, state, cursor, error)
```

All with `org_id` + RLS + WITH CHECK.

### 4.2 Universal work object

Today everything is a conversation. The OS needs a **WorkItem** that can
be a conversation, a ticket, a showing, a lease renewal, a deal, a PO.

```
work_items (org_id, type, status, assignee_employee_id, entity_refs[], conversation_id null, due_at, priority)
work_events (org_id, work_item_id, kind, payload, actor)
```

Conversations become one subtype. Inbox UI reads work_items. Vertical
packs register types.

### 4.3 Connector registry (DB, not only code)

```
connector_defs (key, nango_key, risk_class, confirm_policy, vertical_tags[], mcp_tools[])
org_connectors (org_id, connector_key, status, nango_connection_id, scopes[], last_ok_at, last_error)
sync_cursors   (org_id, connector_key, stream, cursor, updated_at)
```

UI catalog today is a hardcoded array in `integrations/route.ts`. That
becomes a table + seed, so a vertical pack can enable connectors without
editing the dashboard route.

### 4.4 Vertical packs

```
packs (id, name, version)
org_packs (org_id, pack_id, config, installed_at)
pack_employees (pack_id, persona_template)
pack_workflows (pack_id, temporal_workflow_name, triggers)
pack_entities  (pack_id, entity_type, json_schema)
```

Installing “Real Estate — Brokerage IN” seeds employees, entity schemas
(Listing, Inquiry, Showing, Offer), and workflow names. It does not copy
the worker.

---

## 5. Tool executor evolution

`tool-executor.ts` is already large (Gmail, Calendar, Drive/Docs/Sheets,
HubSpot, ads, sandbox, …). The OS path:

1. **Keep the function** `executeAutonomousToolAction` as the single
   gateway (MCP + plan execute + tests).
2. Split provider folders: `tools/gmail.ts`, `tools/hubspot.ts`,
   `tools/realestate/mls.ts`, each exporting `{ actions, risk, confirm }`.
3. Core tools remain always-on: `web_search`, `web_extract`,
   `database_query` (read-only), `file_ops`, `code_execution`.
4. `database_query` grows a **semantic layer** so models ask for
   `metric:pipeline_value` not raw SQL. Raw SQL stays admin-only.
5. Risk classes: `read`, `draft`, `send`, `write_sor`, `pay`, `delete`,
   `publish`, `sign`. Confirm policy keyed by class + org settings + pack.

Never add a second MCP server per vertical. One bridge, many tools,
allowlist by pack + connection.

---

## 6. Agent invocation paths (converge them)

Today:

| Path | Runtime |
|------|---------|
| Ask AI simple | Direct atomic-agent |
| Ask AI complex | LiteLLM plan → approve → execute tools (often direct) |
| `/api/agent/run` | Temporal → fallback direct |
| WhatsApp inbound | Temporal → fallback direct |
| Chatwoot inbound | **No agent** |

Target:

| Path | Runtime |
|------|---------|
| All inbound channels | ingest-worker → persist → Temporal `WorkItemWorkflow` |
| Ask AI simple | Direct (latency) but same memory retrieval prefix |
| Ask AI complex | Same plan-confirm; execution via Temporal if any step is `send/pay/sign` |
| Scheduled | Temporal cron per org (briefing, stale chase) |
| Connector webhook | ingest-worker → maybe open/update work_item → maybe agent |

Every path must call the **same** `retrieveMemory(org, entity, query)`
and the **same** executor. That is how it becomes one brain.

---

## 7. LLM routing policy (keep the split)

| Job | Path | Why |
|-----|------|-----|
| Classify simple vs complex | LiteLLM JSON, `max_tokens` small, reasoning off | Avoid agent-loop hang |
| Generate / revise plan | LiteLLM JSON | Structured |
| Embeddings | LiteLLM or dedicated embed model | Batch on embed-worker |
| Employee turn with tools | atomic-agent SSE | Grammar + MCP |
| Summarize for memory write-back | LiteLLM JSON | Cheap, no tools |
| Insight narrative | LiteLLM JSON over **pre-aggregated** metrics | Never let it scan raw tables |
| Voice transcription | Whisper-class via LiteLLM or dedicated | Not in the agent loop |

Model names remain env (`LITELLM_MODEL`, embed model, etc.). Prod
fail-fast if unset. No hardcoded “gpt-4o” in shipped code.

---

## 8. Scaling the pieces we will hit first

| Bottleneck | Today | OS move |
|------------|-------|---------|
| Dashboard SSE hub | In-process | Redis pub/sub |
| Postgres pool max 10 | Fine for one instance | PgBouncer; release before streams (already required) |
| Shared Redis | Langfuse timeouts | Dedicated Redis: cache / bus / Langfuse / Temporal |
| `tool-executor` size | One file | Provider modules + registry |
| Nango as sync engine | On-demand token fetch | Keep Nango for auth; **our** sync-worker for data |
| atomic-agent sessions | Daily rotation keys | Per work_item session + compacting summaries |
| Embeddings | None | Async worker, backfill job per org |
| Multi-instance dashboard | Unsafe for SSE | Sticky optional; bus makes it unnecessary |

Horizontal scale of **conversations** is Temporal + ingest-worker, not
more Next.js threads waiting on LLMs.

---

## 9. Clone vs build (restated for the OS era)

| Layer | Use | Notes |
|-------|-----|-------|
| Nango | Clone/self-host | Token plane |
| Temporal | Self-host then Temporal Cloud optional | Workflows are our IP |
| LiteLLM | Self-host | Config only |
| Langfuse | Self-host | Dedicated Redis |
| SuperTokens | Self-host | SSO later |
| pgvector | Extension | Memory |
| Chatwoot | Gateway we already wrapped | Do not fork the whole app; keep `apps/inbox` thin |
| atomic-agent | Pinned external | Skills + MCP are our IP |
| Vertical packs | **Build** | Employees, entities, workflows, compliance |
| Connector functions | **Build** | TypeScript per provider |
| Insight engine | **Build** | Reads warehouse + traces |
| Listing database | **Do not build** | Integrate MLS/IDX/portals |
| Telephony | Twilio/Exotel/Plivo | Do not build a PBX |

Still: **never Composio** as the credential runtime (closed + breach
history cited in the original spec).

**Research mapping (2026):** the rest of the agent-OS ecosystem is
catalogued in `15`. Short version for architecture:

| Tempting swap | Why it shows up in research | Darex call |
|---------------|-----------------------------|------------|
| LangGraph / Mastra / Letta / CrewAI / Agno | “Production agent framework” | **REJECT kernel.** One employee loop (atomic-agent). Steal HITL/role YAML only. |
| Mem0 Cloud / Zep / Cognee-as-brain | SOTA memory blogs | **REJECT SoR.** Own pgvector tables. Steal hybrid search + temporal facts. |
| Restate / Inngest | Simpler durable execution | **WATCH.** Temporal stays until ops force a look. |
| Neo4j + Graphiti | Temporal knowledge graphs | **STUDY** fact validity windows; **AGE/Postgres first**. |
| LangSmith | Traces | **REJECT.** Langfuse stays. |
| unified.to / Composio | One API for 50 CRMs | Nango + our executors. Composio never. |

PydanticAI’s 2026 lesson is the one we already follow: **agent logic
and the durable engine are different products.** They compose with
Temporal. So do we.

---

## 10. Developer experience for adding a vertical

A future agent adding “Real Estate — Property Management” should only:

1. Add pack seed (employees, entity JSON schemas, workflow names).
2. Add connector modules + Nango configs + registry rows.
3. Add skill playbooks under `custom-skills/real-estate-*` **and** the
   Dockerfile COPY so they actually mount.
4. Add golden eval conversations.
5. Add compliance gates (confirm classes, disclosure snippets).
6. Update `docs/current-working/` when it works.

They must **not**:

- Add a new agent runtime.
- Accept `org_id` from the client.
- Invent listing prices when the MLS tool is disconnected.
- Await embeddings inside the WhatsApp webhook.

That contract is the architecture.

---

## 11. New architecture pieces (not in the stack today)

**Do not list Temporal, Nango, LiteLLM, Postgres, pgvector, SuperTokens,
Langfuse, Redis, atomic-agent, Chatwoot, or Next.js here.** Those are
§2 KEEP. Supabase is the same job as Postgres+RLS+SuperTokens — it is
not a new idea.

This table is only **OSS we do not run**, mapped to gaps in §3
(event-bus, ingest, embed, graph, semantic layer, sandbox, pool,
media). 15 GitHub repos. We take the piece, not a rewrite.

| # | Repo (not in Darex today) | Gap it fills | Why it can be better | Darex call |
|---|---------------------------|--------------|----------------------|------------|
| 1 | [nats-io/nats-server](https://github.com/nats-io/nats-server) | `event-bus` (in-process SSE today) | CNCF pub/sub + JetStream; multi-replica `needs_attention` without Redis-as-bus | **ADOPT when** Redis pub/sub is not enough (Phase 8+). Redis first. |
| 2 | [apache/age](https://github.com/apache/age) | `graph-service` / `memory_edges` | Cypher **inside** Postgres; no Neo4j cluster | **ADOPT when** recursive CTE on edges is too slow. Not Phase 6. |
| 3 | [paradedb/paradedb](https://github.com/paradedb/paradedb) | Hybrid retrieve (`tsvector` + vector) | BM25 (`pg_search`) in Postgres; better keyword than stock FTS | **STUDY** for `/brain` + listings search. Stay on stock FTS until proven. |
| 4 | [cube-js/cube](https://github.com/cube-js/cube) | Semantic layer (`database_query` → metrics) | Metrics as code; Insight without LLM-SQL | **ADOPT idea** in YAML (`07`/`13` Phase 7). Full Cube only if we outgrow a metrics table. |
| 5 | [duckdb/duckdb](https://github.com/duckdb/duckdb) | Insight OLAP without a warehouse | In-process analytics on exports; no BigQuery yet | **WATCH** for Phase 7 aggregates. OLTP Postgres stays SoR. |
| 6 | [timgit/pg-boss](https://github.com/timgit/pg-boss) | `embed-worker` / `sync-worker` queue | Job queue **in Postgres** we already operate; no extra Redis queue | **ADOPT** for embed/sync if we do not want another Temporal workflow type for every chunk. Temporal still owns HITL. |
| 7 | [graphile/worker](https://github.com/graphile/worker) | Same as pg-boss, Node-native | Fast PG jobs, SKIP LOCKED | **ADOPT alt** to pg-boss; pick one, not both. |
| 8 | [pgbouncer/pgbouncer](https://github.com/pgbouncer/pgbouncer) | Pool max 10 / SSE deadlock | Connection pooling in front of Postgres | **ADOPT** Phase 8. Not a product swap. |
| 9 | [e2b-dev/infra](https://github.com/e2b-dev/infra) | `sandbox` (Docker context not even in git) | Firecracker micro-VMs; real isolation vs our Docker | **STUDY** when sandbox must have no-egress + multi-tenant. Prefer our image until then. |
| 10 | [daytonaio/daytona](https://github.com/daytonaio/daytona) | Same sandbox / browser-runner | Dev-env + isolated runtimes for agents | **WATCH** Phase 17 computer-use. |
| 11 | [open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js) | Traces across dashboard + worker + MCP | Correlate Langfuse LLM spans with HTTP/Temporal | **ADOPT** export; do not replace Langfuse. |
| 12 | [Unleash/unleash](https://github.com/Unleash/unleash) | Pack / skill flags per org | Kill-switch a vertical workflow without deploy | **WATCH** Phase 11+ packs. Env flags first. |
| 13 | [minio/minio](https://github.com/minio/minio) | `media-service` (photos, voice, KYC pointers) | S3-compatible in our VPC | **ADOPT** when listing media leaves Drive. Virus-scan before put. |
| 14 | [traefik/traefik](https://github.com/traefik/traefik) | Split ingest / SSE / dashboard hosts | Path-based routing so webhooks never share the Next.js thread | **ADOPT** when we split services (§3). Caddy is also fine. |
| 15 | [electric-sql/electric](https://github.com/electric-sql/electric) | Owner mobile / offline inbox | Postgres → shape-synced clients | **WATCH** after Redis SSE works. Not year-one. |

Honorable (still not in stack; pick from these if 15 is not enough):
[redpanda-data/connect](https://github.com/redpanda-data/connect) (CDC/sync pipelines),
[valkey-io/valkey](https://github.com/valkey-io/valkey) (dedicated Redis-compatible for Langfuse),
[Infisical/infisical](https://github.com/Infisical/infisical) (BYOK vault instead of env soup),
[Cisco-Talos/clamav](https://github.com/Cisco-Talos/clamav) (virus scan on uploads),
[caddyserver/caddy](https://github.com/caddyserver/caddy) (alt to Traefik),
[envoyproxy/envoy](https://github.com/envoyproxy/envoy) (sidecar if we split ingest),
[cloudnative-pg/cloudnative-pg](https://github.com/cloudnative-pg/cloudnative-pg) (PG operator later),
[dragonflydb/dragonfly](https://github.com/dragonflydb/dragonfly) (Redis-compatible if Valkey is not enough).
Hatchet / Temporal-class jobs live in `09` — do not list them here.

**Still reject as kernel (even if OSS):** LangGraph, Mastra, Letta, Agno,
Supabase-as-backend, Composio. Same job as what we already run.

**What we take from this list first (order):**

1. PgBouncer — pool, Phase 8.  
2. pg-boss **or** Graphile Worker — embed/sync off the dashboard.  
3. Redis pub/sub; NATS only if that fails.  
4. OTel JS → Langfuse.  
5. ParadeDB/AGE only after Phase 6 stock FTS + edges table.  
6. Cube/DuckDB ideas for Phase 7 metrics, not a new SoR.  
7. MinIO when media exists.  
8. E2B/Daytona only if Docker sandbox isolation fails tenants.
