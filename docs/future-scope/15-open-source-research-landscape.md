# 15 — Open-source libraries, remote platforms, people, and research

> This file is the **research appendix** for the Brain OS pack.
> Snapshot: **2026-08-13**. Star counts and product names move; the
> **keep / study / reject** calls are the durable part.
>
> It does **not** change the kernel. Darex already chose a stack
> (atomic-agent + MCP + Temporal + Nango + LiteLLM + Langfuse +
> Postgres/RLS/pgvector + SuperTokens). This document answers:
> what else exists in the world, who built it, what we steal as
> *ideas*, what we might *adopt as a library*, and what we must
> **not** replace.

Read this after `00`, `02`, and `14`. When a future agent wants a
new framework, they must find the row here first.

---

## How to use this file

Every row is tagged:

| Tag | Meaning for Darex |
|-----|-------------------|
| **KEEP** | Already in the runtime. Do not replace. Extend. |
| **ADOPT** | May add as a *library or worker* without changing the agent loop. |
| **STUDY** | Steal patterns, evals, papers, UX. Do not import the product as the kernel. |
| **WATCH** | Interesting; revisit when a phase needs it (voice, graph, computer-use). |
| **REJECT** | Reopens a closed decision (second runtime, closed OAuth broker, new LLM). |

**What “helps” means:** a library helps if it closes a gap in `01`
faster than we can build it, without violating tenancy, confirm,
honest connectors, or the LiteLLM / atomic-agent split.

---

## 1. What Darex already runs (KEEP — do not reopen)

These are load-bearing. Research below exists so we **do not**
rediscover them every quarter.

| Piece | What it is | Why KEEP |
|-------|------------|----------|
| **Postgres + RLS** | Tenant system of record | OS-grade isolation; pgvector lives here |
| **pgvector** | Vectors in the same DB | Memory without a second cluster in Phase 6 |
| **Nango** | Self-hosted OAuth / token plane | Nervous system auth; we do not rebuild Composio |
| **Temporal** | Durable workflows + HITL signals | Webhooks, plan execute, nurture timers |
| **atomic-agent v0.1.72** | Tool-using employee loop (`:8787`) | MCP grammar; skills; pinned image |
| **MCP bridge** `:8790` | `mcp.darex.*` tools | One action bus; allowlist |
| **LiteLLM** | JSON classify / plan / revise / embed | Fast structured thought; not the tool loop |
| **Langfuse** | Traces + later evals | Learning layer |
| **SuperTokens** | Sessions | Add SAML on top; do not replace |
| **Redis** | Cache / future event-bus | Split instances rather than swap product |
| **Chatwoot** | Thin inbox gateway | Do not fork the whole app |
| **Next.js dashboard** | Owner UI + API routes | Split ingest/SSE off; keep the product surface |
| **Jina** | `web_search` / `web_extract` | Cite; not a system of record |
| **Docker sandbox** | `code_execution` | Commit the image context; keep the pattern |

**Closed rejects (also in `14`):** Composio as credential runtime;
LangGraph / Hermes as a second agent OS; a new OAuth broker; our
own MLS; our own bank; custom foundation model.

---

## 2. One-page map: what helps each Brain OS layer

| Layer (`00`) | Keep | What actually helps next | Study, do not swap |
|--------------|------|--------------------------|--------------------|
| 1 Perception | Nango, Chatwoot, WhatsApp Cloud, webhooks | Unified ingest-worker; more Nango providers; LiveKit later | n8n/Zapier as *customer* automation, not our kernel |
| 2 Memory | pgvector in Postgres | Hybrid search (vector + FTS); write-back job; optional Graphiti *ideas* | Mem0/Zep/Cognee as hosted brains (tenancy + cost) |
| 3 Reasoning | LiteLLM JSON + atomic-agent | Skills mounted; critic JSON; playbook matcher | CrewAI/AutoGen/Magentic-One patterns only |
| 4 Action | MCP + tool-executor + Nango | Split executor modules; connector registry | Composio, unified.to as *competitors to Nango* |
| 5 Governance | RLS, confirm, allowlists | τ-bench-style tool+user evals; audit role | Letta as whole runtime |
| 6 Learning | Langfuse | Phoenix/DeepEval/Promptfoo in CI; golden sets | LangSmith lock-in |

---

## 3. Agent runtimes and “AI employee” loops

Darex’s employee is **atomic-agent + MCP**, orchestrated by
**Temporal**, planned by **LiteLLM**. Everything below is either
that same idea under another name, or a product that *is* the
runtime (which we will not become).

### 3.1 What we run

