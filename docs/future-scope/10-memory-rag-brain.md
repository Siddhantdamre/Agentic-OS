# 10 — Memory RAG brain

Phase 6 in the original spec is the difference between a **tool-using
chatbot** and a **Brain OS**. pgvector is already enabled. This file
is the design to actually use it.

atomic-agent’s notes/profile/reflection stay as **working scratch**.
They are not org RAG. We do not rely on them for “what do we know
about the Kapoors?”.

---

## 1. Tiers (all RLS, all `org_id`)

| Tier | Table | Written when | Retrieved when |
|------|-------|--------------|----------------|
| Org | `org_memory` | SOP upload, crawl, pack install | every turn |
| Employee | `employee_memory` | after shifts of work | that employee’s turns |
| Entity | `entity_memory` | closed work, confirmed extracts | entity in context |
| Conversation | `conversation_memory` | every N msgs + close | same thread + similar threads |
| Working | plan + tool results | in process | current turn only |
| Edges | `memory_edges` | extract relations | multi-hop |

`ai_employees.persona` remains the prompt preamble, not memory.

---

## 2. Schema notes

```
org_memory (
  id uuid pk,
  org_id uuid not null,
  kind text,              -- sop, brand, faq, area_book, policy
  title text,
  body text not null,
  embedding vector(n),
  source text,            -- drive, notion, upload, pack
  source_ref text,
  content_hash text,
  metadata jsonb,
  expires_at timestamptz,
  created_at, updated_at
)
```

`entity_memory` adds `entity_type`, `entity_id`.
Indexes: ivfflat or hnsw on embedding, btree on (org_id, entity_type,
entity_id), unique (org_id, source, source_ref, content_hash) for
idempotent upserts.

`n` = embedding dim of the chosen model (env `EMBEDDING_MODEL` /
`EMBEDDING_DIM`). Fail-fast in prod if unset. Do not mix dims in one
column; migrate if model changes (reembed job).

---

## 3. Embedding pipeline

- Worker: `embed-worker` (see `02`).
- Provider: LiteLLM embeddings (OpenRouter/Gemini/local). Same
  gateway as chat, different model env.
- Trigger: enqueue on message insert, file hash change, entity update.
- Batch: 64–128 inputs; backoff on 429.
- Never embed from the WhatsApp webhook request thread.
- Redact secrets/PII patterns before embed when kind is `kyc` —
  better: do not embed KYC at all.

---

## 4. Retrieval prefix (every agent path)

`buildGroundedUserMessage` already injects org_id because atomic-agent
drops `system`. Extend the grounded user message with:

```
Retrieved facts (cite ids, do not invent):
[M-17] Contact Priya Kapoor budget 2.4–2.8 Cr, wants 3BHK Andheri West, stale=false, updated 2026-08-10
[L-88] Listing ... source=sheets row 12 synced 2026-08-13 09:10Z
If a fact is missing, say it is missing. Tools: use listings.search for live inventory.
```

Cap: ~2–4k tokens retrieved. Structured listings as tables beat
prose.

---

## 5. Write-back job

Activity `MemoryWriteBack`:

1. Input: work_item id, transcript excerpt, tool results.
2. LiteLLM JSON: `{facts[], field_updates[], open_questions[],
   relations[]}`.
3. Validate against entity schema.
4. Apply field_updates only if confidence ≥ threshold or human
   confirmed.
5. Upsert facts with hash.
6. Emit `memory.updated` on event-bus.

Prompt must say: prices, legal ids, payments — only from tool
results, never from model world knowledge.

---

## 6. Inspector UI

Route: `/brain` or `/memory`.

- Search “Kapoor” → entities + snippets + sources.
- Delete/correct a memory (owner).
- See stale flags.
- Reindex button per source.

This is how customers trust the OS. Without it, memory is a ghost.

---

## 7. Returning customer exit criterion (spec Phase 6)

A new WhatsApp thread from a known number retrieves name, last
issue/listing, preferences. Eval conversation #7 in `05`. Until this
passes, Phase 6 is not done — even if tables exist.

---

## 8. Failure modes

| Mode | Mitigation |
|------|------------|
| Empty index | Agent uses tools only; says “no stored memory” |
| Wrong neighbor | Metadata filters + structured first |
| Poisoning | Confirm low-confidence writes; hash dedup |
| Cross-tenant | RLS tests in CI with two orgs |
| Cost explosion | Embed only new hashes; don’t reembed whole Drive daily |
| Dim mismatch | Version embeddings in metadata; refuse mix |

---

## 9. What we do not build in Phase 6

- Fine-tuned org models.
- Shared embeddings across tenants.
- Graph DB product (edges table is enough).
- Letting the model `INSERT` into memory tables via raw SQL.

---

## 10. Research that belongs in this design (Phase 6)

Full catalog: `15` §4 and §11. The field in 2026 converged on four
ideas we should **implement in our tables**, not by becoming a
customer of a memory SaaS.

### 10.1 Hybrid retrieval (ADOPT in Postgres)

Mem0, Graphiti, Unforget, and Cognee all fuse **vector + keyword
(BM25 / tsvector) + optional entity overlap**. Darex `retrieveMemory`
should not be cosine-only. Add `tsvector` + GIN (and later `pg_trgm`
for names) in the same RLS query. Unforget’s extra lesson: **writes
must not wait on an LLM** — matches “never embed on the WhatsApp
webhook.”

