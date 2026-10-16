# 22. SQL a model wrote runs as a role that cannot read secrets or leave its tenant

**Status:** Accepted

## Context

`database_query` executes SQL written by a model that has read inbound customer
messages. It is an always-allowed core tool with risk `read`, so no confirmation gate
stands in front of it. Every prompt-injection defence that lives in the prompt is
therefore not a defence here: the input is attacker-influenced text and the output is
a database session.

Measured on unmodified `main`, through the compiled tool, as the application role,
acting as one tenant, with fake data:

- a data-modifying CTE deleted that tenant's rows;
- `set_config('app.current_org_id', …)` re-pointed row-level security and returned
  another tenant's messages, because RLS keys off a setting any role may set;
- SECURITY DEFINER helpers returned another tenant's `password_hash`; a mutation fuzz
  of 4,500 statements invoked them **67 times** across three batches (function-batch
  hits; 54 such functions exist), including `auth_update_password_hash`,
  `auth_link_supertokens_id` and `erase_data_subject`;
- `SELECT * FROM outcome_lift` returned every tenant's rows, because a view owned by a
  superuser reads its base tables with the owner's rights;
- `SELECT meta FROM channels`, `SELECT meta->>'webhook_secret' FROM orgs` and
  `SELECT email, password_hash FROM users` returned the caller's OWN WhatsApp token,
  webhook secret and staff hashes — RLS is not the wall for a tenant's own rows;
- one workspace's runaway queries starved every other tenant's SQL tool.

## Decision

Three layers, each proven to hold WITHOUT the one before it:

1. **A lexical guard** (`sql-guard.ts`): a tokeniser, not a regex, that fails closed.
   Defence in depth; explicitly not a proof.
2. **A READ ONLY transaction with a statement timeout**, always rolled back, result
   bounded inside Postgres.
3. **A dedicated role** (`darex_sql_reader`, migration 048), entered with
   `SET LOCAL ROLE` for the life of one transaction. It is granted every tenant column
   except an explicit list of credentials, holds no write privilege, and has no
   `EXECUTE` on `set_config` or on any SECURITY DEFINER function. Column privileges
   apply to every reference, so `WHERE password_hash LIKE …` is refused as surely as
   selecting it. A new table is invisible to model SQL until a migration grants it.

Around them: every view is `security_invoker` (047), the app role cannot `CREATE` in
`public`, SECURITY DEFINER functions pin `search_path`, and a per-workspace concurrency
cap keeps one tenant from occupying the shared pool.

## Consequences

`SELECT *` on `users`, `orgs` and `channels` is refused, loudly, with a message telling
the model to name columns. A workspace with more than three SQL calls in flight gets a
retryable "busy". If migration 048 is not applied the tool refuses rather than running
as the full application role. Cost per query: +0.2–0.3 ms at p50.

## What breaks if you remove it

Remove layer 3 and `set_config` re-points RLS again, and a prompt-injected message can
turn a tenant's own credentials into a reply. Remove the view rule and the next
superuser-owned view is a cross-tenant read that no lexical guard can see, because a
view's name is indistinguishable from a table's.

## Evidence

`check-database-query.js` (40 assertions) reads rows back rather than trusting the
tool's report, and fails on every attack when run against the original `database.ts`.
`check-rls-coverage.js` (13) audits the catalog for the rule rather than the instance
and fails 9 assertions on the pre-047/048 schema. A 24,000-statement mutation fuzz with a
leak / mutation / function-call oracle found 0 leaks, 0 table or catalog changes and 0
SECURITY DEFINER calls on the fixed system, and lit up on every axis against the
original code as a control. 1,500 concurrent requests over the ten-connection pool had
0 wrong-tenant results and 0 pooled connections carrying leftover state. With the
concurrency cap, an innocent workspace's p95 latency under another's flood was 4 ms;
without it, 10,388 ms.

## What this does not claim

It has not been reviewed by an outside security team. The guard is a denylist. The
fuzz proves that this mutation set found nothing, not that nothing exists. The live
stack (Temporal, Nango OAuth, real providers, a real model) was not available to test
against, so behaviour under a real prompt-injection attempt from a real model is
unmeasured.
