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

### 1. Boot Everything (one command, always works)

```bash
./start.sh
```

This does the whole job: builds images, boots compose, waits for Postgres,
runs migrations, waits for the dashboard health check, then runs the phase-0
+ auth/Nango probes and prints every service URL. If it prints
`ALL CHECKS PASSED` at the end, the stack is fully up and login works —
nothing left to babysit manually.

Flags:
```bash
./start.sh --dev          # infra only, dashboard runs on host via `pnpm dev`
./start.sh --no-build     # skip image rebuild (faster re-runs)
./start.sh --seed         # also run db:seed
./start.sh --checks       # stack already running — just re-verify it
./start.sh --down         # stop compose (volumes kept)
```

**Do not call `docker compose -f infra/docker-compose.yml ...` directly.**
The compose file's `${VAR}` interpolation (ports, secrets) only resolves
against `.env` in the *project directory*, which Docker Compose derives from
the compose file's own folder (`infra/`) — not your shell's cwd. Root `.env`
values silently fall back to their in-file defaults if you skip this. Always
go through `pnpm infra:up` / `./start.sh` / `infra/scripts/compose-cmd.sh`,
which pass `--env-file "$ROOT/.env"` explicitly. If you must call `docker
compose` by hand, add `--env-file .env` yourself.

This boots the full stack:

| Service | URL |
|---|---|
| **Dashboard (Next.js)** | http://localhost:${DASHBOARD_PORT} (`.env`, default `3000`) |
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

### Demo login (hardcoded, always works)

`.env` ships a demo account for fast manual testing — the login page has a
"fill demo" button wired to these two vars:

```
NEXT_PUBLIC_DEMO_EMAIL=aditya@gmail.com
NEXT_PUBLIC_DEMO_PASSWORD=DarexTest123!
```

The account itself is a normal row in Supertokens/Postgres, not magic — it
has to actually be registered once per fresh volume. If login 401s (e.g.
after `docker volume rm` / a fresh clone), create it once:

```bash
curl -X POST http://localhost:${DASHBOARD_PORT:-3000}/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"aditya@gmail.com","password":"DarexTest123!"}'
```

`ALLOW_DEMO_AUTH` gates a *separate* thing (demo OAuth provider) and must
stay `false` in production — it does not affect this login.

### Troubleshooting a stack that won't come up clean

- **`password authentication failed for user "darex"`** (nango/langfuse/
  litellm/dashboard) — the postgres data volume has an old password baked in
  from a previous `.env`. Postgres only applies `POSTGRES_PASSWORD` on first
  init of an empty volume; editing `.env` afterwards does not change it.
  Fix without wiping data:
  ```bash
  docker exec darex-postgres psql -U darex -d postgres \
    -c "ALTER USER darex WITH PASSWORD '<value of DB_PASSWORD in .env>';"
  docker exec darex-postgres psql -U darex -d postgres \
    -c "ALTER USER darex_app WITH PASSWORD '<value of APP_DB_PASSWORD in .env>';"
  docker compose -f infra/docker-compose.yml --env-file .env restart nango-server dashboard worker
  ```
  Or wipe and reinit clean: `./start.sh --down && docker volume rm infra_postgres-data && ./start.sh`.
- **Port already in use on the dashboard's port** — something else on the
  host (often a stray `next dev` from another project) is squatting the
  port. Either stop it, or change `DASHBOARD_PORT` in `.env` and rerun
  `./start.sh`.
- **Not sure if it's actually all working** — run `./start.sh --checks`.
  It re-probes every container, Postgres/Temporal/Redis/PgBouncer/Nango/
  Langfuse/LiteLLM health, and does a live register → login →
  `/api/integrations` round trip against the real dashboard. `ALL CHECKS
  PASSED` is the only signal that means "fully working," not just "containers
  are running."

### 2. Apply DB Migrations & Seed

`start.sh` already runs migrations for you. To run them by hand:

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
- `JINA_API_KEY` — set in `.env` to enable `web_search` / `web_extract`
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
