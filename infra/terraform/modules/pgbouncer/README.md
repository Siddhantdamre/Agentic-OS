# PgBouncer (I4)

Local compose runs **session-mode** PgBouncer as `darex-pgbouncer`
(host port 6432). Dashboard, worker, and atomic-bridge connect as
`darex_app` through it. App pool `max: 10` is unchanged. Temporal / Nango /
Langfuse / SuperTokens / LiteLLM and `pnpm db:migrate` still talk to
Postgres directly.

Session pooling is required so `SET app.current_org_id` (RLS) holds.
Do not switch to transaction pooling without changing `lib/db.ts`.

This module does **not** put secrets in git. When AWS apply is real, put
ECS/EC2 PgBouncer or RDS Proxy in front of RDS and pass passwords via
uncommitted `terraform.tfvars`. Do not replace Postgres.
