# Memory — what to do later

Date: 2026-09-27. Research against the code in `services/workflows/src/memory/`
and `infra/db/migrations/013_memory_rag.sql`.

Implemented in this pass: Cognee and SQL are merged on the same turn (SQL
and facts first, duplicate graph text dropped), `hnsw.iterative_scan` is
set inside the retrieve transaction and ignored when the server rejects
it, stale rows are ranked below a close fresh hit, and Cognee requests
send `COGNEE_API_KEY` when that env var is set. The cognee tool still
uses the session org id and ignores `payload.orgId` / `payload.dataset`.

Still later: PDF/DOCX ingest, walking `memory_edges`, and an index per org.

Memory is already multi-tenant. Every SQL read filters `org_id`, RLS
forces the same check, and Cognee uses one dataset per org
(`org_<uuid>`). The suggestions below keep that boundary. None of them
add a shared memory across orgs.

## How a turn gets memory today

1. `retrieveMemory` takes `orgId` from the session or the workflow. A
   non-UUID org id returns no citations.
2. If `USE_COGNEE` is not `false`, Cognee is searched first. The dataset
   name is built in code as `org_${orgId}`. The model never picks the
   dataset.
3. If Cognee returns **any** citation, SQL is skipped.
4. Otherwise the query is embedded **before** a database client is
   checked out, then `withOrgScopedClient` sets
   `app.current_org_id` and runs hybrid full-text + cosine over the four
   memory tables. `statement_timeout` is set inside that transaction
   only.
5. Operations and growth also prepend current rows from `facts` for the
   entity. Other personas do not.
6. Persona filters then drop tiers that role should not see
   (operations, growth, and marketing drop `conversation`).

Write-back is a separate gate. A model-generated turn does not write
memory. Allowed events are human correction, a resolved decision, a
closed conversation, a confirmed fact, and a resolved obligation.

## Do these, in this order

### 1. Merge Cognee with SQL. Do not let the graph replace the rows.

`retrieveOnce` returns as soon as Cognee has one hit. A stale graph
sentence then hides a corrected `org_memory` row and the `facts` table.

On each turn, for that one org:

- Run Cognee and the SQL hybrid search.
- Tag graph hits `G-` and row hits `M-` (already the id scheme).
- Put `facts` and fresh SQL rows first. Append graph snippets that are
  not the same text.
- If Cognee times out or 5xx, keep the SQL result. That fallback already
  exists for the empty-graph case. Extend it to the "graph had hits but
  SQL also has hits" case.

Tenant rule: both calls use the same org id. Cognee dataset
`org_<that id>`, SQL `WHERE org_id = that id` plus RLS. Do not search
Cognee with a dataset name from the tool payload.

### 2. Put a key on Cognee, and keep the dataset name server-side.

Search and remember send no auth header. Isolation is the dataset name
plus whoever can reach `COGNEE_URL`. A leaked org UUID is enough to read
or write that org's graph.

- Cognee stays on the internal network.
- The worker sends a server-side API key. The key is not per tenant.
- Dataset name stays `org_<session org id>`. `remember` and `search` in
  `tools/cognee.ts` already take `ctx.orgId`. Do not also read
  `payload.orgId` or `payload.dataset`.
- Free-text `remember` from the model should pass the same write-back
  allowlist as SQL memory. A generated chat turn must not cognify itself
  into the org dataset. Raw transcripts cognified as `tier: 'org'` skip
  the persona filter that strips conversation memory for operations and
  growth.

Deleting an org later means deleting dataset `org_<id>` and the SQL rows
for that `org_id`. One without the other leaves a copy.

### 3. Keep one HNSW index. Fix filtered recall in the session.

Each memory table has one HNSW index on `embedding`. Queries also require
`org_id`. That is the right shape. An index per org would be one catalog
entry per tenant and will not scale. A partial index per org has the
same problem.

The actual risk is recall: HNSW finds nearest neighbours in the whole
table, then the `org_id` filter throws most of them away, so a small
org can get too few hits once other orgs have filled the index.

On the retrieve transaction only (same place as `statement_timeout`):

```sql
SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true);
```

pgvector then keeps walking the index until the `LIMIT` is filled with
rows that match `org_id`. This needs pgvector 0.8 or newer on the
`pgvector/pgvector:pg16` image. Confirm the extension version before
relying on it. If the server is older, leave the setting off. The
`org_id` predicate and RLS still make the result correct. They only
make it incomplete.

Do not partition the memory tables by org until one org's own volume is
the problem. Partitioning is an ops change, not a tenancy fix. RLS
already blocks cross-org reads.

### 4. Rank fresh corrections above stale vectors.

Rows older than 21 days are marked `stale` and still sorted only by
entity lock, same thread, then `0.4 * keyword + 0.6 * cosine`. A stale
chunk can outrank yesterday's edit.

- Keep the row. Do not delete on the stale flag.
- Sort stale below a non-stale hit when the scores are close.
- A Brain PATCH already nulls `embedding` and stores
  `memory_revisions`. The agent must not keep citing the old Cognee
  sentence for that fact after the SQL body changed. That is another
  reason SQL rows win over graph hits (item 1). Re-cognify that text
  after the embed job, still in dataset `org_<id>`.

### 5. Facts stay inside the org, and only for the entity on the turn.

`facts` is queried with `org_id` and `subject_id`, status `current`.
That is the right lock. It runs for operations and growth only.

Leave customer, sales, finance, and marketing as they are until a
persona spec says they need entity facts. When it is added, it is the
same query: session org, and `subject_id` from the conversation's
entity, never from the user message.

### 6. One retrieve function for the agent and the Brain page.

Agent retrieve and Brain search already share `hybridSql` /
`searchMemoryHybrid`. New ranking (stale, iterative scan, merge with
Cognee) goes in that SQL path once. The Brain route stays on
`getScopedClient()` so the org id comes from the cookie. The worker
stays on `withOrgScopedClient(orgId)` because there is no cookie. Both
set the same GUC. Neither accepts `org_id` from the body.

### 7. Ingest more file types without a second store.

PDF and DOCX are rejected on purpose. When they are added: extract text
in the worker, chunk on sentence boundaries, insert into `org_memory`
with `source = 'upload'` under the session org, release the client,
then embed. Same hash skip, same RLS, same "null the vector on body
change" trigger. Do not add a side vector table. The embedding column
on the row is the index.

### 8. Leave `memory_edges` alone until something reads them.

The table is RLS-scoped and unused by retrieve. Cognee is the graph.
Building a second walk over `memory_edges` duplicates that and will
drift. Either a later job writes edges from the same confirmed facts
that SQL already stores, or the table stays unused. Do not query it
from the hot path now.

## What not to change

- Do not drop RLS because the query already has `WHERE org_id = $1`.
  Both stay. The predicate makes the planner honest. RLS is the backstop
  when a query forgets the predicate.
- Do not embed while holding a pool client. Embed, then checkout, then
  search, then release. The pool is 10 connections for every tenant.
- Do not raise the persona token budgets to "fit more memory." The caps
  (customer 1800, operations 1200, growth and sales 1600, hard max 4000)
  are what keep one turn from pulling another tenant's worth of text
  into the prompt even after the org filter.
- Do not store KYC, PAN, or Aadhaar on these tables. Redact before embed.
  That rule is already in the migration comments and in `redactForEmbed`.
