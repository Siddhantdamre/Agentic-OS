# 03 — Target architecture

End-state architecture from
[`docs/future-scope/02-architecture-evolution.md`](../future-scope/02-architecture-evolution.md),
grounded in the current monorepo. This is **more modules on the
existing skeleton**, not a greenfield rewrite.

Linked from [README.md](./README.md) and
[02-gap-analysis.md](./02-gap-analysis.md). Documentation only.

---

## 1. Invariants we keep

From future-scope `02` §2 and `AGENTS.md`:

1. **Postgres + RLS** as the system of record. pgvector in the same
   database. Optional later: read replica or warehouse sync for
   Insight — never as the tenant source of truth.
2. **Nango** as OAuth broker. Connection id stays
   `{orgId}_{provider}` unless a migration is explicit.
3. **atomic-agent** as the tool-using employee. MCP names stay
   `mcp.darex.*`.
4. **LiteLLM** for structured JSON (classify/plan/revise/embed-proxy).
5. **Temporal** for anything that must survive death or wait on a
   human.
6. **Langfuse** for traces. Fix Redis isolation rather than swapping.
7. **SuperTokens** for session. Add SAML/SSO on top; do not replace.
8. **Plan-confirm-execute** as the irreversible-action protocol.
9. **Monorepo workspaces** (`apps/dashboard`, `apps/inbox`,
   `services/workflows`, `services/connectors`,
   `packages/shared-types`).

Kernel rules stay: never trust body `org_id`; never await the model
inside a webhook; never hold a pooled client across SSE; never
fabricate connector data; env-driven URLs/keys; prod fail-fast.

---

## 2. Target runtime (logical)

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
              (plan/classify)  (tool loop)    (durable)    + FTS + edges
                      │             │              │          │
                      └──────┬──────┴──────┬───────┴────┬─────┘
                             │             │            │
                        MCP bridge    connector     ingest /
                        tool-exec     registry      embed / sync
                             │             │            │
                    Nango OAuth │ BYOK secrets │ public APIs │ webhooks
