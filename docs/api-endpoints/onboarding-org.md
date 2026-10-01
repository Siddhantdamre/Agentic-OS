# Onboarding and organization

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 16 handlers across 10 paths.

## Paths

- `GET, POST` `/api/onboarding/backfill`
- `GET` `/api/onboarding/observation`
- `GET, PATCH` `/api/onboarding/settings`
- `GET` `/api/onboarding/trajectory`
- `POST` `/api/org/create`
- `GET, PATCH, POST` `/api/org/kill-switch`
- `GET` `/api/org/memberships`
- `GET, PATCH` `/api/org/onboarding`
- `GET, PATCH` `/api/org/rollout`
- `POST` `/api/org/switch`

## Endpoints

### GET `/api/onboarding/backfill`

GET /api/onboarding/backfill.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `jobs`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/onboarding/backfill/route.ts`

### POST `/api/onboarding/backfill`

POST /api/onboarding/backfill.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `windowDays`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **200** keys: `job`, `chased`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- org_id is not accepted from the client; it is resolved from the session.
- backfill failed
- Internal Server Error

**Source.** `apps/dashboard/app/api/onboarding/backfill/route.ts`

### GET `/api/onboarding/observation`

GET /api/onboarding/observation.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `observation`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/onboarding/observation/route.ts`

### GET `/api/onboarding/settings`

GET /api/onboarding/settings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `timezone`, `businessHours`, `decisionRecipientId`, `firstObservationShownAt`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/onboarding/settings/route.ts`

### PATCH `/api/onboarding/settings`

PATCH /api/onboarding/settings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `timezone`
- `businessHours`
- `decisionRecipientId`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **200** keys: `timezone`, `businessHours`, `decisionRecipientId`, `firstObservationShownAt`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- org_id is not accepted from the client; it is resolved from the session.
- Recipient must be a member of this org
- Internal Server Error

**Source.** `apps/dashboard/app/api/onboarding/settings/route.ts`

### GET `/api/onboarding/trajectory`

GET /api/onboarding/trajectory.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `trajectory`, `plan`, `rolloutStage`, `killSwitch`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/onboarding/trajectory/route.ts`

### POST `/api/org/create`

Final onboarding step. Org resolved from session — body org_id rejected. DB writes (name, channels, onboarding) run in one transaction; employee seed and pack install run after commit (seed has its own txn; packs use installPackForOrg).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `businessName`
- `teamSize`
- `businessType`
- `channels`

**JSON responses.**

- **403** keys: `status`, `message`
- **400** keys: `status`, `message`
- **200** keys: `status`, `channelsSeeded`, `channelsStatus`, `connectorsMarkedConnected`
- **500** keys: `status`, `message`

**Error strings in this handler.**
- Forbidden
- org_id is not accepted from the client; it is resolved from the session.
- Business name is required
- Failed to create organization

**Source.** `apps/dashboard/app/api/org/create/route.ts`

### GET `/api/org/kill-switch`

GET /api/org/kill-switch.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/kill-switch/route.ts`

### PATCH `/api/org/kill-switch`

PATCH /api/org/kill-switch.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `enabled`
- `active`
- `orgId` (rejected when sent; the org comes from the session)

Both PATCH and POST call the same writer. That writer requires `canManageOrgSettings` (owner or admin).

**JSON responses.**

- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/kill-switch/route.ts`

### POST `/api/org/kill-switch`

POST /api/org/kill-switch.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `enabled`
- `active`
- `orgId` (rejected when sent; the org comes from the session)

Both PATCH and POST call the same writer. That writer requires `canManageOrgSettings` (owner or admin).

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/org/kill-switch/route.ts`

### GET `/api/org/memberships`

List workspaces the session user belongs to. Org never from body.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `activeOrgId`, `memberships`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/memberships/route.ts`

### GET `/api/org/onboarding`

GET /api/org/onboarding.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `wizardStep`, `businessName`, `teamSize`, `selectedChannels`, `onboardingComplete`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/onboarding/route.ts`

### PATCH `/api/org/onboarding`

PATCH /api/org/onboarding.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `businessName`
- `wizardStep`
- `teamSize`
- `businessType`
- `selectedChannels`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **200** keys: `status`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- org_id is not accepted from the client; it is resolved from the session.
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/onboarding/route.ts`

### GET `/api/org/rollout`

GET /api/org/rollout.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `stage`, `killSwitch`, `shadowReviewed`, `shadowAgreed`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/rollout/route.ts`

### PATCH `/api/org/rollout`

PATCH /api/org/rollout.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `stage`
- `weeksInStage`
- `stateDivergences`
- `approvalRate`
- `decisionsInStage`
- `force`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **400** keys: `stage`, `demoted`
- **409** keys: `error`, `stage`
- **200** keys: `stage`, `reason`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- org_id is not accepted from the client; it is resolved from the session.
- Advance one stage at a time
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/rollout/route.ts`

### POST `/api/org/switch`

Switch active workspace: verify membership, update users.org_id, rotate session cookies so the next request cannot keep the previous org cookie. Never trusts body org_id as tenancy authority.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `targetOrgId`
- `orgId`
- `code`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **402** keys: `error`
- **200** keys: `success`, `activeOrg`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- org_id is not accepted from the client; use targetOrgId and membership is verified server-side.
- targetOrgId must be a valid UUID
- Forbidden: not a member of the requested organization
- Workspace is suspended
- Internal Server Error

**Source.** `apps/dashboard/app/api/org/switch/route.ts`
