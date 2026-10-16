# Settings

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 9 handlers across 5 paths.

## Paths

- `GET, POST` `/api/settings`
- `GET, PATCH` `/api/settings/autonomy`
- `DELETE, PATCH` `/api/settings/members/:id`
- `GET` `/api/settings/pending`
- `GET, DELETE` `/api/settings/suppressions`

## Endpoints

### GET `/api/settings`

GET /api/settings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON responses.**

- **200** keys: `members`, `pendingInvites`, `mailConfigured`, `viewerRole`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/route.ts`

### POST `/api/settings`

POST /api/settings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `enabled`
- `confirm`
- `reason`
- `action`
- `orgName`
- `inviteEmail`
- `inviteRole`
- `allowedOrigins`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **200** keys: `success`, `message`
- **409** keys: `error`
- **402** keys: `error`, `seatsUsed`, `seatLimit`, `source`
- **200** keys: `success`, `emailSent`, `emailReason`, `undefined`, `member`
- **200** keys: `success`, `widget`
- **503** keys: `error`
- **200** keys: `success`, `supportAccessEnabled`
- **400** keys: `success`, `status`, `purge`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Invalid JSON body
- org_id is not accepted from the client; it is resolved from the session.
- Organization updated
- A valid invite email is required
- Invite role must be member, admin, billing, or auditor
- That email is already a member of this organization
- This email already belongs to another organization
- Could not save origins
- Only the organization owner can change support access
- enabled must be a boolean
- Only the organization owner can request workspace deletion

**Source.** `apps/dashboard/app/api/settings/route.ts`

### GET `/api/settings/autonomy`

GET /api/settings/autonomy.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `rules`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/autonomy/route.ts`

### PATCH `/api/settings/autonomy`

PATCH /api/settings/autonomy.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `actionType`
- `employeeRole`
- `autonomyTier`
- `minConfidence`
- `confidenceThreshold`
- `reversibility`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **501** keys: `error`
- **200** keys: `success`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Invalid JSON body
- org_id is not accepted from the client; it is resolved from the session.
- actionType is required
- autonomyTier must be 1-4 or notice|draft|act_internally|act_externally
- minConfidence must be between 0 and 1
- Autonomy rules not available
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/autonomy/route.ts`

### DELETE `/api/settings/members/:id`

DELETE /api/settings/members/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**Path params.** `id`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **200** keys: `success`, `removedUserId`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid member id
- Forbidden
- Cannot remove your own account
- User not found
- Cannot remove organization owner
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/members/[id]/route.ts`

### PATCH `/api/settings/members/:id`

PATCH /api/settings/members/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `role`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **200** keys: `user`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid member id
- Forbidden: only owners can change member roles
- Invalid JSON body
- org_id is not accepted from the client; it is resolved from the session.
- role must be admin, member, or auditor
- User not found
- Cannot modify role of workspace owner
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/members/[id]/route.ts`

### GET `/api/settings/pending`

GET /api/settings/pending.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `pending`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/pending/route.ts`

### DELETE `/api/settings/suppressions`

DELETE /api/settings/suppressions.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**Query.**
- `id`

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `id`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `ok`, `dismissed`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- org_id is not accepted from the request body
- id is required
- Suppression not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/suppressions/route.ts`

### GET `/api/settings/suppressions`

GET /api/settings/suppressions.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: empty object or spread
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/settings/suppressions/route.ts`
