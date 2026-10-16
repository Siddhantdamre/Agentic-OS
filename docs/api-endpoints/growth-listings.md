# Growth, listings, showings, inquiries, rent

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 28 handlers across 16 paths.

## Paths

- `GET` `/api/growth/brief`
- `POST` `/api/growth/listings/match`
- `POST` `/api/growth/opportunities/:id/decision`
- `GET, POST` `/api/inquiries`
- `PATCH, DELETE` `/api/inquiries/:id`
- `GET, POST` `/api/insight`
- `GET, POST` `/api/listings`
- `GET, PATCH, DELETE` `/api/listings/:id`
- `POST` `/api/listings/sync`
- `GET, POST` `/api/rent-reminders`
- `POST` `/api/rent-reminders/charges`
- `GET, POST` `/api/rent-reminders/leases`
- `GET, POST` `/api/showings`
- `PATCH, DELETE` `/api/showings/:id`
- `POST, GET` `/api/showings/calendar-watch`
- `POST, GET` `/api/showings/calendar-watch/calendar-watch`

## Endpoints

### GET `/api/growth/brief`

GET /api/growth/brief.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: empty object or spread
- **500** keys: `opportunities`, `signalCount`, `visitorCount`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/growth/brief/route.ts`

### POST `/api/growth/listings/match`

Match recent re_listings to open re_inquiries and create growth_opportunity work items for human approval. Never sends messages automatically.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `canDisableEmployee()`.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`

**JSON responses.**

- **400** keys: `error`
- **403** keys: `error`
- **200** keys: `ok`, `matched`, `createdWorkItems`, `message`
- **200** keys: `ok`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- Forbidden
- re_listings table not available
- Internal Server Error

**Source.** `apps/dashboard/app/api/growth/listings/match/route.ts`

### POST `/api/growth/opportunities/:id/decision`

Human approval gate for growth opportunity cards → outreach. Never auto-sends: outreach starts only when action === 'approve' and a drafted message + recipient email are present on the card metadata.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `action`
- `draftOverride`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **200** keys: `ok`, `message`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid opportunity id
- org_id is not accepted from the request body
- action must be approve, reject, or snooze
- Opportunity not found
- Outreach dispatch failed
- Internal Server Error

**Source.** `apps/dashboard/app/api/growth/opportunities/[id]/decision/route.ts`

### GET `/api/inquiries`

GET /api/inquiries.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `limit`
- `cursor`
- `status`
- `locality`

**JSON responses.**

- **200** keys: `inquiries`
- **500** keys: `inquiries`, `nextCursor`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/inquiries/route.ts`

### POST `/api/inquiries`

POST /api/inquiries.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `contact`
- `contact_id`
- `contactId`
- `bhk`
- `budget_max`
- `budgetMax`
- `locality`
- `area`
- `city`
- `listingId`
- `listing_id`
- `channel`
- `status`
- `currency`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `inquiry`, `deduplicated`
- **200** keys: `inquiry`, `matchedListingIds`, `deduplicated`
- **409** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- budget_max must be a positive number within bounds
- Duplicate active inquiry for contact
- Internal Server Error

**Source.** `apps/dashboard/app/api/inquiries/route.ts`

### DELETE `/api/inquiries/:id`

DELETE /api/inquiries/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **404** keys: `error`
- **200** keys: `success`
- **500** keys: `error`

**Error strings in this handler.**
- Not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/inquiries/[id]/route.ts`

### PATCH `/api/inquiries/:id`

PATCH /api/inquiries/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `status`
- `assignedAgentId`
- `assigned_agent_id`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `inquiry`
- **500** keys: `error`

**Error strings in this handler.**
- Inquiry not found
- Inquiries table not available
- Internal Server Error

**Source.** `apps/dashboard/app/api/inquiries/[id]/route.ts`

### GET `/api/insight`

Org id comes from the session. Body org_id is rejected.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `insights`, `tripwires`, `source`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/insight/route.ts`

### POST `/api/insight`

POST /api/insight.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `org_id`
- `orgId`
- `metricId`
- `namedWorkflow`

**JSON responses.**

- **400** keys: `error`
- **503** keys: `error`
- **200** keys: `ok`, `workflowId`, `workflowName`
- **500** keys: `error`

**Error strings in this handler.**
- org_id is not accepted from the request body
- metricId is required
- This metric has no named workflow. Review Action is not available.
- Temporal is unavailable — InsightActionWorkflow was not started
- Internal Server Error

**Source.** `apps/dashboard/app/api/insight/route.ts`

### GET `/api/listings`

GET /api/listings. Same handler behavior as [GET `/api/packs/listings`](./packs-skills.md#get-apipackslistings) (alias re-export under packs).

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

**Source.** `apps/dashboard/app/api/listings/route.ts`

### POST `/api/listings`

POST /api/listings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `sourceRef`
- `source_ref`
- `id`
- `list_price`
- `price`
- `source`
- `title`
- `name`
- `locality`
- `area`
- `city`
- `bhk`
- `currency`
- `rera_id`
- `reraId`
- `status`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `listing`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- sourceRef is required. Darex will not invent a listing id.
- Internal Server Error

**Source.** `apps/dashboard/app/api/listings/route.ts`

### DELETE `/api/listings/:id`

DELETE /api/listings/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`, `invented`
- **200** keys: `success`, `withdrawnId`, `listing`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid listing id
- Listing not found
- Internal Server Error

