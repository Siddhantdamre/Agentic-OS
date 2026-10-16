# Audit and data subject requests

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 6 handlers across 6 paths.

## Paths

- `GET` `/api/audit`
- `GET` `/api/audit-logs`
- `GET` `/api/dsr`
- `GET` `/api/dsr/:id/download`
- `POST` `/api/dsr/delete`
- `POST` `/api/dsr/export`

## Endpoints

### GET `/api/audit`

Auditor may read. Never accepts body org_id (session org only).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canReadAudit()`.

**Query.**
- `limit`
- `kind`
- `workItemId`
- `planId`

**JSON responses.**

- **403** keys: `error`
- **200** keys: `events`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/audit/route.ts`

### GET `/api/audit-logs`

Session org only. Never accepts body org_id. Does not dump full payloads.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canReadAudit()`.

**Query.**
- `limit`
- `kind`
- `riskClass`
- `cursor`
- `from`
- `to`

**JSON responses.**

- **403** keys: `error`
- **200** keys: `events`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/audit-logs/route.ts`

### GET `/api/dsr`

Org from session via getScopedClient(). RBAC: canExportDsr (owner/admin).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canExportDsr()`.

**JSON responses.**

- **403** keys: `error`
- **200** keys: empty object or spread
- **401** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- Forbidden
- Unauthorized
- Internal Server Error

**Source.** `apps/dashboard/app/api/dsr/route.ts`

### GET `/api/dsr/:id/download`

Path is resolved under DSR_ARTIFACT_DIR; traversal outside the org folder is rejected. Org from session via getScopedClient(). RBAC: canExportDsr.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canExportDsr()`.

**Path params.** `id`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **401** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid request id
- Forbidden
- Not found
- Not an export request
- Export artifact not ready
- Invalid artifact path
- Artifact file missing
- Unauthorized
- Internal Server Error

**Source.** `apps/dashboard/app/api/dsr/[id]/download/route.ts`

### POST `/api/dsr/delete`

progress). Requires typed confirmation of the org slug or name. Org is always the session org via getScopedClient(); body org_id is rejected. RBAC: owner only (canDeleteDsr).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canDeleteDsr()`.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `confirm`
- `confirmation`
- `confirmSlug`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **202** keys: `status`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- Forbidden
- Organization not found
- Confirmation does not match this organization. Type the org slug or exact name to confirm delete.
- Delete job enqueued. Poll GET /api/dsr for progress.
- Internal Server Error

**Source.** `apps/dashboard/app/api/dsr/delete/route.ts`

### POST `/api/dsr/export`

JSON artifact. Org is always the session org via getScopedClient(). RBAC: owner or admin (canExportDsr). Body org_id is rejected.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canExportDsr()`.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **202** keys: `status`, `downloadPath`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/dsr/export/route.ts`
