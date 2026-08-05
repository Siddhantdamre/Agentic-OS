# Darex Build State

> Source of truth for agent context across sessions. Read this before starting any phase.

---

## Current Phase: 0 (IN PROGRESS)

## Phases Completed
_None yet_

---

## Phase 0 — Foundations

**Status:** IN PROGRESS

**Objective:** Monorepo structure + docker-compose boots Postgres + Temporal + Nango + Langfuse locally, empty but healthy.

### What Was Completed
- [ ] Git repo initialised
- [ ] Monorepo directory structure created
- [ ] `docs/` directory seeded with spec files
- [ ] `.gitignore` created
- [ ] `docker-compose.yml` with Postgres (pgvector), Temporal, Nango, Langfuse
- [ ] First Postgres migration — `orgs` table with RLS
- [ ] `BUILD_STATE.md` created
- [ ] Graphify knowledge graph bootstrapped on project docs

### Key Architectural Decisions Made
1. **Monorepo layout**: `/apps/inbox` (Chatwoot fork placeholder), `/apps/agents` (LangGraph), `/apps/dashboard` (Next.js), `/services/connectors` (Nango), `/services/workflows` (Temporal), `/infra` (docker-compose + Terraform)
2. **Postgres 16 + pgvector**: single DB instance, RLS enabled at cluster level, every table gets `org_id + policy` from first migration — no exceptions
3. **Temporal via docker-compose**: using `temporalio/auto-setup` image for local dev simplicity
4. **Nango self-hosted**: official Nango docker image, connects to shared Postgres
5. **Langfuse self-hosted**: official Langfuse docker images (server + worker + clickhouse)
6. **SuperTokens**: will be added in Phase 1; not needed in Phase 0 exit criteria
7. **LiteLLM**: placeholder service in docker-compose; wired properly in Phase 4

### Deviations from Spec
_None yet_

### Ambiguities Noted
- Spec says "Chatwoot fork" — actual git fork of Chatwoot happens in Phase 3. Phase 0 only creates the `/apps/inbox` placeholder directory.
- E2B is listed in the stack table but explicitly scoped to Phase 7+. Not included in Phase 0 docker-compose to keep it lean.

---

## Next Phase: Phase 1 — Multi-tenant Core

**Start with:**
1. Read BUILD_STATE.md (this file)
2. Install SuperTokens core (docker-compose service)
3. Build org-creation flow + onboarding wizard API routes
4. Automated RLS test proving two orgs' data never cross

---

## Architecture Log

| Decision | Rationale | Phase |
|---|---|---|
| Postgres + pgvector as single DB | Avoids an extra vector DB service; pgvector handles all 3 memory tiers (org/employee/conversation) | 0 |
| Temporal via auto-setup image | Bundles Temporal server + worker + UI + Cassandra in one container for local dev; swap to proper cluster in prod | 0 |
| Nango for all OAuth | Self-hosted, inspectable credential storage; avoids Composio (May 2026 breach) | 0 |
| Langfuse for LLM tracing | Self-hosted; per-tenant cost tagging via `org_id` metadata on every trace | 0 |
