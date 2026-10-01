# Workstream 05 — Data sources and knowledge

Integrations are systems we authenticate to. Data sources are
everything the brain is allowed to know. This workstream is ingest,
normalize, retrieve (via 03), cite, and forget.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/08-tools-catalog.md`,
`11-database-tenancy.md`. Future-scope `07`.

- Class B communications persist (`conversations`, `messages`).
- Class C files: `file_ops` on local workspace only; Drive/Docs/
  Sheets are live tools when connected, not an ingest pipeline.
- Class F: Jina `web_search` / `web_extract`.
- Class A structured sync: **none**. No parse/OCR, no website
  crawl, no public official cache.
- `database_query` is raw SQL (RLS SELECT, 25 rows).

---

## 2. Target

Sources: `docs/future-scope/07-data-sources-knowledge.md`,
`02` §3, `15` §4.

Trust classes A > B/C > D/E > F. G never overwrites A. Two class-A
sources in conflict → mark `conflict`, ask owner.

Ingest: embed messages async; file → virus scan → parse → chunk →
embed; structured CRM/listings as **tables first**; owner-approved
crawl; public official datasets with `retrieved_at` + TTL.

Semantic layer: `metrics.query`. Raw SQL admin-only.

Refuse: secrets in files, other orgs’ data, scraped portal dumps,
clinical notes by default, full Aadhaar/SSN/PAN, CSAM (illegal;
stop), unlicensed MLS extracts.

---

## 3. Gaps

**Audit 2026-08-14:** K1/K3/K4 **done**. K2 **partial** (virus-scan
stub). K5 RERA public tool exists.

| Item | Status |
|------|--------|
| Message persist | **done** |
| Embed pipeline | **missing** (workstream 03 M2) |
| File parse / virus scan | **missing** |
| Sync cursors | **missing** |
| Semantic metrics | **missing** |
| Source health UI | **missing** |
| Official public cache | **missing** |

---

## 4. Work items

### K1 — Drive `knowledge_sources` + `ingestion_jobs`

- **What:** Each source has hash, last_synced, status. Jobs are
  org-scoped, never on the webhook thread.
- **Where:** embed-worker + Temporal.
- **Depends on:** M1.
- **DoD:** `/brain` reindex creates a job. `last_error` does not
  leak tokens.

### K2 — File ingest v1

- **What:** Upload or Drive watch → scan → Docling (default) →
  chunk 512–1024 / 15% overlap → embed. Table chunks stay whole.
- **Where:** embed-worker. Do not make LlamaIndex the agent OS.
- **Depends on:** M2.
- **DoD:** SOP PDF retrievable with path + modified_at. No KYC
  embed. Secrets redacted.

### K3 — Sync-worker cursors

- **What:** `sync_cursors` per org+connector+stream. Webhooks
  preferred. Idempotent on `source_ref`. Nango tokens only.
- **Where:** Temporal; `tools/` read adapters.
- **Depends on:** C3.
- **DoD:** Retry does not duplicate. Sheets vs CRM conflict is
  marked, not silently picked.

### K4 — Semantic metrics registry

- **What:** Metric ids in YAML/table. Tool `metrics.query`.
  Restrict raw `database_query` to admin. Cube/DuckDB are ideas,
  not a new SoR.
- **Where:** `packs/core-b2b/kpis.yaml`;
  `services/workflows/src/tools/metrics.ts`.
- **Depends on:** allowlist; core pack can start first.
- **DoD:** “Unworked inquiries” hits a metric, not free SQL.
  Numbers match the SQL definition.

### K5 — Public official fetch + cache

- **What:** RERA-class fetch with URL + `retrieved_at` + TTL.
  Never as legal opinion.
- **Where:** `tools/public/rera.ts`. Wave C / RE.
- **Depends on:** RE pack; legal review of the source.
- **DoD:** Stale cache labeled. Agent states retrieval date.

---

## 5. End-to-end connections

Memory (03) is the retrieve/write API. Connectors (04) are class A
auth. Channels (06) are class B. `/brain` (09) is source health.
Insight (10) consumes K4. Packs (13) add class A extras.

---

## 6. Non-goals

GraphRAG on live listings; scraping portals; storing Aadhaar/SSN;
clinical notes in Darex; replacing Postgres with a warehouse.

---

## 7. Verification

Class A facts carry `source + source_ref + synced_at`. Web (F)
labeled as web, never as list price. Two-org ingest isolation.
Disconnected Drive → notConnected, not a hallucinated folder.

Related: [03-memory-rag-brain.md](./03-memory-rag-brain.md),
[10-analytics-observability.md](./10-analytics-observability.md).
