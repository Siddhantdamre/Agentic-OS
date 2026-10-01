# Employees

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 11 handlers across 6 paths.

## Paths

- `GET, POST, PATCH` `/api/employees`
- `GET, PATCH, DELETE` `/api/employees/:id`
- `GET` `/api/employees/:id/activity`
- `GET` `/api/employees/customer`
- `GET, PATCH` `/api/employees/customer/open-loops`
- `GET` `/api/employees/stats`

## Endpoints

### GET `/api/employees`

GET /api/employees.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `employees`, `connectedChannels`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/route.ts`

### PATCH `/api/employees`

PATCH /api/employees.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canDisableEmployee()`.

**JSON body fields the handler reads.**

- `id`
- `name`
- `status`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `employee`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Invalid JSON body
- id or name, and status, are required
- Employee not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/route.ts`

### POST `/api/employees`

POST /api/employees.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canDisableEmployee()`.

**JSON body fields the handler reads.**

- `name`
- `role`
- `persona`
- `tool_allowlist`
- `status`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **201** keys: empty object or spread
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Invalid JSON body
- Name and role are required
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/route.ts`

### DELETE `/api/employees/:id`

DELETE /api/employees/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canDisableEmployee()`.

**Path params.** `id`

**Query.**
- `reassignTo`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **409** keys: `error`, `activeTaskCount`
- **404** keys: `error`
- **200** keys: `success`, `archived`, `reassignedTasks`, `reassignTo`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid employee id
- Forbidden
- Invalid reassignTo id
- reassignTo employee not found
- Employee not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/[id]/route.ts`

### GET `/api/employees/:id`

GET /api/employees/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `employee`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid employee id
- Employee not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/[id]/route.ts`

### PATCH `/api/employees/:id`

PATCH /api/employees/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canDisableEmployee()`.

**Path params.** `id`

**JSON body fields the handler reads.**

- `name`
- `role`
- `persona`
- `tool_allowlist`
- `status`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `employee`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Invalid JSON body
- No fields to update
- Employee not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/[id]/route.ts`

### GET `/api/employees/:id/activity`

GET /api/employees/:id/activity.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**Query.**
- `limit`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: empty object or spread
- **500** keys: `error`

**Error strings in this handler.**
- Invalid employee id
- Employee not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/[id]/activity/route.ts`

### GET `/api/employees/customer`

GET /api/employees/customer.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `limit`
- `offset`

**JSON responses.**

- **200** keys: `attention`, `cardsLimit`, `cardsOffset`, `cardsHasMore`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/customer/route.ts`

### GET `/api/employees/customer/open-loops`

GET /api/employees/customer/open-loops.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `openLoops`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/customer/open-loops/route.ts`

### PATCH `/api/employees/customer/open-loops`

PATCH /api/employees/customer/open-loops.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `loopId`
- `status`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `success`, `loop`, `operatorStatus`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- loopId and status (fulfilled|cancelled) required
- Open loop not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/customer/open-loops/route.ts`

### GET `/api/employees/stats`

GET /api/employees/stats.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `totalEmployees`, `activeCount`, `avgResolutionSec`, `conversationsHandled`, `conversationsResolved`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/employees/stats/route.ts`
