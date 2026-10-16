# Brief, decisions, and work items

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 12 handlers across 9 paths.

## Paths

- `GET` `/api/brief`
- `POST` `/api/brief/:id/triage`
- `GET, PATCH` `/api/decisions`
- `POST` `/api/decisions/sweep`
- `GET, POST` `/api/work-items`
- `GET, PATCH` `/api/work-items/:id`
- `POST` `/api/work-items/:id/decision`
- `POST` `/api/work-items/playbook`
- `POST` `/api/work-items/sweep-sla`

## Endpoints

### GET `/api/brief`

GET /api/brief.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `limit`
- `offset`
- `tz`

**JSON responses.**

- **200** keys: `timezone`
- **500** keys: `exceptions`, `handledOvernight`, `totalOpen`, `truncated`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/brief/route.ts`

### POST `/api/brief/:id/triage`

Session org only. Does not execute tools (no tool-executor) — status + audit only.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `action`
- `note`
- `snoozeDuration`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `ok`, `itemId`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid id
- org_id is not accepted from the request body
- action must be approve, snooze, or dismiss
- Work item not found or not actionable
- Internal Server Error

**Source.** `apps/dashboard/app/api/brief/[id]/triage/route.ts`

### GET `/api/decisions`

GET /api/decisions.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `history`
- `status`

**JSON responses.**

- **200** keys: `decisions`
- **500** keys: `orgId`, `decisions`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/decisions/route.ts`

### PATCH `/api/decisions`

PATCH /api/decisions.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `id`
- `status`
- `modifiedPayload`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **200** keys: `id`, `status`
- **200** keys: `id`, `status`, `awaitingApprovals`, `approvals`
- **500** keys: `success`, `status`, `error`
- **200** keys: `success`, `id`, `status`, `result`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the client; it is resolved from the session.
- Valid id required
- status (approved|rejected) required
- Forbidden
- Decision not found
- Decision already resolved
- Only workspace owners and admins can approve refunds.
- Decision not found or already resolved
- You already approved this decision
- Decision expired — expiry never approves
- Parked payload missing tool name
- Internal Server Error

**Source.** `apps/dashboard/app/api/decisions/route.ts`

### POST `/api/decisions/sweep`

POST /api/decisions/sweep.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **403** keys: `error`
- **200** keys: `expiredCount`, `expiredIds`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/decisions/sweep/route.ts`

### GET `/api/work-items`

GET /api/work-items.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `type`
- `priority`
- `assignee`
- `status`
- `assigneeUserId`
- `assignee_user_id`

**JSON responses.**

- **200** keys: `workItems`
- **500** keys: `workItems`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/work-items/route.ts`

### POST `/api/work-items`

POST /api/work-items.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `title`
- `summary`
- `type`
- `priority`
- `assigneeEmployeeId`
- `assigneeUserId`
- `dependsOnId`
- `dueAt`
- `slaDueAt`
- `payload`
- `metadata`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **201** keys: `workItem`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- title is required
- Forbidden
- assigneeUserId must be a member of this organization
- dependsOnId must reference a work item in this organization
- Internal Server Error

**Source.** `apps/dashboard/app/api/work-items/route.ts`

### GET `/api/work-items/:id`

GET /api/work-items/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `workItem`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid work item id
- Work item not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/work-items/[id]/route.ts`

### PATCH `/api/work-items/:id`

PATCH /api/work-items/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `status`
- `priority`
- `assigneeEmployeeId`
- `dueAt`
- `payload`
- `metadata`
- `assigneeUserId`
- `dependsOnId`
- `slaDueAt`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **200** keys: `workItem`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid work item id
- org_id is not accepted from the request body
- Forbidden
- Invalid status
- Invalid priority
- assigneeUserId must be a member of this organization
- dependsOnId cannot reference itself
- dependsOnId must reference a work item in this organization
- No valid update fields provided
- Work item not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/work-items/[id]/route.ts`

### POST `/api/work-items/:id/decision`

Org comes from the session. Body org_id is rejected.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `action`
- `decision`
- `reason`
- `optionId`
- `modifiedArgs`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **502** keys: `error`, `status`
- **200** keys: `ok`, `reason`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid work item id
- org_id is not accepted from the request body
- action must be approve, reject, snooze, or modify
- Forbidden: auditors cannot approve or reject live work items
- Work item not found
- Work item was already decided by another operator
- Workflow signal failed; decision was reverted
- Internal Server Error

**Source.** `apps/dashboard/app/api/work-items/[id]/decision/route.ts`

### POST `/api/work-items/playbook`

POST /api/work-items/playbook.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `name`
- `steps`
- `summary`
- `shapeKey`
- `playbookId`
- `planId`
- `workItemId`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `ok`, `playbook`
- **409** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- name must be 3–80 characters
- playbook already exists
- Internal Server Error

**Source.** `apps/dashboard/app/api/work-items/playbook/route.ts`

### POST `/api/work-items/sweep-sla`

POST /api/work-items/sweep-sla.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **403** keys: `error`
- **200** keys: `breachedCount`, `breached`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/work-items/sweep-sla/route.ts`
