# API conventions

These rules apply to every route under `apps/dashboard`. A new frontend should follow them instead of copying the current React pages.

## Base URL

The API is the Next.js app in `apps/dashboard`. In local dev that is the same origin as `pnpm dev` (usually `http://localhost:3000`). Paths start with `/api/`. There is no separate `/v1` prefix.

Send cookies on every call:

```http
credentials: include
```

## Session

| Cookie | Who sets it | What it is |
| --- | --- | --- |
| `darex_session` | Server, httpOnly, SameSite=Lax | Signed user id and session epoch. The browser cannot read it. |
| `darex_org_id` | Server | Active workspace hint. The database membership is the authority. |
| `darex_onboarding` | Server | `1` while the org still needs onboarding. |
| `darex_pending_invite` | Server | Invite token carried across signup. |
| `darex_impersonation` | Server, httpOnly | Set only while a platform admin is impersonating an org user. |

Login and signup (`POST /api/auth/login`, `POST /api/auth/signup`, and the `signin` / `register` aliases) set these cookies. The JSON body also returns `userId`, `email`, `orgId`, and `onboardingComplete`.

`GET /api/auth/session` is the call to make on app load.

`GET /api/auth/logout` (alias `GET /api/auth/signout`) clears the cookies and redirects to `/login`.

Session lifetime is 7 days, or 30 days when login sends `rememberMe: true` (the default).

## Tenancy

Never send `org_id` or `orgId` as the tenant. Handlers that see those fields return 400. The org is resolved from the signed session inside `getScopedClient()`.

To change workspace, call `POST /api/org/switch` with `targetOrgId`. That route checks membership and rotates the session cookies.

## Who can call what

Middleware (`apps/dashboard/middleware.ts`) runs before the route:

- No session cookie, and the path is not public: **401** `{ "error": "Unauthorized" }`.
- Signed-in calls are rate-limited per org (or per user if the org cookie is missing). A limited call returns **429**.
- `/api/health` and `/api/health/ready` are not rate-limited.

Public paths (no session):

- `/api/health`
- `/api/webhooks/*`
- `/api/widget/*` (the embed site key is the tenant)
- `/api/auth/login`, `/api/auth/signin`, `/api/auth/signup`, `/api/auth/register`
- `/api/auth/session`, `/api/auth/logout`, `/api/auth/signout`
- `/api/auth/forgot-password`, `/api/auth/reset-password`
- `/api/auth/oauth/*`, `/api/auth/sso`, `/api/auth/sso/*`
- `/api/auth/invite/*`
- `GET /embed/widget.js`

Everything else needs a session. Platform routes (`/api/platform/*`) also require a row in `platform_admins`. A signed-in non-admin gets **403**. The exception is `POST /api/platform/impersonation/end`, which uses the impersonation cookie because the active session is the target user.

Org role on `users.role`: `owner`, `admin`, `member`, `auditor`, `billing`.

| Check | Who passes |
| --- | --- |
| `canManageOrgSettings` | owner, admin |
| `canDisableEmployee` | owner, admin |
| `canExportDsr` | owner, admin |
| `canDeleteDsr` | owner only |
| `canReadAudit` | owner, admin, auditor |
| `canCallPayTools` | owner, admin, member |
| `requireBillingManager` | billing managers (checkout, portal, subscription changes) |

A failed check is **403** `{ "error": "Forbidden" }` unless the handler says otherwise.

## Errors you will see on almost every route

| Status | When |
| --- | --- |
| 400 | Bad JSON, missing field, or a client-supplied `org_id` |
| 401 | Missing or dead session |
| 402 | Org is suspended or soft-deleted, or a billing usage gate blocked the call |
| 403 | Role check failed |
| 429 | Rate limit |
| 500 | `{ "error": "Internal Server Error" }` |

Suspended orgs come back as `{ "error": "...", "code": ... }` with status 402 from `scopedAuthErrorResponse`.

Auth failures from login and signup use a different shape: `{ "status": "ERROR", "message": "..." }`. A successful auth call is `{ "status": "OK", ... }`. Login with TOTP enabled returns **401** `{ "status": "MFA_REQUIRED" }` until `mfaCode` is sent.

## Streaming

Two styles. Do not assume every POST is a single JSON object.

| Route | Content type | Shape |
| --- | --- | --- |
| `POST /api/ask-ai` | `application/x-ndjson` | One JSON object per line. `type` is `routing`, `warning`, `chunk`, `tool`, `subagent`, `approval`, `done`, or `error`. A complex turn can instead return one JSON object `{ "type": "complex", ...plan }` and no stream. |
| `POST /api/ask-ai/approve` | `application/x-ndjson` | Same line types: `chunk`, `tool`, `subagent`, `approval`, `done`, `error`. |
| `GET /api/ask-ai/execute` | `text/event-stream` | `event: <name>` then `data: <json>`. Events: `execution_start`, `step_start`, `step_done`, `step_error`, `execution_done`, `execution_error`. |
| `GET /api/stream/events` | server-sent events | Live org events for the signed-in session. |
| `GET /api/widget/stream` | server-sent events | Public widget stream, keyed by the embed session. |

## Bodies and responses in the area docs

Each area file lists:

- the path and method
- the auth rule
- path and query parameters the handler reads
- JSON fields the handler reads
- top-level keys of each `NextResponse.json(...)`
- the route file to open when a field list looks short

Field lists are names found in the handler. They are not a generated OpenAPI schema. Nested objects are named when the handler reads them (`decisions`, `steps`) but their inner keys are only spelled out when the route comment or the type says so. Open the source file linked on that endpoint for the rest.

Two paths are accidental duplicates of the route above them. They behave the same:

- `/api/showings/calendar-watch/calendar-watch`
- `/api/webhooks/google-calendar/google-calendar`

Two more are intentional aliases (re-exports):

- `POST /api/packs/install` → same as `POST /api/packs`
- `GET /api/packs/listings` → same as `GET /api/listings`
