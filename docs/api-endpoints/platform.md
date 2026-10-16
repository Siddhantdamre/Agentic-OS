# Platform admin

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 14 handlers across 14 paths.

## Paths

- `POST` `/api/platform/impersonation`
- `GET` `/api/platform/impersonation/current`
- `POST` `/api/platform/impersonation/end`
- `GET` `/api/platform/observability`
- `GET` `/api/platform/orgs`
- `GET` `/api/platform/orgs/:orgId`
- `POST` `/api/platform/orgs/:orgId/connectors/:id/disconnect`
- `POST` `/api/platform/orgs/:orgId/kill-switch`
- `PUT` `/api/platform/orgs/:orgId/overrides`
- `POST` `/api/platform/orgs/:orgId/soft-delete`
- `POST` `/api/platform/orgs/:orgId/suspend`
- `POST` `/api/platform/orgs/:orgId/unsuspend`
- `POST` `/api/platform/orgs/:orgId/users/:userId/revoke-sessions`
- `GET` `/api/platform/search`

## Endpoints

### POST `/api/platform/impersonation`

Consent path requires orgs.support_access_enabled (migration 121). Missing column → 503. Session cookie is userId.epoch.sig via applySessionCookies.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**JSON body fields the handler reads.**

- `targetUserId`
- `target_user_id`
- `targetOrgId`
- `target_org_id`
- `breakGlass`
- `break_glass`
- `confirm`
- `reason`

**JSON responses.**

- **400** keys: `error`, `message`
- **403** keys: `error`
- **200** keys: `ok`, `impersonationId`, `expiresAt`, `breakGlass`, `consentRecordedAt`
- **503** keys: `error`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- target_required
- targetUserId and targetOrgId are required
- Forbidden
- platform_migration_pending
- migration pending
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/impersonation/route.ts`

### GET `/api/platform/impersonation/current`

Banner read for the *target* session. Uses the normal darex_app pool and the impersonation_sessions target-read RLS policy (migration 121). Honest empty when the table is missing or there is no open session — never invents a banner.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**JSON responses.**

- **200** keys: `active`
- **200** keys: `active`, `sessionId`, `actorUserId`, `actorEmail`, `targetUserId`, `targetOrgId`, `expiresAt`, `breakGlass`, `reason`, `cookiePresent`
- **200** keys: `active`, `tableMissing`

**Source.** `apps/dashboard/app/api/platform/impersonation/current/route.ts`

### POST `/api/platform/impersonation/end`

After start, the browser session is the *target* user — not in platform_admins. Auth: httpOnly darex_impersonation cookie (`sessionId.actorUserId.role`) plus a matching open row. Sets ended_at and increments target session_epoch.

**Auth.** Signed session cookie of the impersonated user, plus the httpOnly `darex_impersonation` cookie. This route does not call `requirePlatformAdmin()` because the active session is the target user.

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **401** keys: `error`
- **400** keys: `error`, `message`
- **200** keys: `ok`
- **403** keys: `error`
- **503** keys: `error`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- Unauthorized
- no_impersonation
- No active impersonation cookie
- Invalid impersonation cookie
- Forbidden
- platform_migration_pending
- migration pending
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/impersonation/end/route.ts`

### GET `/api/platform/observability`

Reads snapshots; does not loop GET /api/observability/metrics.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**JSON responses.**

- **200** keys: `ready`, `llmCost`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/observability/route.ts`

### GET `/api/platform/orgs`

Health is alert count from the latest daily snapshot, or "unknown". Never invents a healthy zero.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**JSON responses.**

- **200** keys: empty object or spread
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/route.ts`

### GET `/api/platform/orgs/:orgId`

Payment method is a processor dashboard link only — never card data.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`

**JSON responses.**

- **400** keys: `error`
- **200** keys: empty object or spread
- **500** keys: `error`

**Error strings in this handler.**
- orgId required
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/route.ts`

### POST `/api/platform/orgs/:orgId/connectors/:id/disconnect`

Same local status update as product disconnect; platform_begin audits first. If Nango is not configured, disconnects locally and says so honestly.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`, `id`

**JSON body fields the handler reads.**

- `confirm`
- `reason`

**JSON responses.**

- **403** keys: `success`
- **403** keys: `error`
- **502** keys: `success`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Nango error
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/connectors/[id]/disconnect/route.ts`

### POST `/api/platform/orgs/:orgId/kill-switch`

Same confirmation class as suspend. Does not replace suspend. org_runtime_controls is not in migration 119's first platform_audit_ok list. We always write orgs.meta (covered); try org_runtime_controls best-effort.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`

**JSON body fields the handler reads.**

- `enabled`
- `active`
- `confirm`
- `reason`

**JSON responses.**

- **400** keys: `error`, `message`
- **200** keys: `ok`, `enabled`, `rolloutStage`
- **500** keys: `error`

**Error strings in this handler.**
- enabled_required
- enabled/active must be a boolean
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/kill-switch/route.ts`

### PUT `/api/platform/orgs/:orgId/overrides`

Raising a hard cap / seat_cap or setting a safety flag requires confirm:true.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`

**JSON body fields the handler reads.**

- `seat_cap`
- `seatCap`
- `meter_caps`
- `meterCaps`
- `feature_flags`
- `featureFlags`
- `confirm`
- `reason`

**JSON responses.**

- **400** keys: `error`, `message`
- **400** keys: `ok`, `override`
- **500** keys: `error`

**Error strings in this handler.**
- invalid_seat_cap
- seat_cap must be integer ≥ 1 or null
- empty_override
- No override fields provided
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/overrides/route.ts`

### POST `/api/platform/orgs/:orgId/soft-delete`

POST /api/platform/orgs/:orgId/soft-delete.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`

**JSON body fields the handler reads.**

- `confirm`
- `reason`

**JSON responses.**

- **403** keys: `ok`, `status`, `purge`
- **403** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/soft-delete/route.ts`

### POST `/api/platform/orgs/:orgId/suspend`

POST /api/platform/orgs/:orgId/suspend.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`

**JSON body fields the handler reads.**

- `confirm`
- `reason`

**JSON responses.**

- **403** keys: `ok`, `status`
- **403** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/suspend/route.ts`

### POST `/api/platform/orgs/:orgId/unsuspend`

Refuses soft_deleted. Does not clear dunning suspensions.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`

**JSON body fields the handler reads.**

- `confirm`
- `reason`

**JSON responses.**

- **403** keys: `ok`, `status`
- **403** keys: `error`
- **409** keys: `error`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- conflict
- Cannot unsuspend this org
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/unsuspend/route.ts`

### POST `/api/platform/orgs/:orgId/users/:userId/revoke-sessions`

Increments users.session_epoch (migration 121).

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Path params.** `orgId`, `userId`

**JSON body fields the handler reads.**

- `confirm`
- `reason`

**JSON responses.**

- **403** keys: `ok`
- **403** keys: `error`
- **503** keys: `error`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- platform_migration_pending
- session_epoch missing
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/orgs/[orgId]/users/[userId]/revoke-sessions/route.ts`

### GET `/api/platform/search`

Cap 50. Audited as platform.search.

**Auth.** Signed session cookie, then `requirePlatformAdmin()` (row in `platform_admins`). Missing session is 401 from middleware. A signed-in user who is not a platform admin gets 403 from the route.

**Query.**
- `q`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `orgs`, `cap`, `q`
- **500** keys: `error`

**Error strings in this handler.**
- q required
- Internal Server Error

**Source.** `apps/dashboard/app/api/platform/search/route.ts`
