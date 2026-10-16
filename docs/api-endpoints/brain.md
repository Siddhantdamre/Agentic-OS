# Brain (knowledge)

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 8 handlers across 4 paths.

## Paths

- `GET, POST` `/api/brain`
- `PATCH, DELETE, POST` `/api/brain/:id`
- `GET` `/api/brain/:id/revisions`
- `GET, POST` `/api/brain/reindex`

## Endpoints

### GET `/api/brain`

GET /api/brain.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `q`

**JSON responses.**

- **200** keys: `searchMode`
- **200** keys: empty object or spread
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/route.ts`

### POST `/api/brain`

POST /api/brain.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `action`
- `sourceId`
- `body`
- `title`
- `filename`

**JSON responses.**

- **403** keys: `error`
- **400** keys: `error`
- **500** keys: `error`
- **200** keys: `enqueued`, `skipped`
- **400** keys: `ok`, `id`, `enqueued`, `skipped`, `undefined`

**Error strings in this handler.**
- Forbidden
- sourceId is required
- Binary PDF/DOCX/XLSX upload is not supported on this endpoint — paste text or use /api/brain/reindex with a connected Drive source.
- Only .txt / .md text uploads are accepted here
- body is required
- Insert failed
- Unknown action
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/route.ts`

### DELETE `/api/brain/:id`

DELETE /api/brain/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **200** keys: `ok`, `deletedId`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid id
- Forbidden
- Not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/[id]/route.ts`

### PATCH `/api/brain/:id`

PATCH /api/brain/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `action`
- `body`
- `title`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **404** keys: `error`
- **400** keys: `ok`, `id`, `enqueued`, `skipped`, `undefined`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid id
- Forbidden
- Cannot correct a source; reindex instead
- body is required
- Not found
- Unknown action
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/[id]/route.ts`

### POST `/api/brain/:id`

POST /api/brain/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **200** keys: `enqueued`, `skipped`
- **500** keys: `error`

**Error strings in this handler.**
- Reindex requires a source id
- Forbidden
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/[id]/route.ts`

### GET `/api/brain/:id/revisions`

GET /api/brain/:id/revisions.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **200** keys: `memoryId`, `revisions`
- **200** keys: `memoryId`, `revisions`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid id
- Forbidden
- memory_revisions table not migrated yet
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/[id]/revisions/route.ts`

### GET `/api/brain/reindex`

GET /api/brain/reindex.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: empty object or spread
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/reindex/route.ts`

### POST `/api/brain/reindex`

POST /api/brain/reindex.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `connector`
- `sync`
- `fileId`
- `path`
- `sourceId`
- `modifiedAt`
- `mimeType`
- `kind`
- `dataClass`
- `content`
- `ingestBase64`
- `stream`

**JSON responses.**

- **404** keys: `error`
- **200** keys: `path`, `modified_at`, `status`, `pending`, `message`
- **200** keys: `status`, `pending`, `sync`, `connector`, `message`
- **200** keys: `modified_at`, `status`, `pending`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- knowledge source not found
- Job queued. Temporal is unavailable so ingest has not started yet.
- Sync enqueued. Sources stay pending until ingest finishes.
- Ingest enqueued. SOP is retrievable with path + modified_at once embedded, or stays pending.
- Internal Server Error

**Source.** `apps/dashboard/app/api/brain/reindex/route.ts`
