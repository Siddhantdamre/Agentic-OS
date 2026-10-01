# Ask AI

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 13 handlers across 7 paths.

## Paths

- `POST, GET` `/api/ask-ai`
- `POST` `/api/ask-ai/approve`
- `GET, POST, PATCH, DELETE` `/api/ask-ai/conversations`
- `GET` `/api/ask-ai/execute`
- `GET, POST` `/api/ask-ai/feedback`
- `GET, PATCH` `/api/ask-ai/plan`
- `POST` `/api/ask-ai/revise`

## Endpoints

### GET `/api/ask-ai`

GET /api/ask-ai.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `conversationId`

**JSON responses.**

- **404** keys: `error`
- **200** keys: `messages`, `plans`
- **500** keys: `error`

**Error strings in this handler.**
- Conversation not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/ask-ai/route.ts`

### POST `/api/ask-ai`

POST /api/ask-ai.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `prompt`
- `conversationId`
- `mode`

**JSON responses.**

- **402** keys: `error`, `message`, `reasons`
- **400** keys: `error`
- **200** keys: `error`
- **200** keys: `type`, `classification`, `provider`, `reasoning`, `summary`, `steps`, `draft`, `employeeName`, `employeeRole`, `routeReason`, `proposedAction`, `error`, `retryable`, `partialReply`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- org_id is not accepted from the request body
- Prompt is required
- Internal Server Error

**Stream.** When the turn runs, the body is `application/x-ndjson`, one JSON object per line. `type` is one of `routing`, `warning`, `chunk`, `tool`, `subagent`, `approval`, `done`, `error`. A complex turn can instead return JSON `{ type: "complex", ...plan }` before any stream.

**Source.** `apps/dashboard/app/api/ask-ai/route.ts`

### POST `/api/ask-ai/approve`

`tool.approval_required`. Body: { sessionId, decisions: [{ threadId, toolCallId, decision: 'allow'|'deny', reason? }] } Streams NDJSON: chunk / tool / approval (chained pauses) / done / error. Tenancy: orgId/userId come ONLY from the session (getScopedClient). The client-supplied sessionId is an opaque TrueForge UUID — tenant headers are

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `sessionId`
- `decisions`
- `conversationId`
- `threadId`
- `toolCallId`
- `decision`
- `reason`

**Response content type.** `application/x-ndjson`

**JSON responses.**

- **400** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- sessionId must be a UUID
- decisions must be a non-empty array (max 10)
- each decision needs threadId, toolCallId, decision
- decision must be 
- Resume failed
- Internal Server Error

**Stream.** May return `application/x-ndjson` with the same `chunk` / `tool` / `subagent` / `approval` / `done` / `error` types as `POST /api/ask-ai`.

**Source.** `apps/dashboard/app/api/ask-ai/approve/route.ts`

### DELETE `/api/ask-ai/conversations`

DELETE /api/ask-ai/conversations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `id`

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `id`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `success`, `deletedId`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- Valid conversation ID is required
- Conversation not found
- Failed to delete conversation

**Source.** `apps/dashboard/app/api/ask-ai/conversations/route.ts`

### GET `/api/ask-ai/conversations`

GET /api/ask-ai/conversations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `conversations`
- **500** keys: `error`

**Error strings in this handler.**
- Failed to fetch conversations

**Source.** `apps/dashboard/app/api/ask-ai/conversations/route.ts`

### PATCH `/api/ask-ai/conversations`

PATCH /api/ask-ai/conversations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `id`
- `summary`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `success`, `conversation`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- Valid id and summary are required
- Conversation not found
- Failed to update conversation

**Source.** `apps/dashboard/app/api/ask-ai/conversations/route.ts`

### POST `/api/ask-ai/conversations`

POST /api/ask-ai/conversations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **200** keys: `success`, `conversation`
- **500** keys: `error`

**Error strings in this handler.**
- Failed to create conversation

**Source.** `apps/dashboard/app/api/ask-ai/conversations/route.ts`

### GET `/api/ask-ai/execute`

SSE stream that executes an APPROVED plan step-by-step through the real tool-execution backend. Emits: event: execution_start  { planId, totalSteps } event: step_start       { stepIndex, description, tool, action } event: step_done        { stepIndex, status, message, data }

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `planId`

**Response content type.** `application/json`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Error strings in this handler.**
- Client disconnected
- Instruction noted — not an executable tool.

**Stream.** `text/event-stream`. Events: `execution_start`, `step_start`, `step_done`, `step_error`, `execution_done`, `execution_error`. Each frame is `event: <name>` then `data: <json>`.

**Source.** `apps/dashboard/app/api/ask-ai/execute/route.ts`

### GET `/api/ask-ai/feedback`

Ask AI learning loop (B4 / A5). - POST vote: thumbs, stored without message bodies. - POST promote: human-named org playbook from a completed/approved plan. Never trusts body org_id. Never trains across tenants.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `votes`, `crossOrgTraining`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/ask-ai/feedback/route.ts`

### POST `/api/ask-ai/feedback`

POST /api/ask-ai/feedback.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `action`

**JSON responses.**

- **400** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- Unsupported action
- Internal Server Error

**Source.** `apps/dashboard/app/api/ask-ai/feedback/route.ts`

### GET `/api/ask-ai/plan`

GET/PATCH /api/ask-ai/plan - GET ?planId=...  -> fetch a persisted plan (restores after refresh) - PATCH { planId, action: 'approve' | 'cancel', steps?: [{id,enabled}] }

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `planId`

**JSON responses.**

- **200** keys: `plans`
- **404** keys: `error`
- **200** keys: `plan`
- **500** keys: `error`

**Error strings in this handler.**
- Plan not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/ask-ai/plan/route.ts`

### PATCH `/api/ask-ai/plan`

PATCH /api/ask-ai/plan.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `planId`
- `action`
- `steps`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **200** keys: `success`, `status`
- **400** keys: `success`, `steps`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- planId is required
- org_id is not accepted from the request body
- Plan not found
- Unsupported action
- Internal Server Error

**Source.** `apps/dashboard/app/api/ask-ai/plan/route.ts`

### POST `/api/ask-ai/revise`

Revise the draft of a plan based on user feedback. Loops back to the planner LLM, increments the draft version, and keeps the plan in `pending` (or `approved` if it was already approved) so execution can proceed after the improved draft is accepted.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `planId`
- `feedback`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **502** keys: `error`
- **200** keys: `success`, `draft`, `status`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- org_id is not accepted from the request body
- planId is required
- feedback is required
- Plan not found
- Draft revision produced empty output
- Internal Server Error

**Source.** `apps/dashboard/app/api/ask-ai/revise/route.ts`
