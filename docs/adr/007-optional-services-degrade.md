# 7. An auxiliary service may remove a capability, never the product

**Status:** Accepted

## Context

A rollback failed because the worker hard-depended on an unhealthy integrations
service. A component nobody was using could prevent recovery.

## Decision

Hard dependencies (`service_healthy`) are reserved for what the product genuinely
cannot function without: the database and the workflow engine. Everything else is
`service_started` or nothing.

Tracing, integrations and the code sandbox are dashed lines on every diagram in this
repo: their failure removes that one capability and nothing else.

## Consequences

Startup ordering is weaker, so services must tolerate a dependency that is not ready
yet.

Cost: each optional integration needs its own timeout and fallback rather than
inheriting one from compose.

## What breaks if you remove it

One failing auxiliary container takes the product down, and takes the rollback with it.

## Evidence

`lint-startup-coupling.js` - 23 hard dependencies, all justified, 6 ordered without
coupling. Proven by completing a rollback with the integrations service stopped.