**Source.** `apps/dashboard/app/api/listings/[id]/route.ts`

### GET `/api/listings/:id`

GET /api/listings/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`, `invented`
- **200** keys: `listing`, `invented`
- **503** keys: `error`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid listing id
- Listing not found
- 015_packs.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/listings/[id]/route.ts`

### PATCH `/api/listings/:id`

PATCH /api/listings/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `status`
- `list_price`
- `price`
- `amenities`
- `title`
- `locality`
- `area`
- `city`
- `address_line`
- `addressLine`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`, `invented`
- **200** keys: `listing`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid listing id
- Listing not found
- list_price must be a number
- Internal Server Error

**Source.** `apps/dashboard/app/api/listings/[id]/route.ts`

### POST `/api/listings/sync`

Idempotent upsert into re_listings on (org_id, source, source_ref). Accepts an explicit listings[] payload only — never invents inventory. Provider pull (MLS API) is Partial: no licensed MLS client is wired in-repo.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `mode`
- `action`
- `provider`
- `source`
- `pull`
- `listings`
- `properties`
- `rows`

**JSON responses.**

- **400** keys: `error`, `invented`
- **501** keys: `ok`, `invented`, `upserted`, `providerPull`, `error`
- **400** keys: `error`, `invented`, `providerPull`
- **200** keys: `ok`, `invented`, `upserted`, `listings`, `providerPull`, `message`
- **400** keys: `error`, `invented`, `upserted`
- **200** keys: `ok`, `invented`, `upserted`, `listings`, `errors`, `providerPull`, `message`
- **503** keys: `error`, `invented`, `upserted`
- **500** keys: `error`, `invented`

**Error strings in this handler.**
- No licensed MLS API client is configured. Push known listings via listings[] for idempotent upsert, or connect a sheet sync — Darex will not invent inventory.
- listings[] is required for sync upsert. Each row needs sourceRef (or source_ref). Darex will not invent listing ids.
- Empty listings[] — nothing to upsert.
- No valid listing rows to upsert
- 015_packs.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/listings/sync/route.ts`

### GET `/api/rent-reminders`

GET /api/rent-reminders.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `charges`, `invented`
- **500** keys: `charges`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/rent-reminders/route.ts`

### POST `/api/rent-reminders`

POST /api/rent-reminders.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `tenantClaimedPaid`
- `closed`
- `pspPaymentId`
- `chargeId`
- `id`

**JSON responses.**

- **400** keys: `error`
- **400** keys: `error`, `closed`
- **404** keys: `error`, `closed`, `invented`
- **200** keys: `via`, `invented`
- **503** keys: `error`, `closed`, `invented`
- **500** keys: `error`, `closed`

**Error strings in this handler.**
- UI rent reminder cannot close a charge or accept a tenant “I paid” claim.
- chargeId (UUID from this org) is required
- Charge not in this org. Will not invent an amount.
- 015_packs.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/rent-reminders/route.ts`

### POST `/api/rent-reminders/charges`

POST /api/rent-reminders/charges.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `leaseId`
- `amount`
- `currency`
- `dueAt`
- `kind`
- `paymentUrl`
- `note`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`, `invented`
- **201** keys: `charge`, `invented`
- **503** keys: `error`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- leaseId (UUID) is required
- amount is required and must be a non-negative number (from source of record)
- Lease not in this org
- 015_packs.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/rent-reminders/charges/route.ts`

### GET `/api/rent-reminders/leases`

GET /api/rent-reminders/leases.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `leases`, `invented`
- **500** keys: `leases`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/rent-reminders/leases/route.ts`

### POST `/api/rent-reminders/leases`

POST /api/rent-reminders/leases.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `tenantName`
- `sourceRef`
- `tenantPhone`
- `tenantEmail`
- `propertyAddress`
- `unitNumber`
- `rentAmount`
- `currency`
- `dueDay`
- `unitId`

**JSON responses.**

- **400** keys: `error`
- **201** keys: `lease`, `invented`
- **503** keys: `error`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- tenantName is required
- 015_packs.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/rent-reminders/leases/route.ts`

