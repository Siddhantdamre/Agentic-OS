# Realtime stream

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 4 handlers across 3 paths.

## Paths

- `GET` `/api/stream/events`
- `POST` `/api/stream/presence`
- `POST, DELETE` `/api/stream/push-subscribe`

## Endpoints

### GET `/api/stream/events`

Server-Sent Events stream for per-org real-time inbox notifications. Authenticates via the darex_session cookie, resolves the org_id, then pushes events as Redis publishes them on `org:{id}`. Org is never taken from the query string or body — only the session. Applies ReadableStream backpressure (desiredSize) and Last-Event-ID ring replay.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Response content type.** `text/event-stream`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Error strings in this handler.**
- Realtime bus unavailable
- Realtime stream connected

**Source.** `apps/dashboard/app/api/stream/events/route.ts`

### POST `/api/stream/presence`

Heartbeat from an authenticated operator viewing/typing in a conversation. Only real session users are recorded — no invented presence. Org and user come from the session, never the body.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `conversationId`
- `conversation_id`
- `action`
- `userName`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `viewers`
- **503** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- org_id must not be supplied in body
- conversationId is required
- action must be viewing, typing, or left
- Conversation not found
- Presence table missing — apply migration 103
- Internal Server Error

**Source.** `apps/dashboard/app/api/stream/presence/route.ts`

### DELETE `/api/stream/push-subscribe`

DELETE /api/stream/push-subscribe.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `endpoint`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `ok`
- **500** keys: `error`

**Error strings in this handler.**
- endpoint is required
- Internal Server Error

**Source.** `apps/dashboard/app/api/stream/push-subscribe/route.ts`

### POST `/api/stream/push-subscribe`

Store a Web Push subscription for the session user/org. Delivery only runs when VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are set (see lib/web-push-notify.ts) — no fake notifications are invented.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Headers the handler reads.**
- `user-agent`

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `endpoint`
- `p256dh`
- `auth`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `ok`, `message`
- **503** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- org_id must not be supplied in body
- endpoint must be an https URL
- keys.p256dh and keys.auth are required
- Push table missing — apply migration 103
- Internal Server Error

**Source.** `apps/dashboard/app/api/stream/push-subscribe/route.ts`
