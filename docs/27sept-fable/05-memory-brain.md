# 05 · Memory / Brain / Knowledge — the "one shared brain"

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 0 | 0.0% |
> | 🟡 **Pending / In Progress** | 0 | 0.0% |
> | 🔴 **Not Done (Open)** | 51 | 100.0% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **51** | **100.0%** |

Audit date 2026-09-27, read-only against `services/workflows/src/{memory,activities,workflows,dsr}`, `apps/dashboard/{lib,app/api/brain,app/api/ask-ai}`, migrations `013`, `022`, `092`, `094`, `infra/docker-compose.yml`. Cross-checked against `docs/db-mem-27-sept/*`, `gap26sept/brain.md`, `gap/20_memory_and_learning.md`, `future-scope/10-memory-rag-brain.md`.

**Headline.** RLS on the four memory tables is correct and the retrieve merge (SQL first, Cognee appended, stale penalty) works as described in `BUILD_STATE.md`. Everything around it is leaky: the parent file row never reaches `ready`, disabling a source does not hide its chunks, every inbound customer WhatsApp message is embedded org-wide with no policy gate, write-back facts never get vectors, Brain stores unredacted bodies, raw transcripts go to an external LLM through Cognee, Cognee data is never deleted on DSR/purge, and the vector query is written so HNSW cannot be used. The "learning loop" (`employee_memory`, `facts`, `fact_conflicts`) has readers and no writers.

---

## 1. Architecture reality

### 1.1 Write paths — what actually lands in memory

| # | Trigger | Code | Target | Redacted? | Policy-gated? | Embedded? |
|---|---|---|---|---|---|---|
| W1 | **Every inbound WhatsApp / Chatwoot / widget message** (before reply) | `WorkItemWorkflow.ts:253-258` → `activities/index.ts:630-662` (`enqueueEmbedActivity`, last `role='user'` message) → `embed.ts:640-648` | `conversation_memory`, source `conversation`, `source_ref = conversationId` | Yes at embed (`embed.ts:582`) | **No** — bypasses `writeback-policy.ts` | Yes |
| W2 | Post-turn write-back (WorkItem child, Ask AI, approve, conversation close) | `WorkItemWorkflow.ts:612-626`, `ask-ai/route.ts:1302-1308`, `ask-ai/approve/route.ts:145`, `conversations/[id]/route.ts:121` → `memory-writeback.ts:574-784` | `conversation_memory` facts/summaries (`:353-388`), `entity_memory` field updates (`:427-462`), `memory_edges` (`:464-475`), Cognee (`:752-773`) | **No** — bodies inserted raw (`:606-621`, `:638-647`); only the separate transcript embed is redacted | Yes (`:624-636`) | **No** for fact rows; a separate transcript row is embedded (`:729-736`) |
| W3 | File ingest (Drive / text upload via `/api/brain/reindex`) | `brain/reindex/route.ts:150-315` → `IngestWorkflow.ts:66` → `ingest-file.ts:824-899` → per chunk `enqueueEmbedJobFromWorker` (`:832-839`) | `org_memory`, source `drive`/`upload`, `source_ref = path#cN` | Yes (`:750`, `embed.ts:582`) | n/a | Yes |
| W4 | Brain create / `.txt` `.md` upload | `brain/route.ts:490-508` | `org_memory` raw body, then in-place re-embed (`embed-enqueue.ts:265-279`) | **Body not redacted**; only embed text | n/a | First ≤1000 chars only (`embed-enqueue.ts:261-263`) |
| W5 | Brain PATCH correct | `brain/[id]/route.ts:107-183` | `memory_revisions` snapshot + UPDATE body raw | **No** | n/a | in-place, first chunk only |
| W6 | Connector sync (Sheets, HubSpot) | `ingest-file.ts:1115-1314` | **`knowledge_sources` catalog rows only** — no memory rows | n/a | n/a | **Never** |
| W7 | Cognee `remember` tool (model-callable) | `tools/cognee.ts:19-51` | Cognee dataset `org_<id>` | **No** | **No** | n/a |
| W8 | Tool results / plan outcomes / Gmail, Slack, Notion, CRM syncs into memory | not found (`MEMORY_SOURCE_KINDS` lists them in `shared-types/memory.ts:28-45`; no writer) | — | — | — | — |
| W9 | `employee_memory` | **no writer anywhere** (`INSERT INTO employee_memory` → 0 hits) | — | — | — | — |
| W10 | `facts` / `fact_conflicts` (022) | **no writer**; `retrieveFactsFirst` (`retrieve.ts:625-654`) and `fact-conflict-route.ts` read an empty table | — | — | — | — |

