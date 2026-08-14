# Darex — The Brain of Your Organization

> Multi-tenant AI-employee SaaS. Darex is the operating brain of your business:
> AI employees answer questions and act on your connected tools (Gmail, Calendar,
> Google Drive/Sheets/Docs, HubSpot, WhatsApp, GitHub, ads, SQL, web, sandboxed
> code) — and confirm before running multi-step plans. It makes business work
> simple.

## Quick Start (Docker)

### Prerequisites
- Docker Desktop 4.x+ with Compose V2
- Node.js 20+ and pnpm 9+

### 1. Boot Infrastructure

```bash
pnpm infra:up
```

This boots the full stack:

| Service | URL |
|---|---|
| **Dashboard (Next.js)** | http://localhost:3000 |
| **Postgres + pgvector** | `localhost:5432` (`darex / darex_dev_secret`) |
| **Temporal + UI** | `localhost:7233` · http://localhost:8233 |
| **Nango (OAuth)** | http://localhost:3003 |
| **Langfuse (tracing)** | http://localhost:3002 (`admin@darex.dev / darex_admin_dev`) |
| **LiteLLM (LLM gateway)** | http://localhost:4000 |
| **Supertokens (auth)** | http://localhost:3567 |
| **Atomic Agent** | `localhost:8787` |
| **MCP Bridge** | `localhost:8790` |
| **Code Sandbox** | `http://localhost:8080/health` |
| **Inbox (Chatwoot fork)** | http://localhost:3004 |

### 2. Apply DB Migrations & Seed

```bash
pnpm db:migrate
pnpm db:seed
```

### 3. Install Dependencies + Run

```bash
pnpm install
pnpm dev          # dashboard only (Next.js)
pnpm dev:all      # all workspaces
pnpm build        # production build all workspaces
```

### Optional runtime config
- `JINA_API_KEY` — set in `infra/.env` to enable `web_search` / `web_extract`
  (free key from https://jina.ai). Not set → these tools report honestly that the
  external search API is unconfigured rather than faking results.
- `DB_USER=darex_app` — set to the least-privilege role (RLS is enforced for that
  role; migration `008` adds the matching `WITH CHECK` policies + grants).

---

## Monorepo Structure

```
dare-xai/
├── apps/
│   ├── dashboard/   → Next.js app — API routes (app/api), lib/, UI
│   └── inbox/       → Chatwoot fork — conversation inbox
├── services/
│   ├── workflows/   → Temporal worker + shared agent runtime (atomic-agent client,
│   │                  tool-executor with per-org allowlist, MCP bridge)
│   └── connectors/  → Nango connector SDK (used by /integrations diagnostics)
├── packages/        → Shared TS types
├── infra/
│   ├── docker-compose.yml  → full stack orchestration
│   ├── docker/       → Dockerfiles (dashboard, worker, atomic-agent, bridge, sandbox)
│   ├── db/           → SQL migrations (001–008) + runner
│   ├── litellm/      → LiteLLM gateway config
│   └── scripts/      → worker/bridge launchers + check-phase probes
├── documentation/   → standalone technical docs (00–10)
├── AGENTS.md        → agent/coding-assistant project context (the whole map)
├── BUILD_STATE.md   → live per-phase status & decisions
├── graphify-out/    → knowledge-graph of the corpus (queryable)
└── package.json
```

---

## Architecture Principles

1. **Multi-tenant from day one** — every table has `org_id` + RLS policy
   (migration 008 adds `WITH CHECK`).
2. **No conversation ever silently drops** — webhooks return `200` immediately,
   then run a durable Temporal workflow.
3. **Never deadlock the DB pool** (`max:10`) — release pooled clients before
   opening SSE streams / slow agent calls.
4. **Never fabricate data** — a missing OAuth connector returns an honest
   `error` + `connected:false` + `/connectors` URL.
5. **Env-driven config only** — every URL/key/model comes from `process.env`;
   secrets live in gitignored `.env*` files.
6. **Tools are scoped per org** — tool-executor enforces an org-wide allowlist
   (core tools + all active-employee tools + connected channels) so real
   connectors run while never-connected ones stay gated.
7. **Untrusted code runs in an isolated sandbox** — `code_execution` executes in
   the self-hosted `sandbox` service (unprivileged child process, hard timeout,
   no outbound network, no DB access).
8. **Observability by default** — every plan/step/agent turn is traced to
   Langfuse so you can see exactly what the agent did.

---

## Tech Stack

| Layer | Technology |
|---|---|
| AI agent runtime | **atomic-agent** (OpenAI-compatible agent + MCP) |
| Tool bridge | MCP SSE bridge (`mcp.darex.*` tools) |
| Code sandbox | Self-hosted, network-isolated container (`infra/docker/sandbox`) |
| Durable execution | Temporal (self-hosted) |
| LLM gateway | LiteLLM (self-hosted) |
| OAuth / connectors | Nango (self-hosted) |
| Vector memory | pgvector |
| Auth / identity | SuperTokens (self-hosted) |
| LLM tracing | Langfuse v3 (self-hosted) |
| Dashboard | Next.js + Tailwind |

---

## Key Docs

- [AGENTS.md](./AGENTS.md) — the repo map / agent context (read first)
- [BUILD_STATE.md](./BUILD_STATE.md) — live phase status & gotchas
- [documentation/00-README.md](./documentation/00-README.md) — doc index
- [documentation/03-docker-infrastructure.md](./documentation/03-docker-infrastructure.md) — infra
- [documentation/07-agent-engine.md](./documentation/07-agent-engine.md) — agent runtime

---

## Recent Updates

### Stats Endpoint Fix (v2.1)
Fixed critical syntax errors in `/api/dashboard/stats` that prevented dashboard compilation:
- Resolved improperly nested try-catch blocks in query handlers
- Fixed database client scope in error handling (finally block)
- Endpoint now compiles and responds correctly with proper error handling
- All query failures gracefully degrade to default values instead of crashing
