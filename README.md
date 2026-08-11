# Darex — Multi-tenant AI Employee SaaS Platform

> Build your AI-powered workforce. Every AI employee has its own persona, memory, tool access, and works across your existing channels.

## Quick Start (Local Development)

### Prerequisites
- Docker Desktop 4.x+ with Compose V2
- Node.js 20+ and pnpm 9+
- Git

### 1. Start Infrastructure

```bash
# From repo root
pnpm infra:up
```

This boots:
| Service | URL | Credentials |
|---|---|---|
| **Postgres + pgvector** | `localhost:5432` | `darex / darex_dev_secret` |
| **Temporal** | `localhost:7233` (gRPC) | — |
| **Temporal UI** | http://localhost:8233 | — |
| **Nango** | http://localhost:3003 | secret key: see `apps/dashboard/.env.local` (`NANGO_SECRET_KEY` / `NEXT_PUBLIC_NANGO_PUBLIC_KEY`) |
| **Langfuse** | http://localhost:3002 | `admin@darex.dev / darex_admin_dev` |
| **LiteLLM** | http://localhost:4000 | master key: `sk-darex-litellm-dev-key` |

### 2. Run DB Migrations

```bash
pnpm db:migrate
```

### 3. Install Dependencies

```bash
pnpm install
```

### 4. Start Development Servers

```bash
pnpm dev
```

---

## Monorepo Structure

```
dare-xai/
├── apps/
│   ├── inbox/          → Chatwoot fork (Phase 3) — conversation inbox
│   ├── agents/         → LangGraph AI employee services (Phase 4)
│   └── dashboard/      → Darex owner dashboard — Next.js (Phase 1)
├── services/
│   ├── connectors/     → Nango integration functions (Phase 2)
│   └── workflows/      → Temporal workflow + activity definitions (Phase 5)
├── packages/           → Shared TypeScript packages (types, utils)
├── infra/
│   ├── docker-compose.yml
│   ├── db/             → SQL migrations + migration runner
│   ├── temporal/       → Temporal dynamic config
│   ├── litellm/        → LiteLLM gateway config
│   └── terraform/      → Production infrastructure (Phase 8)
├── docs/               → Architecture specs
├── BUILD_STATE.md      → Agent build context — read before each phase
├── package.json
└── turbo.json
```

---

## Build Progress

See [BUILD_STATE.md](./BUILD_STATE.md) for current phase status and architectural decisions.

| Phase | Description | Status |
|---|---|---|
| 0 | Foundations — infra scaffold | ✅ In Progress |
| 1 | Multi-tenant core (SuperTokens + onboarding) | ⏳ Pending |
| 2 | Connector layer (Nango + OAuth) | ⏳ Pending |
| 3 | Conversation ingestion (Chatwoot fork) | ⏳ Pending |
| 4 | Agent harness (LangGraph AI employees) | ⏳ Pending |
| 5 | Durability (Temporal workflows) | ⏳ Pending |
| 6 | Memory & RAG (pgvector) | ⏳ Pending |
| 7 | Insight & Analytics engine | ⏳ Pending |
| 8 | Observability, security, scale hardening | ⏳ Pending |
| 9 | Polish & launch readiness | ⏳ Pending |

---

## Architecture Principles

1. **Multi-tenant from day one** — every table has `org_id` + RLS policy
2. **No conversation ever silently drops** — every thread is a Temporal workflow
3. **Modular employees** — an AI employee is config + LangGraph graph + tool allowlist; zero infra changes to add a new role
4. **Every external side-effect is an idempotent Temporal Activity**
5. **Clone, don't rebuild**: Chatwoot, Nango, Temporal, Langfuse. Build fresh: LangGraph graphs, Darex dashboard, Insight engine.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Conversation inbox | Chatwoot (forked) |
| OAuth / connectors | Nango (self-hosted) |
| Durable execution | Temporal (self-hosted) |
| AI agents | LangGraph |
| LLM gateway | LiteLLM (self-hosted) |
| Vector memory | pgvector (Postgres extension) |
| Auth / identity | SuperTokens (self-hosted) |
| LLM tracing | Langfuse (self-hosted) |
| Dashboard | Next.js + Tailwind + shadcn/ui |
