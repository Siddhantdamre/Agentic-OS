# 03 — Docker Infrastructure

Everything lives in `infra/docker-compose.yml` on a single bridge network `darex-net`. Volumes are named `*-data` (Postgres, Temporal, Langfuse ClickHouse/MinIO, Nango, atomic-agent state, atomic-agent work).

## Service inventory

| Compose service | Container name | Image / Build | Ports | Depends on |
|---|---|---|---|---|
| `postgres` | darex-postgres | `pgvector/pgvector:pg16` | 5432 | — |
| `temporal` | darex-temporal | `temporalio/auto-setup:1.24.2` | 7233 | postgres healthy |
| `temporal-ui` | darex-temporal-ui | `temporalio/ui:2.26.2` | 8233→8080 | temporal |
| `redis` | darex-redis | `redis:7-alpine` | 6379 | — |
| `nango-server` | darex-nango | `nangohq/nango-server:latest` | 3003 | postgres+redis healthy |
| `langfuse-clickhouse` | darex-langfuse-clickhouse | `clickhouse/clickhouse-server:24.3` | 8123,9000 | — |
| `langfuse-minio` | darex-langfuse-minio | `minio/minio:RELEASE.2024-06-13T22-53-53Z` | 9090,9091 | — |
| `langfuse-server` | darex-langfuse-server | `langfuse/langfuse:3` | 3002→3000 | postgres+clickhouse+redis healthy |
| `langfuse-worker` | darex-langfuse-worker | `langfuse/langfuse-worker:3` | — | langfuse-server+redis healthy |
| `supertokens` | darex-supertokens | `registry.supertokens.io/supertokens/supertokens-postgresql:9.2.1` | 3567 | postgres healthy |
| `litellm` | darex-litellm | `litellm/litellm:main-latest` | 4000 | postgres healthy |
| `atomic-bridge` | darex-atomic-bridge | **build** `infra/docker/atomic-bridge/Dockerfile` (context `../`) | 127.0.0.1:8790 | postgres+nango healthy |
| `atomic-agent` | darex-atomic-agent | **build** `infra/docker/atomic-agent/Dockerfile` (context `./docker/atomic-agent`) | 127.0.0.1:8787 | atomic-bridge healthy |
| `inbox` | darex-inbox | **build** `apps/inbox/Dockerfile` | 3004 | postgres healthy |
| `sandbox` | darex-sandbox | **build** `infra/docker/sandbox/Dockerfile` | 8080 | — |
| `worker` | darex-worker | **build** `infra/docker/worker/Dockerfile` (context `../`) | — | postgres+temporal+atomic-agent healthy |
| `dashboard` | darex-dashboard | **build** `infra/docker/dashboard/Dockerfile` (context `../`) | 3000 | postgres+supertokens+temporal+atomic-agent healthy |

