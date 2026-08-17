# 07 — Data sources and the knowledge plane

Integrations (`06`) are **systems we authenticate to**. Data sources
are **everything the brain is allowed to know**. They overlap. This
file is the knowledge architecture: ingest, normalize, retrieve, cite,
forget.

---

## 1. Source classes

| Class | Examples | Trust | Cite as |
|-------|----------|-------|---------|
| A. System of record | CRM, PM software, MLS feed, Stripe, Sheets designated as inventory | Highest | `source + source_ref + synced_at` |
| B. Org communications | WhatsApp, Gmail, Slack (org-connected) | High (it happened) | conversation id |
| C. Org documents | Drive, Notion, uploads, SOPs | High if hash matches | path + modified_at |
| D. Licensed third-party | ATTOM, CoStar, partner portals | High within license | vendor + retrieved_at |
| E. Public official | RERA, Companies House, Census | High with TTL | URL + retrieved_at |
| F. Web search / extract | Jina | Medium | URL; **never** as listing price |
| G. Model inference | Summaries, match scores | Low as fact | labeled “inferred” |
| H. Human assertion | Owner typed “price is 2.4 Cr” | High for that org | user id + time |

**Conflict rule:** A > B/C > D/E > F. G never overwrites A. H
overwrites A only for that org’s own listings, not for MLS of others.

If two class-A sources disagree (Sheets vs Zoho), mark `conflict` and
ask owner; do not silently pick.

---

## 2. What we ingest (universal)

### 2.1 Conversations

Already: `conversations`, `messages`. Future: embed new messages
async (embed-worker). Summarize thread every N messages into
`conversation_memory`.

### 2.2 Files

Pipeline: upload or Drive watch → virus scan → parse (PDF, DOCX,
XLSX, CSV, images OCR) → chunk → embed → `knowledge_sources` hash
for incremental.

Chunking: 512–1024 tokens, 15% overlap, keep table chunks whole when
possible (price lists, inventory).

### 2.3 Structured sync

CRM contacts/deals, listings, orders, tickets: **tables first**,
embeddings second (on notes/descriptions). Structured query is not
RAG. “2BHK under 1.2 Cr in Koramangala” is SQL/filters, not cosine
on vibes.

### 2.4 Webhooks / events

Payments, CRM stage changes, Gmail push, Meta inbound, GBP reviews.
Normalize to `work_events`. Optionally embed event text.

### 2.5 Owner-approved website crawl

Sitemap of *their* domain. Respect robots. Recrawl TTL. Used as
support SOP / project microsite. Not a weapon to clone competitors.

### 2.6 Public official datasets

Batch or on-demand with cache. Always store `retrieved_at`. RERA
example: cache 24h unless user forces refresh.

---

## 3. Real estate sources (detail)

| Source | Class | Ingest method | What we store |
|--------|-------|---------------|---------------|
| Google Sheet inventory | A | sync-worker / on query | `re.listing` rows |
| Zoho/FUB/HubSpot | A | webhook + cursor | contacts, inquiries, notes |
| MLS RESO | A/D | feed incremental | listings + photos URLs |
| Portal lead email | B | Gmail parse | inquiry + listing id if present |
| WhatsApp | B | webhook | messages + media pointers |
| Drive floorplans | C | watch | file refs on listing |
| Matterport | D | API | tour URL |
| RERA public | E | fetch+cache | rera_id validity, not legal opinion |
| Neighborhood blog via web | F | on demand | labeled web |
| Showing feedback | H/B | form/WhatsApp | listing memory |

Photos: store in Drive/S3; DB has URLs. Embeddings on captions and
extracted EXIF geo only if present — do not invent lat/lng from
neighborhood name without geocoder.

---

## 4. Other vertical sources (quick map)

| Vertical | Class A extras | Class C extras | Class E/F |
|----------|----------------|----------------|-----------|
| Agency | Ads, GA4, GSC | brand guidelines | competitor pages (F, labeled) |
| Ecom | Shopify orders/SKU | return policy PDF | |
| SaaS | Stripe, product analytics | docs site crawl | changelog |
| Wholesale | Tally/Zoho Books, price list | | GSTN (E) |
| Recruiting | ATS | scorecards | job boards official API only |
| Hospitality | PMS | house rules | GBP reviews |
| Clinic-ops | Calendar only by default | **no clinical notes** | |

---

## 5. Retrieval algorithm (the brain’s recall)

`retrieveMemory(orgId, query, opts)`:

1. **ACL / RLS** — session already scoped; still pass orgId from
   session, never body.
2. **Entity lock** — if `contact_id` / `listing_id` known, fetch
   those rows first (structured).
3. **Filters** — budget, status, geo radius (listings, SKUs).
4. **Vector** — top k from org_memory + entity_memory + conversation
   summaries, metadata filter pack/type.
5. **Graph hop** (optional) — contact —showed→ listing —feedback→.
6. **Freshness** — drop or downrank `stale` and expired.
7. **Budget** — cap tokens; prefer structured tables over dumping 40
   PDFs.
8. **Citations** — every paragraph the model may use as fact gets a
   source id. Ask AI UI shows them.

Ask AI and webhook agent **both** call this before the model. That is
non-negotiable for calling Darex a brain.

---

## 6. Write-back (learning without poisoning)

After a work item closes:

- LiteLLM JSON summary: facts vs open questions vs actions taken.
- Extract structured field updates (budget changed) with confidence.
- High confidence + schema-valid → update entity.
- Low confidence → `needs_attention` “confirm this memory”.
- Never write inferred prices into `list_price`.
- Dedup: hash of fact; don’t append “wants 3BHK” ten times.

Decay: requirements `stale_after` (org setting, default 21 days for
buyers, 7 for hot rentals). Agent must re-confirm stale facts.

