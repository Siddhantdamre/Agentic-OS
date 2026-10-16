# Database — what Darex uses

Date: 2026-09-27.

## Engine

One Postgres 16 server with the pgvector image
(`pgvector/pgvector:pg16`, container `darex-postgres`). Compose sets
`max_connections=200` because Temporal, Langfuse, Nango, SuperTokens,
LiteLLM, and PgBouncer all log in to this same server.

The application database is `darex`. Init
(`infra/db/init/00_create_databases.sql`) also creates separate databases
on that server so other services do not share the app schema:

| Database | Used by |
|---|---|
| `darex` | Dashboard, workflows worker, MCP bridge. Extensions: `uuid-ossp`, `pgcrypto`, `vector`. `row_security = on`. |
| `langfuse` | Langfuse server (traces, not app tenant data) |
| `nango` | Nango OAuth connection store |
| `litellm` | LiteLLM proxy spend / key store |
| `temporal_visibility` | Temporal visibility store (auto-setup, `DB=postgres12`) |
| `supertokens` | SuperTokens |
| `trueforge` | TrueForge harness session store |

Temporal's own persistence also uses this Postgres instance
(`POSTGRES_SEEDS=postgres`, user `darex`). Migrations never run against
those side databases.

## Roles

| Role | When |
|---|---|
| `darex` | Superuser. Migrations (`pnpm db:migrate`) and compose init. Production app boot refuses this user. |
| `darex_app` | Runtime. `resolveRuntimeDbUser()` in `apps/dashboard/lib/boot-guards.ts` defaults to `darex_app` in dev and requires `DB_USER` set to a non-superuser in production. |

Password comes from `APP_DB_PASSWORD` or `DB_PASSWORD`. There is no
hardcoded password in the pool. `next build` may use a dummy password
only while collecting pages (`NEXT_PHASE=phase-production-build`).

## How the app connects

`apps/dashboard/lib/db.ts` builds one `pg.Pool`:

- host `DB_HOST` (default `localhost`)
- port `DB_PORT` (default `5432`)
- database `DB_NAME` (default `darex`)
- user `darex_app`
- **`max: 10`**
- idle timeout 30s

The pool is cached on `globalThis`. A second import must not open another
pool of 10.

PgBouncer (`edoburu/pgbouncer`, host port `6432`) sits in front of `darex`
only, in **session** mode, so `SET app.current_org_id` survives for the
checkout. Dashboard pool size stays 10 in app code. Temporal, Nango,
Langfuse, SuperTokens, and LiteLLM connect to Postgres `5432` directly.
Migrations connect to `5432` as `darex`.

## Tenancy

Every app table has `org_id`. RLS is enabled and forced. Policies compare
`org_id` to `current_setting('app.current_org_id', true)`.

`getScopedClient()`:

1. Reads the user id from the session cookie. It never takes `org_id` from
   the request body or query.
2. Checks out a client.
3. `set_config('app.current_user_id', …, false)` (session-level, not
   transaction-local).
4. Looks up the user, creates an org if they have none, then
   `set_config('app.current_org_id', …, false)`.
5. Refuses suspended or soft-deleted orgs.

On release, every checkout (including raw `pool.connect()`) runs
`RESET app.current_org_id` then `RESET app.current_user_id` before the
client returns to the pool. A failed RESET destroys the client so a
poisoned session is not reused. Callers must `release()` before SSE
streams, LLM turns, or Temporal calls. Holding a client across those
calls deadlocks the pool of 10.

## Migrations

Numbered SQL in `infra/db/migrations/`, applied in order as superuser
`darex`. Latest files in the tree are in the 100s (employee tool
allowlists, Ask AI employee mode, DSR progress, audit append-only, plan
compensation). App code assumes those migrations have been applied. A
missing table is handled only where a route already checks Postgres
`42P01` (analytics ROI and calibration).

## What is not the app database

Redis (`redis:6379`) is the SSE / event bus. `langfuse-redis` is Langfuse
only. Langfuse events also use ClickHouse and MinIO. Those are not
substitutes for `darex`.