Notes:
- `atomic-bridge`, `atomic-agent`, `worker`, `dashboard`, `sandbox` load env via `env_file:` from `../.env`, `../apps/dashboard/.env.local`, `./.env` (and connectors' `.env` for the bridge). Explicit `environment:` entries override `env_file:` — that's how the compose file forces internal hostnames (`DB_HOST=postgres`, `NANGO_HOST=http://nango-server:3003`, `ATOMIC_AGENT_URL=http://atomic-agent:8787`, `SUPERTOKENS_CONNECTION_URI=http://supertokens:3567`, `SANDBOX_API_URL=http://sandbox:8080`, `LANGFUSE_HOST=http://langfuse-server:3000`).
- Langfuse v3 requires **`REDIS_CONNECTION_STRING`** (not `REDIS_URL`) — verified fixed.
- Langfuse S3 uploads go to the bundled MinIO via `LANGFUSE_S3_ENDPOINT=http://darex-langfuse-minio:9000`.
- `sandbox` (`infra/docker/sandbox`): self-hosted, network-isolated code execution for the
  `code_execution` / `sandbox` / `execute_code` agent tools. Runs untrusted code as an
  unprivileged user with a hard timeout; **no outbound network, no DB access**. API:
  `POST /execute {language: node|python|bash, code, timeoutMs}` → `{result:{stdout,stderr,exitCode}}`.
  Health: `GET /health`.

## Dockerfiles

### `infra/docker/dashboard/Dockerfile` (tag `darex-dashboard`)
- `deps`: `node:22-bookworm-slim`, corepack, copies root `package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml` + workspace `package.json`s, runs `pnpm install --frozen-lockfile`.
- `builder`: builds `@darex/connectors` then `@darex/workflows`, then `pnpm --filter @darex/dashboard build` (Next build).
- `runner`: production `next start -p 3000`; workspace `dist` folders shipped so the app can import `@darex/workflows/dist/*`.

### `infra/docker/worker/Dockerfile` (tag `darex-worker`)
- Same `deps`/`builder` stages (connectors + workflows only, no Next).
- `runner`: `node dist/worker.js` from `services/workflows`.

### `infra/docker/atomic-bridge/Dockerfile`
- Builds `@darex/connectors` + `@darex/workflows`; runs `node dist/mcp-bridge.js` (SSE server on 8790).

### `infra/docker/atomic-agent/Dockerfile` (tag `darex-atomic-agent`)
- **Builds atomic-agent from source**: `node:25-bookworm`, `git clone --depth 1 --branch v0.1.72 https://github.com/AtomicBot-ai/atomic-agent.git`, `npm ci`, `npm run build`. Requires Node ≥ 25.7.
- Runner: `node:25-bookworm`, copies `dist/`, `grammars/`, `starter-skills/`, `assets/`, `node_modules/`, plus `render-config.mjs` and `entrypoint.sh`.
- `ENTRYPOINT ./entrypoint.sh`, `CMD ["serve", "--host", "0.0.0.0", "--port", "8787", "--cwd", "/work"]`. State dir `/data` (volume `atomic-agent-data`), workdir `/work` (volume `atomic-agent-work`).

### `infra/docker/atomic-agent/entrypoint.sh`
Exports `ATOMIC_AGENT_STATE_DIR` (default `/data`), runs `node /app/render-config.mjs`, then `exec node /app/dist/cli/index.js "$@"`.

### `infra/docker/atomic-agent/render-config.mjs`
Renders `/data/config.json` at boot:
- **Providers** (pushed conditionally): `darex-openrouter` (kind openrouter, model `${OPENROUTER_MODEL:-deepseek/deepseek-v4-flash-0731}`), `darex-groq` (openai-compatible, `llama-3.3-70b-versatile`), `darex-gemini` (openai-compatible, `gemini-2.0-flash`). Active = `ATOMIC_AGENT_ACTIVE_PROVIDER` (default `darex-openrouter`). Throws if none configured.
- **Agent params**: tokenBudget 32768, maxSteps 30, toolTimeoutMs 60000, approvalRequired false.
- **MCP server**: `darex` → SSE `ATOMIC_AGENT_MCP_URL || http://atomic-bridge:8790/sse`, trust `approval_gated`.
- **Web search**: Exa provider (needs `EXA_API_KEY` to really work), fallback duckduckgo, brave optional.
- **Memory fabric**: profile, reflection (segmentation on), notes, recallInjection, index, dedup, links enabled; embeddings/evolution/lessons/procedures/consolidation/voting disabled (embedding provider not configured).

### `infra/docker/atomic-bridge/Dockerfile`
Produces the MCP SSE server; see `07-agent-engine.md` for the tool surface.

### `apps/inbox/Dockerfile`
Builds the Express inbox gateway (`ts-node`/`tsc` then `node dist/index.js`), port 3004.

## Host launchers (dev alternative to the `worker`/`atomic-bridge` containers)

- `infra/scripts/worker-launcher.js` — merges root `.env`, `apps/dashboard/.env.local`, `infra/.env` into env, spawns `services/workflows/dist/worker.js`.
- `infra/scripts/bridge-launcher.js` — same merge (+ connectors `.env`), spawns `services/workflows/dist/mcp-bridge.js`.

These are fallbacks if you run the worker/bridge on the host for local iteration; the docker-compose `worker`/`atomic-bridge` containers are the canonical way now.
