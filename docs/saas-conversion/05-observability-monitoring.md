# 05 — Observability and monitoring

"Monitor all users, all info, end to end" means three concrete layers: a per-org product view that already exists, a platform aggregate that is only an audited read of those same signals, and alerts when a threshold trips. It does not mean a second metrics database or a probe that pretends a dependency is healthy.

## Reuse these endpoints

| Endpoint | What it is | Who calls it |
|----------|------------|--------------|
| `GET /api/health` | Process liveness. No database. `apps/dashboard/app/api/health/route.ts:6-13`. | Load balancer, console header. |
| `GET /api/health/ready` | Readiness. Postgres and pool pressure fail the probe (503). Redis, Temporal, LiteLLM, Cognee, and MCP bridge fail as `degraded` when configured and down; unset is `not_configured` and does not fail the probe. 5 second cache. | Same header. Do not fork a platform-only ready route. |
| `GET /api/health/diagnostics` | Session required, `canReadAudit` (`diagnostics/route.ts:8-18`). Pool stats and configured flags. No DSNs. | The org's owner, admin, or auditor. The platform drill-in does not widen this handler. It calls the ready payload plus audited SQL. |
| `GET /api/audit-logs` | Cursor page of `audit_events`, redacted (`audit-logs/route.ts:7-20`). | Org audit page. Platform drill-in uses the same redaction helper on an audited query. |
| `GET /api/observability/metrics` | Per-org employee metrics. Snapshot-first via `getOrComputeDailyMetrics` / `loadFreshDailyMetricsSnapshot` (fresh under-24h row → no recompute write). | Org observability page. |
| Langfuse | Traces and cost. `org-cost.ts:1-4` throws rather than inventing `$0`. | Billing meters and the platform cost column. |

`BUILD_STATE.md` (2026-09-27) and `ready/route.ts` probe Cognee (`COGNEE_URL`) and the MCP bridge (`MCP_BRIDGE_URL`). Unset stays `not_configured`. The console consumes the same ready JSON.

Org autonomy kill switch and rollout stage already ride along on the metrics payload (`killSwitch`, `rolloutStage` at `metrics/route.ts`). The platform drill-in shows them. Flipping them is the confirmation-gated control in [03](03-superadmin-console.md), not a metrics write.

## Per-org dashboard (product, keep)

The org observability page stays on `GET /api/observability/metrics` under `getScopedClient`. Signals already computed there (approval fatigue, grounding rejection, open discrepancies, autonomous share, suppression) stay the employee-activity view. Empty tables return `unknown` / "No data", which `gap26sept/observability.md` row 1 already closed. Do not put a zero back.

Cost for the org is the Langfuse total from `org-cost.ts`, surfaced on billing today. Error rate for the org is failed tool results and `failed_webhooks` rows with that `org_id`, divided by attempts in the same window. When the denominator is zero, the rate is `unknown`.

Two former open rows in `gap26sept/observability.md` that this folder also tracked:

- Row 2 (alert dispatcher): code path is `lib/alert-dispatch.ts` + `POST /api/observability/alerts/dispatch`. Posts to `DAREX_ALERT_WEBHOOK_URL`. Unset returns `not_configured` (honest empty channel). Env must be set in each environment for live delivery.
- Row 5 (metrics GET write-stampede): `getOrComputeDailyMetrics` reads a fresh (under 24h) `org_employee_metrics_daily` snapshot first; computes + persists only on miss/stale. Platform aggregates must still read snapshots, not loop the org GET.

## Platform aggregate (new, audited)

`GET /api/platform/observability` runs on the `darex_platform` pool after `platform_begin` (`platform.observability.read`).

It returns:

- Ready payload from the same function `GET /api/health/ready` uses (call the checker, do not HTTP-loop through the public route from inside the process if that re-enters middleware).
- Counts of orgs by `orgs.status`.
- Count of subscriptions in `past_due` or with `dunning_grace_ends_at` set.
- Sum of meter quantities for the open period, by `meter_kind`. A missing Langfuse config is `llm_cost: unknown`, not 0.
- Orgs whose latest daily snapshot has `status = 'alert'`, listed with org id, name, and metric name.
- `failed_webhooks` counts grouped by `org_id` (NULL grouped as `unresolved`).