### 1.2 Read paths

| Caller | Function | employeeId | employeeRole (persona filter) | conversationId | entityType/Id | Notes |
|---|---|---|---|---|---|---|
| Ask AI simple stream | `ask-ai/route.ts:1229-1233` `retrieveMemory` | **no** | **no** | yes | no | No persona filter; employee tier never queried |
| TrueForge HTTP turn | `trueforge-client.ts:472-477` | yes | no | yes | no | only if not prefetched |
| In-process turn | `local-turn.ts:496-501` | yes | no | yes | no | same |
| WorkItemWorkflow parent | `WorkItemWorkflow.ts:180-187` → `activities/index.ts:507-533` `retrieveForEmployee` | yes | **not passed** (routing happens *after* retrieve at `:198`) | yes | no | idempotency-cached 24h |
| Child agent turn | `activities/index.ts:176-183` | yes | yes | yes | no | only path with persona filter |
| `/api/agent/run`, `/stream` | `agent/run/route.ts:97`, `agent/stream/route.ts:96` | ? | yes | ? | ? | |
| Brain UI | `brain/route.ts:323-329` `searchMemoryHybrid` | n/a | n/a | n/a | n/a | same `hybridSql(false)` — UI/agent parity is now real |
| Cognee tool | `tools/cognee.ts:67-72` | n/a | n/a | n/a | n/a | dataset = ctx.orgId |

`entityType`/`entityId` is supplied by **no caller** → entity lock (`retrieve.ts:360-364,377`) and facts-first (`:626`) are dead in practice.

### 1.3 Storage / retrieval engine

| Item | Reality | Evidence |
|---|---|---|
| Vector store | pgvector `vector(1536)` on 4 tables; partial HNSW cosine `WHERE embedding IS NOT NULL`; GIN on `body_tsv` (`'english'`) | `013_memory_rag.sql:41,49-55,70-72` |
| Embedding model | LiteLLM `text-embedding-3-small` via OpenRouter, `dimensions:1536` | `infra/litellm/*.yaml:37-42`, `docker-compose.yml:834-835`, `embed.ts:511` |
| Dim guard | worker fail-fast `EMBEDDING_DIM==1536` | `embed.ts:75-94,107-123,476-481` |
| Hybrid ranking | `0.4*fts + 0.6*cosine − 0.15 if stale`, entity_lock/same_thread first, global `LIMIT 48`, cosine distance `<0.45` | `retrieve.ts:342-343,413-417,466-467` |
| Cognee | separate service, dataset `org_<uuid>`, `GRAPH_COMPLETION`, `only_context`, `ENABLE_BACKEND_ACCESS_CONTROL=false`, LLM = OpenRouter gemini-2.5-flash, local bge-small embeddings, sqlite/kuzu/lancedb on volume `cognee-data` | `cognee-client.ts:112,117-123,188-196`; `docker-compose.yml:697-709` |
| Cognee auth | optional bearer `COGNEE_API_KEY` sent by client; **server does not enforce** (no key env on `cognee` service) | `cognee-client.ts:17-22`; `docker-compose.yml:696-707` |
| Dedupe | exact SHA-256 `content_hash` unique `(org_id, source, source_ref, content_hash)` | `013:65-66`, `embed.ts:59-61,589-599` |
| Decay / TTL | `expires_at` column exists, **no writer sets it**; only a `stale` flag after 21 days | `retrieve.ts:40,323` |
| Conflict resolution | `fact_conflicts` + router to work_items exist; nothing writes conflicts; sync only sets `knowledge_sources.status='conflict'` | `022_entity_graph.sql:265`, `fact-conflict-route.ts`, `ingest-file.ts:931-946` |
| Citations | `M-n` ids renumbered per query — row UUID dropped; `G-n` graph ids carry no timestamp | `retrieve.ts:432,437-438`; `cognee-client.ts:145-156` |
| Redaction gate | regex secrets / PAN / Aadhaar / card / SSN + KYC-kind skip | `redact.ts:34-49,90-111` |

