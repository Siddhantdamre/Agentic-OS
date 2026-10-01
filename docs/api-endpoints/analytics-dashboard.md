# Analytics and dashboard

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 7 handlers across 7 paths.

## Paths

- `GET` `/api/analytics`
- `GET` `/api/analytics/calibration`
- `GET` `/api/analytics/cost`
- `GET` `/api/analytics/cost-health`
- `GET` `/api/analytics/export`
- `GET` `/api/analytics/roi`
- `GET` `/api/dashboard/stats`

## Endpoints

### GET `/api/analytics`

GET /api/analytics.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `range`

**JSON responses.**

- **200** keys: `range`, `rangeKey`, `metrics`, `metricIds`, `metricPoints`, `metricValues`, `gaps`, `source`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/analytics/route.ts`

### GET `/api/analytics/calibration`

GET /api/analytics/calibration.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `windowDays`, `deciles`
- **200** keys: `windowDays`, `deciles`, `tablesReady`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/analytics/calibration/route.ts`

### GET `/api/analytics/cost`

Weekly LLM cost for the session org (Langfuse, not guessed) plus confirm-reject drift from agent_plans. Org id comes from the session via getScopedClient — never from the request body or query string.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: empty object or spread
- **503** keys: `error`, `verified`, `source`, `orgId`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/analytics/cost/route.ts`

### GET `/api/analytics/cost-health`

GET /api/analytics/cost-health.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `windowDays`, `sweepModelCalls`, `sweepShare`, `0`, `idleSweepPasses`, `busySweepPasses`, `costPerObligationCents`, `null`, `escalateOnly`, `maxSpendCentsPerDay`, `healthy`
- **200** keys: `windowDays`, `modelCalls`, `spendCents`, `sweepShare`, `healthy`, `tablesReady`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/analytics/cost-health/route.ts`

### GET `/api/analytics/export`

No secrets; scalars only.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/analytics/export/route.ts`

### GET `/api/analytics/roi`

GET /api/analytics/roi.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: empty object or spread
- **500** keys: `pipeline`, `hoursSaved`, `hoursByRole`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/analytics/roi/route.ts`

### GET `/api/dashboard/stats`

Consolidated CTE + 30s in-process cache per org (no Redis required).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/dashboard/stats/route.ts`
