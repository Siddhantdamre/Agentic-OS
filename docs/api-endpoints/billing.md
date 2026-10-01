# Billing

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 5 handlers across 5 paths.

## Paths

- `GET` `/api/billing`
- `POST` `/api/billing/checkout`
- `GET` `/api/billing/meters`
- `POST` `/api/billing/portal`
- `PATCH` `/api/billing/subscription`

## Endpoints

### GET `/api/billing`

Session org only — never a body/query org_id. Invoices are RLS-scoped + paginated.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `limit`
- `offset`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `neverEscrow`, `providers`, `providerGaps`, `catalog`, `subscriptions`, `invoices`, `invoicePagination`, `audit`, `meters`, `llm`, `llmError`, `confirmReject`, `usageBlocked`, `seatsUsed`, `whatsappConversations`
- **503** keys: `error`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/billing/route.ts`

### POST `/api/billing/checkout`

Start Darex SaaS checkout (Stripe and/or Razorpay). Org is session-only. If the org already has an active subscription for the provider, modify in place (Stripe with proration) instead of opening a second parallel checkout.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `requireBillingManager()`.

**JSON body fields the handler reads.**

- `provider`
- `plan`
- `seats`

**JSON responses.**

- **400** keys: `error`
- **503** keys: `error`, `connected`
- **200** keys: `error`
- **200** keys: `changed`, `plan`, `seats`, `prorated`, `neverEscrow`
- **200** keys: `url`, `neverEscrow`
- **500** keys: `error`

**Error strings in this handler.**
- customer_id / subscription_id are not accepted from the client; they are resolved from the session org.
- provider must be stripe or razorpay
- plan must be starter, growth, or enterprise
- Internal Server Error

**Source.** `apps/dashboard/app/api/billing/checkout/route.ts`

### GET `/api/billing/meters`

LLM (Langfuse cost API) + WhatsApp conversations + seats for the session org. notConnected / disconnected tools are metered separately and do not count as success. Surfaces `isUsageBlocked` / `assertUsageAllowed` for circuit-breaker consumers.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **400** keys: `error`
- **200** keys: `usageGate`, `note`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/billing/meters/route.ts`

### POST `/api/billing/portal`

- Stripe open: hosted customer portal URL - Razorpay open: in-app manage payload (no hosted portal) - action=cancel: cancel for the session org's provider subscription

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `requireBillingManager()`.

**JSON body fields the handler reads.**

- `action`
- `provider`
- `atPeriodEnd`
- `cancel_at_period_end`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `error`
- **404** keys: `error`
- **503** keys: `error`, `connected`
- **200** keys: `provider`, `action`, `cancelAtPeriodEnd`, `status`, `neverEscrow`
- **200** keys: `provider`, `mode`, `neverEscrow`, `subscription`, `actions`, `message`
- **200** keys: `url`, `provider`, `mode`, `neverEscrow`
- **500** keys: `error`

**Error strings in this handler.**
- customer_id is not accepted from the client; it is resolved from the session org.
- action must be open or cancel
- No billing subscription for this organization
- Razorpay has no hosted customer portal. Use action=cancel or PATCH /api/billing/subscription.
- No Stripe customer for this organization
- Internal Server Error

**Source.** `apps/dashboard/app/api/billing/portal/route.ts`

### PATCH `/api/billing/subscription`

Modify-in-place plan change for the session org. Stripe: subscriptions.update with proration_behavior=create_prorations. Razorpay: subscriptions PATCH schedule_change_at=now (provider has no Stripe-style proration). Never trusts client-sent prices, customer ids, or org_id.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body. Extra role check: `requireBillingManager()`.

**JSON body fields the handler reads.**

- `plan`
- `seats`
- `provider`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **503** keys: `error`, `connected`
- **200** keys: `plan`, `seats`, `status`, `prorated`, `neverEscrow`
- **500** keys: `error`

**Error strings in this handler.**
- customer_id / subscription_id are not accepted from the client; they are resolved from the session org.
- plan must be starter, growth, or enterprise
- No active subscription to modify. Use checkout to start a plan.
- Subscription is missing provider id; cannot change plan in place.
- No active subscription to modify
- Internal Server Error

**Source.** `apps/dashboard/app/api/billing/subscription/route.ts`