---

## 2. Bugs

| ID | Sev | Where | What happens | Fix sketch | Status |
|---|---|---|---|---|---|
| MEM-B01 | P0 | `ingest-file.ts:583` + `embed.ts:453-462` + `ingest-file.ts:835` | Parent file row set `status='syncing'` on ingest; `markJob` only updates the **chunk's** row (`path#cN`). Parent never becomes `ready`; `/api/brain/reindex` GET reports `pending=true` forever (`reindex/route.ts:127`). | Track chunk-job completion against the parent (count or `knowledge_source_id` + `chunk_index`), flip parent when all chunks succeed. | 🔴 |
| MEM-B02 | P0 | `ingest-file.ts:836` vs `retrieve.ts:296-303,334-340` | Chunk memories have `source_ref=path#cN` but the disable check matches `ks.path = source_ref` exactly. Disabling a file does **not** hide its chunks — "Disabled sources must not be retrieved" (`013:325`) is broken for every chunked doc. Same for `#chunk-N` (`embed-enqueue.ts:331`). | Add `knowledge_source_id` FK on memory rows and join on it. | 🟢 2026-10-05: filter matches chunk refs (`#cN`/`#chunk-N`) to the parent path; disable/enable action on `PATCH /api/brain/source:<id>`; syncs keep a disabled source disabled |
| MEM-B03 | P0 | `embed.ts:601-631`, `:788-792`, `:459`; `embed-enqueue.ts:297-320` | `knowledge_sources` upsert on `(org, connector, path)` stores `pendingText` in metadata. Two embed jobs for the same conversation (W1 fires every message) share one row: B overwrites A's text; A embeds B's text; `markJob` strips `pendingText`, so B reads `''` → `skipped:empty`. **Lost writes under normal WhatsApp cadence.** | Put the payload on `ingestion_jobs`, never on the shared source row. | 🔴 |
| MEM-B04 | P1 | `memory-writeback.ts:353-388,427-462` vs `:729-736` | Extracted fact / entity rows are inserted with `embedding NULL` and never embedded; no `embedding IS NULL` backfill exists. Write-back memory is FTS-only. | Enqueue embed per fact row; periodic NULL-embedding backfill. | 🔴 |
| MEM-B05 | P1 | `retrieve.ts:342-343,378-379,409-410` | Vector predicate is a **range filter** (`<=> < 0.45`) inside an `OR` with FTS; HNSW only accelerates `ORDER BY <=> LIMIT`. Every retrieve is a seq scan of the org's rows across 4 tables computing 1536-d distances. `hnsw.iterative_scan` (`:555-561`) is a no-op. | Per-tier CTE `ORDER BY embedding <=> $q LIMIT k` UNION FTS top-k, then re-rank. | 🔴 |
| MEM-B06 | P1 | `retrieve.ts:717-725` | `Promise.race` fallback fires at `timeoutMs+50` (3550 ms) but the SQL branch runs embed (≤400 ms) **then** a 3500 ms `statement_timeout` query. Under load, empty memory is returned even though SQL succeeds, and the client stays checked out until statement_timeout. | Single deadline across embed+SQL; abort query on race loss. | 🔴 |
| MEM-B07 | P1 | `WorkItemWorkflow.ts:180-187` → `index.ts:522-529` | `employeeRole` not passed; retrieval runs before `routeEmployeeActivity` (`:198`). Persona tier exclusions (`retrieve.ts:656-694`) never apply on the inbound parent path. Ask AI (`ask-ai/route.ts:1229`) also never passes role/employee. | Route first, then retrieve with the resolved employee. | 🔴 |
| MEM-B08 | P1 | `brain/route.ts:491-497`; `brain/[id]/route.ts:146-169`; `embed-enqueue.ts:246` | Body stored **unredacted**; only embedding input is redacted. FTS snippets (`retrieve.ts:319`) return the raw body — PAN / API keys typed into Brain are retrievable. `content_hash` diverges (raw vs redacted, `embed-enqueue.ts:273,221`). | Redact before INSERT/UPDATE; one hash. | 🔴 |
| MEM-B09 | P1 | `embed-enqueue.ts:261-273` | Brain create/PATCH embeds only `chunks[0]` (≤1000 chars); long SOPs get one vector for the first paragraph. | Child chunk rows or multi-vector. | 🔴 |
| MEM-B10 | P1 | `embed-enqueue.ts:268-279` | In-place re-embed is `void`-fired in a Next.js request — no Temporal, no job row. Redeploy/OOM drops it; row stays `embedding NULL` forever; returned `jobId: inplace-…` is not a job. | `ingestion_jobs` row + EmbedWorkflow update-in-place. | 🔴 |
| MEM-B11 | P1 | `brain/[id]/route.ts:235-244` | `DELETE knowledge_sources` cascades to `ingestion_jobs` (`013:337`) but **not** to produced memory rows → ghost knowledge stays retrievable. | Delete by `knowledge_source_id`. | 🔴 |
| MEM-B12 | P1 | `ingest-file.ts:998-1019,1097-1101` | Cursor stores both `modifiedTime` and `pageToken`; next run builds a **new `q`** and reuses the old `pageToken` → Google 400 → sync fails until cursor cleared. | Drop pageToken when query changes. | 🔴 |
| MEM-B13 | P1 | `embed.ts:640-648`, `:257-261`; `reindex/route.ts:226-233,299-304` | Job row committed, then `workflow.start` failure only logged. Job stays `queued` forever; `periodic-registry.ts:22-33` has no Embed/Sync drainer. | Outbox sweep per org; requeue `running` older than N min. | 🔴 |
| MEM-B14 | P2 | `ingest-file.ts:1041,1010` | Drive path = `${id}/${name}`; rename → duplicate memory; `trashed=false` filter means deletions never observed → no tombstones. | Key on `fileId`; separate trashed pass. | 🔴 |
| MEM-B15 | P2 | `ingest-file.ts:447-462`, `:419-420`, `:364-374` | Whole file buffered, no size cap (OOM); no charset/BOM handling; `looksLikeText` heuristic mangles Latin-1. | Size cap, stream to Docling, charset sniff. | 🔴 |
| MEM-B16 | P2 | `ingest-file.ts:1115-1215,1217-1314` | Sheets/HubSpot sync writes `status='ready'` catalog rows with no memory text — Brain shows knowledge that is not retrievable. | Emit a memory row per contact/row or label `catalog_only`. | 🔴 |
| MEM-B17 | P2 | `memory-writeback.ts:633-636` | Policy-blocked facts counted as `skippedDuplicates` — metrics lie. | Separate counter. | 🔴 |
| MEM-B18 | P2 | `embed.ts:816-991`, `ingest-file.ts:830-841,842-845` | One Temporal workflow **per chunk** (200-page doc → 200 workflows) and 3–4 pool checkouts per job; N+1 on `knowledge_sources`. | Batch per document. | 🔴 |
| MEM-B19 | P2 | `retrieve.ts:41,466-467` | Docs claim per-tier limit 12 (`memory.md:45`); code is one global `LIMIT 48` — a chatty conversation tier starves `org_memory`. | Per-branch LIMIT. | 🔴 |
| MEM-B20 | P2 | `013:49-55` | `to_tsvector('english')` only; Hindi/Hinglish real-estate text gets no stemming. | `simple`+`english` dual tsvector or `pg_trgm`. | 🔴 |

