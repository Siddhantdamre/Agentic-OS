# Darex Build State

> Source of truth for agent context across sessions. Read this before starting any phase.

---

## Current Phase: 0 (IN PROGRESS — Graphify pipeline running)

## Phases Completed
_None yet — Phase 0 in progress_

---

## Phase 0 — Foundations

**Status:** IN PROGRESS

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
  - `infra/` (docker-compose + configs + migrations)
  - `docs/` (spec files)
- [x] `BUILD_STATE.md` created
- [x] Root `package.json` (pnpm workspaces + Turborepo)
- [x] `turbo.json` pipeline config
- [x] `infra/docker-compose.yml` — services: Postgres+pgvector, Temporal+UI, Nango, Langfuse (server+worker+clickhouse+minio), LiteLLM
- [x] `infra/db/init/00_create_databases.sql` — bootstraps langfuse/nango/litellm/temporal_visibility databases + enables pgvector extension + creates darex_app role
- [x] `infra/db/migrations/001_core_schema.sql` — tables: orgs, users, ai_employees, channels, conversations, messages, org_onboarding, idempotency_keys — ALL with org_id + RLS policies
- [x] `infra/db/migrations/002_rls_test.sql` — stored procedure test_rls_isolation() for Phase 1 exit criteria
- [x] `infra/db/migrate.js` — Node.js migration runner
- [x] `infra/temporal/dynamicconfig/development-sql.yaml`
- [x] `infra/litellm/config.yaml` (placeholder)
- [x] `README.md` (root, with quick start guide)
- [x] First git commit: `[Phase 0] Monorepo scaffold...`
- [ ] Graphify knowledge graph built on project docs (IN PROGRESS — semantic extraction subagent running)
- [ ] Exit criteria verified: `docker-compose up` boots all services healthy
- [ ] Phase 0 final commit

### Key Architectural Decisions Made
1. **Monorepo layout**: `/apps/inbox` (Chatwoot fork placeholder), `/apps/agents` (LangGraph), `/apps/dashboard` (Next.js), `/services/connectors` (Nango), `/services/workflows` (Temporal), `/infra` (docker-compose + Terraform)
2. **Postgres 16 + pgvector**: single DB instance, RLS enabled at cluster level, every table gets `org_id + policy` from first migration — no exceptions
3. **Temporal via docker-compose**: using `temporalio/auto-setup:1.24.2` image for local dev simplicity
4. **Nango self-hosted**: official Nango docker image, connects to shared Postgres
5. **Langfuse self-hosted**: official Langfuse v3 docker images (server + worker + clickhouse + minio)
6. **SuperTokens**: will be added in Phase 1; not needed in Phase 0 exit criteria
7. **LiteLLM**: placeholder service in docker-compose; wired properly in Phase 4
8. **Graphify**: running on the `/docs` + project files to build a queryable knowledge graph for agent context persistence across sessions

### Deviations from Spec
- **Langfuse ClickHouse + MinIO**: Langfuse v3 requires ClickHouse for trace storage and S3-compatible storage (MinIO locally) — not mentioned in spec but required by the current Langfuse release. Added both.
- **Graphify NOT in graphify-out/ commit**: graphify-out/ is in .gitignore (it's a build artifact). The graph is rebuilt per session from the docs.

### Ambiguities Noted
- Spec says "Chatwoot fork" — actual git fork of Chatwoot happens in Phase 3. Phase 0 only creates the `/apps/inbox` placeholder directory.
- E2B is listed in the stack table but explicitly scoped to Phase 7+. Not included in Phase 0 docker-compose to keep it lean.
- Nango docker image tag: using `nangohq/nango:latest` — should be pinned to a specific version in production. Noted for Phase 8 hardening.

---

## Next Phase: Phase 1 — Multi-tenant Core

**Start with:**
1. Read BUILD_STATE.md (this file)
2. Verify Phase 0 exit criteria: `docker-compose up` boots all services
3. Install SuperTokens core (docker-compose service)
4. Build org-creation API + onboarding wizard (Next.js)
5. Run automated RLS test (`SELECT test_rls_isolation()`) — Phase 1 exit criteria

---

## Architecture Log

| Decision | Rationale | Phase |
|---|---|---|
| Postgres + pgvector as single DB | Avoids an extra vector DB service; pgvector handles all 3 memory tiers (org/employee/conversation) | 0 |
| Temporal via auto-setup image | Bundles Temporal server + worker + UI + Cassandra-free in one container for local dev; swap to proper cluster in prod | 0 |
| Nango for all OAuth | Self-hosted, inspectable credential storage; avoids Composio (May 2026 breach) | 0 |
| Langfuse for LLM tracing | Self-hosted; per-tenant cost tagging via org_id metadata on every trace | 0 |
| RLS policy pattern | `current_setting('app.current_org_id', true)::UUID` — app sets this at session start, enforced at DB level | 0 |
| Idempotency keys table | Temporal activities use this to ensure exactly-once semantics for external side-effects | 0 |
| Graphify for context persistence | Knowledge graph built from docs + code, queryable across build sessions to avoid agent context loss | 0 |
