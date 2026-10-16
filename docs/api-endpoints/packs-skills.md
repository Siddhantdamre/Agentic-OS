# Packs and skills

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 8 handlers across 6 paths.

## Paths

- `GET, POST, DELETE` `/api/packs`
- `PATCH` `/api/packs/:id/config`
- `POST` `/api/packs/install`
- `GET` `/api/packs/listings`
- `GET` `/api/skills`
- `PATCH` `/api/skills/:id`

## Endpoints

### DELETE `/api/packs`

DELETE /api/packs.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `packId`
- `pack_id`
- `orgId`
- `org_id`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **200** keys: `conversationsDeleted`
- **503** keys: `error`, `conversationsDeleted`
- **500** keys: `error`

**Error strings in this handler.**
- Only owners and admins can uninstall packs
- packId is required
- Pack tables missing — apply infra/db/migrations/015_packs.sql
- Internal Server Error

**Source.** `apps/dashboard/app/api/packs/route.ts`

### GET `/api/packs`

GET /api/packs.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `packs`, `installed`, `livePackIds`, `connectorsMarkedConnected`
- **503** keys: `error`, `orgId`, `packs`, `installed`, `livePackIds`, `connectorsMarkedConnected`
- **500** keys: `error`, `packs`, `installed`, `livePackIds`

**Error strings in this handler.**
- Pack tables missing — apply infra/db/migrations/015_packs.sql
- Internal Server Error

**Source.** `apps/dashboard/app/api/packs/route.ts`

### POST `/api/packs`

POST /api/packs.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `packId`
- `pack_id`
- `action`
- `orgId`
- `org_id`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **400** keys: `error`, `connectorsMarkedConnected`
- **409** keys: `error`, `connectorsMarkedConnected`
- **200** keys: `connectorsMarkedConnected`
- **503** keys: `error`, `connectorsMarkedConnected`
- **500** keys: `error`

**Error strings in this handler.**
- Only owners and admins can install packs
- packId is required
- Pack is RFC / not live. Quality bar (03 §11) is not met. Connectors were not marked connected.
- Pack upgrade failed — pack must be installed first
- Pack install failed
- Pack install failed — catalog row missing or pack tables not migrated. Apply infra/db/migrations/015_packs.sql
- Internal Server Error

**Source.** `apps/dashboard/app/api/packs/route.ts`

Same handler behavior as [POST `/api/packs/install`](#post-apipacksinstall) (alias re-export).

### POST `/api/packs/install`

Alias of [POST `/api/packs`](#post-apipacks). Re-exports the same `POST` handler. Used by org create / pack install callers that hit `PACK_INSTALL_PATHS`.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**JSON body fields the handler reads.**

- `packId`
- `pack_id`
- `action`
- `orgId`
- `org_id`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **400** keys: `error`, `connectorsMarkedConnected`
- **409** keys: `error`, `connectorsMarkedConnected`
- **200** keys: `connectorsMarkedConnected`
- **503** keys: `error`, `connectorsMarkedConnected`
- **500** keys: `error`

**Error strings in this handler.**
- Only owners and admins can install packs
- packId is required
- Pack is RFC / not live. Quality bar (03 §11) is not met. Connectors were not marked connected.
- Pack upgrade failed — pack must be installed first
- Pack install failed
- Pack install failed — catalog row missing or pack tables not migrated. Apply infra/db/migrations/015_packs.sql
- Internal Server Error

**Source.** `apps/dashboard/app/api/packs/install/route.ts` (re-exports `POST` from `apps/dashboard/app/api/packs/route.ts`)

### GET `/api/packs/listings`

Alias of [GET `/api/listings`](./growth-listings.md#get-apilistings). Re-exports the same `GET` handler. The listings UI probes this path in addition to `/api/listings`.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `bhk`
- `locality`
- `area`
- `city`
- `maxPrice`
- `under`
- `currency`
- `cursor`
- `limit`

**JSON responses.**

- **200** keys: `orgId`, `listings`, `nextCursor`, `hasMore`, `invented`
- **200** keys: `listings`, `invented`, `error`
- **500** keys: `error`

**Error strings in this handler.**
- 015_packs.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/packs/listings/route.ts` (re-exports `GET` from `apps/dashboard/app/api/listings/route.ts`)

### PATCH `/api/packs/:id/config`

Merge JSON config into org_packs.config for the session org. Never trusts body org_id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**Path params.** `id`

**JSON body fields the handler reads.**

- `config`
- `orgId`
- `org_id`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **200** keys: `success`, `pack`
- **503** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- pack id is required
- Pack is not live / unknown
- config object is required
- Only owners and admins can update pack config
- Pack not installed
- Pack tables missing — apply infra/db/migrations/015_packs.sql
- Internal Server Error

**Source.** `apps/dashboard/app/api/packs/[id]/config/route.ts`

### GET `/api/skills`

GET /api/skills.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `employees`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/skills/route.ts`

### PATCH `/api/skills/:id`

PATCH /api/skills/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canManageOrgSettings()`.

**Path params.** `id`

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `enabled`
- `customPromptOverlay`
- `config`
- `assignedEmployeeIds`

**JSON responses.**

- **404** keys: `error`
- **400** keys: `error`
- **403** keys: `error`
- **200** keys: `success`
- **500** keys: `error`

**Error strings in this handler.**
- Unknown skill
- Invalid JSON body
- org_id is not accepted in the body
- Forbidden
- One or more employees are invalid
- Internal Server Error

**Source.** `apps/dashboard/app/api/skills/[id]/route.ts`