## 3. Security / tenancy

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| MEM-S01 | P0 | **Raw, unredacted transcript/facts sent to Cognee**, whose LLM is external OpenRouter. `redactForEmbed` not applied; `remember` tool forwards model text as-is. PII/secrets leave the VPC. | `memory-writeback.ts:753-765`; `tools/cognee.ts:32-36`; `docker-compose.yml:700-702` | 🔴 |
| MEM-S02 | P0 | Every inbound customer message becomes org-wide `conversation_memory` (W1) with no policy gate; `filterCitationsForPersona('customer')` only filters `entity` tier (`retrieve.ts:663-670`) → Customer employee can cite **another customer's** WhatsApp text. Violates `20_memory_and_learning.md:47`. | `WorkItemWorkflow.ts:253`, `activities/index.ts:636-658` | 🔴 |
| MEM-S03 | P1 | Cognee runs with `ENABLE_BACKEND_ACCESS_CONTROL=false`; isolation is the dataset *name* chosen by the client. Any process on `darex-net` (sandbox, mcp-bridge) can read/write any org's graph. No server-side key. | `docker-compose.yml:707`; `cognee-client.ts:112,120` | 🔴 |
| MEM-S04 | P1 | Cognee data never deleted on DSR delete or org purge → orphaned tenant copy after "deletion". | `dsr/tables.ts:31-48`, `org-purge.ts:61-66` | 🔴 |
| MEM-S05 | P1 | `memory_revisions.previous_body` retains full prior text and is absent from both delete lists. `knowledge_sources.metadata.pendingText/ingestText/ingestBase64` hold raw bytes and are absent from org-purge. | `094:7-16`; `dsr/tables.ts:31-48`; `org-purge.ts:61-66` | 🔴 |
| MEM-S06 | P1 | Model-supplied `source_ref`, `entity_id`, `from_id/to_id` persisted as provenance/edges without existence checks (edges have no FK, `013:257-258`). Prompt-injected transcript can forge provenance. | `memory-writeback.ts:207-208,217-228,251-257,464-475` | 🔴 |
| MEM-S07 | P1 | Brain PATCH/DELETE and source DELETE write **no audit event**; DELETE takes no revision snapshot. | `brain/[id]/route.ts:218-266` | 🔴 |
| MEM-S08 | P2 | Graph citations typed `tier:'org'` (`cognee-client.ts:148`) so cognified transcripts bypass the `conversation`-tier persona exclusion. | `retrieve.ts:671-686` | 🔴 |
| MEM-S09 | P2 | Retrieve timeout race leaves the scoped client running; `_rollbackFailed` never set by retrieve → a failed ROLLBACK can return a dirty connection with GUC still set. | `retrieve.ts:565-571`; `tools/shared.ts:54-63` | 🔴 |
| ✅ | — | RLS: all four memory tables `FORCE ROW LEVEL SECURITY`; worker uses `set_config(false)`+`RESET`; dashboard uses `getScopedClient()`; no raw-pool queries on memory tables; `body.orgId` ignored (`reindex/route.ts:154-155`); cognee tool ignores payload org (`tools/cognee.ts:14-16`). | `013:57-63,113-119,167-173,223-229`; `tools/shared.ts:37-66` |