No row in this payload includes webhook bodies, session cookies, or connector tokens. Drill-in is a separate audited read.

## Logged versus derived

| Stored as it happens | Derived on read |
|----------------------|-----------------|
| `audit_events` (org actions, append-only after `106`) | Seat usage = `COUNT(users)` vs `billing_subscriptions.seats` |
| `admin_audit_log` (platform reads and writes) | Error rate = failures / attempts in the window |
| `billing_audit_log`, `billing_meters`, invoices | Dunning "days left" from `dunning_grace_ends_at` |
| `org_employee_metrics_daily` snapshots | Platform totals summed from those snapshots and meter rows |
| `failed_webhooks` rows | Unresolved backlog = `org_id IS NULL` or `status = unresolved` |
| Langfuse traces (external) | Dollar cost, fetched, never cached as a fake zero |
| Ready check samples (5 second cache, not a history table) | Uptime charts are out of scope until a check history table exists. The console shows the latest sample. |

Do not log raw `failed_webhooks.raw_payload` into `admin_audit_log`. The audit row stores the action, org id, and row id. An operator opens one payload from drill-in, which writes `platform.webhook.read` for that id.

## Alert thresholds

These are the conditions the dispatcher (`lib/alert-dispatch.ts`) can POST when `DAREX_ALERT_WEBHOOK_URL` is set. Unset stays `not_configured` — an honest empty channel, not a delivered notification.

| Condition | Level | Where it is visible now |
|-----------|-------|-------------------------|
| Ready status `unhealthy` (Postgres or pool) | page | `/api/health/ready` returns 503 |
| Ready status `degraded` | page | 200 with `degraded` |
| Any org `orgs.status = suspended` and `suspended_by = dunning` | page | After migration 116 writes status |
| Meter `overHard` for `llm_tokens` or `whatsapp_conversations` | page | `assertUsageAllowed` already blocks the org |
| Daily snapshot metric `status = alert` | page + optional webhook | Existing per-org metrics; dispatch route posts alert subset |
| `failed_webhooks` unresolved older than 1 hour | page | Count on the platform aggregate |
| Impersonation session past `expires_at` and `ended_at` null | page | Sweeper sets `ended_at` and increments `session_epoch` |

Outbound delivery requires `DAREX_ALERT_WEBHOOK_URL`. The code path is 🟢; live Slack/webhook delivery is env-gated.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Liveness probe | — | `app/api/health/route.ts:6-13` | 🟢 Done | No DB. Reuse. |
| 2 | Readiness probe | — | `app/api/health/ready/route.ts` | 🟢 Done | Postgres required. Redis, Temporal, LiteLLM, Cognee, MCP degrade when configured+down. 5s cache. |
| 3 | Org diagnostics | — | `app/api/health/diagnostics/route.ts:8-18` | 🟢 Done | Session + `canReadAudit`. No secrets. |
| 4 | Per-org metrics, unknown instead of fake 0 | — | `gap26sept/observability.md` row 1 | 🟢 Done | Leave the employee query. |
| 5 | Langfuse cost fails closed | — | `apps/dashboard/lib/org-cost.ts:1-4` | 🟢 Done | Throw, do not invent `$0`. |
| 6 | Metrics GET writes on every read | P1 | `employee-metrics-query.ts` `loadFreshDailyMetricsSnapshot` / `getOrComputeDailyMetrics`; `observability/metrics/route.ts` | 🟢 Done | Fresh under-24h snapshot returned without recompute; miss/stale computes once and persists. |
| 7 | Alert dispatcher | P1 | `lib/alert-dispatch.ts`; `api/observability/alerts/dispatch/route.ts` | 🟢 Done | Code path posts alert metrics to `DAREX_ALERT_WEBHOOK_URL`. Unset → `not_configured`. |
| 8 | `GET /api/platform/observability` | P1 | `api/platform/observability/route.ts` | 🟢 Done | Audited wrapper; thin platform-pool ready + snapshot aggregate. Depends on 119 applied. |
| 9 | Cognee and MCP on the ready payload | P2 | `ready/route.ts` `checkCognee` / `checkMcpBridge` | 🟢 Done | Cognee + MCP bridge probes wired; unset = `not_configured`. |
