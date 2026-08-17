# Workstream 03 — Memory, RAG, and the brain

Phase 6 is the difference between a tool-using chatbot and a Brain
OS. pgvector is already enabled. This workstream actually uses it.
**Never skip this workstream.**

atomic-agent notes/profile stay **working scratch**. They are not
org RAG. We do not rely on them for “what do we know about the
Kapoors?”

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/00-status-at-a-glance.md`,
`11-database-tenancy.md`, `14-what-does-not-work.md`,
`07-e2e-agent-runtime.md`. Future-scope `10` intro.

- Postgres 16 + pgvector extension on. **No embeddings tables or
  pipeline.**
- `buildGroundedUserMessage` injects org id + connected channels
  only.
- Conversations and messages persist; they are not embedded.
- `file_ops` writes `workspace_storage/{orgId}/` basename-only —
  not a knowledge lake.
- `database_query` is RLS SELECT, max 25 rows — a footgun, not a
  semantic layer.
- Future-scope `01` correctly lists this as the largest hole.

---

## 2. Target

Sources: `docs/future-scope/10-memory-rag-brain.md`,
`07-data-sources-knowledge.md` §5–6, `02` §4.1, `13` Phase 6,
`15` §4 and §13 Phase 6.

Tiers (all RLS, all `org_id`):

| Tier | Table | Written when | Retrieved when |
|------|-------|--------------|----------------|
| Org | `org_memory` | SOP upload, crawl, pack install | every turn |
| Employee | `employee_memory` | after shifts of work | that employee’s turns |
| Entity | `entity_memory` | closed work, confirmed extracts | entity in context |
| Conversation | `conversation_memory` | every N msgs + close | same + similar threads |
| Working | plan + tool results | in process | current turn only |
| Edges | `memory_edges` | extract relations | multi-hop later |

`retrieveMemory(orgId, query, opts)`: ACL/RLS → entity lock →
structured filters → hybrid vector + `tsvector` → optional graph
hop → freshness → token budget → citations. Ask AI **and** webhook
agent both call this before the model.

Write-back is a Temporal activity off the webhook thread. Prices,
legal ids, payments — only from tool results. Low confidence →
`needs_attention`. Hash dedup. Decay on stale requirements.

`/brain` inspector: search, cite, delete/correct, stale flags,
reindex per source.

Exit criterion (future-scope `10` §7): a new WhatsApp thread from a
known number retrieves name, last issue/listing, preferences.
Until that passes, Phase 6 is not done — even if tables exist.

**Adopt in our tables, do not outsource:** hybrid retrieve (Mem0/
Graphiti/Unforget pattern), temporal fact columns later, zero-LLM
write on ingest. **Reject:** Mem0 Cloud, Letta server, Zep Cloud,
GraphRAG on the webhook, dedicated vector DB in Phase 6.

---

## 3. Gaps

**Audit 2026-08-14:** M1–M5 **done**. M6 **partial** (eval YAML
exists; parent `retrieveMemoryActivity` now calls `retrieveMemory`;
live eval still needs a migrated DB). AGE **deferred**.

| Item | Status |
|------|--------|
| pgvector extension | **done** |
| Memory tables + RLS | **missing** |
| embed-worker + `EMBEDDING_MODEL` | **missing** |
| `retrieveMemory` prefix | **missing** |
| MemoryWriteBack | **missing** |
| `/brain` UI | **missing** |
| Hybrid FTS | **missing** |
| Two-org vector CI | **missing** |
| File parse pipeline | **missing** (workstream 05; after retrieve) |

---

## 4. Work items

### M1 — Schema

- **What:** Migration for `org_memory`, `employee_memory`,
  `entity_memory`, `conversation_memory`, `knowledge_sources`,
  `ingestion_jobs`. Columns per future-scope `10` §2. HNSW or
  IVFFlat on embedding; btree `(org_id, entity_type, entity_id)`;
  unique `(org_id, source, source_ref, content_hash)`. `tsvector` +
  GIN from day one. `EMBEDDING_DIM` from env; do not mix dims.
- **Where:** `infra/db/migrations/013_memory_rag.sql`.
- **Depends on:** 009–011 applied; `darex_app` grants on new tables
  (workstream 07).
- **DoD:** RLS + WITH CHECK. Two-org test includes a vector row.
  Prod fail-fast if `EMBEDDING_MODEL` / `EMBEDDING_DIM` unset.

### M2 — embed-worker

- **What:** Enqueue on message insert, file hash change, entity
  update. LiteLLM embeddings. Batch 64–128; backoff on 429. Redact
  secret/PII patterns; **do not embed KYC**. Never run on the
  WhatsApp request thread. Prefer Temporal activity or pg-boss /
  Graphile Worker (pick one).
- **Where:** `services/workflows/src/activities/embed.ts` or
  `services/embed-worker/`. Env: `EMBEDDING_MODEL`,
  `EMBEDDING_DIM`, `LITELLM_BASE_URL`.
- **Depends on:** M1.
- **DoD:** Inserting a message eventually produces a row with
  embedding. Webhook handler does not await embed. Hash skip on
  unchanged body.

### M3 — `retrieveMemory` + grounded prefix

- **What:** Shared function used by Ask AI, Temporal turn, and
  later WorkItemWorkflow. Cap ~2–4k tokens. Structured rows beat
  prose. Empty index → “no stored memory”; tools still run.
- **Where:** `services/workflows/src/memory/retrieve.ts`; called
  from `atomic-agent-client.ts` (R2).
- **Depends on:** M1; M2 can be empty at first.
- **DoD:** Same query, two orgs, zero cross hits. Citation ids
  like `[M-17]` appear in the user message.

### M4 — MemoryWriteBack activity

- **What:** LiteLLM JSON `{facts[], field_updates[],
  open_questions[], relations[]}`. Validate against entity schema.
  Apply field_updates only if confidence ≥ threshold or human
  confirmed. Never write inferred prices into `list_price`. Emit
  `memory.updated` when the bus exists.
- **Where:** `services/workflows/src/activities/memory-writeback.ts`.
- **Depends on:** M1, O2 (can attach to AutonomousAgentWorkflow
  first).
- **DoD:** Closed conversation writes a hash-idempotent fact.
  Duplicate “wants 3BHK” does not append ten times. Low-confidence
  extract creates needs_attention, not a silent entity update.

### M5 — `/brain` inspector v1

- **What:** Search → entities + snippets + sources. Owner can
  delete/correct. Stale flags. Reindex per source. Ask AI must not
  pretend a disabled source exists.
- **Where:** `apps/dashboard/app/(dashboard)/brain/page.tsx`;
  `app/api/brain/route.ts` via `getScopedClient`.
- **Depends on:** M3.
- **DoD:** Member of org A cannot see org B snippets. Disabled
  source is not retrieved.

### M6 — Returning-contact eval (Phase 6 exit)

- **What:** Promptfoo (or equivalent) golden: known WhatsApp
  number → name + last issue. Plus two-org vector test. Plus
  disconnected source stays honest.
- **Where:** `infra/evals/phase6-returning-contact.yaml`.
- **Depends on:** M3, M4, seeded fixture org (synthetic).
- **DoD:** Future-scope `10` §7 passes. Phase 6 marked shipped in
  current-working.

---

## 5. End-to-end connections

- Runtime (01) injects retrieve into every agent path.
- Orchestration (02) calls retrieve/write-back as activities.
- Channels (06) enqueue embed; never embed inline.
- Knowledge (05) fills `knowledge_sources` and file parse.
- Dashboard (09) shows citations and `/brain`.
- Security (07) RLS on vectors; retrieval uses the same ACL as tools.
- Packs (13) cannot go live without M6-style goldens.

---

## 6. Non-goals (Phase 6)

From future-scope `10` §9: no fine-tuned org models; no shared
embeddings across tenants; no graph DB product; no model `INSERT`
via raw SQL; no Mem0/Zep/Letta as SoR; no GraphRAG on inbound.

---

## 7. Verification

| Mode | Mitigation |
|------|------------|
| Empty index | Tools only; say “no stored memory” |
| Wrong neighbor | Metadata filters + structured first |
| Poisoning | Confirm low-confidence writes; hash dedup |
| Cross-tenant | Two-org CI |
| Cost explosion | Embed only new hashes |
| Dim mismatch | Version embeddings; refuse mix |

Never invent a listing price from web_search and write it into
entity memory.

Related: [05-data-sources-and-knowledge.md](./05-data-sources-and-knowledge.md),
[09-dashboard-ux-and-ask-ai.md](./09-dashboard-ux-and-ask-ai.md).