| Project | License | Notes |
|---------|---------|-------|
| **atomic-agent** ([AtomicBot-ai/atomic-agent](https://github.com/AtomicBot-ai/atomic-agent)) | OSS, pinned `v0.1.72` | OpenAI-compatible SSE; drops `system` (ground in user message); skills via `SKILL.md`; MCP client. **KEEP.** Mount custom skills in the image — that is the next work, not a new runtime. |

### 3.2 Graph / crew / actor frameworks (STUDY, REJECT as kernel)

| Project | Who | What it is | Darex take |
|---------|-----|------------|------------|
| **LangGraph** | Harrison Chase / LangChain Inc. | Typed state graph, durable execution, HITL interrupts, TS+Python | We **left** LangGraph (`apps/agents/` legacy). Steal: checkpoint + interrupt UX. Do not revive as runtime. |
| **LangChain** | same | Integrations + LCEL | Too much abstraction for our executor. MCP tools are enough. |
| **CrewAI** | João Moura / CrewAI Inc. | Role + Task + Crew; Flows for event control; MCP adapter | Maps to our **employee + skill + Temporal**. STUDY role/backstory YAML. REJECT as orchestrator. |
| **AutoGen** → **Microsoft Agent Framework** | Microsoft Research (Qingyun Wu, Gagan Bansal, et al.) | Async actors; Magentic-One orchestrator+specialists | STUDY Magentic-One: Orchestrator ledger + WebSurfer/Coder. We already have manager + specialists as config. AutoGen is maintenance-mode; MAF is Azure-gravity. REJECT kernel. |
| **Letta** (ex-MemGPT) | Charles Packer, Sarah Wooders, Ion Stoica (Berkeley) | Agent *is* an OS: core memory (RAM) + archival (disk); agent pages itself | STUDY the **hierarchical memory metaphor** for `10`. REJECT replacing atomic-agent — Letta *is* a runtime. |
| **Agno** (ex-Phidata) | Agno | Python AgentOS, teams, MCP, control-plane UI, ~40k★ | STUDY multi-tenant AgentOS claims. Python-only; we are TS. REJECT kernel. |
| **PydanticAI** | Samuel Colvin / Pydantic | Typed agents, durable execution via Temporal/DBOS | STUDY: they **compose with Temporal** the way we should — agent logic ≠ durability engine. ADOPT *ideas* for LiteLLM JSON schemas. |
| **Mastra** | Mastra (TS, $22M Series A, 1.0 in 2026) | TS agents + workflows + memory + MCP + Next.js | Closest *language* cousin. STUDY memory/workspace APIs. REJECT swapping atomic-agent; we already have the loop. Optional later: Mastra only if we ever write a *new* TS worker that is not the employee loop. |
| **Vercel AI SDK** | Vercel | Tool loops, UI hooks (`useChat`), Next.js | STUDY streaming UI. Dashboard already has custom NDJSON. Do not dual-stack streaming protocols. |
| **OpenAI Agents SDK** | OpenAI | Agents, handoffs, guardrails | Vendor-first. STUDY handoff + guardrail API shape for critic. REJECT lock-in. |
| **Google ADK** | Google | Workflow agents + A2A | GCP gravity. WATCH A2A protocol only. |
| **OpenHands** (ex-OpenDevin) | Xingyao Wang, Graham Neubig, CMU/All Hands | MIT software-agent SDK; sandbox; event-sourced state | STUDY sandbox + confirm + event sourcing for `code_execution` / computer-use. Not a business-employee OS. |
| **Hermes Agent** | Nous Research | Agent with memory providers | Our `hermes` route is **broken legacy**. Delete or rewire; do not revive as second runtime. |
| **DSPy** | Omar Khattab, Stanford | Compile prompts from data | WATCH for eval-runner / classify+plan prompt optimization in Phase 6+. Not a runtime. |
| **Deep Agents** (LangChain) | LangChain | Plan + subagents + filesystem | STUDY subagent pattern; we do this with Temporal child workflows. |

**Why not Mastra/LangGraph even though they are “production” in 2026:**
Darex already paid the migration cost *off* LangGraph onto
atomic-agent. A second loop splits allowlists, tracing, and the
`system`-role bug class. The OS is one employee loop.

### 3.3 Patterns to steal (no new dependency)

From this family, Darex already implements or will implement:

| Pattern | Origin | Darex home |
|---------|--------|------------|
| ReAct (reason ↔ act) | Yao et al. 2023 | atomic-agent tool loop |
| Plan-then-execute | Plan-and-Solve, LLM Planner | Ask AI complex + `agent_plans` |
| Verbal reflection | Reflexion (Shinn, Yao, …) | Langfuse + memory write-back, not weight updates |
| Orchestrator + specialists | Magentic-One | Manager employee + pack roster |
| HITL interrupt | LangGraph | Temporal signal + PlanCard |
| Skills as files | Cursor / Claude / atomic-agent | `SKILL.md` **mounted in image** |
| Handoffs | OpenAI Agents SDK | Router `employeeId` + allowlist |
| Guardrails | same + PydanticAI | Critic LiteLLM JSON + confirm classes |

---

## 4. Memory, RAG, and “company brain” libraries

Phase 6 is **pgvector tables we own** (`10`). Hosted memory products
are tempting and usually wrong for a multi-tenant OS: they become
a second system of record, with someone else’s tenancy story.

### 4.1 KEEP / ADOPT (in our Postgres)

| Project | License | Helps how |
|---------|---------|-----------|
| **pgvector** | PostgreSQL | HNSW (prefer) or IVFFlat. **Multitenancy note from upstream:** a shared ANN index can leak recall across tenants — use `org_id` filters **and** consider list partitioning / per-org indexes if recall tests fail. |
| **Postgres FTS** (`tsvector` + GIN) | built-in | Hybrid: vector + BM25-class keyword. Mem0/Unforget/Graphiti all converged here. ADOPT in `retrieveMemory`. |
| **Apache AGE** | Apache-2.0 | Graph in Postgres (Cypher). `02` already: AGE first, Neo4j only if proven. WATCH until `memory_edges` is too small. |
| **pg_trgm** | built-in | Fuzzy names (“Kapoor” / “Kapur”). ADOPT for inspector search. |

### 4.2 Memory layers (STUDY architecture, do not outsource tenant facts)

| Project | Stars (order, 2026) | Model | Darex take |
|---------|---------------------|-------|------------|
| **Mem0** ([mem0ai/mem0](https://github.com/mem0ai/mem0)) | ~63k | Fact extract → vector (+ graph); user/session/agent tiers; Apache-2.0; paper arXiv:2504.19413 (Chhikara, Khant, Aryan, Singh, Yadav) | STUDY extraction JSON + hybrid retrieval. Hosted Mem0 **REJECT** as org brain (PII leaves our RLS). Optional ADOPT: OSS SDK *behind* our tables only if it saves months — still write `org_id` ourselves. |
| **Graphiti / Zep** ([getzep/graphiti](https://github.com/getzep/graphiti)) | ~30k | **Temporal** knowledge graph: facts with validity windows; hybrid semantic+BM25+graph; paper *Zep: A Temporal Knowledge Graph Architecture for Agent Memory* arXiv:2501.13956 | **Best idea for Darex entity memory.** Listings, rents, budgets, CRM stages *change*. STUDY bi-temporal facts (`valid_from` / `invalidated_at`) in `entity_memory`. Graphiti defaults to Neo4j — extra cluster. Prefer AGE/edges in Postgres until Neo4j is forced. Zep Cloud REJECT for tenancy. |
| **Cognee** ([topoteretes/cognee](https://github.com/topoteretes/cognee)) | ~30k | ECL pipeline (extract–cognify–load); can demo graph+vector on **one Postgres**; paper arXiv:2505.24478 (Markovic et al.) | STUDY “company brain” ingest of Drive/Notion. Postgres-graph is still demo; production graph-native. WATCH, do not block Phase 6 on it. |
| **Letta memory** | ~24k | Agent-owned core + archival | STUDY paging; we keep retrieval in *our* prefix (`buildGroundedUserMessage`). |
| **Microsoft GraphRAG** | ~35k | Batch community summaries over static corpora | STUDY for **org SOP / Drive dumps**. Bad for live CRM. Too slow/expensive for inbound WhatsApp. Use for `/brain` backfill jobs only if at all. |
| **LlamaIndex** | Jerry Liu | Document RAG + workflows | STUDY chunking/readers. REJECT as the agent OS. |
| **Haystack** (deepset) | Apache-2.0 | Production RAG pipelines | STUDY eval + hybrid. Python. |
| **LangMem** | LangChain | Memory for LangGraph | Only if we were on LangGraph. We are not. |
| **SuperMemory** | supermemoryai | Hosted memory API; claims SOTA LongMemEval/LoCoMo | WATCH benchmarks. REJECT as SoR. |
| **Hindsight** | Vectorize | Embedded Postgres memory | STUDY single-binary ops. |
| **Unforget** | unforget-ai | Zero-LLM write (~7ms), 4-channel hybrid on Postgres | STUDY write-path: **do not LLM-extract on the webhook**. Matches our “embed-worker, not request thread” rule. |
| **LightRAG** | HKUDS et al. | Dual-level graph RAG, cheaper than GraphRAG | WATCH for org KB. |
| **Chroma / Qdrant / Weaviate / Milvus / LanceDB** | various | Dedicated vector DBs | REJECT for Phase 6. Optional later if pgvector recall/ops fail at scale — still RLS or per-tenant collections. |

### 4.3 Benchmarks memory work must beat (or at least cite)

| Bench | What it measures | Use |
|-------|------------------|-----|
| **LongMemEval** | Long-horizon conversational memory | Our returning-customer eval (`10` §7) is the product version of this |
| **LoCoMo** | Long conversation memory | Same |
| **BEAM** | Very long memory | Later |
| **MemoryBench** (SuperMemory) | Compare Mem0/Zep/etc. | Do not chase vendor numbers; run **two-org RLS + WhatsApp returning contact** |

**What helps Phase 6 immediately:** hybrid retrieval, hash-idempotent
upserts, temporal invalidation of facts, LLM extract **off** the
webhook, inspector UI. Those are in `10`. Libraries above are
references, not blockers.

---

## 5. Orchestration and durable execution

### 5.1 KEEP

**Temporal** (MIT, self-host now, Cloud later). Polyglot, signals
for confirm, timers for nurture, child workflows for fan-out.
Already in webhooks and `AutonomousAgentWorkflow`.

### 5.2 STUDY / WATCH (do not migrate)

| Engine | Why people pick it | Why we do not switch |
|--------|--------------------|----------------------|
| **Restate** | Single Rust binary; virtual objects per entity; BSL runtime | Cool fit for `work_item` as a virtual object. Migration cost > benefit while Temporal is live. WATCH if Temporal ops become the bottleneck. |
| **Inngest + AgentKit** | TS, events, AgentKit networks + MCP | Serverless gravity. We need self-host + HITL that already works. STUDY AgentKit router. |
| **Trigger.dev v3** | TS background jobs | Fine for embed-worker *if* we did not already have Temporal workers. |
| **Hatchet / DBOS** | Postgres-native workflows | Philosophically close (everything in PG). STUDY if we ever want fewer moving parts. |
| **Cadence** | Temporal’s ancestor (Uber) | No reason. |
| **n8n / Windmill / Activepieces** | OSS Zapier | **Customer-facing** “if this then that” later, not the kernel. WATCH as a *pack* or embed. |
| **Camunda** | BPMN | Too heavy; packs are YAML + Temporal names. |

**What helps:** Temporal **durable-agent** recipes (isolate LLM
calls in activities — we already do). Restate/Inngest blogs are
good reading for WorkItemWorkflow design, not a rewrite.

---

## 6. Tools, MCP, OAuth, integration planes

Integrations are the nervous system (`06`). Auth plane stays Nango.

| Project | Role | Tag |
|---------|------|-----|
| **Model Context Protocol** (Anthropic, 2024–) | Tool/resource protocol | **KEEP** (we speak it). Follow spec + official TS SDK updates. |
| **Nango** | OAuth, token refresh, 400+ APIs | **KEEP.** Sync-worker is *ours*; Nango stays tokens. |
| **Composio** | Closed-ish tool+auth | **REJECT** (original spec: closed + breach history). |
| **Pipedream / Zapier / Workato / Make** | iPaaS | STUDY connector coverage. We execute in TS with honest `notConnected`. |
| **unified.to / Merge.dev / Knit** | Unified CRM/HR APIs | WATCH as a *read* adapter if 40 CRMs drown us; still Nango for OAuth. |
| **Klavis / mcp-use / awesome-mcp-servers** | MCP server catalogs | STUDY for `mcp.darex.*` design. Do not expose raw third-party MCP to a tenant without allowlist. |
| **Jina** | Search + extract | **KEEP** for world-sense. |
| **Firecrawl / Tavily / Exa / Brave Search** | Alt search/crawl | WATCH if Jina quality fails; still cite; never SoR. |
| **Browserbase / Kernel / Playwright** | Remote/local browser | WATCH Phase 17 last-resort computer-use. Confirm + sandbox + domain allowlist. |
| **E2B / Daytona / Modal sandboxes** | Hosted code sandboxes | STUDY vs our Docker sandbox. Prefer our image (no extra vendor) until scale. |

**MCP rule (unchanged):** one bridge, many tools, namespaced
`mcp.darex.*`, org from job context not from the model.

---

## 7. Observability, evals, prompt ops

| Project | Who | Tag |
|---------|-----|-----|
| **Langfuse** | Langfuse OSS | **KEEP.** Fix Redis isolation; do not swap. |
| **Arize Phoenix** | Arize | ADOPT in CI as optional OpenTelemetry/eval runner if Langfuse self-host stays painful. |
| **Braintrust** | commercial | WATCH for eval UX. Do not make it the SoR for traces. |
| **LangSmith** | LangChain | REJECT lock-in with LangGraph revival. |
| **Promptfoo** | OSS | ADOPT for golden conversation YAML in eval-runner. |
| **DeepEval** (Confident AI) | OSS+cloud | STUDY RAG metrics (faithfulness, citation). |
| **Ragas** | OSS | STUDY RAG eval. |
| **τ-bench** (Yao, Shinn, Narasimhan) | ICLR 2025 | **ADOPT as design:** tool-agent-user interaction in domains. Our golden WhatsApp+CRM paths *are* a private τ-bench. |
| **SWE-bench / SWE-agent** | Jimenez, Yang, Yao, Press, Narasimhan | STUDY agent-computer interface; relevant to sandbox, not listings. |
| **GAIA** | Mialon et al. | STUDY generalist agent eval; too web-search-heavy for tenant OS. |
| **WebArena / WebShop** | Zhou et al. / Yao et al. | STUDY computer-use evals if we build browser-runner. |

**What helps learning (layer 6):** one trace per work item, cost
per org, golden set in CI from Phase 6 onward. That is Langfuse +
eval-runner, not a new vendor.

---

## 8. LLM gateways and structured output

| Project | Tag |
|---------|-----|
| **LiteLLM** | **KEEP** for JSON + embeddings proxy. Models stay env. |
| **OpenRouter** | Already a possible LiteLLM backend. KEEP as *provider*, not a second gateway in app code. |
| **Instructor** (Jason Liu) | STUDY for Pydantic-like JSON from LiteLLM. We can stay with JSON schema in prompts if it works. |
| **Outlines** | WATCH constrained decoding if classify drifts. |
| **vLLM / Ollama / llama.cpp** | WATCH for on-prem embed or air-gapped orgs (Phase 15 residency). Not default. |

Do not let atomic-agent and LiteLLM both grow ad-hoc provider SDKs.
One gateway for JSON; atomic-agent’s own model env for the tool loop
(already split on purpose — `BUILD_STATE.md` hang).

---

## 9. Auth, realtime, media, graph extras

| Project | Tag |
|---------|-----|
| **SuperTokens** | **KEEP.** SSO SAML/OIDC on top (Phase 15). |
| **Keycloak / Authentik / Zitadel** | REJECT replace; STUDY SAML recipes. |
| **Casbin / Oso / OpenFGA** | WATCH if allowlists outgrow SQL. Not now. |
| **Redis** | **KEEP**; dedicated instances (cache / bus / Langfuse / Temporal). |
| **NATS / Redis Streams** | WATCH if pub/sub outgrows Redis. |
| **LiveKit** | WATCH voice employee (`06` livekit row). |
| **Deepgram / AssemblyAI / Whisper** | WATCH Phase 17 STT. |
| **ElevenLabs** | WATCH TTS; confirm voice-of-brand. |
| **Neo4j / FalkorDB / Kuzu** | Only if Graphiti-style graph leaves Postgres. Prefer AGE. |
| **ClickHouse** | Langfuse already uses it. Warehouse for Insight later (`02`). |
| **MinIO / S3 / R2** | Media lake when listings photos/voice land. |

---

## 10. People and labs worth following

Not an endorsement. These are the humans whose **papers and
products** map onto Darex layers. Follow the work, not the hype.

### 10.1 Agent algorithms and evals

| Person | Why they matter to Darex |
|--------|--------------------------|
| **Shunyu Yao** (OpenAI; Princeton PhD) | ReAct, Tree of Thoughts, Reflexion co-author, CoALA, SWE-agent, **τ-bench**. Our loop is ReAct; our product eval should look like τ-bench. |
| **Noah Shinn** | Reflexion; τ-bench. Verbal RL → our write-back + critic. |
| **Karthik Narasimhan** (Princeton NLP) | Advisor on ReAct/SWE-bench/τ-bench. |
| **Ofir Press** | SWE-bench / SWE-agent. Sandbox + agent-computer interface. |
| **Carlos Jimenez, John Yang** | SWE-bench. |
| **Jason Wei, Denny Zhou** (Google) | Chain-of-Thought. Classify/plan still CoT-shaped JSON. |
| **Omar Khattab** (Stanford → Databricks) | DSPy, ColBERT. Prompt compile + retrieval. |
| **Theodore Sumers, Thomas L. Griffiths** | CoALA (cognitive architectures for language agents) with Yao. Maps to our six layers. |

### 10.2 Multi-agent and “OS” metaphors

| Person | Why |
|--------|-----|
| **Charles Packer, Sarah Wooders, Shishir Patil, Ion Stoica** | MemGPT / Letta: LLM as OS (core vs archival memory). Steal the metaphor; keep our runtime. |
| **Qingyun Wu, Gagan Bansal, Chi Wang, Saleema Amershi, Ece Kamar** | AutoGen; Magentic-One (Adam Fourney et al.). Orchestrator + ledger. |
| **João Moura** | CrewAI role-playing crews → employee YAML. |
| **Harrison Chase** | LangChain/LangGraph: durable graphs + HITL. We use Temporal instead. |
| **Andrew Ng** | Agentic workflows teaching (decompose, tools, reflection). Useful internally; not a library. |

### 10.3 Memory, RAG, data

| Person | Why |
|--------|-----|
| **Jerry Liu** | LlamaIndex. Document ingest patterns. |
| **Prateek Chhikara, Taranjeet Singh, Deshraj Yadav** et al. | Mem0 paper + product. Fact extraction. |
| **Zep / Graphiti team** | Temporal facts. Highest-value *idea* for listings/CRM. |
| **Vasilije Markovic** et al. | Cognee KG+LLM paper. |
| **Microsoft GraphRAG authors** (Edge et al.) | Community summaries for static KB. |
| **pgvector maintainers** (Andrew Kane et al.) | Our memory engine. Read their multitenancy notes. |

### 10.4 Infra, tools, product companies

| Person / org | Why |
|--------------|-----|
| **Anthropic MCP team** | Tool protocol we speak. |
| **Nango** | Our OAuth plane. |
| **Langfuse team** | Our traces. |
| **Temporal** (Samar Abbas, Maxim Fateev — Cadence lineage) | Durability. |
| **BerriAI / LiteLLM** (Ishaan Jaffer) | Model gateway. |
| **SuperTokens** | Sessions. |
| **Graham Neubig, Xingyao Wang** | OpenHands production-agent SDK lessons (sandbox, event source, confirm). |
| **Jina AI** (Han Xiao) | Search/extract tools. |

### 10.5 Adjacent product companies (learn positioning, do not copy stack)

| Company | Shape | What to learn | What not to copy |
|---------|-------|---------------|------------------|
| **Dust.tt** | Multiplayer company AI, EU, MCP, semantic layer | Permissions dual-layer; “AI operator” UX; knowledge synthesis | Closed core; not multi-tenant *our* RLS model |
| **Lindy** | No-code AI employee for email/calendar | Simplicity of “hire for a task” | We are API-first OS + packs, not only no-code |
| **Relevance AI** | Agent workforce builder, L1–L4 autonomy | Autonomy levels vs our confirm classes | Builder-not-OS; weak vertical packs |
| **Ema** | Universal AI employee, enterprise | Role catalog marketing | Fusion-model lock-in |
| **Sierra** | CX agents, outcome pricing | Channel quality bar for support | Not a full brain OS |
| **Glean** | Enterprise search + agents + permissions | Permission-aware retrieval | Search company, not action OS |
| **Harvey / EvenUp** | Legal vertical AI | How deep a pack can go | Licensed advice — our non-goal |
| **Devin / Cognition, OpenHands** | Software employee | Sandbox + confirm | Coding, not B2B ops |
| **11x, Artisan, Aidan/Sable** | Specialist SDR/voice | Vertical employee depth | We stay platform + packs |
| **CellCog / others** | “Hire an AI employee” SaaS | Roster + shifts metaphor | Validate; do not chase every clone |
| **Adept** (acquired / pivoted lineage) | Computer use | Last-resort browser | Not default muscle |
| **MultiOn** | Web agent | Same | Same |

India / RE-adjacent to watch: **LeadSquared, Sell.Do, NoBroker,
Housing.com APIs** — products in `06`, not agent OS peers.

---

## 11. Papers that map onto Darex (annotated)

Read these when designing a phase, not as a bibliography flex.
Links are arXiv or venue names; versions move.

### Reasoning and acting

| Paper | Authors | Steal for Darex |
|-------|---------|-----------------|
| **ReAct** (ICLR 2023) | Yao, Zhao, Yu, Du, Shafran, Narasimhan, Cao | Tool loop: thought ↔ `mcp.darex.*`. Already live. |
| **Chain-of-Thought** (NeurIPS 2022) | Wei et al. | Classify/plan JSON; keep reasoning **off** on classify (hang). |
| **Tree of Thoughts** (NeurIPS 2023) | Yao, Yu, Zhao, Shafran, Griffiths, Cao, Narasimhan | Rare: hard planning. Do not ToT every WhatsApp. |
| **Reflexion** (NeurIPS 2023) | Shinn, Cassano, Berman, Gopinath, Narasimhan, Yao | Critic + episodic memory text. Write-back activity. |
| **Plan-and-Solve** | Wang et al. 2023 | Ask AI complex path. |
| **HuggingGPT** | Shen et al. 2023 | Router to specialists — our employee router. |
| **Toolformer** | Schick et al. 2023 | Self-supervised tool use; we use MCP instead of training. |
| **CoALA** (TMLR 2024) | Sumers, Yao, Narasimhan, Griffiths | Memory/action/decision modules — our six layers. |

### Multi-agent

| Paper | Steal |
|-------|-------|
| **AutoGen** (Wu et al. 2023) | Conversation between roles; we do Temporal not chat-ping-pong. |
| **Magentic-One** (Fourney, Bansal, Mozannar, … 2024) | Orchestrator progress ledger; recovery from errors. |
| **Generative Agents** (Park et al. 2023, Stanford) | Memory stream + retrieval + reflection. Closest academic cousin to “org brain.” **Do not** simulate 25 fake people in a village — apply to *real* employees + write-back. |
| **MetaGPT** | SOPs as prompts — our SKILL.md. |
| **Voyager** (Wang et al., NVIDIA/Caltech) | Skill library that grows. Org playbook promotion. |

### Memory and RAG

| Paper | Steal |
|-------|-------|
| **MemGPT** (Packer et al. 2023, arXiv:2310.08560) | Hierarchical memory; paging. |
| **Mem0** (Chhikara et al. 2025, arXiv:2504.19413) | Production fact extract. |
| **Zep / Graphiti** (arXiv:2501.13956) | Temporal validity. **High priority for listings/CRM.** |
| **Cognee KG–LLM** (Markovic et al. 2025, arXiv:2505.24478) | Graph–LLM interface. |
| **GraphRAG** (Edge / Microsoft 2024) | Static corpus communities. |
| **RAGAS / various RAG surveys** | Eval metrics for `/brain`. |

### Evals and interfaces

| Paper | Steal |
|-------|-------|
| **τ-bench** (Yao, Shinn, Razavi, Narasimhan, ICLR 2025) | Domain tool + user simulator. Pack golden sets. |
| **SWE-bench** (Jimenez, Yang, … ICLR 2024) | Real tools, real fail. Sandbox honesty. |
| **SWE-agent** (Yang, Jimenez, … NeurIPS 2024) | Agent-computer interface design. |
| **GAIA** (Mialon et al.) | Generalist bar — not our product bar. |
| **WebShop** (Yao, Chen, … NeurIPS 2022) | Grounded web agents. |

### Product / systems (not classic ML)

| Paper / note | Steal |
|--------------|-------|
| **OpenHands Software Agent SDK** (Wang, Neubig, et al., MLSys 2026) | Event-sourced state, sandbox, confirm, local→remote. |
| MCP spec + Anthropic engineering posts | Tool names, resources vs tools. |
| Temporal “your agent is a workflow” (2026) | Activities wrap LLM/tools. We already agree. |

---

## 12. Remote / hosted services (when self-host is not the point)

Darex self-hosts the kernel. Remote APIs are **muscles and senses**,
not the brain.

| Kind | Examples | Rule |
|------|----------|------|
| LLM APIs | OpenAI, Anthropic, Google, OpenRouter, Groq | Via LiteLLM / atomic-agent env. Fail-fast if unset. |
| OAuth APIs | Google, Meta, HubSpot, … | Via Nango. |
| Channels | WhatsApp Cloud, Twilio, Exotel, Instagram | BYOK + webhook signatures. |
| Search | Jina, later Tavily/Exa | Cite; not inventory. |
| Payments | Stripe, Razorpay | Confirm class `pay`. Never escrow. |
| E-sign | DocuSign, Leegality | Confirm `sign`. |
| Voice | Deepgram, LiveKit Cloud | Phase 17. |
| Maps | Google Maps, Mapbox, Nominatim | Public; rate-limit. |
| MLS / data vendors | RESO, ATTOM, CoStar | Licensed feeds; never scrape. |
| Observability SaaS | Langfuse Cloud, Phoenix Cloud | Prefer self-host; Cloud OK if residency allows. |
| Temporal Cloud | optional | After self-host is boring. |

**Never remote-out:** tenant memory, RLS, confirm decisions, raw
tokens (Nango holds them), audit log.

---

## 13. What will help — concrete, by upcoming phase

Mapped to `13-phased-roadmap.md`. This is the “keep these / this
helps” list the rest of the pack assumes.

### Phase 6 — Memory (do this first)

**Keep:** Postgres, pgvector, LiteLLM embeddings, Temporal
activities, `buildGroundedUserMessage`, RLS tests.

**Helps (ideas, maybe small libs):**

- Hybrid retrieval (vector + `tsvector`) — pattern from Mem0/Graphiti/Unforget.
- Temporal fact invalidation — **Graphiti paper**, implemented as columns, not Neo4j.
- Zero-LLM write on ingest — Unforget lesson; extract async.
- Promptfoo YAML for returning-customer eval.
- Instructor-style schema for `MemoryWriteBack` JSON.

**Does not help:** swapping in Mem0 Cloud, Letta server, Cognee as
the brain, GraphRAG on every message.

### Phase 7 — Insight

**Keep:** SQL aggregates, Langfuse costs, Temporal for “Review
Action”.

**Helps:** semantic metrics YAML (our code). WATCH Cube/dbt-style
semantic layers as *inspiration*, not a new warehouse product yet.

### Phase 8 — Scale

**Keep:** Redis, Temporal, PgBouncer pattern.

**Helps:** Redis pub/sub (no NATS yet). Dedicated Redis for
Langfuse (their docs). Terraform later.

### Phase 9–10 — Product + connectors

**Keep:** Nango, SuperTokens, MCP bridge.

**Helps:** Nango provider catalog (finish stubs). SuperTokens SAML
recipes. Chatwoot only as gateway.

### Phase 11+ — Vertical packs

**Keep:** pack YAML model (`03`).

**Helps:** CrewAI-style role cards as **pack employee YAML**.
τ-bench as eval shape. Dust/Glean permission stories for `/brain`.

### Phase 17 — Voice / computer-use

**Keep:** confirm + sandbox policy.

**Helps:** LiveKit Agents, Deepgram, Playwright, OpenHands sandbox
lessons, OpenAI CUA as **WATCH** not default.

---

## 14. Keep / adopt / study / reject — full cheat sheet

### KEEP (kernel)

Postgres+RLS, pgvector, Nango, Temporal, atomic-agent, MCP bridge,
LiteLLM, Langfuse, SuperTokens, Redis, Chatwoot-thin, Next.js,
Jina, Docker sandbox, plan-confirm-execute, employee-as-config.

### ADOPT (libraries or practices, not new OS)

Postgres FTS + HNSW; Promptfoo (or equivalent) in CI; τ-bench-style
domain evals; Instructor-like JSON for write-back; Apache AGE when
edges explode; LiveKit/Deepgram when voice starts; Playwright in
locked sandbox when computer-use starts; OpenTelemetry export from
Langfuse if we need it.

### STUDY (read, copy patterns, do not import as kernel)

LangGraph interrupts, CrewAI roles, Magentic-One ledger, Letta
core/archival, Mem0 extract, Graphiti bi-temporal facts, Cognee
ECL ingest, Generative Agents memory stream, OpenHands event
sourcing, Mastra TS agent APIs, Dust permission UX, Glean ACL
retrieval, PydanticAI+Temporal composition, DSPy for prompt
compile, n8n as future customer automation.

### WATCH (revisit on a named phase)

Restate, Inngest AgentKit, unified.to, Neo4j/FalkorDB, Qdrant,
vLLM on-prem, A2A protocol, GraphRAG batch jobs, E2B, Browserbase.

### REJECT (do not reopen)

Composio credential runtime; LangGraph/Hermes/Letta/Mastra/CrewAI
as the **employee loop**; second MCP server per vertical; Mem0/Zep
Cloud as tenant memory SoR; new OAuth broker; custom LLM; our MLS;
escrow; scraping portals; awaiting embeddings in webhooks; body
`org_id`.

---

## 15. Suggested reading order for a future coding agent

If you are implementing a phase and feel the urge to add a
framework:

1. `AGENTS.md` + `14-build-principles.md`
2. This file §14 cheat sheet
3. The phase file in `13` + the layer file (`08`/`09`/`10`/…)
4. **One** paper from §11 that matches the layer
5. Then write code in *our* modules

If after that you still want a new runtime, you are proposing a
fork. Stop and get a human decision. The research already says the
winning 2026 pattern is: **durable engine (Temporal) + typed
tools (MCP) + memory you own (Postgres) + a thin agent loop
(atomic-agent)**. Darex is already on that pattern.

---

## 16. Sources (starting points, not exhaustive)

- LangGraph vs CrewAI vs Letta vs AutoGen — MCP.Directory, 2026-05
- Ry Walker, *Agent Frameworks Compared*, 2026-02
- Mem0 vs Zep vs Letta vs Cognee — particula.tech / DEV / MCP.Directory, 2026
- Hindsight, *Best Open-Source Agent Memory Systems*, 2026-08-11
- Graphiti README + Zep paper arXiv:2501.13956
- Mem0 README + arXiv:2504.19413
- Cognee README + arXiv:2505.24478
- Magentic-One arXiv:2411.04468
- ReAct / Reflexion / ToT / CoALA / τ-bench / SWE-bench (venues above)
- Temporal vs Restate vs Inngest — dreaming.press, 2026
- Dust.tt, Relevance AI, Lindy, Glean public positioning, 2026
- OpenHands SDK paper, MLSys 2026
- Darex `BUILD_STATE.md`, `docs/current-working/`, this pack `00`–`14`

When a source disagrees with **current-working**, current-working
wins for what exists. When it disagrees with **this pack’s keep
list**, the keep list wins until BUILD_STATE records a deviation.

---

## 17. Unique GitHub catalog (each repo once)

**Rule:** a cloneable repo appears in **one** layer file. This section is
the union + KEEP + extras that do not belong to a layer. Odoo is only
`03`. Mem0 is only `10`. n8n is only `06`. Chatwoot is KEEP below, not
re-sold as an alternative in `11`.

### 17.1 Kernel KEEP (already running — do not re-list in layer files)

| Repo | Role |
|------|------|
| [AtomicBot-ai/atomic-agent](https://github.com/AtomicBot-ai/atomic-agent) | Employee loop v0.1.72 |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | JSON classify / plan / embed |
| [NangoHQ/nango](https://github.com/NangoHQ/nango) | OAuth / token plane |
| [temporalio/temporal](https://github.com/temporalio/temporal) | Durable HITL |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | Traces |
| [supertokens/supertokens-core](https://github.com/supertokens/supertokens-core) | Sessions |
| [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot) | Thin inbox gateway |
| [pgvector/pgvector](https://github.com/pgvector/pgvector) | Vectors in Postgres |
| [jina-ai/reader](https://github.com/jina-ai/reader) | World extract; cite, not SoR |
| [modelcontextprotocol/specification](https://github.com/modelcontextprotocol/specification) | MCP grammar for `mcp.darex.*` |

### 17.2 Where the rest live (open that file for the table)

| File | Owns |
|------|------|
| `00` | OpenFang, Agno, OpenHands, Dust, Continue, Cline, Goose, Skyvern, Browser Use, Eliza, AutoGPT, DSPy, Mastra |
| `01` | Promptfoo, Phoenix, Ragas, DeepEval, Giskard, OpenAI evals, anthropics/skills, OpenLLMetry, Promptflow, Weave, AIConfig, HELM |
| `02` | NATS, Apache AGE, ParadeDB, Cube, DuckDB, pg-boss, Graphile Worker, PgBouncer, E2B, Daytona, OTel JS, Unleash, MinIO, Traefik, ElectricSQL + Valkey, Infisical, ClamAV, Caddy, Envoy, CNPG, Dragonfly, Redpanda Connect |
| `03` | **Odoo, ERPNext, Frappe, Twenty**, SuiteCRM, EspoCRM, Dolibarr, Akaunting, Invoice Ninja, Budibase, Appsmith, NocoDB, Baserow, Directus |
| `04` | Medusa, Saleor, WooCommerce, Magento, PostHog, Outline, Strapi, Ghost, Moodle, OpenEMR, Plane, Listmonk, Plausible, Umami, Pretix |
| `05` | RESO metadata, Nominatim, OSM, MapLibre, Leaflet, Turf, Pelias, Photon, OpenAddresses, **Cal.com, Documenso**, geopy |
| `06` | **n8n**, Activepieces, Huginn, Pipedream, MCP servers/SDKs, Firecrawl, Crawl4AI, Scrapy, Crawlee, Camel, Svix, Playwright |
| `07` | Unstructured, Docling, Tika, LlamaIndex, Haystack, Airbyte, dlt, **GraphRAG**, RAGFlow, Marker, MinerU, PyMuPDF, Typesense, Meilisearch, Vespa |
| `08` | CrewAI, AutoGen, **Google ADK**, MetaGPT, ChatDev, Swarms, Langroid, Camel, smolagents, OpenAI Agents, PydanticAI, Reflexion, ToT, Semantic Kernel, STORM |
| `09` | temporal-ai-agent, durable-agentic-harness, Restate, Inngest, **Hatchet**, Windmill, Trigger.dev, Prefect, Dagster, Cadence, River, BullMQ, LangGraph, Conductor, Argo, DBOS |
| `10` | **Mem0, Graphiti, Cognee, Letta**, Qdrant, Weaviate, Chroma, LanceDB, Milvus, HippoRAG, Zep (reject hosted) |
| `11` | LiveKit, Papercups, Typebot, Botpress, Mattermost, Rocket.Chat, Synapse, Element, Rasa, Jitsi |
| `12` | **OpenFGA**, Casbin, Cerbos, OPA, Keto, Hydra, Keycloak, Zitadel, Authentik, Citus, Vault, oauth2-proxy, SOPS, Gitleaks, TruffleHog |
| `13`/`14` | No GitHub dump — order and invariants only |

### 17.3 Extras (not a layer — LLM serving / studios / REJECT)

These are **not** kernel and **not** repeated in `00`–`12`. Steal or ignore.

| Repo | Call |
|------|------|
| [vllm-project/vllm](https://github.com/vllm-project/vllm) | WATCH self-host decode; LiteLLM stays the gateway |
| [sgl-project/sglang](https://github.com/sgl-project/sglang) | Same |
| [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | Local fallback; not production brain |
| [ollama/ollama](https://github.com/ollama/ollama) | Dev only |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | Chat UI — we have Ask AI |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | Desktop RAG — tenancy no |
| [langgenius/dify](https://github.com/langgenius/dify) | Studio OS; dual loop = hang |
| [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | Visual graphs; same REJECT as LangGraph kernel |
| [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) | Same |
| [vercel/ai](https://github.com/vercel/ai) | SSE helpers for Ask AI; not a runtime |
| [instructor-ai/instructor](https://github.com/instructor-ai/instructor) | Structured JSON; LiteLLM already |
| [dottxt-ai/outlines](https://github.com/dottxt-ai/outlines) | Constrained decode; WATCH |
| [cloudflare/agents](https://github.com/cloudflare/agents) | Durable objects agents; WATCH edge |
| [ComposioHQ/composio](https://github.com/ComposioHQ/composio) | **REJECT** credential runtime |
| [ToolJet/ToolJet](https://github.com/ToolJet/ToolJet) | Internal apps; Budibase is `03` |

Remote APIs (not GitHub): WhatsApp Cloud, Twilio, Meta, HubSpot, Stripe, Razorpay, Jina, OpenRouter — always via Nango/LiteLLM/BYOK, never as the brain.

Steal patterns. Do not swap the kernel.
