# 12 — Reliability, Observability and Scale (audit of 2026-10-09)

Scope: health and readiness, metrics, tracing (Langfuse), alerting, realtime
SSE and its fallback, Temporal operations, database pool and PgBouncer, the
single Azure Spot VM, backups, disaster recovery, a load and scale plan (what
breaks at 100, 1,000 and 10,000 orgs), cost per org, and CI/CD and test gaps.

Method: the September trackers in `docs/new-109-pg-plan/gap26sept/`
(`health.md`, `observability.md`, `realtime-stream.md`, `billing.md`,
`00-summary.md`) were re-checked against code on `main` at `c8ad0ab1`, along
with `infra/docker-compose.yml`, `deploy/` and `.github/workflows/`. Code
wins. No load test or live probe was run for this document; numbers marked
**estimate** are derived from configuration, not measured.

Companion: `11-security-and-platform-gaps.md` (security, RBAC, compliance).

Legend and priority/effort scale are the same as file 11:
🟢 closed, 🟡 partial, 🔴 open, 🆕 not tracked before. P0 blocks the first
paying customer; P1 before scale; P2 polish. Effort S ≤ 1 day, M 2–4 days,
L 1–2 weeks, XL > 2 weeks.

---

## 1. Executive summary

The application layer has good reliability habits: readiness probes with
timeouts, a fail-closed usage gate, Temporal for durable work, resumable DSR
and plan execution, idempotency keys on Stripe writes, an SSE stream that
degrades to DB polling when Redis is down, a deploy that rolls back a failed
swap, and a guard that refuses to deploy commits that are not on
`origin/main`.

The platform underneath is not ready for paying customers:

1. **Everything runs on one Azure Spot VM** (2 vCPU, 16 GiB) that Azure can
   evict with about 30 seconds' notice, shared with three unrelated projects
   (`deploy/SERVER.md`). Postgres, Temporal, Redis, Langfuse, Nango, LiteLLM,
   Cognee, Hindsight, TrueForge and the app share that host. One eviction,
   disk-full or kernel OOM is a full outage of every tenant and of the other
   projects.