## 4. Functional gaps toward "what do we know?" (cited, never invented)

| ID | Sev | Gap | Evidence | Enterprise target | Status |
|---|---|---|---|---|---|
| MEM-G01 | P0 | Only Drive files + pasted text produce memory. Sheets/HubSpot = catalog only. Gmail, Slack, Notion, Calendar, Stripe, Zendesk: **no ingest**. | `ingest-file.ts:64,1316-1334`; `SyncWorkflow.ts:5` | Connector-native incremental ingest for every connected source with per-source freshness. | 🔴 |
| MEM-G02 | P0 | No scheduled sync; `SyncWorkflow` only via manual POST. No freshness SLA. | `periodic-registry.ts:22-33`; `reindex/route.ts:252-278` | Cron per connector + freshness badge + stale-source alert. | 🔴 |
| MEM-G03 | P0 | Citations lose row identity (`M-n`); UI shows no `sourceRef`/link/revision on a cited fact. Answers cannot be traced to a document/chunk. | `retrieve.ts:432`; `brain/page.tsx:185-186` | Stable citation ids (`tier:uuid`), click-through to source + chunk + revision. | 🔴 |
| MEM-G04 | P1 | Per-employee memory: `employee_memory` never written; `employee-retrieve.ts` only adds a refund citation — `memory.md:56` claim is false. | `employee-retrieve.ts:22-45` | Employee-owned learned patterns with explicit sharing rules. | 🔴 |
| MEM-G05 | P1 | Entity graph: `entities`/`facts`/`fact_conflicts` unwritten; `memory_edges` written, never read except DSR export; `entity_memory.entity_id` is free text from the LLM. `validFrom/validUntil/supersedesId` declared in types with no columns. | `retrieve.ts:625-654`; `dsr/run-export.ts:144`; `shared-types/memory.ts:106-109` | Resolved contacts/companies/deals with typed facts and validity windows. | 🔴 |
| MEM-G06 | P1 | Learning loop: `human_correction`/`decision_card_resolved`/`obligation_resolved` events defined, **no caller**. Brain PATCH does not mark human-confirmed or boost. | `memory-writeback.ts:624-627`; `writeback-policy.ts:1-7` | Feedback → confidence; corrections outrank stale rows. | 🔴 |
| MEM-G07 | P1 | Contradicting `org_memory` rows both returned; no supersedes chain. | `retrieve.ts:413-417` | `supersedes_id` + current filter + contradiction card. | 🔴 |
| MEM-G08 | P1 | No retrieval-quality eval (recall/precision), no golden set, no per-org RAG metrics. | `infra/evals/lib/scenarios.js:207,248` | Offline eval per release + online citation-hit metric. | 🔴 |
| MEM-G09 | P1 | No reranker; fixed 0.4/0.6 blend; 0.45 gate hard-coded; no near-dup collapse. | `retrieve.ts:342,414` | Cross-encoder rerank, MMR. | 🔴 |
| MEM-G10 | P2 | UI hybrid parity ✅ (`brain/route.ts:313-366`) but no tier/source/date facets; `loadEntities` keyword-only (`:279`). | — | Faceted search. | 🔴 |
| MEM-G11 | P2 | No bulk forget by source/customer/entity; no memory export. | `brain/[id]/route.ts:218-266` | Forget-by-entity, export. | 🔴 |
| MEM-G12 | P2 | Docs drift: `gap26sept/brain.md:56,80` cite a non-existent `memory_embeddings` table and `005_brain.sql`; `memory.md:45` per-tier limit. | — | Refresh. | 🔴 |

