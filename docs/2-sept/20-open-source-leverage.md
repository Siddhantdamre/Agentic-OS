# 20 — Open Source We Can Take

What exists in the open-source world that closes a Darex gap, what we take from
each, and what we must not swap. This is the **product-decision** version;
`docs/future-scope/15-open-source-research-landscape.md` is the longer research
appendix and holds the original keep/adopt/study/reject calls.

## 0. The rule for adopting anything

A dependency earns its place only if it closes a gap in `09` faster than we can
build it **without violating any of the four invariants**:

1. **Tenancy** — org isolation must remain enforceable in Postgres RLS. A
   service that holds tenant data outside our database needs its own isolation
   model, backup story, and synchronisation problem.
2. **Confirm** — irreversible actions keep their human gate. A framework that
   executes tools autonomously by default fights the product.
3. **Honest connectors** — no library may report a success it did not get.
4. **The LiteLLM / agent-loop split** — structured JSON call sites use a plain
   client; tool grammars belong only where tools are called.

A library that breaks one of these is a **REJECT**, no matter how good it is.

| Tag | Meaning |
|---|---|
| **KEEP** | Already load-bearing. Extend, never replace. |
| **ADOPT** | Add as a library or worker; does not change the agent loop. |
| **STUDY** | Steal patterns, evals, schemas, UX. Do not import as kernel. |
| **WATCH** | Revisit when a specific phase needs it. |
| **REJECT** | Reopens a closed decision. |

---

## 1. What we already run (KEEP — closed decisions)

| Piece | Role | Why it stays |
|---|---|---|
| **Postgres + RLS** | System of record and tenancy | OS-grade isolation; `FORCE` + `WITH CHECK` proven with a two-org test |
| **pgvector** | Vectors in the same database | Memory without a second cluster; RLS covers vectors for free |
| **Temporal** | Durable execution, HITL signals | Hours-long approvals, resumable sends, inspectable state |
| **Nango** | Self-hosted OAuth broker | Per-org tokens, self-hostable; we do not rebuild a credential plane |
| **LiteLLM** | Model gateway | Provider-agnostic; structured call sites hit it directly |
| **Langfuse** | Tracing and cost | Per-org attribution, joinable to `audit_events.langfuse_trace_id` |
| **Supertokens** | Auth | Self-hostable; SAML/SSO layers on top |
| **atomic-agent + MCP bridge** | Employee loop, one action bus | Tool grammar and allowlist in one place |
| **Chatwoot (fork)** | Inbox gateway | Thin use; do not maintain a full fork of the product |
| **Next.js** | Dashboard and API | |
| **Redis** | Queues and caches | Split instances rather than swap products |
| **promptfoo** | Golden evals | Already runs 6 suites |

**Closed rejects:** a second agent runtime, a hosted OAuth broker, a hosted
memory service as the system of record, a custom foundation model, our own MLS.

---

## 2. Entity graph and fact extraction — gap `09` §1.1

The single most important gap. Nothing here should become the store; the store
is Postgres. What we take is **schema design and reconciliation logic**.

| Project | Take | Do not take | Tag |
|---|---|---|---|
| **Graphiti** (Zep) | The temporal-fact model: bi-temporal validity (`valid_from`/`valid_to` plus ingestion time), edge invalidation instead of deletion, and episode-based extraction. This is the closest published design to what `04` §3.3 specifies. | Its Neo4j dependency and its runtime | **STUDY** |
| **Zep / Mem0** | Fact-extraction prompts, contradiction-resolution heuristics, memory-decay policy | Hosted memory as the system of record — tenancy, cost, and data residency all break | **STUDY** |
| **Cognee** | Pipeline decomposition: ingest → extract → resolve → enrich as separate stages, each independently retryable | Its own storage layer | **STUDY** |
| **Apache AGE** | Cypher-style traversal **inside Postgres** if recursive CTEs over `memory_edges` stop performing. Already named as the escape hatch in `013_memory_rag`. | Adopting it before there is a measured traversal bottleneck | **WATCH** |
| **dbt / SQLMesh** | Model the fact and metric layer as versioned, tested transformations rather than ad-hoc SQL | Making it the runtime path — this is for aggregation, not request-time | **WATCH** |
| **Dedupe.io / splink** | Probabilistic entity resolution with explicit match/no-match/review thresholds — exactly the three-way outcome `04` §3.6 needs | Auto-merging below the review threshold | **ADOPT** (splink; Python worker) |