---

## 7. Knowledge graph (phase after vectors)

Nodes: contact, company, listing, ticket, employee, document,
work_item. Edges: `inquired_about`, `shown`, `owns`, `employs`,
`cites`. Start with `memory_edges` in Postgres. Apache AGE only if
multi-hop queries become painful.

Graph is **not** a substitute for RLS: every node still `org_id`.

---

## 8. Semantic layer (stop giving the model raw SQL)

`database_query` today is a powerful footgun. Future:

```
metrics:
  - id: re.inquiries_unworked
    description: Inquiries with no outbound in 2h
    source: sql ...
  - id: core.revenue_collected_7d
    source: stripe projection
```

The tool `metrics.query` takes metric ids + date range. Raw SQL tool
restricted to admin employees. Insight engine uses the same metrics.

---

## 9. Media and binary

- Images/audio: store object storage; transcribe/OCR async.
- PII in images (KYC): encrypt, restricted employee allowlist, no
  send to web_search, no third-party embed APIs that retain data
  unless DPA exists.
- Video tours: URL only when possible (Matterport).

---

## 10. What we refuse to ingest

- Secrets found in files (block patterns; redaction job).
- Other orgs’ data (RLS test).
- Scraped portal HTML dumps the customer “just has”.
- Clinical notes by default.
- Full Aadhaar/SSN/PAN/card PAN.
- Child sexual abuse material — illegal; stop; no processing.
- Competitor MLS extracts the org is not licensed to hold.

---

## 11. Source health UI (“Brain” page)

Per source: last success, error, lag, document count, “reindex”.
Owner can disable a source (e.g. stop embedding Slack). Ask AI must
then not pretend Slack knowledge exists.

This page is how we earn the word **OS**: the customer can see the
brain’s senses, not a magic black box.

---

## 12. Alternatives in the world (instead of our ingest/RAG plane)

**What Darex does:** class A–H sources, structured tables first,
pgvector second, cite, forget. Embed-worker off the webhook.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Unstructured.io** ETL for 60+ file types | Production parse/chunk/embed; MCP server | Python service we can *call* from embed-worker; not the SoR | [Unstructured-IO/unstructured](https://github.com/Unstructured-IO/unstructured) |
| 2 | **LlamaParse / LiteParse** (LlamaIndex) | Vision-language tables in PDFs (OMs, rent rolls) | ADOPT for RE PDFs; keep our tables + RLS | LlamaIndex blog “Beyond raw text”; llama_parse |
| 3 | **Docling** (IBM) / **Apache Tika** | Local OSS parse, no cloud | Good default before LlamaParse cost | [docling-project/docling](https://github.com/docling-project/docling), Apache Tika |
| 4 | **Airbyte / dlt** for CRM/SoR sync | Cursors, 300+ sources, OSS | Our sync-worker must be org-scoped + Nango tokens | [airbytehq/airbyte](https://github.com/airbytehq/airbyte), [dlt-hub/dlt](https://github.com/dlt-hub/dlt) |
| 5 | **Microsoft GraphRAG** batch communities | Best for static SOP dumps | Lethal on live listings; `/brain` backfill only | [microsoft/graphrag](https://github.com/microsoft/graphrag) |

**Five things to steal anyway**

1. Tables in PDFs → LlamaParse/Docling, not naive chunking (`07` §2.2).
2. Airbyte cursor model → `sync_cursors` (`02`).
3. Trust classes A>F stay; GraphRAG never overwrites class A.
4. Virus scan + hash before embed (Unstructured partition step).
5. Source health UI like Airbyte connections page → `/brain`.

### Open-source GitHub — this file only (parse / RAG / SoR sync)

pgvector KEEP → `15` §1. Mem0 / Graphiti → `10`. GraphRAG is listed **only here**.

| Repo | Similar to | We take |
|------|------------|---------|
| [Unstructured-IO/unstructured](https://github.com/Unstructured-IO/unstructured) | File ETL for agents | Call from embed-worker |
| [docling-project/docling](https://github.com/docling-project/docling) | Local PDF/Office parse | Default parser |
| [apache/tika](https://github.com/apache/tika) | Java MIME/parse | Fallback for odd Office |
| [run-llama/llama_index](https://github.com/run-llama/llama_index) | RAG + LlamaParse | Table-preserving chunks (OMs, rent rolls) |
| [deepset-ai/haystack](https://github.com/deepset-ai/haystack) | Production RAG pipelines | Hybrid + eval metrics |
| [airbytehq/airbyte](https://github.com/airbytehq/airbyte) | SoR sync cursors | `sync_cursors` |
| [dlt-hub/dlt](https://github.com/dlt-hub/dlt) | Python ingest | Same, lighter |
| [microsoft/graphrag](https://github.com/microsoft/graphrag) | Static SOP communities | `/brain` backfill only; never live listings |
| [infiniflow/ragflow](https://github.com/infiniflow/ragflow) | Deep-doc RAG UI | Inspector ideas; not SoR |
| [datalab-to/marker](https://github.com/datalab-to/marker) | PDF → markdown | RE OM parse |
| [opendatalab/MinerU](https://github.com/opendatalab/MinerU) | PDF extract | Same |
| [pymupdf/PyMuPDF](https://github.com/pymupdf/PyMuPDF) | Fast PDF | Chunk worker |
| [typesense/typesense](https://github.com/typesense/typesense) | Typo-tolerant search | WATCH if FTS fails listings |
| [meilisearch/meilisearch](https://github.com/meilisearch/meilisearch) | Same | Same |
| [vespa-engine/vespa](https://github.com/vespa-engine/vespa) | Serving + ranking | Only if pgvector+FTS dies at scale |
