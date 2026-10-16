# Health and observability

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 5 handlers across 5 paths.

## Paths

- `GET` `/api/health`
- `GET` `/api/health/diagnostics`
- `GET` `/api/health/ready`
- `POST` `/api/observability/alerts/dispatch`
- `GET` `/api/observability/metrics`

## Endpoints

### GET `/api/health`

Liveness probe for compose / load balancers. Does not require a session.

**Auth.** Public. Middleware does not require a session cookie.

**JSON responses.**

- **200** keys: `ok`, `service`

**Source.** `apps/dashboard/app/api/health/route.ts`

### GET `/api/health/diagnostics`

Session required. Does not leak connection strings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canReadAudit()`.

**JSON responses.**

- **403** keys: `error`
- **200** keys: `environment`, `dbPool`, `configured`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/health/diagnostics/route.ts`

### GET `/api/health/ready`

GET /api/health/ready.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/health/ready/route.ts`

### POST `/api/observability/alerts/dispatch`

Session org only — rejects body org_id. Requires canManageOrgSettings. Posts { orgId, alerts } to DAREX_ALERT_WEBHOOK_URL when set.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `dryRun`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- org_id is not accepted from the client; it is resolved from the session.
- Internal Server Error

**Source.** `apps/dashboard/app/api/observability/alerts/dispatch/route.ts`

### GET `/api/observability/metrics`

GET /api/observability/metrics.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `alertCount`, `killSwitch`, `rolloutStage`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/observability/metrics/route.ts`