### 10.2 Temporal facts (STUDY Graphiti, implement as columns)

Zep/Graphiti (arXiv:2501.13956) treat every fact as having a
**validity window**. A listing price, a rent, a CRM stage, a budget
all *change*. Schema addition when we outgrow `expires_at`:

```
valid_from timestamptz,
valid_until timestamptz null,  -- null = current
invalidated_at timestamptz null,
supersedes_id uuid null
```

Do **not** stand up Neo4j for this in Phase 6. Edges table + these
columns are enough. Apache AGE later (`02`).

### 10.3 Hierarchical memory (STUDY Letta/MemGPT, keep our runtime)

Letta (Packer, Wooders, Stoica — MemGPT arXiv:2310.08560) is the
“LLM as OS” paper: core memory always in context, archival on disk,
agent pages itself. Darex mapping:

| Letta | Darex |
|-------|-------|
| Core memory | `ai_employees.persona` + retrieved org snippets in the grounded **user** message |
| Archival | `org_memory` / `entity_memory` / `conversation_memory` |
| Paging tools | `retrieveMemory` prefix, not Letta’s runtime |
| Agent-owned edits | `MemoryWriteBack` activity with confirm on low confidence |

We do **not** run the Letta server. atomic-agent scratch notes stay
working memory only (`10` intro).

### 10.4 What we will not outsource

Hosted Mem0 / Zep / SuperMemory become a second system of record
with someone else’s tenancy. Microsoft GraphRAG is a **batch** job
for static SOP corpora — useful later for Drive dumps, lethal if
run on every inbound message. Dedicated vector DBs (Qdrant, etc.)
wait until pgvector recall/ops fail **and** we can still filter by
`org_id` (pgvector docs: shared ANN indexes can leak recall across
tenants — partition or filter strictly).

### 10.5 Product eval, not vendor leaderboards

LongMemEval / LoCoMo / MemoryBench are how vendors argue. Our exit
criterion stays §7: returning WhatsApp number retrieves name + last
issue, two-org RLS vector test, disconnected sources stay honest.
Promptfoo (or equivalent YAML) in CI is the ADOPT tool (`15` §7).

---

## 11. Alternatives in the world (instead of “our pgvector brain”)

**What Darex does:** own RLS tables + embed-worker + retrieveMemory
prefix. Not Mem0 Cloud. Not Letta server.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Mem0** OSS/cloud | Fastest fact-extract SDK; ~63k★; arXiv:2504.19413 | Hosted = second SoR; steal hybrid retrieve | [mem0ai/mem0](https://github.com/mem0ai/mem0) |
| 2 | **Graphiti / Zep** | Temporal fact windows; SOTA LongMemEval claims | Neo4j extra cluster; implement columns in PG | [getzep/graphiti](https://github.com/getzep/graphiti), arXiv:2501.13956 |
| 3 | **Cognee** | Company-brain ECL; can demo on one Postgres | Graph-in-PG still demo; tenancy ours | [topoteretes/cognee](https://github.com/topoteretes/cognee), arXiv:2505.24478 |
| 4 | **Letta / MemGPT** | Agent pages core vs archival | Whole runtime swap | arXiv:2310.08560 |
| 5 | **Qdrant / Weaviate / Chroma** dedicated vectors | Scale, hybrid built-in | Phase 6 stays pgvector; ANN recall leak across tenants if unfiltered | [pgvector/pgvector](https://github.com/pgvector/pgvector) multitenancy notes |

**Five things to steal anyway**

1. Hybrid vector + `tsvector` + entity overlap.
2. `valid_from` / `invalidated_at` on entity facts.
3. Zero-LLM write on ingest (Unforget lesson).
4. Two-org RLS vector test in CI — our LongMemEval.
5. Inspector UI or memory is a ghost (`10` §6).

### Open-source GitHub — this file only (memory)

pgvector KEEP → `15` §1. GraphRAG → `07`. Letta / Mem0 / Graphiti listed **only here**.

| Repo | Similar to | We take |
|------|------------|---------|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Fact extract + hybrid | Extract JSON + FTS in *our* tables |
| [getzep/graphiti](https://github.com/getzep/graphiti) | Temporal KG | `valid_from` / `invalidated_at` |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | Company brain on PG | ECL ingest |
| [letta-ai/letta](https://github.com/letta-ai/letta) | Core vs archival (MemGPT) | Hierarchy in grounded user message |
| [qdrant/qdrant](https://github.com/qdrant/qdrant) | Dedicated hybrid search | Only if pgvector fails |
| [weaviate/weaviate](https://github.com/weaviate/weaviate) | Hybrid + tenant concepts | Same WATCH |
| [chroma-core/chroma](https://github.com/chroma-core/chroma) | Embedded vectors | Dev only |
| [lancedb/lancedb](https://github.com/lancedb/lancedb) | Embedded ANN | Dev |
| [milvus-io/milvus](https://github.com/milvus-io/milvus) | Scale-out vectors | Only after RLS-safe pgvector fails |
| [OSU-NLP-Group/HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG) | Hippocampal RAG | Entity overlap retrieve |
| [getzep/zep](https://github.com/getzep/zep) | Cloud memory sibling of Graphiti | **REJECT** hosted as SoR |