2. **There are no scheduled backups.** The only dump on record was taken by
   hand before the 2026-10-01 wipe (`deploy/SERVER.md`, "Backups taken before
   the 2026-10-01 wipe"). `infra/scripts/restore-drill.sh` is a dry-run drill,
   not a backup job. Losing the OS disk loses every tenant's data, the
   `CHANNEL_SECRETS_KEY` that unseals WhatsApp tokens, and Nango's OAuth
   tokens.
3. **No alerting reaches a human.** Alert probes exist as scripts
   (`infra/scripts/alerting-*.js`) and an owner-triggered dispatch route
   (`/api/observability/alerts/dispatch`), but nothing runs them on a schedule
   and nothing pages anyone. There is no uptime monitor; `/api/health/ready`
   requires a session cookie, so an external monitor cannot call it.
4. **No metrics or error tracking stack.** No Prometheus/OpenTelemetry
   exporter, no Sentry, no central logs. Logs are `console.*` into Docker's
   json-file driver, capped at 30 MB per container and lost on recreate.
5. **Memory limits add up to ~15.6 GB** of the 16 GiB host before mtip,
   TrueForge host services and the OS (sum of `mem_limit` in
   `infra/docker-compose.yml` plus the 512 MB frontend in the prod overlay).
   Overcommit is intentional per the compose comment, which means the kernel
   OOM killer decides which service dies under load.
6. **Capacity ceilings are low and mostly per-process:** DB pool `max: 10` in
   the dashboard (`apps/dashboard/lib/db.ts:52`) and in the worker
   (`services/workflows/src/tools/shared.ts:50-56`), one dashboard container,
   one worker, Temporal on the `auto-setup` image with the development dynamic
   config (`infra/temporal/dynamicconfig/development-sql.yaml`), rate limits
   and SSE caps held in process memory.
7. **CI does not test the product end to end.** It runs typecheck, lint,
   build, unit tests (≈ 625 dashboard + 487 workflows), the RLS isolation
   suite and deploy-script tests. There are no API integration tests against a
   running stack, no browser tests, no load tests, no image vulnerability
   scan, and deploys are manual from the VM.

Rough capacity (estimate): the current box serves **tens of active orgs**
comfortably, **~100 orgs** with light usage if backups and alerting exist,
and fails well before **1,000** active orgs on DB connections, LLM
concurrency, Cognee/Hindsight memory and a single worker. §9 has the detail.

### Top-15 backlog (detail in §13)

| # | Item | Pri | Effort | Section |
|---|---|---|---|---|
| 1 | Scheduled, encrypted, off-box Postgres backups + WAL archiving; secrets and volumes backed up; a real restore test | P0 | M | 8 |
| 2 | Move off Spot and off the shared VM (regular VM or managed services) | P0 | M | 7 |
| 3 | External uptime monitor + public unauthenticated readiness endpoint (no detail) + paging | P0 | S | 2, 4 |
| 4 | Schedule alert probes (worker periodic workflow) and route to a pager/Slack | P0 | S | 4 |
| 5 | Error tracking (Sentry or equivalent) in dashboard, worker, bridge, frontend | P1 | S | 3 |
| 6 | Metrics: OpenTelemetry/Prometheus for HTTP, DB pool, Temporal, LLM latency/cost, queue depth | P1 | M | 3 |
| 7 | Central log shipping with retention (Azure Monitor / Loki) and request ids | P1 | M | 3 |
| 8 | Postgres sizing and tuning; separate data disk; `statement_timeout`; connection budget | P1 | M | 6 |
| 9 | Temporal production config: namespace retention, worker tuning, separate task queues, metrics | P1 | M | 11 |
| 10 | Two dashboard replicas behind the proxy (zero-downtime deploy) + Redis-backed limiters | P1 | M | 7, 9 |
| 11 | CI: API integration tests on a compose stack, Playwright smoke, image scan, deploy from CI | P1 | L | 12 |
| 12 | Load test harness and a baseline (k6) for chat, webhooks and SSE | P1 | M | 9 |
| 13 | Cost per org dashboard from `org_model_spend` + infra allocation; margin alerts | P1 | M | 10 |
| 14 | DR runbook with RPO/RTO targets and a quarterly drill | P1 | S | 8 |
| 15 | Langfuse retention, sampling and DSR coverage | P2 | S | 3.3 |

---

## 2. Health and readiness

### 2.1 What exists

| Probe | Path | Auth | What it checks | Evidence |
|---|---|---|---|---|
| Liveness | `GET /api/health` | public (`lib/session-cookie.ts:221`) | process up, runtime memory and event-loop delay | `apps/dashboard/app/api/health/route.ts`, `lib/runtime-telemetry.ts` |
| Readiness | `GET /api/health/ready` | **session required** | Postgres (dedicated 1-connection probe pool), pool waiting count, Redis, Temporal, LiteLLM, each with 1500 ms timeout; 5 s cache; 503 only on Postgres/pool hard failure | `app/api/health/ready/route.ts`, `lib/health-readiness.ts`, `lib/db.ts:55-62` |
| Diagnostics | `GET /api/health/diagnostics` | owner/admin/auditor | runtime + pool + configured-deps flags | `app/api/health/diagnostics/route.ts` (`canReadAudit`) |
| Banner | client | in app | polls ready every 30 s, shows degraded/unhealthy | `components/SystemDegradationBanner.tsx` |
| Worker | `:8788/health` | internal | worker process | compose worker healthcheck |
| Deploy | `curl /api/health` on dashboard and frontend | — | after recreate | `deploy/redeploy.sh:90-91, 378-382` |

September tracker (`health.md`) rows 1–7 are all 🟢 in code.

### 2.2 Gaps

1. **Readiness is not reachable by an external monitor.** Middleware treats
   only `/api/health` as public (`lib/session-cookie.ts:220-221`); the
   `isHealthApiPath` exception in `middleware.ts:26-28,62` only skips the rate
   limiter. An unauthenticated `GET /api/health/ready` returns 401. Either add
   it to `isPublicApiPath` with a body that reveals only `{status}` (no
   dependency names, latencies or memory), or add `/api/health/live` +
   `/api/health/ready-public`. **P0, S.**
2. **Readiness does not cover the services that most often fail:** Nango
   (connector tokens), the MCP bridge, TrueForge, Cognee, Hindsight, Langfuse,
   Evolution, SearXNG/Crawl4AI, SuperTokens, and the worker itself (no
   heartbeat). Add each as a non-fatal check (`degraded`, never `unhealthy`)
   and a worker heartbeat row (`worker_heartbeats(id, last_seen_at,
   task_queue, build_sha)`) written every 30 s, read by readiness. **P1, M.**
3. **Liveness exposes runtime memory and event-loop delay publicly.** Minor
   information leak; move the detail behind diagnostics. **P2, S.**
4. **The dashboard container has no Docker healthcheck** in
   `infra/docker-compose.yml` (the worker has one), so `restart: always`
   restarts only on process exit, not on a hung event loop. Add
   `healthcheck: curl -fsS -m 5 http://127.0.0.1:3000/api/health`. Docker does
   not restart unhealthy containers by itself; pair with an autoheal sidecar
   or move to an orchestrator that does. **P1, S.**
5. **Deploy health gate checks liveness only.** `redeploy.sh` should also
   require readiness `healthy` (or `degraded` with an explicit allowlist) and
   one synthetic API call (login page 200, `/api/auth/session` 200) before
   declaring success and dropping rollback tags. **P1, S.**
6. **No synthetic transaction.** A scheduled probe that signs in as a
   dedicated test org, sends one Ask AI message with a cheap model and checks
   a streamed reply catches the failures health checks miss (LiteLLM key
   expired, OpenRouter credit exhausted, MCP secret mismatch). **P1, M.**

---

## 3. Metrics, logging, tracing and error tracking

### 3.1 Metrics

**Status: 🔴 for infrastructure metrics; 🟢 for product metrics.**

Product metrics exist and are real: per-employee observability tiles
(`lib/employee-metrics-query.ts`, outbound per customer and calibration from
real tables, `observability.md` row 1), daily snapshot to avoid a write
stampede (row 5), analytics ROI and cost-health routes, platform
observability route (`app/api/platform/observability/route.ts`).

Missing: there is no Prometheus, OpenTelemetry or StatsD exporter anywhere
(grep for `prom-client`, `opentelemetry`, `@sentry` finds none). Nobody can
answer "what was p95 latency of `/api/ask-ai` yesterday", "how many DB
connections were waiting", "how deep is the Temporal task queue", or "how
many LLM calls failed per provider" without reading logs by hand.

Fix steps:
1. Add OpenTelemetry SDK to dashboard (Next.js `instrumentation.ts` already
   exists and runs at boot), worker and MCP bridge. Auto-instrument HTTP,
   `pg`, `fetch`. Export OTLP to a collector container.
2. Custom metrics (names are proposals):
   - `darex_http_request_duration_seconds{route,method,status}`
   - `darex_db_pool_waiting`, `darex_db_pool_total`, `darex_db_pool_idle`
     `{service}` (pg Pool exposes these)
   - `darex_llm_request_duration_seconds{provider,model,outcome}`,
     `darex_llm_tokens_total{direction}`, `darex_llm_cost_usd_total{org_tier}`
     (do not label by org id; cardinality)
   - `darex_tool_calls_total{tool,outcome}` (outcome: executed, parked,
     denied, error)
   - `darex_approvals_pending`, `darex_approval_age_seconds`
   - `darex_sse_connections{mode=redis|polling}`
   - `darex_webhook_received_total{channel,outcome}`,
     `darex_webhook_signature_failures_total{channel}`
   - `darex_usage_gate_blocks_total{reason}`
   - Temporal SDK metrics (worker task slots, schedule-to-start latency,
     activity failures) via the SDK's Prometheus/OTel exporter.
3. Storage: Azure Monitor managed Prometheus, Grafana Cloud free tier, or a
   small Prometheus + Grafana pair (not on the same VM as the app once the
   platform is split).
4. Dashboards: golden signals per service; LLM spend per hour; approvals
   backlog; webhook ingest rate.

Priority **P1**, effort **M**.

### 3.2 Logging

**Status: 🔴.**

- 267 `console.*` calls under `apps/dashboard/app/api` alone; unstructured
  strings, no request id, no org id field, no level discipline.
- Docker json-file logs capped at 10 MB × 3 per container
  (`deploy/docker-compose.prod.yml` `x-default-logging`), lost when a
  container is recreated by `redeploy.sh`.
- Operator scripts read logs from the box (`infra/scripts/logs.sh`).

Fix steps:
1. A tiny `log` helper (pino is the common choice; check whether any
   workspace already depends on it before adding) emitting JSON with
   `ts, level, service, route, requestId, orgId, userId, msg, err`. Never log
   message bodies, tokens or emails at info level.
2. Request id: generate in middleware (`x-request-id`), pass to route
   handlers, to Temporal workflow memo, and to Langfuse trace metadata, so one
   id joins HTTP, workflow and trace.
3. Ship logs off-box: Azure Monitor Agent / Log Analytics, or Loki via
   Promtail/Alloy. Retention 30 days hot, 1 year archive for audit-relevant
   streams.
4. Replace `console.error(err)` patterns that print full driver errors with
   structured error logging and a returned `errorId` (file 11 §15).

Priority **P1**, effort **M**.

### 3.3 Tracing (Langfuse)

**Status: 🟢 for LLM traces, 🟡 operationally.**

Good:
- Dashboard routes trace Ask AI turns (`apps/dashboard/lib/langfuse-trace.ts`).
- Worker agent turns are traced since 2026-10-05
  (`services/workflows/src/langfuse-trace.ts`, called from
  `runAgentTurnActivity`), with token usage, duration, USD cost, employee,
  tools, step count; failures as level ERROR. Fire-and-forget; config errors
  logged once.
- Audit UI deep-links to Langfuse traces (`audit-log.md` row 1).
- An alert probe checks Langfuse ingest (`infra/scripts/alerting-langfuse-ingest.js`).

Gaps:
1. **Langfuse is optional on small hosts.** `deploy.sh` skips the Langfuse
   stack (server, worker, ClickHouse, MinIO, its Redis — about 1.5–2.5 GB) on
   hosts under 12 GB RAM or with `LITE=1` (`deploy/SERVER.md` risk 3). When it
   is skipped, cost and debug traces silently stop. Readiness should report
   `langfuse: not_configured` and the platform console should show it.
   **P2, S.**
2. **Self-hosted Langfuse is the heaviest observability component** on the
   box (ClickHouse 896 MB, server 1 GB, worker 450 MB, MinIO 256 MB, Redis
   300 MB = ~2.9 GB of limits). Langfuse Cloud (or a separate small VM)
   removes ~3 GB from the app host. Data residency must be checked first.
   **P1, S decision.**
3. **No retention.** Traces contain full prompts and customer messages.
   Configure project-level data retention (e.g. 30 days) and include
   Langfuse in DSR delete (file 11 §13.1). **P1, S.**
4. **Not distributed tracing.** Langfuse covers LLM generations. HTTP → DB →
   Temporal → tool → provider spans need OTel (§3.1). Link the two by putting
   the OTel trace id in Langfuse trace metadata. **P2, M.**
5. **Sampling.** At 1,000+ orgs, trace every turn's metadata but sample
   full input/output (e.g. 10%, 100% for errors and for orgs in a debug
   flag). **P2, S.**

### 3.4 Error tracking

**Status: 🔴.** No Sentry or equivalent. Unhandled errors in route handlers,
Temporal activities, the MCP bridge and the frontend are only in container
logs. Add Sentry (or Azure Application Insights) to all four with release =
git sha (already known to the deploy as `.git/darex-deployed`), environment,
and `orgId` as a tag (not PII). Scrub request bodies. **P1, S.**

---

## 4. Alerting

**Status: 🔴 (September `observability.md` row 2 is 🟡; in practice nothing
pages).**

What exists:
- `apps/dashboard/lib/alert-dispatch.ts` posts `{orgId, alerts}` to
  `DAREX_ALERT_WEBHOOK_URL` when set; `POST /api/observability/alerts/dispatch`
  (owner/admin) triggers it manually with dry-run and an audit row.
- `infra/scripts/alerting-run.js` runs four probes —
  `alerting-queue-lag.js`, `alerting-connector-401s.js`,
  `alerting-rls-job.js`, `alerting-langfuse-ingest.js` — and exits 1 on any
  failure. Run by hand (`deploy/README.md` "Commands").
- The observability tiles show thresholds in the UI.

What is missing:
1. **No scheduler.** Neither the worker's periodic registry
   (`services/workflows/src/periodic-registry.ts`) nor cron on the VM runs the
   probes or the dispatcher. **P0, S.**
2. **No destination.** `DAREX_ALERT_WEBHOOK_URL` is not in
   `deploy/env.production.example`. Per-org alert destinations (tenant-facing:
   "your WhatsApp token expired") and platform alerts (operator-facing:
   "Postgres down") are different audiences and need separate routes.
   **P0, S.**
3. **No external uptime check.** If the VM is evicted, nothing inside it can
   send an alert. Use an external monitor (Azure Monitor availability test,
   UptimeRobot, Better Stack) on the public `/api/health` and the public
   readiness endpoint from §2.2, paging by SMS/phone. **P0, S.**
4. **No Azure-level alerts:** Spot eviction (Scheduled Events / Activity Log
   "Deallocate"), VM availability, disk > 80%, CPU credit / load, memory.
   **P0, S.**

Proposed alert catalogue (platform, operator-facing):

| Alert | Condition (initial) | Severity | Source |
|---|---|---|---|
| Site down | external probe fails 2× in 2 min | page | uptime monitor |
| VM evicted / deallocated | Azure Activity Log event | page | Azure Monitor |
| Postgres unreachable | readiness `postgres: error` 2 min | page | readiness |
| DB pool saturation | `pool.waitingCount ≥ 5` for 5 min | high | readiness / metric |
| Disk usage | > 80% warn, > 90% page | high/page | node exporter / Azure |
| Container restart loop | > 3 restarts / 10 min | high | Docker events |
| OOM kill | any `oom_kill` in kernel log | high | node exporter |
| Temporal schedule-to-start | p95 > 30 s for 10 min | high | Temporal metrics |
| Worker heartbeat missing | > 2 min | page | heartbeat table |
| LLM error rate | > 10% for 5 min per provider | high | metric |
| LLM spend anomaly | hourly spend > 3× 7-day hourly p95 | high | `org_model_spend` |
| Webhook signature failures | > 20 / 10 min per channel | medium | `failed_webhooks` |
| Webhook ingest stopped | 0 inbound for 2 h on an org that averages > 10/h | medium | messages table |
| Approvals backlog | pending > 50 or oldest > 24 h (per org, tenant-facing) | medium | `agent_pending_actions` |
| Connector 401s | existing probe | medium (tenant) | `alerting-connector-401s.js` |
| Backup missing | no successful backup in 26 h | page | backup job |
| Cert expiry | < 14 days | medium | uptime monitor |
| DSR job stuck | `running` > 30 min (reaper marks failed) | medium | `dsr_requests` |

Fix steps:
1. New `PlatformAlertsWorkflow` (every 5 min) in the worker running the four
   probe checks plus pool/disk/heartbeat queries, posting to a platform
   webhook (Slack + PagerDuty/Opsgenie or a phone-call service).
2. Tenant alerts via the existing dispatcher on a schedule, with per-org
   destination settings (email to owners by default).
3. External uptime + Azure Monitor alerts configured by hand (or Terraform
   in `infra/terraform/`).
4. Write the on-call runbook: each alert links to a section with first
   checks and fixes.

Effort **M** overall; items 1–3 are S each.

---

## 5. Realtime (SSE) and fallback

**Status: 🟢 in code for a single replica; 🟡 for scale.**

Re-verified (`realtime-stream.md` rows 1–12):
- `/api/stream/events` keeps a 200 stream in `polling` mode (10 s DB poll of
  conversations, plans, work items) when Redis is unreachable or subscribe
  fails; the shared `useRealtimeStream` hook reconnects with 1.5ⁿ backoff and
  jitter and exposes `fallback`.
- Hub validates and allowlists event types; per-org ring buffer (500 events,
  deduped by event id, LRU 1,000 orgs, 15 min idle TTL) for Last-Event-ID
  gap fill; RESP framing handles fragmented frames; heartbeat.
- Per-process caps: 6 SSE connections per user, 200 per org, 429 above.
- Backpressure via `desiredSize`; presence heartbeats; web push gated on VAPID.

Gaps and scale limits:
1. **Replay ring is process-local.** With two dashboard replicas, a client
   that reconnects to the other replica misses events between its last id and
   now (the ring there has a different history). Pub/sub still delivers new
   events. Fix: Redis Streams (`XADD` with `MAXLEN ~ 1000` per org, `XREAD`
   from Last-Event-ID) replace pub/sub + ring. `infra/scripts/check-two-replica-sse.js`
   exists to test this. **P1, M.**
2. **Connection caps are per replica**, so they double with two replicas and
   do not bound total load. Move counters to Redis with TTL. **P2, S.**
3. **Each SSE connection holds a Node socket for its lifetime** and, in
   polling mode, runs a DB query every 10 s per connection. 200 users in
   polling mode = 20 queries/s against a 10-connection pool, on top of normal
   traffic. Poll once per org per interval and fan out in process. **P1, S.**
4. **Redis is shared with Nango** (`REDIS_URL → redis:6379`, compose comment
   at line 21; Nango uses the same instance). A Nango-driven memory spike
   evicts or blocks the SSE bus. Separate logical DBs at minimum, separate
   instances at scale; set `maxmemory` and policy. **P2, S.**
5. **The frontend proxies SSE through Next rewrites** (frontend container →
   dashboard). Check proxy buffering and timeouts on Caddy (`flush_interval
   -1` for the stream path) and the rewrite. **To verify on the VM.**
   **P2, S.**
6. **No SSE metrics** (connections by mode, reconnect rate, delivery lag); the
   hub warns on > 5 s lag in logs only. Add the metrics in §3.1. **P2, S.**

---

## 6. Database: Postgres, pool and PgBouncer

### 6.1 Current configuration

| Item | Value | Evidence |
|---|---|---|
| Image | `pgvector/pgvector:pg16`, one instance for all services | `infra/docker-compose.yml:64-100` |
| Memory limit | 768 MB (reservation 512 MB) | same |
| `max_connections` | 200 | `command: ["postgres","-c","max_connections=200"]` |
| Other tuning | none (`shared_buffers` default 128 MB, `work_mem` 4 MB, no `statement_timeout`) | same |
| Storage | named volume `postgres-data` on the OS disk | `deploy/SERVER.md` (no data disk) |
| Other tenants of the instance | Temporal, Langfuse (Postgres part), Nango, SuperTokens, LiteLLM, Evolution, Hindsight | compose env |
| PgBouncer | session mode, `MAX_CLIENT_CONN=200`, `DEFAULT_POOL_SIZE=25`, darex DB only | `infra/docker-compose.yml:102-128` |
| Dashboard pool | `max: 10`, idle 30 s, **no `connectionTimeoutMillis`, no `statement_timeout`** | `apps/dashboard/lib/db.ts:28-52` |
| Health probe pool | `max: 1`, separate | `lib/db.ts:55-62` |
| Worker / MCP bridge pool | `max: 10` each | `services/workflows/src/tools/shared.ts:50-56` |
| Queries per scoped request | 5 round trips before the route's own query (set user GUC, lookup user, epoch/disabled, set org GUC, org status) | `lib/db.ts:176-215` |

### 6.2 Gaps

1. **Memory.** 768 MB for a Postgres serving nine services (including pgvector
   indexes and Temporal's history tables) is tight. Default `shared_buffers`
   (128 MB) leaves most of the limit unused for caching, while a few
   concurrent sorts or an HNSW build can push it over the cgroup limit and get
   it OOM-killed — taking every service down at once. Size to 2–4 GB, set
   `shared_buffers` ≈ 25%, `effective_cache_size` ≈ 60%,
   `maintenance_work_mem` 256 MB, `work_mem` 8–16 MB. **P1, S.**
2. **No timeouts.** A slow query holds one of 10 pool slots indefinitely; a
   full pool makes `pool.connect()` wait forever (no
   `connectionTimeoutMillis`). Set `connectionTimeoutMillis: 5000`,
   role-level `statement_timeout = '15s'` for `darex_app` (override per
   transaction for long jobs), `idle_in_transaction_session_timeout = '30s'`,
   `lock_timeout = '5s'`. **P1, S.**
3. **Per-request overhead.** Five round trips per API call before work
   starts. Cache user/epoch/disabled/org status for 5–10 s per process (keyed
   by user id + epoch) or fold into one SQL function `auth_session_context($user)`
   that sets both GUCs and returns status. Halves DB load for chatty pages.
   **P1, M.**
4. **Session-mode PgBouncer gives no multiplexing.** Each app pool slot is a
   server connection. It is useful only as a connection cap. To scale beyond
   ~3 app replicas, move RLS context to `SET LOCAL` inside transactions and
   switch to transaction mode (file 11 §6 item 1 warns of the leak if done
   without that change). **P1 at 1,000 orgs, M.**
5. **Shared instance.** Temporal's persistence load and Langfuse's Postgres
   share I/O and connections with tenant data. Temporal alone can use ~50
   connections (compose comment). Separate Temporal's database at least onto
   its own instance (or Temporal Cloud) before 1,000 orgs. **P1, M.**
6. **Vacuum and bloat.** High-churn tables (`messages`, `ingestion_jobs`,
   `agent_pending_actions`, `org_employee_metrics_daily`, `failed_webhooks`,
   `audit_events`, Temporal history) need autovacuum tuning and monitoring.
   `pg_stat_statements` is not enabled; enable it to find slow queries.
   **P2, S.**
7. **Partitioning.** `messages`, `audit_events`, `tool_invocations`,
   `org_model_spend` grow without bound. Partition by month before 10,000
   orgs; add retention jobs. **P2 now, P1 at scale, L.**
8. **pgvector.** Check index type (HNSW vs IVFFlat) and that every vector
   query filters by `org_id` first (it does, per `org-tenancy.md` row 10). At
   scale, per-org partial indexes or partitioning by org hash keep recall and
   latency stable. **P2, M.**
9. **Migrations run as superuser after containers come up**
   (`deploy/README.md`), so new code briefly runs against the old schema.
   Additive-only migrations make this safe; add a CI check that rejects
   destructive DDL (`DROP COLUMN`, `ALTER TYPE`, `NOT NULL` without default)
   without an explicit `-- destructive-ok` marker. **P2, S.**

---

## 7. The single Azure Spot VM

### 7.1 Facts (from `deploy/SERVER.md`, last reviewed 2026-10-01)

- `Standard_E2as_v5`: 2 vCPU, 16 GiB RAM, Central India zone 2, **Azure
  Spot** with eviction policy Deallocate (~$9.65/month Spot vs ~$52
  regular).
- One OS disk (resize to 128 GiB was in progress), **no data disk**, 6 GB
  swap. Docker uses the containerd image store (layers stored twice).
- Shared with **mtip** (~11 containers, owns 80/443 via `mtip-caddy`),
  **trueforge** (2 containers + 3 systemd services), **cognee** (systemd),
  **openclaw-gateway**, Tailscale.
- Darex TLS is terminated by `mtip-caddy`, another project's container,
  attached to `darex-net` by a manual `docker network connect` that is lost
  whenever `mtip-caddy` is recreated.
- Public name is `darex.135-235-136-6.sslip.io` (breaks if the IP changes).
- NSG rules "not reviewed (to check)"; ~4 OS updates pending.
- `next build` took 13+ minutes on the box; images now build on GitHub and
  are pulled.

### 7.2 Risks

| # | Risk | Likelihood | Impact | Notes |
|---|---|---|---|---|
| 1 | Spot eviction | Medium (capacity-driven; can be daily in busy regions) | Total outage until someone starts the VM; in-flight Temporal activities retry, SSE drops, webhooks fail (Meta retries for a while, then drops) | 30 s notice, no automation listens for it |
| 2 | Disk full | High (happened already) | Postgres stops accepting writes; Docker cannot start containers | No data disk; images, build cache, logs and DB share one disk |
| 3 | OOM | Medium-high | Kernel kills the largest cgroup offender; Postgres or Cognee most likely | Limits sum to ~15.6 GB on 16 GiB plus other projects |
| 4 | Noisy neighbour | Medium | mtip or trueforge load starves Darex (load average 27 seen during builds) | 2 vCPU total |
| 5 | Other project's proxy | Medium | A change to `mtip-caddy` takes Darex offline | Manual network attach |
| 6 | Single disk loss | Low | **Permanent data loss** (no backups) | §8 |
| 7 | Security blast radius | Medium | A compromise of any co-hosted project reaches Darex's Docker socket, `.env`, and volumes | file 11 §16.1 |
| 8 | IP change | Low | sslip.io domain, OAuth redirect URIs, Meta webhooks break | |
| 9 | Manual operations | High | Deploys, migrations, restarts depend on one person with SSH | |

### 7.3 Target options

| Option | Monthly cost (estimate, compute + managed services, Central India) | Pros | Cons |
|---|---|---|---|
| A. Regular (non-Spot) dedicated VM `D4as_v5` (4 vCPU / 16 GiB) + premium SSD data disk + Azure Backup | ~$80–150 | Smallest change; removes eviction and neighbours | Still a single host; manual DR |
| B. A + Azure Database for PostgreSQL Flexible Server (Burstable B2s/B2ms, zone-redundant HA optional) + Azure Cache for Redis Basic | ~$200–350 | Managed backups/PITR, separate failure domain for data | Must re-check pgvector version, extensions, RLS roles, PgBouncer built in |
| C. B + app on Azure Container Apps (dashboard ×2, worker ×2, bridge) + Temporal Cloud + Langfuse Cloud | ~$500–1,200+ (Temporal Cloud and Langfuse Cloud priced by usage) | Horizontal scale, zero-downtime deploys, managed observability | Larger migration; Cognee/Hindsight/TrueForge/Evolution still need a home |
| D. AKS | higher | Full control | Operational overhead not justified before ~1,000 orgs |

Recommendation: **A immediately** (days), **B before the first paying
customer** (weeks), **C when active orgs approach a few hundred** or when one
VM can no longer absorb peak load. Prices are rough planning numbers, not
quotes — check the Azure pricing calculator before committing.

Immediate mitigations while still on Spot:
1. Subscribe to Azure Scheduled Events (`169.254.169.254/metadata/scheduledevents`)
   from a small host service; on `Preempt`, stop accepting webhooks (return
   503 so Meta retries), drain the worker, `CHECKPOINT` Postgres. **P1, S.**
2. Azure Automation runbook or Logic App that restarts the VM after eviction
   when capacity returns, and an alert (§4). **P0, S.**
3. Add a data disk for Docker volumes; move `postgres-data` there. **P1, S.**
4. Make the `mtip-caddy` network attach permanent (external network in
   mtip's compose) or give Darex its own Caddy on a separate IP. **P1, S.**

---
## 8. Backups and disaster recovery

### 8.1 Current state

**Status: 🔴 Open. P0.**

- No scheduled backup job exists in `deploy/`, `infra/scripts/` or as a
  worker workflow (grep for `pg_dump` finds only `restore-drill.sh`).
- `infra/scripts/restore-drill.sh` defaults to a dry run: it takes a
  schema-only dump and prints the restore steps; a non-dry-run mode restores a
  full dump into a drill database. It is a drill, not a backup.
- The only real backup on record is a manual `~/darex-db-backup.sql.gz` on
  the **same disk** before the 2026-10-01 wipe (`deploy/SERVER.md`).
- Azure Backup for the VM is not mentioned as configured ("Not set:
  Auto-shutdown, health monitoring, hibernation").
- The repo itself survived only because `feat/close-109-plan-gaps` had 30
  server-only commits bundled by hand; the sync guard now prevents that.

### 8.2 What must be backed up

| Data | Location | Why it matters | Method |
|---|---|---|---|
| Darex app DB (`darex`) | Postgres volume | All tenant data | WAL archiving + nightly base backup (pgBackRest or WAL-G to Azure Blob) |
| Nango DB | same Postgres | OAuth tokens for every connector; losing it forces every customer to reconnect every tool | included in cluster backup |
| SuperTokens DB | same Postgres | password hashes, SSO config | included |
| Temporal DB | same Postgres | in-flight workflows (plans, approvals waiting on signals, DSR jobs, sweeps) | included; on restore, expect to re-signal or re-start some workflows |
| LiteLLM DB | same Postgres | virtual keys, spend logs | included |
| Langfuse Postgres + ClickHouse + MinIO | volumes | traces (nice to have) | ClickHouse backup or accept loss; document |
| Cognee data | `cognee-data` volume + its DB | per-org knowledge graph | volume snapshot nightly |
| Hindsight | its DB / volume | extracted agent memory | include |
| Evolution | `evolution-data` | WhatsApp QR sessions; loss = re-pair every number | volume snapshot |
| DSR export artifacts | `DSR_ARTIFACT_DIR` | short-lived | exclude, or 7-day backup |
| `.env` and `CHANNEL_SECRETS_KEY`, `NANGO_ENCRYPTION_KEY`, `DAREX_SESSION_SECRET`, `MCP_BRIDGE_SECRET` | VM file | without the seal keys, backed-up encrypted tokens are useless | Key Vault (file 11 §8.4) |
| TrueForge image and checkout | `~/trueforge` | local-only image, no registry copy (`deploy/SERVER.md`) | push to a private registry |
| Cognee checkout | `~/cognee` | built from a sibling checkout | pin a commit, push image to registry |

### 8.3 Targets (proposal)

| Phase | RPO | RTO | How |
|---|---|---|---|
| Now (single VM) | ≤ 15 min | ≤ 4 h | WAL-G to Blob (continuous WAL, nightly base), volume snapshots nightly, documented rebuild from `deploy.sh` on a new VM |
| Managed Postgres (option B, §7.3) | ≤ 5 min (PITR) | ≤ 1 h | Flexible Server PITR + geo-redundant backup; app rebuilt from images |
| Scale (option C) | ≤ 1 min | ≤ 15 min | Zone-redundant HA, multi-replica app, IaC rebuild |

### 8.4 Fix steps

1. **Today:** cron on the VM (or a worker periodic workflow) running
   `pg_dumpall` (globals) + `pg_dump -Fc` per database, encrypted with `age`
   or `gpg` to a key not stored on the VM, uploaded to Azure Blob with
   immutability (time-based retention 30 days). Alert if no success in 26 h.
   **P0, S.**
2. **This week:** WAL-G or pgBackRest with continuous WAL shipping for
   point-in-time recovery. **P0, M.**
3. Nightly snapshots of `cognee-data`, `evolution-data`, Hindsight volumes
   (or Azure Backup for the whole VM including a data disk). **P1, S.**
4. Secrets to Key Vault, with soft delete and purge protection. **P1, S.**
5. Push the TrueForge and Cognee images to the private GHCR alongside the
   others so a new VM can be built without the sibling checkouts. **P1, S.**
6. **Restore test monthly:** run `restore-drill.sh` in full (non-dry-run)
   against the latest backup on a scratch VM, run the RLS isolation suite and
   a smoke test against it, record time taken (that is the measured RTO).
   **P1, S per run.**
7. **DR runbook** in `deploy/DR.md`: eviction, disk full, DB corruption, lost
   VM, leaked secret, bad migration; each with detection, first 10 minutes,
   restore steps, comms template. **P1, S.**

### 8.5 Bad deploy and bad migration recovery

- `redeploy.sh` tags `:rollback` images and restores them if compose up,
  health checks or migrations fail (BUILD_STATE 2026-10-05). Good.
- Migrations are not reversed (additive and idempotent by convention). A
  migration that corrupts data can only be undone from backup. Take a
  `pg_dump -Fc` of affected tables before each migration batch (cheap at
  current size) and keep 7 days. **P1, S.**

---

## 9. Load and scale plan

This section estimates where the current design breaks. "Org" means an
**active** workspace: ~3 human users, 1–2 connected channels, ~50–200
inbound messages a day, ~20–50 Ask AI turns a day, and periodic sweeps.
These are planning assumptions, not measurements. Replace them with real
numbers from `org_model_spend`, `messages` and `tool_invocations` once
§3.1 metrics exist.

### 9.1 Load per org (estimate)

| Source | Per active org per day | Peak factor |
|---|---|---|
| Inbound messages (WhatsApp/IG/email/widget) | 50–200 → 50–200 agent turns | 5× in business hours |
| Ask AI turns | 20–50 (each 1–6 tool steps) | 3× |
| Periodic sweeps (growth, customer, operations, billing meter, DLQ, DSR reaper) | ~100 workflow runs (sweeps × employees × interval) | flat |
| Embeddings (write-back, uploads) | 100–300 chunks | bursty |
| API calls from open dashboards (incl. SSE, polling) | 2,000–10,000 | 3× |
| LLM tokens | 0.5–3 M input, 50–300 k output (agent loops resend context + tool schemas each step) | 3× |

### 9.2 What breaks first

| Component | Limit today | ~100 orgs | ~1,000 orgs | ~10,000 orgs |
|---|---|---|---|---|
| Host (2 vCPU / 16 GiB, shared) | — | **Strained**: CPU saturates at peaks; Next SSR + Node workers + Postgres compete | **Breaks** | — |
| Dashboard DB pool (10, no timeout) | ~10 concurrent queries per replica | Waits at peaks (5 round trips per request, §6.2.3) | **Breaks** without caching + replicas | — |
| Worker (1 container, pool 10, 384 MB) | Temporal default slots far exceed 10 DB connections | OK with tuning | **Breaks**: activity backlog, schedule-to-start latency in minutes | — |
| Postgres (768 MB, shared by 9 services) | — | Needs 2–4 GB | Needs dedicated 4–8 vCPU managed instance; Temporal moved out | Partitioning, read replica for analytics, possibly sharding by org hash |
| Temporal (auto-setup, dev dynamic config, 4 shards, shared PG) | `historyMgrNumShards: 4` (`infra/temporal/dynamicconfig/development-sql.yaml`); shard count cannot change later | OK | Borderline: sweeps × orgs dominate | **Breaks**: needs Temporal Cloud or a properly sized cluster with 512+ shards |
| Periodic sweeps | One schedule per employee type × org (check `periodic-registry.ts`) | OK | Thousands of workflow runs per interval; batch per tick instead | Must be batched/fanned-out with rate limits |
| LLM (OpenRouter via LiteLLM, 1 GB) | Provider rate limits per key; LiteLLM single instance | OK | **Provider 429s** at peak; need multiple keys/providers, queueing, per-org concurrency caps | Contracted capacity, regional routing |
| MCP bridge (256 MB, 20 sessions per org cap) | per-process sessions | OK | Needs 2+ replicas | Horizontal |
| TrueForge sidecar (768 MB) | single process | OK | Single point of failure; scale or use in-process `local-turn` path | — |
| Cognee (2 GB) and Hindsight (1 GB) | memory-heavy, per-org datasets; Cognee OOM history | **Strained** | **Breaks**: needs dedicated nodes or a managed vector/graph store | Re-architect memory tier |
| Redis (256 MB, shared with Nango) | SSE bus + Nango | OK | Separate instances; Streams for SSE | Managed Redis cluster |
| SSE | 200/org, 6/user per process; polling fallback 1 query/10 s/connection | OK | Needs Redis-backed caps and per-org polling | Dedicated realtime service or managed pub/sub |
| Rate limits / lockout | in-memory | OK (weak) | Wrong with >1 replica | Redis |
| Nango (1 GB) | token refresh for all connections | OK | Monitor refresh failures; may need scaling | Nango Cloud or scaled self-host |
| Langfuse (ClickHouse etc. ~2.9 GB) | self-hosted on app box | Move off box | Cloud or own cluster; sampling | Sampling mandatory |
| Logs (json-file, 30 MB/container) | lost on recreate | Unusable for incidents | Central logging required | — |
| Webhook ingest | in Next.js process with LLM routes (split ingest documented, not built: `infra/scripts/split-ingest.md`) | OK | **Risk**: slow chat requests delay webhook 200s; Meta retries cause duplicates | Separate ingest service |
| Deploy | manual, single replica, downtime per recreate | Acceptable | Needs CI-driven rolling deploy | — |
| Cost tracking | `org_model_spend` | OK | Needs aggregation tables | Partitioned |

### 9.3 Plan by stage

**Stage 0 — now to ~30 active orgs (current box, with P0 fixes):**
backups, alerting, uptime monitor, regular VM, data disk, Postgres memory,
pool timeouts. Nothing architectural.

**Stage 1 — ~100 active orgs:**
1. Managed Postgres (option B), Temporal DB separated or Temporal Cloud.
2. Two dashboard replicas behind Caddy with health-based routing; Redis for
   rate limits, lockout and SSE (Streams).
3. Worker tuned: `maxConcurrentActivityTaskExecutions` ≤ DB pool × 2 for
   DB-bound activities; separate task queues for `llm` (I/O-bound, high
   concurrency), `db` (bounded), `sweeps` (low priority), `embed`. Two worker
   replicas.
4. Langfuse off the box; Cognee/Hindsight on their own VM.
5. Split webhook ingest into its own small service (persist + 200 +
   Temporal start), as `split-ingest.md` describes.
6. OTel metrics + dashboards; load test baseline (§9.4).

**Stage 2 — ~1,000 active orgs:**
1. Container Apps / AKS for dashboard, worker, bridge, ingest; autoscale on
   CPU and Temporal schedule-to-start latency.
2. PgBouncer transaction mode with `SET LOCAL` RLS context; read replica for
   analytics and exports.
3. Per-org concurrency caps for agent turns (queue, not reject) and a global
   LLM concurrency budget per provider key; multiple OpenRouter keys or direct
   provider contracts; fallback model per tier (circuit breaker exists per
   process, `services/workflows/src/circuit-breaker.ts`, make it shared via
   Redis).
4. Sweeps batched: one schedule per sweep type that pages through orgs with
   a cursor and starts child workflows with a concurrency limit, instead of
   one schedule per org.
5. Partition `messages`, `audit_events`, `tool_invocations`,
   `org_model_spend` by month.
6. Caching of session context (§6.2.3) and of employee cards / allowlists.

**Stage 3 — ~10,000 active orgs:**
1. Temporal Cloud (or a cluster sized with many shards; the 4-shard dev
   config cannot be resized in place).
2. Postgres: larger instance + replicas; consider splitting hot domains
   (messages/conversations) into their own database; evaluate Citus or
   org-hash sharding if a single primary cannot hold write load.
3. Memory tier redesign: a managed vector store with per-org namespaces;
   Cognee/Hindsight as asynchronous enrichment, not on the hot path.
4. Multi-region read paths if customers outside India need latency.
5. Dedicated realtime service (or Azure Web PubSub / SignalR) for SSE fan-out.
6. Cost controls are now a core product feature (§10).

### 9.4 Load testing

**Status: 🔴.** No load test exists.

Fix steps:
1. k6 scripts in `tests/load/`: (a) login + dashboard page APIs,
   (b) Ask AI simple turn with a stubbed LLM (point LiteLLM at a mock
   provider that returns fixed completions with configurable latency), (c)
   WhatsApp webhook burst with valid signatures, (d) 500 SSE connections,
   (e) widget message burst.
2. Run against a staging stack sized like production; record p50/p95/p99,
   error rate, DB pool waiting, Temporal schedule-to-start, memory.
3. Targets for Stage 1: webhook 200 p95 < 300 ms at 50 rps; Ask AI first
   token p95 < 3 s excluding model latency; zero 5xx at 2× expected peak.
4. Run before each infrastructure change and monthly.

Priority **P1**, effort **M**.

---

## 10. Cost per org

### 10.1 What is tracked

- Per-turn spend in fractional cents (`services/workflows/src/cost/budget.ts:57-70`
  `turnSpendCents`, prefers the runtime's reported cost),
  `125_org_model_spend_fractional_cents.sql`, Postgres aggregation for model
  spend (BUILD_STATE 2026-09-29).
- Daily ceiling default `DEFAULT_MAX_SPEND_CENTS_PER_DAY = 2500` ($25/org/day)
  (`cost/budget.ts:5`), `dailySpendBreached` (`:42-44`).
- Usage meters refreshed every 15 min; usage gate blocks over the hard cap.
- Langfuse cost per generation; analytics `cost` and `cost-health` routes;
  billing page shows meters.
- Output token cap per agent turn and reuse of identical read-only tool
  results within a turn (BUILD_STATE 2026-09-30 live sweep) reduce spend.

### 10.2 What is missing

1. **Infrastructure cost is not allocated.** Spend tracking covers LLM calls
   only. Embeddings (if billed), Cognee/Hindsight LLM calls (their own model
   usage), web search APIs (Jina, SearXNG is free), Twilio/WhatsApp
   conversation fees, Resend, and the fixed platform cost are not attributed
   to orgs.
2. **No margin view.** Nothing compares an org's plan revenue with its spend.
3. **$25/day default ceiling = up to $750/month per org**, which is likely
   above most plan prices. The ceiling should derive from the plan (with
   overrides in `org_plan_overrides`).
4. **Sweep cost** grows with orgs × employees × frequency even for idle orgs.
   Skip sweeps for orgs with no activity in N days.
5. **Cognee search on every turn** was costing even for orgs with no dataset
   (fixed 2026-10-05); similar "always on" calls should be audited.

### 10.3 Unit-economics model (estimate; fill with measured values)

Formula per active org per month:

```
LLM      = turns × steps_per_turn × (in_tokens × p_in + out_tokens × p_out)
Memory   = embed_chunks × p_embed + cognee_hindsight_llm_calls × p_call
Channels = whatsapp_conversations × meta_fee + sms × twilio_fee + emails × resend_fee
Infra    = fixed_platform_cost / active_orgs + storage_gb × p_storage
Total    = LLM + Memory + Channels + Infra
```

Illustrative scenario (assumptions, not quotes): a "flash"-class model at
~$0.10–0.30 per million input tokens and ~$0.40–1.20 per million output
tokens; 3,000 agent turns per month (inbound + chat); 3 steps per turn;
~8,000 input tokens per step (system prompt, allowlisted tool schemas,
history, tool results) and ~400 output tokens per step.

| Item | Low | High |
|---|---|---|
| Input tokens | 3,000 × 3 × 8k = 72 M → $7 | 72 M → $22 |
| Output tokens | 3,000 × 3 × 400 = 3.6 M → $1.4 | 3.6 M → $4.3 |
| Memory / embeddings / extraction | $1 | $6 |
| Infra share at 100 orgs on option B (~$300/month) | $3 | $3 |
| Infra share at 30 orgs | $10 | $10 |
| **Total (excl. channel fees)** | **~$12–20** | **~$35–45** |

Channel fees (WhatsApp business-initiated templates, SMS) are passed through
or priced separately; at scale they can exceed LLM cost.

Levers, roughly in order of impact:
1. Prompt caching (provider-side) for the system prompt and tool schemas,
   which dominate input tokens; keep the prefix stable across steps.
2. Smaller tool schema sets per turn (allowlist narrowing already exists;
   `local-tool-select.ts` selects tools — measure tokens saved).
3. Route simple inbound replies (FAQs, greetings) to the cheapest model or to
   a non-agent template path.
4. Cap steps per turn by employee and plan.
5. Batch and throttle sweeps for idle orgs.

### 10.4 Fix steps

1. Daily `org_cost_daily(org_id, day, llm_cents, embed_cents, search_cents,
   channel_cents, infra_alloc_cents)` rollup job. **P1, M.**
2. Platform console page: top orgs by cost, cost/revenue ratio, orgs above
   plan margin. **P1, M.**
3. Plan-derived daily ceiling and soft alerts at 50/80/100% to owners.
   **P1, S.**
4. Measure tokens per step by employee; record in Langfuse metadata. **P2, S.**

---

## 11. Temporal and background work

### 11.1 What exists

- One task queue `darex-agent-tasks` for every workflow
  (`services/workflows/src/worker.ts:78-83`): agent, crew, work item, embed,
  memory write-back, ingest/sync, plan execute, owner briefing, stale chase,
  nurture, insight action, pack install, showings, rent reminders, billing
  sweep, DLQ retention, DSR delete/export/reaper.
- Worker reconnect loop with backoff; seeds TrueForge on boot; boots
  periodic sweeps and the billing sweep (`worker.ts:87-110`).
- Plan execution: cancellation via `CancellationScope`, reconnect/resume
  without re-running steps, per-step idempotency claim; retried agent turns
  do not re-run tools already run (BUILD_STATE 2026-10-05).
- Dashboard falls back to direct execution when Temporal is down (DSR, crew,
  inbound) — good for availability, but a second code path to keep correct.

### 11.2 Gaps

1. **Development configuration in production.** `temporalio/auto-setup:1.24.2`
   with `development-sql.yaml` (4 history shards,
   `system.advancedVisibilityWritingMode: off`, client version check off).
   auto-setup is documented by Temporal as not for production. The shard
   count is fixed at cluster creation. **P1 now (decide), M to migrate.**
   Options: Temporal Cloud (simplest), or `temporalio/server` with an explicit
   schema setup, 512 shards, its own Postgres database, and the UI behind
   auth.
2. **Namespace retention** not set explicitly (default namespace created by
   auto-setup). Workflow histories with message text accumulate in Postgres.
   Set retention (e.g. 7 days) and confirm. **P1, S.** Also file 11 §13.3.
3. **Single task queue.** A burst of embeds or sweeps delays customer-facing
   inbound replies on the same queue. Split into `inbound` (highest
   priority), `chat`, `plans`, `sweeps`, `embed`, `dsr`, each with its own
   worker concurrency. **P1, M.**
4. **Worker sizing.** One worker container at 384 MB with a 256 MB heap and a
   10-connection DB pool; Temporal TS SDK default concurrency allows many more
   concurrent activities than the pool can serve, so activities queue on
   `pool.connect()` with no timeout (§6.2.2). Set
   `maxConcurrentActivityTaskExecutions`, `maxConcurrentWorkflowTaskExecutions`
   and `maxCachedWorkflows` explicitly; raise heap to fit the workflow cache.
   **P1, S.**
5. **No Temporal metrics or alerting.** Schedule-to-start latency, task
   slots used, workflow failures, activity retries per type. SDK metrics →
   OTel (§3.1). **P1, S.**
6. **Temporal UI** is bound to loopback in prod (good) but has no auth; it
   shows workflow inputs (customer messages). Keep it on loopback/SSH tunnel
   only; never expose through Caddy. **P2.**
7. **Activity timeouts and retry policies** per activity type should be
   reviewed in one table (start-to-close, heartbeat for long LLM calls,
   non-retryable error types for 4xx provider errors) — not done in this
   audit. **P2, M.**
8. **Direct-execution fallbacks** when Temporal is down run long work inside
   a Next.js request or fire-and-forget promise; a dashboard restart loses
   them. Record such runs in a table and re-drive them when Temporal returns,
   or return 503 for non-urgent work. **P2, M.**
9. **Workflow versioning.** Deploys replace worker code while workflows are
   in flight (plans waiting on approval for days, nurture sequences). Check
   that workflow code changes use `patched()` / versioning; a non-determinism
   error after deploy fails long-running workflows. Add a replay test in CI
   using recorded histories. **P1, M.**

### 11.3 Provider resilience (LLM and connectors)

- `circuit-breaker.ts` opens a provider after 3 consecutive failures for
  60 s, **per process** (`:12-14`), with no half-open probe limit and no
  shared state between dashboard, worker and bridge. Fine for one replica;
  move state to Redis and add metrics at Stage 1. **P2, S.**
- Provider rate limits: `tools/provider-rate-limit.ts` exists; confirm it is
  shared across processes.
- Nango token refresh failures surface as `revoked` / `never-configured`
  (fixed 2026-10-05) and the connector-401 probe exists; schedule it (§4).
- LiteLLM is a single container with 1 GB; it is a single point of failure for
  every LLM call. Run two replicas or allow direct provider fallback.
  **P1 at Stage 1.**

---

## 12. CI/CD and test gaps

### 12.1 What exists

`.github/workflows/ci.yml` on push to `main`, `develop` and three feature
branches, and on pull requests:
- REJECT-framework deny-list check on `package.json` / lockfiles.
- Install with frozen lockfile; typecheck (shared-types, connectors,
  workflows, dashboard); lint; build all workspaces.
- Deploy script tests: port guard, prebuilt image pull, sync guard
  (`tests/deploy-*.sh`).
- Unit tests: `@darex/workflows` (≈ 487) and `@darex/dashboard` (≈ 625).
- Dependency audit gate on production deps (`infra/scripts/audit-gate.js`,
  allowlist down to `braces`).
- A separate job with a real Postgres: migrations applied, `darex_platform`
  role, multi-tenant isolation suite (`tests/e2e-tenant-isolation.test.js`).
- Chat coverage matrix test keeps `gap26sept/chat-coverage.md` complete.

`.github/workflows/images.yml` builds `dashboard`, `worker`, `inbox`,
`sandbox` images on push to `main` and pushes to GHCR tagged with the commit
SHA; `redeploy.sh` pulls them when HEAD equals `origin/main`.

### 12.2 Gaps

| # | Gap | Impact | Fix | Pri | Effort |
|---|---|---|---|---|---|
| 12.1 | Deploy is manual from the VM (`./deploy/redeploy.sh` over SSH) | Human-dependent, no audit trail of who deployed what | GitHub Actions deploy job (environment with required approval) that SSHes or uses a self-hosted runner to run `redeploy.sh` for the image SHA; records the SHA in a deploy log | P1 | M |
| 12.2 | No staging environment | Every change is first exercised in production | A small staging VM / Container Apps env with test PSP keys, seeded data; deploy there on merge, promote by SHA | P1 | M |
| 12.3 | No API integration tests against a running stack | Route wiring, migrations and RLS together are only tested in the isolation suite | CI job: `compose up` a lite stack (Postgres, Redis, Temporal dev server, stub LLM), run migrations, run a Jest/Vitest suite hitting HTTP routes with real cookies (login, Ask AI simple turn with stub model, approve flow, webhook with valid signature, DSR export) | P1 | L |
| 12.4 | No browser tests | Frontend regressions (separate repo) found by hand | Playwright smoke on NEW-FRONTEND: sign-in, chat send, approvals, connectors page, settings | P1 | M |
| 12.5 | No load tests | §9.4 | k6 in a scheduled workflow against staging | P1 | M |
| 12.6 | No container image scanning | CVEs in base images unknown | Trivy (or Grype) step in `images.yml`, fail on critical with an allowlist | P1 | S |
| 12.7 | No SAST / secret scan | file 11 §8.9 | CodeQL for JS/TS; gitleaks | P1 | S |
| 12.8 | Frontend repo CI | NEW-FRONTEND is a separate repo with its own Vitest; build is done on the VM | Build the frontend image on GitHub too (it is still built on the box per `deploy/SERVER.md`) | P1 | S |
| 12.9 | `mcp-bridge` image built on the VM (`FROM darex-dashboard:local`) | Slow, not reproducible | Build in `images.yml` from the dashboard image tag | P2 | S |
| 12.10 | Branch protection / required checks not evidenced | Broken code can reach `main`; AGENTS.md permits direct commits to `main` | Protect `main`, require CI + one review | P1 | S |
| 12.11 | Coverage not measured | Unknown blind spots | Jest coverage report; ratchet on touched files | P2 | S |
| 12.12 | Migration safety | Destructive DDL could ship | Lint migrations (§6.2.9); run every migration twice in CI to prove idempotency | P2 | S |
| 12.13 | Workflow replay tests | Non-determinism after deploy (§11.2.9) | Temporal `Worker.runReplayHistories` with saved histories | P1 | M |
| 12.14 | Prompt-injection and behaviour evals not in CI | Regressions in agent safety | `infra/evals` + `run-evals.sh` nightly with a cheap model; gate on a red-team subset (file 11 §10.2.7) | P1 | M |
| 12.15 | RBAC route coverage not in CI | New routes ship unguarded (file 11 §4) | Route policy test | P0 | S |
| 12.16 | Live-verification debt | Many BUILD_STATE entries say "Not verified: live" (migrations 202, 203, 209; inbound usage gate; Gmail/Outlook/Slack/IG live calls; Langfuse ingest; email verification) | A tracked checklist executed on staging after each deploy, with results recorded | P1 | M |
| 12.17 | Rollback covers images, not data | §8.5 | Pre-migration table dumps | P1 | S |
| 12.18 | Port and sync guards tested in CI, but not the full `deploy.sh` on a clean VM | First-install regressions | Periodic job that provisions a throwaway VM and runs `deploy.sh` end to end | P2 | M |

---

## 13. Consolidated backlog

| # | Item | Area | Pri | Effort | Section |
|---|---|---|---|---|---|
| R-01 | Encrypted off-box nightly dumps + alert on missing backup | infra | P0 | S | 8.4.1 |
| R-02 | WAL archiving / PITR | infra | P0 | M | 8.4.2 |
| R-03 | Regular (non-Spot) dedicated VM with data disk; Darex off the shared box | infra | P0 | M | 7.3 |
| R-04 | External uptime monitor + public minimal readiness endpoint | infra | P0 | S | 2.2.1, 4 |
| R-05 | Scheduled platform alert workflow + pager destination; Azure eviction/disk alerts | infra | P0 | S | 4 |
| R-06 | Auto-restart after Spot eviction (until R-03 lands) | infra | P0 | S | 7.3 |
| R-07 | Error tracking in dashboard, worker, bridge, frontend | infra | P1 | S | 3.4 |
| R-08 | OTel metrics + Grafana dashboards (HTTP, DB pool, LLM, tools, approvals, SSE, webhooks, Temporal) | infra | P1 | M | 3.1 |
| R-09 | Structured logs with request id; central log store | infra | P1 | M | 3.2 |
| R-10 | Postgres memory/tuning, `pg_stat_statements`, timeouts on pool and role | infra | P1 | S | 6.2 |
| R-11 | Session-context caching / single auth SQL function | dashboard | P1 | M | 6.2.3 |
| R-12 | Readiness covers Nango, bridge, TrueForge, Cognee, Hindsight, Langfuse, worker heartbeat | dashboard | P1 | M | 2.2.2 |
| R-13 | Dashboard container healthcheck + autoheal | infra | P1 | S | 2.2.4 |
| R-14 | Deploy gate on readiness + synthetic call | infra | P1 | S | 2.2.5 |
| R-15 | Synthetic transaction probe (cheap model) | infra | P1 | M | 2.2.6 |
| R-16 | Temporal production setup (Cloud or proper cluster), retention, metrics | workflows | P1 | M | 11.2 |
| R-17 | Split task queues; explicit worker concurrency; two workers | workflows | P1 | M | 11.2.3–4 |
| R-18 | Workflow versioning discipline + replay tests | workflows | P1 | M | 11.2.9 |
| R-19 | Two dashboard replicas; Redis-backed limits; SSE via Redis Streams | dashboard | P1 | M | 5, 9.3 |
| R-20 | Per-org SSE polling fan-out | dashboard | P1 | S | 5.3 |
| R-21 | Webhook ingest split from Next.js | webhooks | P1 | M | 9.2 |
| R-22 | Langfuse off the app box; retention; DSR | infra | P1 | S | 3.3 |
| R-23 | Managed Postgres + managed Redis (option B) | infra | P1 | L | 7.3 |
| R-24 | Load test harness + baseline | ci | P1 | M | 9.4 |
| R-25 | Cost rollup per org, margin view, plan-derived ceilings | billing | P1 | M | 10.4 |
| R-26 | DR runbook + monthly restore test | infra | P1 | S | 8.4 |
| R-27 | Secrets and local-only images in Key Vault / registry | infra | P1 | S | 8.4 |
| R-28 | Pre-migration table dumps | infra | P1 | S | 8.5 |
| R-29 | CI: integration tests, Playwright, image scan, CodeQL, gitleaks, deploy job, staging, branch protection | ci | P1 | L | 12.2 |
| R-30 | LiteLLM redundancy; shared circuit breaker | ask-ai | P1 | S | 11.3 |
| R-31 | Spot Scheduled Events drain handler | infra | P1 | S | 7.3 |
| R-32 | Permanent proxy network attach or own proxy | infra | P1 | S | 7.3 |
| R-33 | Sweep batching and idle-org skipping | workflows | P2 now / P1 at 1k | M | 9.3, 10.2 |
| R-34 | Partition high-growth tables; retention jobs | infra | P2 now / P1 at 1k | L | 6.2.7 |
| R-35 | PgBouncer transaction mode with `SET LOCAL` | rls | P2 now / P1 at 1k | M | 6.2.4 |
| R-36 | Separate Redis for Nango vs SSE; maxmemory policy | infra | P2 | S | 5.4 |
| R-37 | Liveness endpoint detail behind diagnostics | dashboard | P2 | S | 2.2.3 |
| R-38 | Activity timeout/retry review table | workflows | P2 | M | 11.2.7 |
| R-39 | Direct-execution fallback durability | workflows | P2 | M | 11.2.8 |
| R-40 | Coverage reporting, migration lint and idempotency test | ci | P2 | S | 12.2 |

### Suggested sequencing

- **This week:** R-01, R-04, R-05, R-06, R-10, R-13 (all S). Start R-03.
- **Next two weeks:** R-02, R-03, R-07, R-09, R-14, R-16 (decision), R-17,
  R-22, R-26, R-27, R-28.
- **Before the first paying customer:** R-08, R-12, R-15, R-23, R-29 (at
  least staging, image scan, branch protection, deploy job), R-24 baseline,
  R-25.
- **Toward 1,000 orgs:** R-19, R-21, R-33–R-35, Stage 2 of §9.3.

---

## 14. How to re-verify

```bash
# Backups: expect a scheduled job and recent objects in Blob
crontab -l; systemctl list-timers | grep -i backup
az storage blob list --container-name darex-backups --account-name <acct> -o table | tail

# Readiness from outside (expect 200 with {status} only after R-04)
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/health/ready

# Memory budget vs host
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | sort -k2 -h
free -h; df -h /; nproc --all

# Postgres settings
docker exec darex-postgres psql -U darex -c "show shared_buffers; show max_connections; show statement_timeout;"
docker exec darex-postgres psql -U darex -c "select usename, count(*) from pg_stat_activity group by 1 order by 2 desc;"

# Temporal namespace retention and task queue backlog
docker exec darex-temporal temporal operator namespace describe default
docker exec darex-temporal temporal task-queue describe --task-queue darex-agent-tasks

# Spot eviction history
az monitor activity-log list --resource-group Darexai --offset 30d \
  --query "[?contains(operationName.value,'deallocate')].{t:eventTimestamp,op:operationName.value}" -o table
```

Facts in this document that were not confirmed on the VM and should be
checked first: OS disk size after resize, `nproc`, whether Azure Backup or
disk snapshots exist, NSG rules, Nango encryption key, Temporal namespace
retention, Caddy buffering for SSE, and how the proxy chain handles
`X-Forwarded-For`.
