# Darex — Project Documentation Index

> **Purpose of this folder:** give any AI model or new engineer the full project context — how to run it, what the architecture is, what exists today, and what is still to be built. Each doc below is written to be read on its own and to act as context for a coding agent or LLM.

## The single source of truth

- **`BUILD_STATE.md`** (repo root) is the live, authoritative build log. Every phase, decision, and verification result is recorded there. **Always read it first.** This `documentation/` folder is the stable, non-mutating companion to it.
- **`darex-ai-employee-platform-build-spec.md`** and **`darex-frontend-architecture.md`** (also mirrored in `docs/`) are the original product/architecture specs. This folder summarizes and supersedes them for "current state" purposes.

## Monorepo map

```
dare xai/
├── apps/
│   ├── dashboard/      → Next.js owner dashboard (port 3000) — auth, inbox UI, agent run, SSE realtime
│   ├── inbox/          → Express "Chatwoot-gateway" proxy (port 3004)
│   └── agents/         → LEGACY placeholder (LangGraph plan) — NOT in use. Replaced by atomic-agent.
├── services/
│   ├── connectors/     → Nango-based connector functions (whatsapp, gmail, calendar, hubspot, razorpay, meta-ads, google-ads)
│   └── workflows/      → Temporal worker + activities + MCP bridge (atomic-bridge) + atomic-agent client
├── packages/
│   └── shared-types/   → Shared TS types (mostly placeholder)
├── infra/
│   ├── docker-compose.yml  → ALL 15 services defined here
│   ├── docker/             → Dockerfiles (dashboard, worker, atomic-agent, atomic-bridge, inbox)
│   ├── db/                 → migrations (001–006), init/00_create_databases.sql, migrate runner
│   ├── scripts/            → verification scripts (check-phase0/2/3, check-auth-nango, e2e-live-llm) + launchers
│   ├── temporal/           → Temporal dynamic config
│   └── litellm/            → LiteLLM gateway config
├── docs/              → Original spec docs (duplicates of root spec files)
├── figma/             → Design mockups (PNG/PDF screens)
├── BUILD_STATE.md     → LIVE build state (read this first)
├── README.md          → Quick-start (partially outdated; see documentation/01-quickstart-run.md)
├── package.json / pnpm-workspace.yaml
```

## Document list

| # | Doc | Covers |
|---|---|---|
| 00 | `00-README.md` | This index |
| 01 | `01-quickstart-run.md` | How to run the entire stack, rebuild images, verify health |
| 02 | `02-architecture-overview.md` | System architecture, data/control flow, port map, component responsibilities |
| 03 | `03-docker-infrastructure.md` | All 15 containers, Dockerfiles, env loading, atomic-agent runtime config |
| 04 | `04-database-schema.md` | Databases, migrations, tables, RLS, key contracts |
| 05 | `05-authentication-authz.md` | SuperTokens + Postgres auth flow, session cookies, RLS scoping, webhook auth |
| 06 | `06-api-reference.md` | All dashboard API routes + inbox + atomic-agent/bridge endpoints |
| 07 | `07-agent-engine.md` | Temporal worker, activities, MCP bridge (24 tools), atomic-agent client, execution paths |
| 08 | `08-realtime-notifications.md` | SSE realtime hub, `/api/stream/events`, publishers, inbox UI integration |
| 09 | `09-verification-checks.md` | Every check script, what it verifies, expected results (all green as of last run) |
| 10 | `10-features-roadmap.md` | Phase status (1–5 done), remaining features (6–9), open items |

## Verification status (last full run)

| Check | Result |
|---|---|
| Phase 0 (infra health) | 17/17 PASS |
| Phase 2 (connectors) | 17/17 PASS |
| Phase 3 (conversation inbox) | 6/6 PASS |
| Auth + Nango | 3/3 PASS |

---

_Read order for a fresh agent:_ `BUILD_STATE.md` → `00-README.md` → `01-quickstart-run.md` → `02-architecture-overview.md` → then the domain docs relevant to your task.