### GET `/api/showings`

GET /api/showings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `listingId`
- `inquiryId`

**JSON responses.**

- **200** keys: `showings`, `invented`
- **500** keys: `showings`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/showings/route.ts`

### POST `/api/showings`

POST /api/showings.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `startTime`
- `endTime`
- `durationMinutes`
- `timezone`
- `summary`
- `listingId`
- `listing_id`
- `inquiryId`
- `inquiry_id`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`, `booked`, `invented`
- **409** keys: `booked`, `conflict`, `invented`, `error`, `conflicts`
- **409** keys: `booked`, `conflict`, `invented`, `connected`, `reconnectUrl`, `setupUrl`, `reason`, `error`
- **409** keys: `booked`, `conflict`, `invented`, `connected`, `error`, `busy`
- **200** keys: empty object or spread
- **503** keys: `error`, `booked`, `invented`
- **500** keys: `error`, `booked`

**Error strings in this handler.**
- startTime (ISO-8601) is required
- startTime must be a valid ISO-8601 datetime
- endTime must be a valid ISO-8601 datetime
- listingId must be a listing UUID from this org
- inquiryId must be an inquiry UUID from this org
- Listing not in this org. Will not invent a unit.
- Inquiry not in this org. Will not invent a lead.
- Time slot conflicts with an existing showing for this org.
- Google Calendar reports the agent is busy for this slot.
- Reminders not scheduled
- ShowingReminderWorkflow started
- Temporal unavailable — reminders not scheduled (no fake send)

**Source.** `apps/dashboard/app/api/showings/route.ts`

### DELETE `/api/showings/:id`

DELETE /api/showings/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `cancellationReason`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`, `invented`
- **200** keys: `success`, `message`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid showing id
- Showing not found
- Showing cancelled
- Internal Server Error

**Source.** `apps/dashboard/app/api/showings/[id]/route.ts`

### PATCH `/api/showings/:id`

PATCH /api/showings/:id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `id`

**JSON body fields the handler reads.**

- `startsAt`
- `startTime`
- `endsAt`
- `endTime`
- `status`
- `feedbackRating`
- `feedbackNotes`
- `cancellationReason`
- `timezone`
- `durationMinutes`

**JSON responses.**

- **400** keys: `error`
- **404** keys: `error`, `invented`
- **409** keys: `error`, `conflict`, `conflicts`, `booked`
- **409** keys: `error`, `connected`, `reconnectUrl`, `setupUrl`, `booked`
- **409** keys: `error`, `conflict`, `busy`, `booked`
- **200** keys: `showing`, `invented`
- **503** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid showing id
- Showing not found
- startsAt must be ISO-8601
- endsAt must be ISO-8601
- Time slot conflicts with another showing
- Google Calendar reports the agent is busy for this slot.
- 015_packs.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/showings/[id]/route.ts`

### GET `/api/showings/calendar-watch`

GET /api/showings/calendar-watch. Same handler behavior as [GET `/api/showings/calendar-watch/calendar-watch`](#get-apishowingscalendar-watchcalendar-watch) (byte-identical nested duplicate route).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `watches`, `invented`
- **500** keys: `watches`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/showings/calendar-watch/route.ts`

### POST `/api/showings/calendar-watch`

Register (or honestly report not-configured) a Google Calendar push channel for the session org. Does not invent sync when webhook URL / OAuth is missing. Same handler behavior as [POST `/api/showings/calendar-watch/calendar-watch`](#post-apishowingscalendar-watchcalendar-watch).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **200** keys: `invented`
- **503** keys: `configured`, `status`, `message`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- 102_showing_reminders_gcal_watch.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/showings/calendar-watch/route.ts`

### GET `/api/showings/calendar-watch/calendar-watch`

Same handler behavior as [GET `/api/showings/calendar-watch`](#get-apishowingscalendar-watch). Nested path is reachable; file is byte-identical to the parent route.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `watches`, `invented`
- **500** keys: `watches`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/showings/calendar-watch/calendar-watch/route.ts`

### POST `/api/showings/calendar-watch/calendar-watch`

Same handler behavior as [POST `/api/showings/calendar-watch`](#post-apishowingscalendar-watch). Nested path is reachable; file is byte-identical to the parent route.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **200** keys: `invented`
- **503** keys: `configured`, `status`, `message`, `invented`
- **500** keys: `error`

**Error strings in this handler.**
- 102_showing_reminders_gcal_watch.sql not applied
- Internal Server Error

**Source.** `apps/dashboard/app/api/showings/calendar-watch/calendar-watch/route.ts`