**Concretely we take:** bi-temporal validity columns from Graphiti, the
three-way resolution outcome from splink, and the staged-pipeline shape from
Cognee. We write ~600 lines of our own extraction against our own schema.

---

## 3. Retrieval quality — gap `07`

We already do hybrid FTS + HNSW, which most RAG libraries are still catching up
to. What is missing is fusion ranking and re-ranking.

| Project | Take | Tag |
|---|---|---|
| **Reciprocal Rank Fusion** (the algorithm, ~20 lines) | The principled way to combine `fts_rank` and `vec_sim`, which `retrieve.ts` currently carries as separate signals | **ADOPT** |
| **bge-reranker / Jina reranker** (open weights) | A cross-encoder re-rank over the top ~50 fused candidates before the token budget is applied | **ADOPT** |
| **RAGAS** | Retrieval-quality metrics: context precision, context recall, faithfulness. Turns "is retrieval good?" into a number we can regress against | **ADOPT** (evals only) |
| **LlamaIndex / LangChain** | Chunking strategies, query-rewriting patterns, small-to-big retrieval ideas | **STUDY** — importing either as a framework reopens the agent-loop decision |
| **pgvectorscale / DiskANN** | If HNSW recall or memory footprint becomes a problem at scale | **WATCH** |
| **Postgres full-text refinements** | `websearch_to_tsquery`, weighted `setweight` on title vs. body | **ADOPT** — free, no dependency |

**Concretely we take:** RRF, a reranker model behind LiteLLM, RAGAS in the eval
suite, and better tsquery handling. All additive to `retrieve.ts`.

---

## 4. Document understanding — gap `09` §3.1

Turning a dropped PDF contract into entities and obligations.

| Project | Take | Tag |
|---|---|---|
| **Docling** (IBM, MIT licence) | Layout-aware PDF/DOCX/PPTX → structured markdown with tables preserved. Table fidelity is the requirement for rent schedules and invoices. | **ADOPT** |
| **Unstructured.io** (open core) | Partitioning strategies per document type | **STUDY** — the open core is capable; watch the licence line |
| **Marker** | Fast PDF → markdown when layout is simple | **WATCH** (fallback path) |
| **Tesseract / PaddleOCR** | Scanned documents, which Indian brokerage genuinely has | **ADOPT** (PaddleOCR — better on non-Latin scripts) |
| **LayoutLM-family** | Key-value extraction from forms | **STUDY** — an LLM with a good schema prompt is usually enough |

**Constraint:** the document pipeline must obey `blockedDataClasses`
(`kyc`, `pan`, `aadhaar`). Extraction runs, identity numbers are redacted before
anything is stored or embedded.

---

## 5. Voice and telephony — gap `09` §3.1

| Project | Take | Tag |
|---|---|---|
| **LiveKit Agents** | Realtime voice agent orchestration, self-hostable, with turn-taking and interruption handling already solved | **ADOPT** when voice ships |
| **Pipecat** | Alternative pipeline framework; simpler mental model, smaller community | **WATCH** |
| **Whisper / faster-whisper** | Self-hosted STT, including Indian-accented English and Hindi | **ADOPT** |
| **Piper / Coqui** | Self-hosted TTS where latency and cost matter more than voice quality | **WATCH** |
| **Asterisk / FreeSWITCH** | Only if we need our own PBX rather than a provider | **REJECT** for now — Twilio is already a tool |

