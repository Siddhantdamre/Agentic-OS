# Database health — what to do

Date: 2026-09-27. Research against `apps/dashboard/lib/db.ts`,
`apps/dashboard/app/api/health/ready/route.ts`,
`services/workflows/src/tools/shared.ts`, and
`infra/docker-compose.yml`.

Implemented in this pass: `darex_app` role timeouts
(`115_app_role_timeouts_and_signup_terms.sql`), readiness probes for
Cognee and the MCP bridge (optional, same rules as Redis), and `SELECT 1`
on a separate `max: 1` pool that never sets a tenant GUC. PgBouncer stays
in session mode. Email signup now stores `users.terms_accepted_at`.
Conversation transcripts stay in `messages` (user and assistant rows).
`conversation_memory` is still the summary written on close.

Still later: analytics daily rollups and the `/plans` history view.

Memory, analytics, and plans all use this one pool and this one RLS
setting. Health work is what keeps one tenant's query from stalling the
others.

## What is already right

- Runtime user is `darex_app`. Production refuses to boot as `darex` or
  `postgres`.
- App pool `max: 10`, cached once per process.
- PgBouncer in front of `darex` only, **session** mode, so
  `app.current_org_id` survives for the checkout. Temporal, Langfuse,
  Nango, LiteLLM, and SuperTokens use other databases on the same
  Postgres and do not go through this pool.
- Every checkout resets `app.current_org_id` and `app.current_user_id`
  before the client returns to the pool. Dashboard does this in
  `installPoolConnectGuard`. The worker does it in `withOrgScopedClient`.
- `/api/health` does not touch the database. `/api/health/ready` fails
  hard only when Postgres or the pool is down. Redis, Temporal, and
  LiteLLM degrade the status when they are configured and unreachable.
- Ready responses are cached 5 seconds so a scraper does not take a pool
  slot on every hit.
- The public payload has no org id and no connection string.

## The shared-pool fact

There is one pool for every org in the process. A connection is not
reserved per tenant. If org A holds all 10 slots, org B waits, and
`waitingCount >= 5` marks the whole process unhealthy. That banner is
global on purpose. The fix is to make each checkout short. It is not a
pool per org. A pool per org would multiply connections by tenant count
and blow past `max_connections=200`, which is already shared with
Temporal and the other service databases.

## Do these, in this order

### 1. Cap how long `darex_app` may hold a query.

Memory retrieve sets `statement_timeout` inside its own transaction.
Analytics, plans, and Brain search do not. One 90-day scan or a forgotten
client pins a slot for every tenant.

On the role, not in a single route:

- `statement_timeout` around 15 seconds.
- `lock_timeout` around 2 seconds.
- `idle_in_transaction_session_timeout` around 15 seconds, so a leaked
  `BEGIN` (retrieve does use a transaction) dies instead of sitting in
  the pool.

Migrations keep using superuser `darex` and are not under this cap.
A route that needs longer than 15 seconds should not. Analytics is
already limited by range and a 2000-row latency sample. Memory retrieve
can set a tighter timeout inside its transaction, which overrides the
role default for that transaction only.

This is the change that protects multi-tenant work. Org A's slow query
ends. The slot is reset and reused by org B with a clean GUC.

### 2. Keep PgBouncer in session mode.

Transaction-mode pooling would clear `app.current_org_id` between
statements on the same checkout. The next query from that client would
see no tenant or the wrong one. Memory, analytics, and plans all depend
on the GUC lasting until `release()`.

Do not "speed up" the pool by switching `POOL_MODE`. If the bouncer
queue grows, raise `DEFAULT_POOL_SIZE` only after checking Postgres
`max_connections` still has room for Temporal and the other databases.
Leave the app `max: 10` alone until a measured wait says the app itself
is short, not the bouncer.

### 3. Never hold a client across anything but SQL.

Already the rule. It is the main way related work stays safe on a shared
pool:

| Work | Checkout | Release before |
|---|---|---|
| Memory retrieve | After the query embedding returns | Cognee HTTP, embed HTTP, the model |
| Brain edit | Read and update the row, null the vector | The embed job |
| Analytics page | The bounded aggregates for that org | Building the JSON response is fine; do not hold across Langfuse |
| Plan approve / cancel | Status update | The Temporal signal |
| Plan execute | Each status write | The SSE stream and the tool call |
| Health ready | `SELECT 1` only | Immediately. No tenant table. |

`getScopedClient()` and `withOrgScopedClient(orgId)` stay the only ways
to set the GUC. Health probes use `pool.query('SELECT 1')` and must not
set an org id. A ready check that queried `org_memory` would need a
tenant it does not have, and would put tenant data on an unauthenticated
URL.

### 4. Add the missing probes as optional.

Ready today checks Postgres, the pool, Redis, Temporal, and LiteLLM. It
does not check Cognee, the MCP bridge (`:8790`), Nango, Langfuse, or
whether the Temporal worker is still polling.

Add them the same way Redis is added:

- Unset URL → `not_configured`. That does not fail ready.
- Configured and down → `degraded`, HTTP 200.
- Only Postgres and `waitingCount >= 5` stay HTTP 503.

Cognee can use the existing `isCogneeHealthy` (short timeout, no dataset
name in the result). The bridge is a TCP connect, like Temporal. None of
these responses include an org id, a dataset name, or a DSN.

A worker heartbeat table, if added, is process health: `worker_id`,
queue, last seen. It has no `org_id`, so it has no RLS, and it is not
readable from a tenant route. Per-org sweep progress stays in an org
table with RLS. Do not mix "is the worker alive" with "what did we last
do for this customer" on the public health URL.

### 5. Give the ready probe its own single connection.

`SELECT 1` today uses the app pool. When all 10 slots are busy, the
health check waits behind tenant work and reports late, or it takes the
last slot a request needed.

Use one long-lived client, or a `Pool` with `max: 1`, used only for
`SELECT 1`. It never calls `set_config` for an org. It never reads
`org_memory`, `agent_plans`, or `messages`. The request pool's
`waitingCount` is still reported from the app pool. The probe's private
connection is how Postgres reachability is measured when the app pool is
already full.

### 6. Related work on this same database

These are not new databases. They are more queries on `darex`, so they
follow the same checkout rules.

**Analytics.** Each request already scopes with `getScopedClient()` and
a range (`24h` to `90d`). Keep it that way. A later daily rollup is one
row per `(org_id, date)`, RLS like the other tables, written by a worker
that sets the GUC for one org, writes, and releases before the next org.
The page then reads the rollup instead of scanning `messages`. Cost stays
on Langfuse and still returns 503 rather than a fake zero. The public
ready endpoint does not call Langfuse with a tenant key.

**Plans.** The inbox query is `org_id` from the session plus `user_id`
plus `status IN ('pending','approved','running')`. A history view widens
the status list. It does not drop `org_id` or `user_id`. Edit params, when
wired on `/plans`, updates the step JSON for that plan id under the same
session org. Approve and cancel keep releasing the client before the
Temporal signal so a slow workflow does not pin the pool.

**Memory.** Covered in `suggestions-memory.md`. The health-related part
is only: embed and Cognee happen outside the checkout, and the SQL
transaction has a timeout.

## What not to change

- Do not put org ids, dataset names, or error strings that contain
  passwords on `/api/health` or `/api/health/ready`. Diagnostics stays
  behind owner, admin, or auditor, and still returns no secrets.
- Do not mark the process unhealthy because one optional dependency is
  down. Chat can still answer from SQL memory when Cognee is down.
  Degraded is the honest state.
- Do not run tenant SQL from the ready route to "prove RLS." That check
  belongs in the existing RLS scripts, under a test org, not on an
  unauthenticated probe.
