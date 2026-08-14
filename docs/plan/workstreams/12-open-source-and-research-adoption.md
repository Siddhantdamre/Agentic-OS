# Workstream 12 — Open-source and research adoption

This workstream is **binding policy**, not a shopping list.
Future-scope `15` is the catalog. If a future agent wants a new
framework, they must find the row there first.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/future-scope/15-open-source-research-landscape.md`
§1 and §14; `14-build-principles.md`; current-working runtime.

Darex already runs the KEEP kernel: Postgres+RLS, pgvector, Nango,
Temporal, atomic-agent v0.1.72, MCP bridge, LiteLLM, Langfuse,
SuperTokens, Redis, Chatwoot-thin, Next.js, Jina, Docker sandbox.

Closed rejects already paid for: left LangGraph/Hermes; never
Composio.

---

## 2. Target

Use `15` tags: KEEP (do not replace), ADOPT (library/worker),
STUDY (patterns into our tables/YAML), WATCH (named phase),
REJECT (closed decision).

---

## 3. Gaps

**Audit 2026-08-14:** L1–L5 **done** (CI deny-list; Promptfoo YAML;
hybrid retrieve; PgBouncer).

Policy exists in future-scope. This plan must apply it so
implementers do not add Mastra/Mem0/CrewAI as a kernel.

---

## 4. Work items

### L1 — ADOPT now (Phase 6–8)

Postgres FTS + HNSW in `retrieveMemory`. Promptfoo eval CI.
τ-bench *shape* for pack goldens. Instructor-like JSON for
write-back. pg-boss **or** Graphile Worker (pick one). PgBouncer.
OTel JS beside Langfuse. SKILL.md mount (already in tree).

### L2 — STUDY (copy patterns only)

Mem0 hybrid → our tables. Graphiti windows → columns, not Neo4j.
Letta hierarchy → grounded user message. CrewAI cards → pack
YAML. Magentic-One ledger → WorkItemWorkflow. LangGraph HITL →
Temporal signal. Dust/Glean permissions → allowlist + RLS.
Unforget → no LLM on webhook write. Odoo manifest → `pack.yaml`.
n8n → customer iPaaS later.

### L3 — WATCH (named phase only)

Restate, Inngest, unified.to, AGE, ParadeDB, NATS, LiveKit,
Playwright/E2B, Cube/DuckDB, MinIO, OpenFGA, vLLM.

### L4 — REJECT

Composio; LangGraph/Hermes/Letta/Mastra/CrewAI/Agno as employee
loop; second MCP server; Mem0/Zep Cloud as SoR; new OAuth broker;
custom LLM; our MLS; escrow; portal scrape; embeddings in
webhooks; body `org_id`; Dify/Langflow as kernel.

### L5 — Review gate

PR must not add those frameworks without a BUILD_STATE deviation.

---

## 5. End-to-end connections

Every workstream’s non-goals point here. Phase files must not
schedule a kernel swap.

---

## 6. Non-goals

Re-listing every GitHub table from `00`–`12`. Becoming Dust,
Glean, or EliseAI.

---

## 7. Verification

`15` §14 matches the lockfile. Phase 6 ships without Mem0 Cloud.

Related: [../04-principles-and-constraints.md](../04-principles-and-constraints.md),
[`../../future-scope/15-open-source-research-landscape.md`](../../future-scope/15-open-source-research-landscape.md).
