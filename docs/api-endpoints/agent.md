# Agent runtime

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 7 handlers across 6 paths.

## Paths

- `POST` `/api/agent/crew`
- `GET` `/api/agent/explain`
- `POST` `/api/agent/pending-actions`
- `POST` `/api/agent/run`
- `POST` `/api/agent/stream`
- `GET, POST` `/api/agent/tools`

## Endpoints

### POST `/api/agent/crew`

POST /api/agent/crew.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `userMessage`
- `conversationId`
- `channelId`

**JSON responses.**

- **400** keys: `error`
- **499** keys: `error`
- **502** keys: `error`, `detail`
- **200** keys: `success`, `mode`, `reason`, `replyMessage`, `spawned`, `usedTools`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted in the body
- userMessage is required
- No AI employees in this org. Hire one first.
- No active AI employees available for crew.
- Client aborted
- Crew workflow failed
- Internal Server Error

**Source.** `apps/dashboard/app/api/agent/crew/route.ts`

### GET `/api/agent/explain`

GET /api/agent/explain.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `q`
- `query`
- `objectId`
- `action_id`
- `actionType`

**JSON responses.**

- **200** keys: `query`, `objectId`, `actionType`, `source`, `decisions`, `matches`, `remedy`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/agent/explain/route.ts`

### POST `/api/agent/pending-actions`

Resolve a parked autonomy action. Timeout never approves — the caller must send an explicit decision. The raw token is hashed; only the hash is stored.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `pendingActionId`
- `token`
- `decision`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **403** keys: `error`
- **409** keys: `error`
- **200** keys: `ok`, `actionType`, `decidedBy`
- **500** keys: `error`

**Error strings in this handler.**
- pendingActionId and token are required
- decision must be approved or rejected
- pending action not found
- invalid token
- expired
- Internal Server Error

**Source.** `apps/dashboard/app/api/agent/pending-actions/route.ts`

### POST `/api/agent/run`

POST /api/agent/run.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `conversationId`
- `userMessage`
- `employeeId`
- `channelId`

**JSON responses.**

- **400** keys: `error`
- **502** keys: `error`, `detail`
- **200** keys: `success`, `replyMessage`, `executedSteps`, `usedTools`
- **500** keys: `error`

**Error strings in this handler.**
- userMessage is required
- Agent workflow failed
- Internal Server Error

**Source.** `apps/dashboard/app/api/agent/run/route.ts`

### POST `/api/agent/stream`

POST /api/agent/stream.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `userMessage`
- `conversationId`
- `employeeId`
- `channelId`

**Response content type.** `text/event-stream`

**JSON responses.**

- **400** keys: `error`
- **502** keys: `error`, `detail`
- **500** keys: `error`

**Error strings in this handler.**
- userMessage is required
- Agent workflow failed
- Stream timed out waiting for workflow
- Internal Server Error

**Source.** `apps/dashboard/app/api/agent/stream/route.ts`

### GET `/api/agent/tools`

GET /api/agent/tools.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `tools`, `totalCount`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/agent/tools/route.ts`

### POST `/api/agent/tools`

POST /api/agent/tools.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canCallPayTools()`.

**JSON body fields the handler reads.**

- `tool`
- `action`
- `payload`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **200** keys: `success`, `error`, `undefined`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- Tool parameter is required
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/agent/tools/route.ts`
