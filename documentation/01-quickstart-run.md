# 01 — Quickstart: Run the Project

> Applies to the **current state**: everything runs inside Docker Compose. The host machine only needs Docker, Node/pnpm (for rebuilds and verification scripts), and the `.env` files described below.

## Prerequisites

- Docker Desktop 4.x+ with Compose V2 (the `docker compose` plugin).
- Node.js 20+ and pnpm 9+ (only needed to **rebuild** workspace images and run check scripts; the running app does not use the host Node).
- Git.

## 1. Environment files

Three env layers exist. Values in `environment:` blocks of `infra/docker-compose.yml` take precedence over `env_file:`.

| File | Purpose |
|---|---|
| `.env` (repo root) | LLM API keys, Meta/WhatsApp creds, `CHATWOOT_WEBHOOK_SECRET`, misc secrets |
| `apps/dashboard/.env.local` | Dashboard secrets: DB, SuperTokens, Langfuse, Nango, `CHATWOOT_WEBHOOK_SECRET`, atomic-agent key |
| `infra/.env` | Compose-local overrides |
| `services/connectors/.env` | Connector-only vars (loaded by atomic-bridge) |

The compose file mounts env files for the containers that need them (`atomic-bridge`, `atomic-agent`, `worker`, `dashboard`).

**Key variables that must exist** (they are read but most have dev defaults):

- `OPENROUTER_API_KEY` (funded key) — used as the active LLM provider for atomic-agent (`ATOMIC_AGENT_ACTIVE_PROVIDER=darex-openrouter`, model `deepseek/deepseek-v4-flash-0731`).
- `GROQ_API_KEY`, `GEMINI_API_KEY` — optional alternative providers (fallback chain in `render-config.mjs`).
- `CHATWOOT_WEBHOOK_SECRET` — **required now**: the Chatwoot webhook route rejects unsigned webhooks with 401 when set. Dev value used by check scripts: `darex-chatwoot-webhook-secret-dev`.
- `META_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `VERIFY_TOKEN` — for real WhatsApp. Note: the Meta token has **expired** and must be rotated before real outbound WhatsApp works.
- `DB_PASSWORD`, `NANGO_SECRET_KEY`, `SUPERTOKENS_API_KEY`, Langfuse public/secret keys — see `05-authentication-authz.md`.

## 2. Start everything

```bash
# From infra/
docker compose up -d
```

This boots all 15 services. First boot runs `infra/db/init/00_create_databases.sql` (creates the 10 databases) and Postgres applies migrations on first healthy boot.

## 3. Verify it is healthy

```bash
# From repo root
node infra/scripts/check-phase0.js    # 17/17 infra checks
node infra/scripts/check-auth-nango.js  # 3/3 auth + integrations
node infra/scripts/check-phase2.js    # 17/17 connectors
node infra/scripts/check-phase3.js    # 6/6 conversation inbox (needs dashboard + DB up)
```

All four should report ALL CHECKS PASSED. See `09-verification-checks.md` for details.

## 4. Rebuilding images after code changes

Images must be rebuilt when you change **workspace** code (dashboard, inbox, connectors, workflows) or the atomic-agent wrapper.

```bash
# From repo ROOT (build context must be the repo root for workspace resolution)
docker build -f infra/docker/dashboard/Dockerfile -t darex-dashboard .
docker build -f infra/docker/worker/Dockerfile -t darex-worker .
docker build -f infra/docker/atomic-bridge/Dockerfile -t darex-atomic-bridge .

# atomic-agent builds from its own directory
docker build -f infra/docker/atomic-agent/Dockerfile -t darex-atomic-agent infra/docker/atomic-agent

# inbox builds from apps/inbox
docker build -f apps/inbox/Dockerfile -t darex-inbox apps/inbox
```

Then restart the affected containers:

```bash
cd infra
docker compose up -d dashboard worker atomic-bridge atomic-agent inbox
```

## 5. Common operations

| Task | Command |
|---|---|
| Stream logs | `docker compose -f infra/docker-compose.yml logs -f <service>` |
| Stop (keep data) | `docker compose -f infra/docker-compose.yml down` |
| Full reset (wipe volumes) | `docker compose -f infra/docker-compose.yml down -v` |
| Inspect DB | `docker exec -it darex-postgres psql -U darex -d darex` |
| Run Temporal worker on host (dev) | `node infra/scripts/worker-launcher.js` |
| Run MCP bridge on host (dev) | `node infra/scripts/bridge-launcher.js` |

## 6. Ports / URLs

| Service | URL |
|---|---|
| Dashboard (Next.js) | http://localhost:3000 |
| Langfuse UI | http://localhost:3002 (admin@darex.dev / darex_admin_dev) |
| Nango | http://localhost:3003 |
| Inbox gateway | http://localhost:3004 |
| SuperTokens API | http://localhost:3567 |
| LiteLLM | http://localhost:4000 (Bearer sk-darex-litellm-dev-key) |
| Temporal UI | http://localhost:8233 |
| Postgres | localhost:5432 (darex / darex_dev_secret) |
| Redis | localhost:6379 |
| ClickHouse | localhost:8123 (HTTP) / 9000 (native) |
| MinIO | localhost:9090 (S3 API) / 9091 (console) |
| atomic-agent (OpenAI-compatible HTTP) | http://localhost:8787 (localhost only) |
| atomic-bridge (MCP SSE) | http://localhost:8790/sse (localhost only) |

## 7. Troubleshooting

- **Webhook tests return 401** → you changed `CHATWOOT_WEBHOOK_SECRET`; the caller must HMAC-sign. `infra/scripts/check-phase3.js` signs with `CHATWOOT_WEBHOOK_SECRET` or falls back to `darex-chatwoot-webhook-secret-dev`.
- **Temporal workflow "fetch failed"** → usually a stale atomic-agent→bridge SSE session; restart `atomic-agent` / `atomic-bridge` and retry. Fresh runs succeed.
- **Langfuse worker crash-looping** → confirm `REDIS_CONNECTION_STRING` (not `REDIS_URL`) is set in compose.
- **atomic-agent won't start** → its entrypoint runs `render-config.mjs`, which throws if **no** LLM key is set (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, or `GEMINI_API_KEY`).
- **Dashboard shows auth loop** → session cookie `darex_session` is missing/expired; clear cookies and re-login. `getScopedClient()` throws `Unauthorized` when the cookie value isn't a valid `users.id`.
