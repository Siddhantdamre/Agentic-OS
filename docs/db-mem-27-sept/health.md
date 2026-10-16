# Health

Date: 2026-09-27. Code: `apps/dashboard/app/api/health/`.

The Sept 26 audit described `/api/health` as a static `{ ok: true }` with
no dependency checks. That is no longer the whole picture. Liveness and
readiness are split.

## Endpoints

| Route | Auth | What it does |
|---|---|---|
| `GET /api/health` | none | Liveness. Returns `{ ok: true, service: 'dashboard', runtime }`. Does not open the DB pool. Safe for a load balancer. |
| `GET /api/health/ready` | none | Readiness. Probes Postgres, Redis, Temporal, LiteLLM, and the DB pool. Cached 5 seconds. |
| `GET /api/health/diagnostics` | session, owner / admin / auditor | Runtime telemetry, pool stats, and which dependency env vars are set. No secrets. |

`SystemDegradationBanner` polls `/api/health/ready` about every 30s and
shows a banner only when status is `degraded` or `unhealthy`.

Runtime telemetry (`apps/dashboard/lib/runtime-telemetry.ts`) is Node
`process.memoryUsage` plus a short event-loop delay sample. It is attached
to both `/api/health` and `/api/health/ready`.

## Readiness rules

Each probe times out at **1500ms**.

| Check | Required? | How |
|---|---|---|
| `postgres` | yes | `pool.query('SELECT 1')`. Failure → `unhealthy`, HTTP 503. |
| `db_pool` | yes | `waitingCount`, `totalCount`, `idleCount`. `waitingCount >= 5` is an error → 503. |
| `redis` | no | Ping only if `REDIS_URL` is set. Unset → `not_configured` (does not fail ready). Down → `degraded`, HTTP 200. |
| `temporal` | no | TCP connect to `TEMPORAL_ADDRESS` when set. Same degraded rule. |
| `litellm` | no | `GET {LITELLM_BASE_URL}/health/readiness` when the base URL is set. Same degraded rule. |

Postgres or pool failure is the only path to HTTP 503. A missing optional
dependency is not treated as an outage.

## What readiness does not probe

Nango, Langfuse, and the Temporal worker heartbeat are not in this
payload. Cognee is probed only when `COGNEE_URL` is set. The MCP bridge
is probed only when `MCP_BRIDGE_URL` is set. Either one down is
`degraded`, not a 503. A green ready response means Postgres answers and
the pool is not backed up.

Docker Compose still has its own checks: `pg_isready` on Postgres,
`redis-cli ping` on Redis, and Temporal's workflow-list healthcheck.
Those are container start order, not the dashboard API.
