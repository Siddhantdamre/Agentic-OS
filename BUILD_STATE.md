# Darex Build State

> Source of truth for agent context across sessions. Read this before starting any phase.

---

## Current Phase: 0 (COMPLETED) → Phase 1 (READY TO START)

## Phases Completed
- ✅ **Phase 0 — Foundations** (Completed: 2026-08-05)

---

## Phase 0 — Foundations

**Status:** ✅ COMPLETED

**Objective:** Monorepo structure + docker-compose boots Postgres + Temporal + Nango + Langfuse locally, empty but healthy.

### What Was Completed
- [x] Git repo initialised (`git init`)
- [x] `.gitignore` and `.gitattributes` created
- [x] Monorepo directory structure created:
  - `apps/inbox/` (Chatwoot placeholder)
  - `apps/agents/` (LangGraph placeholder)
  - `apps/dashboard/` (Next.js placeholder)
  - `services/connectors/` (Nango placeholder)
  - `services/workflows/` (Temporal placeholder)
  - `packages/shared-types/` (Shared TS types placeholder)
  - `infra/` (docker-compose + configs + migrations + health checks)
  - `docs/` (spec files)
- [x] `BUILD_STATE.md` created
- [x] Root `package.json` (pnpm workspaces + Turborepo)
- [x] `turbo.json` pipeline config
- [x] `infra/docker-compose.yml` — services: Postgres+pgvector, Temporal+UI, Nango+Redis, Langfuse (server+worker+clickhouse+minio), LiteLLM
- [x] `infra/db/init/00_create_databases.sql` — bootstraps langfuse/nango/litellm/temporal_visibility databases + enables pgvector extension + creates darex_app role
- [x] `infra/db/migrations/001_core_schema.sql` — tables: orgs, users, ai_employees, channels, conversations, messages, org_onboarding, idempotency_keys — ALL with org_id + RLS
- [x] `infra/db/migrations/002_rls_test.sql` — stored procedure test_rls_isolation() for Phase 1 exit criteria
- [x] `infra/db/migrate.js` — Node.js migration runner
- [x] `infra/temporal/dynamicconfig/development-sql.yaml`
- [x] `infra/litellm/config.yaml`
- [x] `infra/scripts/check-phase0.js` — automated health verification script
- [x] `README.md` (root, with quick start guide)
- [x] Graphify knowledge graph built on project docs (118 nodes, 111 edges, 32 communities, interactive `graph.html` exported)
- [x] Exit criteria verified: `node infra/scripts/check-phase0.js` returns **ALL CHECKS PASSED (17/17)**

### Key Architectural Decisions Made
1. **Monorepo layout**: `/apps/inbox` (Chatwoot fork placeholder), `/apps/agents` (LangGraph), `/apps/dashboard` (Next.js), `/services/connectors` (Nango), `/services/workflows` (Temporal), `/infra` (docker-compose + Terraform)
2. **Postgres 16 + pgvector**: single DB instance, RLS enabled at cluster level, every table gets `org_id + policy` from first migration — no exceptions
3. **Temporal via docker-compose**: using `temporalio/auto-setup:1.24.2` image with `DB=postgres12` for local dev simplicity
4. **Nango self-hosted**: official `nangohq/nango-server:latest` image with `redis:7-alpine` for background queues
5. **Langfuse self-hosted**: official Langfuse v3 docker images (`langfuse/langfuse:3` + `langfuse-worker:3` + `clickhouse-server:24.3` + `minio`), with `CLICKHOUSE_CLUSTER_ENABLED=false` for single-node deployment
6. **LiteLLM**: configured with proxy master key authentication (`sk-darex-litellm-dev-key`)
7. **Graphify**: knowledge graph built from `/docs` + code for context persistence across agent sessions

### Deviations from Spec
- **Langfuse ClickHouse + MinIO**: Langfuse v3 requires ClickHouse for trace storage and MinIO for S3 media/event uploads. Added both to docker-compose.
- **Nango Redis**: Nango self-hosted requires Redis for job queue management. Added `redis:7-alpine` container.

### Ambiguities Noted
- Chatwoot fork will be populated into `/apps/inbox` in Phase 3 per spec execution order.
- SuperTokens auth container will be added in Phase 1 per spec.

---

## Next Phase: Phase 1 — Multi-Tenant Core

**Objective:** SuperTokens auth integration + org creation + onboarding wizard + automated RLS test.

**Start with:**
1. Read BUILD_STATE.md (this file)
2. Add SuperTokens Core to `infra/docker-compose.yml`
3. Implement SuperTokens integration in `/apps/dashboard` and backend services
4. Build org creation & team invite APIs
5. Build Onboarding Wizard UI matching Figma spec (`/onboarding/*`)
6. Execute automated RLS verification: `SELECT test_rls_isolation();` (Phase 1 exit criteria)

---

## Architecture Log

| Decision | Rationale | Phase |
|---|---|---|
| Postgres + pgvector as single DB | Avoids extra vector DB service; pgvector handles all 3 memory tiers (org/employee/conversation) | 0 |
| Temporal via auto-setup image | Bundles Temporal server + worker + UI in one container for local dev | 0 |
| Nango for all OAuth | Self-hosted, inspectable credential storage; avoids Composio | 0 |
| Langfuse for LLM tracing | Self-hosted; per-tenant cost tagging via org_id metadata on every trace | 0 |
| RLS policy pattern | `current_setting('app.current_org_id', true)::UUID` — app sets this at session start, enforced at DB level | 0 |
| Idempotency keys table | Temporal activities use this to ensure exactly-once semantics for external side-effects | 0 |
| Graphify for context persistence | Knowledge graph built from docs + code, queryable across build sessions to avoid agent context loss | 0 |
