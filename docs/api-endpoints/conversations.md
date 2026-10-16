# Conversations

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 5 handlers across 3 paths.

## Paths

- `GET, POST` `/api/conversations`
- `PATCH` `/api/conversations/:id`
- `GET, POST` `/api/conversations/:id/messages`

## Endpoints

### GET `/api/conversations`

GET /api/conversations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `channel`
- `status`
- `search`
- `limit`
- `cursor`

**JSON responses.**

- **200** keys: empty object or spread
- **500** keys: `error`

**Source.** `apps/dashboard/app/api/conversations/route.ts`

### POST `/api/conversations`

POST /api/conversations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `contactId`
- `channelType`
- `employeeId`
- `initialMessage`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `success`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body

**Source.** `apps/dashboard/app/api/conversations/route.ts`

### PATCH `/api/conversations/:id`

PATCH /api/conversations/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `status`
- `employee_id`
- `assigned_user_id`
- `assignedUserId`
- `pauseAi`
- `ai_paused`
- `aiPaused`
- `durationHours`
- `duration_hours`
- `clearUnread`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `success`, `conversation`, `pausedBy`, `userId`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- Invalid status
- Conversation not found

**Source.** `apps/dashboard/app/api/conversations/[id]/route.ts`

### GET `/api/conversations/:id/messages`

GET /api/conversations/:id/messages.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON responses.**

- **404** keys: `error`
- **200** keys: `conversation`
- **500** keys: `error`

**Error strings in this handler.**
- Conversation not found

**Source.** `apps/dashboard/app/api/conversations/[id]/messages/route.ts`

### POST `/api/conversations/:id/messages`

POST /api/conversations/:id/messages.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `content`
- `role`
- `isInternal`
- `is_internal`
- `attachments`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **502** keys: `error`, `detail`, `message`, `userMessage`
- **502** keys: `error`, `detail`, `userMessage`
- **200** keys: `success`, `userMessage`, `aiResponse`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- Invalid role. Must be user, customer, human_agent, or assistant
- Message content is required
- Conversation not found
- Failed to deliver to channel
- send failed
- Channel delivery failed

**Source.** `apps/dashboard/app/api/conversations/[id]/messages/route.ts`