## 5. Enterprise readiness

| ID | Sev | Area | Reality | Evidence | Status |
|---|---|---|---|---|---|
| MEM-E01 | P0 | DSR delete coverage | SQL memory ✅; **Cognee ❌, `memory_revisions` ❌, `sync_cursors` ❌** | `tables.ts:31-48`; `org-purge.ts:61-66` | 🔴 |
| MEM-E02 | P1 | Encryption at rest | Postgres + `cognee-data` volumes unencrypted; bodies plaintext | `docker-compose.yml:45,709` | 🔴 |
| MEM-E03 | P1 | Retention | `expires_at` never populated; no policy per org/tier | — | 🔴 |
| MEM-E04 | P1 | Audit of memory reads/writes | Reads: none. Writes: `memory_writeback` work_event only; Brain mutations unaudited | `WorkItemWorkflow.ts:627-634` | 🔴 |
| MEM-E05 | P1 | Quotas | No per-org cap on rows/bytes/embeds; Drive 50 files/run unlimited across runs | `ingest-file.ts:28-29` | 🔴 |
| MEM-E06 | P1 | Embedding cost | `org_model_spend` exists, `embed.ts` records nothing | — | 🔴 |
| MEM-E07 | P1 | Backup/restore | Cognee sqlite/kuzu files, no dump path | `docker-compose.yml:705-709` | 🔴 |
| MEM-E08 | P2 | Residency | Embeddings and Cognee LLM go to OpenRouter (US) regardless of tenant | `litellm/*.yaml:39` | 🔴 |
| MEM-E09 | P2 | Virus scan / parser | ClamAV and Docling referenced, **not in compose**; PDF/DOCX silently `skipped:parse` | `ingest-file.ts:232,377-384` | 🔴 |
| MEM-E10 | P2 | Two-org RLS vector test | `check-memory-rls.sql`, `check-retrieve-memory.js` exist, not in `pnpm test` | `future-scope/10:233` | 🔴 |

