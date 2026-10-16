# Public widget and embed

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 15 handlers across 7 paths.

## Paths

- `OPTIONS, POST` `/api/widget/intent`
- `OPTIONS, GET` `/api/widget/listings/search`
- `OPTIONS, GET, POST` `/api/widget/message`
- `OPTIONS, POST` `/api/widget/session`
- `OPTIONS, GET` `/api/widget/stream`
- `OPTIONS, POST, GET` `/api/widget/tools`
- `GET` `/embed/widget.js`

## Endpoints

### OPTIONS `/api/widget/intent`

OPTIONS /api/widget/intent.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/widget/intent/route.ts`

### POST `/api/widget/intent`

Public embed ping. Tenant is the site key — body org_id is ignored.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON body fields the handler reads.**

- `path`
- `href`
- `visitorId`

**JSON responses.**

- **200** keys: `ok`, `isPricing`, `stored`, `missingTable`, `reveal`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/widget/intent/route.ts`

### GET `/api/widget/listings/search`

GET /api/widget/listings/search.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**Query.**
- `q`
- `query`

**JSON responses.**

- **200** keys: `listings`, `count`, `invented`

**Source.** `apps/dashboard/app/api/widget/listings/search/route.ts`

### OPTIONS `/api/widget/listings/search`

OPTIONS /api/widget/listings/search.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/widget/listings/search/route.ts`

### GET `/api/widget/message`

GET /api/widget/message.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**Query.**
- `sessionId`
- `conversationId`
- `after`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `messages`
- **500** keys: `error`

**Error strings in this handler.**
- sessionId is required
- Session not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/widget/message/route.ts`

### OPTIONS `/api/widget/message`

OPTIONS /api/widget/message.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/widget/message/route.ts`

### POST `/api/widget/message`

POST /api/widget/message.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON body fields the handler reads.**

- `sessionId`
- `conversationId`
- `content`
- `visitorToken`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `ok`, `conversationId`, `messageId`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON
- sessionId and content are required
- Session not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/widget/message/route.ts`

### OPTIONS `/api/widget/session`

OPTIONS /api/widget/session.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/widget/session/route.ts`

### POST `/api/widget/session`

POST /api/widget/session.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON body fields the handler reads.**

- `visitorId`

**JSON responses.**

- **200** keys: `sessionId`, `conversationId`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/widget/session/route.ts`

### GET `/api/widget/stream`

Public-safe SSE for a widget session. Requires site key + signed visitor token. Never awaits an agent turn here — only forwards persisted message events.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**Query.**
- `sessionId`

**Headers the handler reads.**
- `origin`

**Response content type.** `application/json`, `text/event-stream`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Error strings in this handler.**
- sessionId is required
- Forbidden: invalid visitor session signature
- Session not found

**Source.** `apps/dashboard/app/api/widget/stream/route.ts`

### OPTIONS `/api/widget/stream`

OPTIONS /api/widget/stream.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/widget/stream/route.ts`

### GET `/api/widget/tools`

GET /api/widget/tools.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON responses.**

- **200** keys: `allowlist`, `denied`

**Source.** `apps/dashboard/app/api/widget/tools/route.ts`

### OPTIONS `/api/widget/tools`

OPTIONS /api/widget/tools.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/widget/tools/route.ts`

### POST `/api/widget/tools`

POST /api/widget/tools.

**Auth.** Public. No session cookie. Tenant is the embed site key, not the logged-in user.

**JSON body fields the handler reads.**

- `tool`
- `name`

**JSON responses.**

- **200** keys: `ok`, `tool`, `hint`

**Source.** `apps/dashboard/app/api/widget/tools/route.ts`

### GET `/embed/widget.js`

GET /embed/widget.js.

**Auth.** Public. Serves the embed script.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/embed/widget.js/route.ts`
