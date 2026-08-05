# Darex Build State

> Source of truth for agent context across sessions. Read this before starting any phase.

---

## Current Phase: 1 (COMPLETED) → Phase 2 (READY TO START)

## Phases Completed
- ✅ **Phase 0 — Foundations** (Completed: 2026-08-05)
- ✅ **Phase 1 — Multi-Tenant Core** (Completed: 2026-08-05)

---

## Phase 1 — Multi-Tenant Core

**Status:** ✅ COMPLETED

**Objective:** SuperTokens auth integration + org creation + onboarding wizard screens + automated RLS test.

### What Was Completed
- [x] SuperTokens Core added to `infra/docker-compose.yml` (`supertokens/supertokens-postgresql:9.2.1`)
- [x] SuperTokens database created in Postgres (`CREATE DATABASE supertokens;`)
- [x] Dashboard app (`/apps/dashboard`) scaffolded with Next.js App Router, Tailwind CSS design system tokens matching Figma spec:
  - Cream background: `#FAF9F0`
  - Gold accent: `#F0C05A`
  - Pale green surface: `#F5F2D8`
  - Dark green-gray text: `#1E2B27`
  - Rounded corners: `16px-24px` (`rounded-2xl`, `rounded-3xl`)
- [x] GrowthTree SVG illustration component (`components/onboarding/GrowthTree.tsx`) implemented matching Figma sprout-to-blossom metaphor across onboarding steps.
- [x] Onboarding Wizard UI (`/onboarding/*`) implemented:
  - `/onboarding/name`: Business Name input
  - `/onboarding/team-size`: Team size range slider (`<RangeSlider>`)
  - `/onboarding/business-type`: Industry selector (`<ComboboxSelect>`)
  - `/onboarding/channels`: Multi-select channel grid (`<IconMultiSelect>`)
- [x] Org Creation API (`/api/org/create`): Creates isolated `orgs`, owner `users`, default AI employee roster (`Sarah` sales, `Emma` support, `Marcus` marketing), channels, and `org_onboarding` record in Postgres with session RLS context.
- [x] App Shell (`components/shell/AppShell.tsx`) with persistent icon-only 8-item left sidebar.
- [x] Home Dashboard (`/app/(dashboard)/page.tsx`) with Warm-up state vs Steady state snapshot toggle.
- [x] Automated RLS Verification: `SELECT test_rls_isolation();` executed as non-superuser role `darex_app` returning **PASS: RLS isolation verified — two orgs data never cross in a query**.

### Key Architectural Decisions Made
1. **SuperTokens Integration**: Configured in docker-compose connecting to dedicated `supertokens` Postgres database.
2. **Onboarding State Flow**: Client state stored in Zustand (`lib/store.ts`), final submission executes atomic Postgres transaction with `app.current_org_id` session configuration.
3. **FORCE ROW LEVEL SECURITY**: Applied `FORCE ROW LEVEL SECURITY` across all tenant tables in `001_core_schema.sql`.
4. **App Shell**: Single shared `<AppShell>` wrapper with narrow (~72px) icon-only navigation sidebar matching Figma layout.

---

## Phase 0 — Foundations

**Status:** ✅ COMPLETED

**Objective:** Monorepo structure + docker-compose boots Postgres + Temporal + Nango + Langfuse locally, empty but healthy.

### What Was Completed
- [x] Git repo initialised (`git init`)
- [x] `.gitignore` and `.gitattributes` created
- [x] Monorepo directory structure created
- [x] `BUILD_STATE.md` created
- [x] Root `package.json` & `turbo.json`
- [x] `infra/docker-compose.yml` — services: Postgres+pgvector, Temporal+UI, Nango+Redis, Langfuse (server+worker+clickhouse+minio), LiteLLM, SuperTokens
- [x] `infra/db/init/00_create_databases.sql`
- [x] `infra/db/migrations/001_core_schema.sql` — 8 tables with `org_id` and RLS
- [x] `infra/db/migrations/002_rls_test.sql` — `test_rls_isolation()` procedure
- [x] `infra/scripts/check-phase0.js` — automated health verification script (17/17 checks pass)
- [x] Graphify knowledge graph built on project docs (118 nodes, 111 edges, 32 communities)

---

## Next Phase: Phase 2 — Connector Layer

**Objective:** Nango configuration & OAuth connectors for WhatsApp Cloud API, Gmail, Google Calendar, HubSpot, Razorpay, Meta Ads, Google Ads.

**Start with:**
1. Read BUILD_STATE.md (this file)
2. Create `/services/connectors/nango.yaml` integration definitions
3. Build TypeScript connector wrapper functions in `/services/connectors/src/*` for each app (HubSpot, Razorpay, Google Ads, Meta Ads, Calendar, WhatsApp, Gmail)
4. Build Dashboard `/integrations` page displaying grid of connector cards with "Connected" / "Connect" status and Nango OAuth trigger
5. Verify Phase 2 exit criteria: Each integration in the Figma "Integration" page can be connected end-to-end and shows "Connected" + live sync status.

---

## Architecture Log

| Decision | Rationale | Phase |
|---|---|---|
| Postgres + pgvector as single DB | Avoids extra vector DB service; pgvector handles all 3 memory tiers | 0 |
| Temporal via auto-setup image | Bundles Temporal server + worker + UI in one container for local dev | 0 |
| Nango for all OAuth | Self-hosted, inspectable credential storage; avoids Composio | 0 |
| Langfuse for LLM tracing | Self-hosted; per-tenant cost tagging via org_id metadata on every trace | 0 |
| RLS policy pattern | `current_setting('app.current_org_id', true)::UUID` — enforced at DB level | 0 |
| Idempotency keys table | Temporal activities use this to ensure exactly-once semantics for external side-effects | 0 |
| Graphify for context persistence | Knowledge graph built from docs + code, queryable across build sessions | 0 |
| SuperTokens for Auth | Open-source multi-tenant auth with built-in Session & User Management | 1 |
| Figma Design System Tokens | Custom Tailwind theme palette (`#FAF9F0`, `#F0C05A`, `#1E2B27`) | 1 |