```

Dashboard already does too much (API + UI + SSE hub + webhook
ingest). The OS splits **slow / streaming / ingest** off the request
path over Phases 6–8. Do not merge new workers into
`apps/dashboard` request handlers.

---

## 3. New services (add, do not merge into dashboard)

From future-scope `02` §3. Proposed compose / package homes:

| Service | Responsibility | Likely home | Notes |
|---------|----------------|-------------|-------|
| `event-bus` | Redis pub/sub for `needs_attention`, sync, memory-updated | Redis topic `org:{id}`; dashboard SSE subscribes | Replaces in-process `realtime-hub.ts` |
| `ingest-worker` | Channel webhooks → normalize → persist → enqueue Temporal | New `services/ingest` **or** Temporal activities first | Dashboard returns 200 after enqueue only |
| `sync-worker` | Incremental CRM/Drive/Gmail/MLS sync, cursors | Temporal workflows + `sync_cursors` | Nango stays tokens; we own data sync |
| `embed-worker` | Chunk + embed + upsert vectors | Temporal or pg-boss/Graphile (`02` ADOPT) | Never on webhook thread |
| `connector-runtime` | Registry + per-provider modules | `services/workflows/src/tools/*` | Keep `executeAutonomousToolAction` as the single gateway |
| `eval-runner` | Golden conversations per pack | `infra/scripts` + Promptfoo CI | Blocks skill deploys |
| `sandbox` | Already designed | `infra/docker/sandbox/` | Commit context; no egress, no DB |
| `atomic-agent` | Keep; mount custom skills | `infra/docker/atomic-agent/` | Image COPY already in working tree |

Optional later (Phase 12+): `graph-service` (Apache AGE first),
`warehouse-sync`, `media-service` (MinIO/R2 + virus scan),
`browser-runner` (Playwright in locked sandbox, Phase 17).

**Adopt order from `02` §11:** PgBouncer (Phase 8) → pg-boss **or**
Graphile Worker for embed/sync if we do not want a Temporal workflow
type per chunk → Redis pub/sub (NATS only if that fails) → OTel JS
export beside Langfuse → ParadeDB/AGE only after stock FTS + edges
→ Cube/DuckDB ideas for Phase 7 metrics → MinIO when media exists →
E2B/Daytona only if Docker sandbox isolation fails tenants.

---

## 4. Data model evolution (additive)

Do **not** break existing `conversations`, `messages`, `channels`,
`ai_employees`, `agent_plans`, `channel_logs`, `org_invites`,
`idempotency_keys`. Add (all `org_id` + RLS + WITH CHECK):

### 4.1 Memory and knowledge

```
org_memory            (org_id, kind, text, embedding, source, source_ref, metadata, expires_at)
employee_memory       (org_id, employee_id, ...)
entity_memory         (org_id, entity_type, entity_id, ...)
conversation_memory   (org_id, conversation_id, summary, embedding, ...)
memory_edges          (org_id, from_id, to_id, rel, weight)
knowledge_sources     (org_id, connector, path, hash, last_synced, status)
ingestion_jobs        (org_id, source_id, state, cursor, error)
```

Optional later on entity facts: `valid_from`, `valid_until`,
`invalidated_at`, `supersedes_id` (Graphiti idea, columns not Neo4j).

### 4.2 Universal work object

```
work_items (org_id, type, status, assignee_employee_id, entity_refs[], conversation_id, due_at, priority)
work_events (org_id, work_item_id, kind, payload, actor)
```

Conversations become one subtype. Inbox UI reads work_items.
Vertical packs register types (`re.listing`, `pm.work_order`, …).

### 4.3 Connector registry

```
connector_defs (key, nango_key, risk_class, confirm_policy, vertical_tags[], mcp_tools[])
org_connectors (org_id, connector_key, status, nango_connection_id, scopes[], last_ok_at, last_error)
sync_cursors   (org_id, connector_key, stream, cursor, updated_at)
```

Today’s hardcoded `ALL_INTEGRATIONS` array becomes a table + seed.

### 4.4 Vertical packs

```
packs (id, name, version)
org_packs (org_id, pack_id, config, installed_at)
pack_employees / pack_workflows / pack_entities
```

Installing a pack is an idempotent Temporal workflow. Uninstall
disables schedules and hides UI; it does not delete conversations.

---

## 5. Agent invocation paths (converge them)

Today versus target (future-scope `02` §6). Chatwoot “no agent” in
that table is **stale** — current-working wires `fireInboundAgent`.
The remaining gap is the **WorkItem** model and shared memory prefix.

| Path | Today | Target |
|------|-------|--------|
| Ask AI simple | Direct atomic-agent | Direct (latency) + `retrieveMemory` prefix |
| Ask AI complex | LiteLLM plan → approve → execute tools (often direct) | Same PlanCard; Temporal if any step is `send`/`pay`/`sign` |
| `/api/agent/run` | Temporal → fallback direct | Same + memory prefix |
| WhatsApp / Chatwoot | Persist → 200 → Temporal/direct | ingest → persist → Temporal `WorkItemWorkflow` |
| Scheduled | none | Temporal cron per org |
| Connector webhook | ad hoc | ingest → work_item → maybe agent |

Every path must call the **same** `retrieveMemory(org, entity, query)`
and the **same** `executeAutonomousToolAction`. That is how it
becomes one brain.

Session keys: Ask AI stays `askai-{userId}-{YYYYMMDD}`. Inbound
becomes `darex:{org}:{workItemId}` (not a shared daily org chat).

---

## 6. LLM routing policy (keep the split)

| Job | Path | Why |
|-----|------|-----|
| Classify simple vs complex | LiteLLM JSON, small `max_tokens`, reasoning off | Avoid agent-loop hang (BUILD_STATE) |
| Generate / revise plan | LiteLLM JSON | Structured |
| Embeddings | LiteLLM or dedicated embed model | Batch on embed-worker |
| Employee turn with tools | atomic-agent SSE | Grammar + MCP |
| Memory write-back / critic | LiteLLM JSON | Cheap, no tools |
| Insight narrative | LiteLLM JSON over **pre-aggregated** metrics | Never scan raw tables |
| Voice transcription | Whisper-class via LiteLLM or dedicated | Phase 17; not in the agent loop |

Model names remain env. Prod fail-fast if unset. No hardcoded
`gpt-4o` in shipped code.

---

## 7. Tool executor evolution

1. Keep `executeAutonomousToolAction` as the single gateway (MCP +
   plan execute + tests).
2. Split provider folders: `services/workflows/src/tools/gmail.ts`,
   `hubspot.ts`, `realestate/mls.ts`, each exporting
   `{ actions, risk, confirm }`.
3. Core tools remain always-on: `web_search`, `web_extract`,
   `database_query` (read-only), `file_ops`, `code_execution`.
4. `database_query` grows a semantic layer (`metrics.query`). Raw
   SQL stays admin-only.
5. Risk classes: `read`, `draft`, `send`, `write_sor`, `pay`,
   `delete`, `publish`, `sign`. Confirm policy keyed by class + org
   settings + pack.

Never add a second MCP server per vertical.

---

## 8. Scaling the pieces we will hit first

| Bottleneck | Today | OS move |
|------------|-------|---------|
| Dashboard SSE hub | In-process | Redis pub/sub |
| Postgres pool max 10 | Fine for one instance | PgBouncer; still release before streams |
| Shared Redis | Langfuse had timeouts | Dedicated Redis already for Langfuse; still split cache/bus |
| `tool-executor` size | One file | Provider modules + registry |
| Nango as sync engine | On-demand token fetch | Keep Nango for auth; **our** sync-worker for data |
| atomic-agent sessions | Daily rotation keys | Per work_item session + compacting summaries |
| Embeddings | None | Async worker, backfill job per org |
| Multi-instance dashboard | Unsafe for SSE | Bus makes sticky sessions unnecessary |

Horizontal scale of conversations is Temporal + ingest-worker, not
more Next.js threads waiting on LLMs.

---

## 9. Developer contract for a vertical

A future agent adding “Real Estate — Property Management” should
only:

1. Add pack seed (employees, entity JSON schemas, workflow names).
2. Add connector modules + Nango configs + registry rows.
3. Add skill playbooks under `custom-skills/real-estate-*` **and**
   keep the Dockerfile COPY so they mount.
4. Add golden eval conversations.
5. Add compliance gates (confirm classes, disclosure snippets).
6. Update `docs/current-working/` when it works.

They must **not**: add a new agent runtime; accept `org_id` from the
client; invent listing prices when the MLS/Sheets tool is
disconnected; await embeddings inside the WhatsApp webhook.

Detail: [workstreams/13-vertical-packs.md](./workstreams/13-vertical-packs.md).
