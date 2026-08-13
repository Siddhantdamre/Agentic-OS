# 12 — Infrastructure (Docker)

File: `infra/docker-compose.yml`. Network `darex-net`. Boot: `pnpm infra:up`
from repo root (compose file under `infra/`).

Live compose has **18** services (older docs say 15).

## Services

| Service | Host port | Job | Health |
|---------|-----------|-----|--------|
| postgres | 5432 | Postgres 16 + pgvector | `pg_isready` |
| temporal | 7233 | Workflow server | `temporal workflow list` |
| temporal-ui | 8233 | UI | none |
| redis | 6379 | Nango + Langfuse queues | `PING` |
| nango-server | 3003 | OAuth | `/health` |
| langfuse-clickhouse | 8123 / 9000 | Trace store | `SELECT 1` |
| langfuse-minio | 9090 / 9091 | S3 blobs | `mc ready` |
| langfuse-minio-createbuckets | — | One-shot buckets | exits |
| langfuse-server | 3002 | UI + API | `/api/public/health` |
| langfuse-worker | — | Async persist | none |
| supertokens | 3567 | Auth | TCP |
| litellm | 4000 | LLM gateway | `/health/readiness` |
| atomic-bridge | 127.0.0.1:8790 | MCP | TCP 8790 |
| atomic-agent | 127.0.0.1:8787 | Agent loop | TCP 8787 |
| sandbox | internal 8080 | Code exec | `/health` — **build context missing** |
| inbox | 3004 | Chatwoot proxy | `/health` |
| worker | — | Temporal worker | no-op |
| dashboard | 3000 | Next.js `next start` | none |

## LiteLLM (`infra/litellm/config.yaml`)

Alias `atomic-agent` → `openrouter/deepseek/deepseek-chat`. Fallbacks
`atomic-agent-fallback`, `atomic-agent-deepseek`. Langfuse callbacks on.
Classify/plan/revise set `reasoning: { enabled: false }`.

atomic-agent compose default provider: `darex-litellm`. Worker may still
reference `darex-openrouter` depending on env.

## Sandbox gap

Compose:

```yaml
sandbox:
  build:
    context: ./docker/sandbox
```

**`infra/docker/sandbox/` is not in the git tree.** `docker compose up` will
fail to build this service until the Dockerfile is committed. Executor and
env `SANDBOX_API_URL=http://sandbox:8080` are already wired. BUILD_STATE
records a live python/node/bash smoke test from when the image existed locally.

## Custom skills gap

`infra/docker/atomic-agent/custom-skills/` has 11 SKILL.md playbooks.
Dockerfile does not COPY them. Image uses upstream starter-skills.

## Redis / Langfuse ops

Shared Redis (~100 clients). Langfuse BullMQ can timeout; ingestion to the
server works; ClickHouse persistence is flaky. Dedicated Redis is an ops item.

## Verification scripts (`infra/scripts/`)

| Script | Last recorded |
|--------|----------------|
| `check-phase0.js` | 17/17 — foundation containers (not dashboard/worker/agent/sandbox) |
| `check-phase2.js` | 17/17 — 7 integrations |
| `check-phase3.js` | 6/6 — Chatwoot HMAC ingest |
| `check-auth-nango.js` | 3/3 |
| `e2e-live-llm.js` | 5/5 inbound+LLM; outbound Meta 401 |
| `seed-nango-configs.sql` | Gmail scopes + intercom/notion + drive/docs/sheets |

Host fallbacks: `worker-launcher.js`, `bridge-launcher.js` (merge env files).
Prefer compose `worker` / `atomic-bridge` now.

## Host vs Docker

Stack is meant to run **fully in compose**. Dashboard image compiles
`@darex/connectors` + `@darex/workflows`. Worker uses `TEMPORAL_ADDRESS=temporal:7233`,
`ATOMIC_AGENT_URL=http://atomic-agent:8787`, `NANGO_HOST=http://nango-server:3003`.

`pnpm dev` still runs Next on the host against those ports.
