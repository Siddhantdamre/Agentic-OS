# Memory

Date: 2026-09-27.

Company memory is rows in the `darex` database, not a separate vector
product. Embeddings are a `vector(1536)` column on each memory row
(pgvector, HNSW cosine index where the vector is not null). Dimension
must match `EMBEDDING_DIM` (default 1536). There is no separate
`memory_embeddings` table. Deleting a row deletes its vector.

Schema: `infra/db/migrations/013_memory_rag.sql`, cascade clear on body
edit in `092_memory_cascade.sql`, revision snapshots in
`094_brain_insight_brief.sql`.

## Four tiers

All four have `org_id`, forced RLS, a generated `body_tsv` (English),
`content_hash`, `source`, `source_ref`, and `embedding`.

| Table | What it stores | Extra key |
|---|---|---|
| `org_memory` | SOP, brand, FAQ, area book, policy. Retrieved on every turn. | `kind` |
| `employee_memory` | Patterns learned for one AI employee. | `employee_id` → `ai_employees` |
| `entity_memory` | Confirmed facts about a contact, listing, or other entity. | `(entity_type, entity_id)` |
| `conversation_memory` | Thread summary plus body for similar-thread recall. | `conversation_id` |

Related tables in the same migration: `memory_edges` (extracted
relations, not a graph database), `knowledge_sources` (Drive, Notion,
upload, pack, crawl), `ingestion_jobs` (async parse / embed).

`memory_revisions` stores the previous title and body on a Brain
correction, with the user id and tier (`org`, `employee`, `entity`,
`conversation`).

KYC, PAN, and Aadhaar are not columns on these tables. Embed text is
redacted before the embed job (`redactForEmbed` in
`apps/dashboard/lib/embed-enqueue.ts`).

## How an agent reads memory

`services/workflows/src/memory/retrieve.ts` (`search` path used by agent
turns):

- Hybrid: full-text (`tsvector`) plus cosine when a query embedding
  exists. Embeddings may be null; keyword search still runs.
- Per-tier limit 12. Snippet length 480 characters.
- Token budget depends on persona (customer 1800, operations 1200,
  growth/sales 1600, default 3000, cap 4000).
- Retrieve timeout `MEMORY_RETRIEVE_TIMEOUT_MS` (default 3500). Embed
  for the query `MEMORY_EMBED_TIMEOUT_MS` (default 400).
- Stale flag after `MEMORY_STALE_AFTER_DAYS` (default 21).
- Empty index returns the literal block `no stored memory`. The model
  is told not to invent contacts, listings, or prior conversations.
- Org scope comes from `withOrgScopedClient`, not from the prompt.

`employee-retrieve.ts` narrows employee-tier recall.
`fact-conflict-route.ts` and `playbook-proposal.ts` sit beside retrieve
for conflicting facts and proposed playbooks.

## Cognee

`services/workflows/src/memory/cognee-client.ts` is an optional graph
layer on top of the SQL tiers. It calls `COGNEE_URL` (default
`http://127.0.0.1:8000`, or `http://cognee:8000` when `DB_HOST=pgbouncer`).
Search types: `GRAPH_COMPLETION`, `HYBRID_COMPLETION`, `CHUNKS`,
`SUMMARIES`. Timeout default 3500ms. Health probe tries `/health` then
`/docs`. If Cognee is down, SQL hybrid retrieve still runs. Cognee is
not a second source of truth for tenant rows.

## Write-back

`writeback-policy.ts` allows memory writes only for:

- `human_correction`
- `decision_card_resolved`
- `conversation_closed`
- `durable_fact_confirmed`
- `obligation_resolved`

A model-generated turn (`generated: true`) does not write memory by
itself.

## Brain UI

`/api/brain` and `/api/brain/[id]` are the operator surface over the
same four tables.

- Search is hybrid (full-text + cosine), with a keyword fallback and
  `searchMode` when vectors are missing.
- Create and `.txt` / `.md` upload insert under the session org, then
  embed in place. PDF and DOCX are rejected.
- PATCH snapshots the old body into `memory_revisions`, nulls
  `embedding` (the DB trigger does this on body change too), releases
  the client, then enqueues re-embed.
- Mutations require owner or admin (`canMutateBrain`).
- Reindex load-and-enqueue is shared in `apps/dashboard/lib/brain-reindex.ts`.

Embed jobs hash the text (SHA-256) and skip when the hash already
matches. They go through Temporal. The request path does not wait on
the embedding model.
