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