Voice is the highest-signal missing sense for the SMB buyer: the customer who
calls is more valuable than the one who fills a form, and today that call is
invisible to the brain.

---

## 6. Proactivity and metrics — gap `04` §5

| Project | Take | Tag |
|---|---|---|
| **Cube / MetricFlow** | The **semantic metrics layer**: define a KPI once, have analytics and insight cards read the same definition. `kpis.yaml` per pack is already this idea, less formally. | **STUDY**, then formalise our own YAML |
| **Prophet / statsforecast** | Baselines with seasonality, so "unusual" accounts for the fact that Sunday is always quiet | **ADOPT** (statsforecast — lighter) |
| **Great Expectations / Soda** | Data-quality expectations as declarative rules, which is structurally the same object as a watcher | **STUDY** — the rule-object design, not the runtime |
| **Grafana alerting model** | Threshold vs. baseline, `for` duration, deduplication, silences. The silence and dedup design is directly reusable for the silence budget. | **STUDY** |

**Concretely we take:** Grafana's silence/dedup semantics, statsforecast for
baselines, and Cube's separation of metric definition from query.

---

## 7. Procedure authoring — gap `09` §1.3

| Project | Take | Tag |
|---|---|---|
| **n8n / Windmill** (both source-available) | Node-graph UX for a non-technical author; Windmill's typed-parameter model for scripts is close to the procedure `parameters` object | **STUDY** — as a *customer-facing* surface pattern, never as our execution kernel (Temporal is) |
| **Temporal's own patching / versioning** | The correct way to evolve long-running procedures without breaking in-flight runs | **ADOPT** — needed before multi-week nurture procedures are customer-authored |
| **JSON Schema / Zod** | Typed procedure parameters with validation and generated forms | **ADOPT** (already in the dependency tree) |
| **OpenAI Swarm / CrewAI / AutoGen** | Handoff and role-contract patterns for multi-agent work | **STUDY** — `crew-contract.ts` with `MAX_CREW_SPAWN=3` is already a stricter version of this |

---

## 8. Safety, injection and evals — gap `09` §2.1, `18`

| Project | Take | Tag |
|---|---|---|
| **Rebuff / LLM Guard** | Injection-detection heuristics and canary-token techniques | **ADOPT** (detection signal; never the sole gate) |
| **Garak** | Adversarial probe suites — a ready-made source of red-team goldens | **ADOPT** (eval only) |
| **NeMo Guardrails** | Rail-definition DSL as a design reference | **STUDY** — our gates are database-enforced, which is stronger |
| **promptfoo** | Already in use; extend with the red-team suites it ships | **KEEP + extend** |
| **DeepEval / Phoenix / RAGAS** | Retrieval and answer metrics in CI | **ADOPT** (evals only) |
| **τ-bench, AgentBench, WorkArena** | Task benchmarks that test *tool use plus user simulation*, which is exactly our shape | **STUDY** — steal the methodology for our own per-procedure goldens |
| **OWASP LLM Top 10** | The checklist to audit against, and a shared vocabulary for customer security reviews | **ADOPT** as the audit framework |

**The strongest defence we have is already ours:** authorisation is a database
array, not prompt text. Every library above is a detection layer on top of that,
never a replacement for it.

---

## 9. Infrastructure and operations

| Project | Take | Tag |
|---|---|---|
| **PgBouncer** | Already running | **KEEP** |
| **pgBackRest / wal-g** | Real PITR backups behind `restore-drill.sh` | **ADOPT** |
| **Terraform / OpenTofu** | The starter stack in the roadmap: VPC, RDS, Redis, secrets, HTTPS | **ADOPT** (OpenTofu — licence stability) |
| **Prometheus + Grafana + Alertmanager** | Replaces the five hand-rolled `alerting-*.js` scripts with a standard stack | **ADOPT** |
| **OpenTelemetry** | Trace context propagation across dashboard → worker → tools, joined to Langfuse | **ADOPT** |
| **Infisical / OpenBao** | Secrets management once BYOK credentials multiply across orgs | **WATCH** |
| **Keycloak** | Only if Supertokens cannot deliver SAML/SCIM for enterprise | **WATCH** — do not pre-empt |
| **ClickHouse** | Already behind Langfuse; also the right home for a metrics warehouse later | **KEEP / WATCH** |