## 6. Dead / duplicate code

- `retrieve.ts:208-211` `embedQuery` deprecated alias; `:218-220` `vectorLiteral` wrapper.
- `ingest-file.ts:289-292` `virusScanStub`.
- `redact.ts:114-120` `redactForEmbedActivity` registered (`activities/index.ts:28`), no workflow calls it.
- Two chunkers: `ingest-file.ts:301-362` (token, `#cN`) vs `embed-enqueue.ts:41-107` (char, `#chunk-N`).
- `startEmbedWorkflowFireAndForget` / `isAlreadyStarted` / `hashEmbedContent` / `UUID_RE` duplicated: `embed.ts:243-262,236-241,59-61` vs `embed-enqueue.ts:111-161,33-35`; `isAlreadyStarted` again `reindex/route.ts:16-21`.
- `canMutateBrain` / `parseBrainId` / `tableForTier` triplicated: `brain/route.ts:107-118`, `brain/[id]/route.ts:20-67`, `revisions/route.ts:12-41`; `tableForTier` again `embed-enqueue.ts:118-133`.
- KYC kind sets duplicated: `ingest-file.ts:14-15` vs `redact.ts:32`.
- `activities/index.ts:664-706` `writeBackMemoryActivity` parallels `MemoryWriteBackWorkflow`; `enqueueEmbedActivity` (`:630-662`) is a second, ungated write path.

## 7. Test coverage map

| Area | Tests | Gaps |
|---|---|---|
| Retrieve merge / persona filter | `memory/retrieve.test.ts:5-108` (pure) | No SQL/RLS test in `pnpm test`; `hybridSql`, timeout race untested |
| Redaction | `activities/redact.test.ts:6-80` | No test that Brain body insert is redacted (it isn't) |
| Write-back | `memory-writeback.test.ts:5-46`, `writeback-policy.test.ts:5-15` | Event classification from callers, Cognee payload redaction, lost write |
| DSR table list | `dsr/tables.test.ts:10-50` | Does not assert `memory_revisions`/Cognee |
| `embed.ts` | **none** | dim mismatch, pendingText race, parent status |
| Ingest / chunker / Drive cursor | **none** | |
| Dashboard `embed-enqueue`, `brain-reindex`, brain routes | **none** | |
| Cognee client tenancy | `infra/scripts/test-cognee-memory.js` (manual) | not in CI |
| Two-org RLS vector | manual scripts | not in CI |

## 8. Fix order for this domain

1. **MEM-S01 / MEM-S03** — redact before Cognee; server-side Cognee key; network-restrict Cognee to worker + dashboard.
2. **MEM-S02 + MEM-B07** — gate W1 through `writeback-policy`; route before retrieve; per-customer scoping of `conversation_memory` citations for Customer persona.
3. **MEM-B01 / B02 / B11** — `knowledge_source_id` FK on memory rows; parent lifecycle; disable/delete cascade.
4. **MEM-B03** — job payload off the shared `knowledge_sources` row.
5. **MEM-B04** — embed write-back facts + NULL backfill sweep.
6. **MEM-B05** — index-able vector query.
7. **MEM-E01 / S05** — Cognee + `memory_revisions` + `sync_cursors` in DSR and purge.
8. **MEM-G03** — stable citation ids → provenance UI.
9. **MEM-G01 / G02** — connector-native ingest + scheduled sync (Gmail, Slack, Notion first).
10. **MEM-G05 / G06** — write the entity graph and the learning loop that already have readers.
