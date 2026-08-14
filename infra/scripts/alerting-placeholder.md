# Alerting (I6)

Probes live next to this file. They **fail closed**: if a dependency is down
or logs cannot be read, the probe exits 1. They never invent a green result.

```bash
node infra/scripts/alerting-run.js
node infra/scripts/alerting-queue-lag.js
node infra/scripts/alerting-connector-401s.js
node infra/scripts/alerting-connector-401s.js --require-401   # drill: must see a 401 log line
node infra/scripts/alerting-rls-job.js
node infra/scripts/alerting-langfuse-ingest.js
```

| Signal | Script | Honest behaviour |
|--------|--------|------------------|
| Queue lag | `alerting-queue-lag.js` | FAIL if Temporal/Redis unreachable or running workflows > `QUEUE_LAG_MAX` (default 50) |
| Connector 401s | `alerting-connector-401s.js` | FAIL if logs unreadable; `--require-401` FAIL if no 401/`notConnected` line |
| RLS job | `alerting-rls-job.js` | FAIL if not `darex_app` or org A can see org B |
| Langfuse ingest | `alerting-langfuse-ingest.js` | FAIL if health/ClickHouse/`langfuse-redis` is down. Does not use the SSE Redis. |
| Phase 6 memory | `check-phase6-memory.js` | Separate probe when M6 tables exist |

PagerDuty/Opsgenie is not wired. Redis pub/sub SSE (I3) is not owned here.
Phase 0 stays in `check-phase0.js` (PgBouncer check is additive only).