---

## 10. Distribution — where open source is a channel, not a dependency

Three genuine opportunities, in order of leverage:

1. **MCP server distribution.** The MCP bridge already exposes `mcp.darex.*`.
   Publishing a Darex MCP server puts the product inside every MCP-capable
   client (IDEs, desktop assistants, other agents) with the same allowlist and
   audit rules. This is distribution with no new attack surface, because the
   authorisation model is unchanged.

2. **Open-sourcing the pack format.** `pack.yaml` + employees + entities +
   workflow map + KPIs + compliance + goldens is a genuinely reusable schema.
   Publishing the format and a reference pack lets partners and customers author
   verticals, and every third-party pack is a distribution channel we did not
   staff. The eval requirement (`no goldens, no install`) is the quality gate
   that makes this safe.

3. **Open-sourcing the honesty eval suite.** `honesty-connectors.yaml` — with
   its `negativeOutput` technique of writing down the exact plausible lie — is a
   contribution the whole agent ecosystem lacks and would use. It is also the
   single best marketing asset the product has: a public, runnable demonstration
   that our agents do not fabricate, at a moment when every competitor demos
   simulated results.

**Not open source:** the entity graph and extraction logic, the procedure
compiler, the ranking model. Those are the compounding parts.

---

## 11. What we must not do

| Temptation | Why not |
|---|---|
| Adopt LangGraph, LangChain, Letta, or CrewAI as the agent runtime | A second runtime means two tool paths, two allowlist implementations, and two places for the confirm gate to be missed. Steal the patterns; keep one kernel. |
| Move memory to a hosted service (Mem0 Cloud, Zep Cloud, Pinecone) | Tenant data leaves Postgres; RLS stops being the guarantee; residency and cost both become customer objections. |
| Replace Nango with Composio or a hosted broker | Credentials are the highest-trust asset in the product. Self-hosted, or not at all. |
| Fork Chatwoot deeply | Thin gateway use is fine. Owning a full inbox product is a company we are not starting. |
| Add a graph database before measuring | `memory_edges` plus recursive CTEs inside RLS is correct until proven slow. AGE is the escape hatch. |
| Import a "RAG framework" wholesale | Our retrieval is already hybrid, tenant-scoped, budgeted, and timeout-bounded. Most frameworks are none of those. |

---

## 12. Adoption shortlist, ranked by leverage per unit of effort

| # | Adopt | Closes | Effort |
|---|---|---|---|
| 1 | Reciprocal Rank Fusion in `retrieve.ts` | Retrieval quality | Hours |
| 2 | RAGAS + DeepEval in the eval suite | No retrieval metric today | Days |
| 3 | Garak red-team suites as goldens | Untested injection risk | Days |
| 4 | statsforecast baselines | Proactivity has no "unusual" | Days |
| 5 | Docling + PaddleOCR document worker | Documents are invisible to the brain | 1–2 weeks |
| 6 | splink entity resolution with a review threshold | Same person, four half-memories | 1–2 weeks |
| 7 | OpenTelemetry propagation into Langfuse | Cross-service traces are stitched by hand | 1 week |
| 8 | Prometheus/Grafana replacing `alerting-*.js` | Hand-rolled alerting | 1 week |
| 9 | pgBackRest behind the restore drill | Backups exist; PITR does not | 1 week |
| 10 | LiveKit + faster-whisper voice channel | The highest-signal missing sense | 3–4 weeks |

Everything above is additive. None of it touches the four invariants, and none
of it reopens a closed decision.
