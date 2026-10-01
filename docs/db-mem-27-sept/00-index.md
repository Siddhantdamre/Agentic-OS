# Database, memory, health, analytics, plans (2026-09-27)

Snapshot of what the running product uses. Written from the code and
migrations on 2026-09-27. The older gap audits in
`docs/new-109-pg-plan/gap26sept/` still describe some of these areas as
broken; where this folder and those audits disagree, this folder follows
the code.

| File | What it covers |
|---|---|
| [database.md](./database.md) | Postgres 16 + pgvector, databases on the one instance, roles, pool, RLS, migrations |
| [health.md](./health.md) | Liveness, readiness, diagnostics, what each probe checks |
| [memory.md](./memory.md) | Four memory tiers, hybrid retrieve, Cognee, Brain UI, write-back |
| [analytics.md](./analytics.md) | `/analytics` routes, the two rate formulas, cost / ROI / calibration |
| [plans.md](./plans.md) | `agent_plans`, Ask AI plan-confirm-execute, `/plans` inbox gaps |
| [suggestions-memory.md](./suggestions-memory.md) | Later work: merge Cognee with SQL, lock the graph to the org, filtered vector recall |
| [suggestions-db-health.md](./suggestions-db-health.md) | Shared pool, role timeouts, probes, how analytics and plans stay on the same database |

Role timeouts, the readiness probe pool, Cognee+SQL merge, and signup
`terms_accepted_at` are in the code as of 2026-09-27. See `BUILD_STATE.md`.
PDF ingest, `memory_edges`, analytics rollups, and `/plans` history are
still later.

App data lives in the `darex` database. Memory, analytics, and plans all
read and write that database through the same `darex_app` pool (`max: 10`)
and the same RLS session setting (`app.current_org_id`).
