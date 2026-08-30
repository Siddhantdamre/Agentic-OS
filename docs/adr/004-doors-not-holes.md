# 4. Tenant isolation is forced RLS with named doors through it

**Status:** Accepted

## Context

`orgs` - the table that defines what a tenant is - had no row-level security at all.
The least-privilege application role could enumerate every customer on the deployment:
name, slug, plan, status.

Several flows legitimately touch `orgs` before any org context exists. Resolving which
org an inbound webhook belongs to is precisely the question being asked, and at signup
the row being written is what establishes the context.

## Decision

`ENABLE` plus `FORCE ROW LEVEL SECURITY` on every tenant table, so the table owner is
bound by the policy too.

Pre-context flows go through named `SECURITY DEFINER` functions that take one argument
and return one id, never a table. The difference between a hole and a door is that a
door is named, granted deliberately, and returns a single row.

## Consequences

Definer functions execute as `darex`, a superuser, which bypasses RLS regardless of
FORCE. That is load-bearing and written down: moving these tables to a non-superuser
owner requires `SET row_security = off` on those functions or the webhook paths go
dark.

Cost: every pre-context flow needs a function written for it, and signup cannot simply
insert a row.

## What breaks if you remove it

The claim becomes "every tenant table is protected except the tenant list", which is
the first thing a prospect's security reviewer checks.

## Evidence

Migration 028. Verified during the ground-up audit against a tenant created five
minutes earlier, not against a fixture.
