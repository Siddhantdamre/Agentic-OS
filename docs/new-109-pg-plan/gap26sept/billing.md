# Billing Audit

## Status: done (billing-domain complete; ask-ai + tool-executor usage gate wired)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Active sub demoted to `incomplete` on checkout visit | P0 | `apps/dashboard/app/api/billing/_lib.ts` (`upsertSubscription`) | 🟢 Done | ON CONFLICT preserves active/trialing when EXCLUDED.status=`incomplete` |
| 2 | `usageBlocked` not enforced on execution paths | P0 | `usage-gate.ts` + `tool-executor.ts` | 🟢 Done | Shared `@darex/workflows` gate; tool-executor blocks before execute; ask-ai already calls `assertUsageAllowed` (402). |
| 3 | No cancel path for Razorpay; portal Stripe-only | P0 | `portal/route.ts` | 🟢 Done | `action=cancel` Stripe+Razorpay; Razorpay in-app manage payload |
| 4 | Checkout-as-upgrade creates parallel subscriptions | P1 | `checkout/route.ts`, `subscription/route.ts` | 🟢 Done | Stripe proration in-place; Razorpay PATCH schedule_change_at=now |
| 5 | Portal 404s for Razorpay | P1 | `portal/route.ts`, billing page | 🟢 Done | In-app manage + Cancel / Change plan UI |
| 6 | Seat enforcement at invite time | P1 | `_lib.ts` `checkSeatAvailability`; `@/lib/usage-gate` re-export | 🟢 Done | Helper + settings invite path imports `checkSeatAvailability` from `@/lib/usage-gate` |
| 7 | No dunning / audit trail / invoice pagination | P2 | `104_billing_packs_gaps.sql`, `_lib.ts`, `route.ts` | 🟢 Done | `billing_audit_log`, `applyDunningState` on payment_failed, invoice `limit`/`offset` pagination, audit list on GET /api/billing |
| 8 | Any role could read invoices, PSP customer/subscription ids and the billing audit trail (27sept BIZ-S04) | P1 | `app/api/billing/route.ts` | 🟡 Typechecked | Non-billing-managers get plan + meters only; invoices/audit empty, PSP ids null. |
| 9 | Meters refreshed only on /billing page view; gate fail-open (27sept BIZ-B01/B19) | P0 | `wf/billing/meter-refresh.ts`, `wf/workflows/BillingSweepWorkflow.ts`, `wf/usage-gate.ts`, `140_billing_meter_refresh.sql` | 🟡 Unit-tested | Worker sweep refreshes every org every 15 min; gate fails closed on read error. Verified in code: `startBillingSweep` is booted from `worker.ts`; `meter-refresh.test.ts` covers it. No live worker run done, so it stays 🟡. |
| 11 | Direct agent routes (`/api/agent/run`, `/stream`, `/crew`) started LLM turns past the hard cap; only per-tool calls were gated | P0 | `lib/usage-gate.ts` `usageBlockedResponse`, `app/api/agent/{run,stream,crew}/route.ts` | 🟢 Done | 402 `USAGE_CAP_REACHED` before any DB/model work; test `agent-routes-usage-gate.test.ts`. |
| 10 | Subscription integrity: seat add-on collapsed to 1, plan from stale metadata, double subscription across PSPs, cancel on one PSP set free, seat cap ignored invites and raced (27sept BIZ-B03/B04/B05/B06/B08) | P0 | `_lib.ts`, `_stripe-items.ts`, `_plan-resolve.ts`, `checkout/route.ts`, `settings/route.ts` invite | 🟡 Unit-tested | Seats summed by price id; plan from price/plan id; 409 on second provider; plan derived from all rows; invites reserve seats under an advisory lock. |
| 12 | Webhook-started agent turns (WhatsApp, Chatwoot, Instagram, Gmail, SMS, Evolution, widget, conversations) ran the model past the hard cap | P0 | `lib/inbound-agent.ts` `blockIfOverUsageCap` (single dispatch choke point) | 🟡 Unit-tested | Cap checked before media read/workflow/model; over cap (or gate error, fail closed) sends no reply, flags conversation `needs_attention`, records a `usage_cap_blocked` work event. Test `inbound-agent-usage-gate.test.ts`. Not exercised against a live webhook. |

---

## What works (cite file:line)

1. **Two real payment providers, called via raw HTTPS fetch (no SDK).**
   `apps/dashboard/app/api/billing/_lib.ts:401-418` (`stripePost`) posts to
   `https://api.stripe.com/v1${path}` with `Authorization: Bearer <secret>`;
   `apps/dashboard/app/api/billing/_lib.ts:420-442` (`razorpayRequest`) posts
   to `https://api.razorpay.com/v1${path}` with HTTP Basic auth. Confirmed no
   `stripe` or `razorpay` npm package in `apps/dashboard/package.json`
   (`dependencies`/`devDependencies` both empty for those keys) — this is a
   deliberate zero-dependency REST integration, not a missing SDK stub.

2. **Checkout is real**, not mocked. `createStripeCheckout`
   (`_lib.ts:1144-1198`) creates a Stripe customer if needed
   (`POST /customers`, line 1158) and a real Checkout Session
   (`POST /checkout/sessions`, line 1187) with `client_reference_id`,
   `metadata.darex_org_id`/`darex_plan`, and `subscription_data.metadata`
   carrying the org id — the exact hook the webhook later needs to resolve
   tenant without trusting client input. `createRazorpaySubscription`
   (`_lib.ts:1216-1260`) creates a Razorpay customer then a real subscription
   (`POST /subscriptions`) and returns `short_url`. Route
   `apps/dashboard/app/api/billing/checkout/route.ts:88-119` dispatches to
   whichever provider the caller picked and persists an `incomplete`
   subscription row before redirecting (`route.ts:121-134`).

3. **Customer portal is real Stripe billing portal**, not a stub.
   `createStripePortal` (`_lib.ts:1200-1214`) calls
   `POST /billing_portal/sessions` and returns the real portal URL;
   `apps/dashboard/app/api/billing/portal/route.ts:56-64` 404s cleanly when
   there is no Stripe customer for the org rather than fabricating a URL.

4. **Webhooks are implemented and signature-verified for both providers.**
   `verifyStripeSignature` (`_lib.ts:444-462`) parses the
   `Stripe-Signature` header, checks a 300s timestamp tolerance
   (`STRIPE_TOLERANCE_SEC`, line 72), and does an HMAC-SHA256 comparison with
   `crypto.timingSafeEqual` via `timingSafeEqualString` (`_lib.ts:112-120`,
   deliberately padding-safe: on length mismatch it still calls
   `timingSafeEqual(aBuf, aBuf)` to avoid a length-based timing oracle before
   returning false). `verifyRazorpaySignature` (`_lib.ts:464-468`) does the
   analogous HMAC check on `x-razorpay-signature`. The webhook route
   `apps/dashboard/app/api/webhooks/billing/route.ts:60-74` rejects any
   request with no matching signature header with `401 Unsigned billing
   webhook rejected` **before** parsing JSON — an attacker cannot even get a
   parse-error response without a valid signature.

5. **Webhook idempotency + tenant resolution without trusting payload
   org_id.** `claimWebhookEvent`/`finishWebhookEvent`
   (`_lib.ts:672-698`) call `billing_claim_webhook_event` /
   `billing_finish_webhook_event`, SQL functions defined
   `infra/db/migrations/017_billing.sql:274-313` that `INSERT ... ON
   CONFLICT` on `(provider, provider_event_id)` — a replayed Stripe event is
   a no-op (`route.ts:89-92` returns `{duplicate:true}` without reprocessing).
   Tenant is resolved via `resolveWebhookOrg` (`_lib.ts:1262-1276`), which
   only trusts `metadataOrgId` as a **fallback**, and only if
   `isUuid(...)` **and** `billing_org_exists()` confirms the org is real
   (`_lib.ts:1272`); the primary paths are `lookupBySubscription` /
   `lookupByCustomer` against `billing_subscriptions` keyed by the
   provider's own customer/subscription id
   (`_lib.ts:641-665`), which are `SECURITY DEFINER` functions
   (`017_billing.sql:210-244`) so they can look up org before RLS scope is
   even set. This matches AGENTS.md rule 1 ("never trust org_id from request
   body") — here it's a webhook payload rather than a client body, and the
   code treats it with equivalent suspicion.

6. **All 4 session-facing billing routes resolve org from session, not
   body/query, and explicitly reject client-supplied org/customer ids.**
   - `GET /api/billing` (`route.ts:23-26`): `requestHasClientOrgId(request)`
     → 400 `CLIENT_ORG_ID_ERROR` before anything else; org comes from
     `getScopedClient()` (`route.ts:29-30`) which derives it from the
     session cookie (`lib/db.ts:42-72`, `parseSessionCookie` → `user.org_id`).
   - `POST /api/billing/checkout` (`checkout/route.ts:30-38`): rejects both
     `org_id`/`orgId` and `customer_id`/`subscription_id` from the body.
   - `POST /api/billing/portal` (`portal/route.ts:24-32`): same two checks.
   - `GET /api/billing/meters` (`meters/route.ts:13-15`): same org_id check.
   `requestHasClientOrgId` (`_lib.ts:294-302`) checks both query string
   (`org_id`/`orgId`) and body; `requestHasClientCustomerId`
   (`_lib.ts:304-307`) checks `customerId`/`customer_id`/`subscriptionId`/
   `subscription_id`. This is a real, tested pattern, not just a comment.

7. **RLS is used correctly, not bypassed with raw pool queries, for all
   tenant-facing reads/writes.** `getScopedClient()` (`lib/db.ts:42-72`) sets
   `app.current_user_id` and `app.current_org_id` at session level via
   `set_config(..., false)` (session-level, not transaction-local — matches
   AGENTS.md's stated pattern) and wraps `client.release()`
   (`wrapClientRelease`, `lib/db.ts:94-127`) to `RESET` both settings before
   the client returns to the pool — so a poisoned/scoped connection can never
   leak org A's scope to org B's next checkout. `getOrgScopedClient(orgId)`
   (`lib/db.ts:79-92`) is the equivalent for background/webhook code that has
   already resolved a trusted org id server-side (used throughout
   `processStripeEvent`/`processRazorpayEvent`, e.g. `_lib.ts:1307`,
   `_lib.ts:1343`, `_lib.ts:1380`). `billing_subscriptions`,
   `billing_invoices`, and `billing_meters` all have `ENABLE ROW LEVEL
   SECURITY` + `FORCE ROW LEVEL SECURITY` + an `org_id = current_setting(...)`
   policy (`017_billing.sql:71-77, 117-123, 168-174`), so even the app's own
   DB role cannot cross tenants by omission. The one exception,
   `billing_webhook_events`, is deliberately **not** FORCE-RLS'd
   (`017_billing.sql:180-183` comment: "org is unknown until the provider id
   is resolved") and is only ever touched via the `SECURITY DEFINER`
   functions, not directly queried by tenant-facing code — an intentional,
   documented design choice rather than an oversight.

8. **Usage-based metering pulls from real usage data, not hardcoded
   numbers.** `refreshOrgMeters` (`_lib.ts:915-1112`) queries: WhatsApp
   conversation count via a real join against `conversations`/`channels`
   scoped to the org (`_lib.ts:928-939`), seat count via `COUNT(*) FROM
   users WHERE org_id = $1` (`_lib.ts:941-945`), and LLM cost via the real
   Langfuse public API (`lib/org-cost.ts:284-357`, `fetchOrgWeeklyCost`),
   which paginates `/api/public/traces` and sums `totalCost`/
   `calculatedTotalCost` per trace — and **deliberately throws**
   (`LangfuseUnavailableError`) rather than returning a fabricated `$0` when
   Langfuse is down (`org-cost.ts:1-5` docstring, `org-cost.ts:240-253`).
   The UI surfaces this honestly: `apps/dashboard/app/(dashboard)/billing/
   page.tsx:220-225` shows "No fabricated $0 total" when `llmError` is set.

9. **Soft/hard usage caps are env-configurable and computed correctly.**
   `meterCaps()` (`_lib.ts:260-276`) and `overFlags()`
   (`_lib.ts:895-903`) compute `overSoft`/`overHard` per meter kind; caps are
   persisted per-period in `billing_meters` (`upsertMeter`,
   `_lib.ts:837-879`) with a real `ON CONFLICT (org_id, period_start,
   meter_kind)` upsert.

10. **Role gating on billing mutations.** `requireBillingManager`
    (`_lib.ts:157-166`) is called in both `checkout/route.ts:67` and
    `portal/route.ts:38` and returns 403 for `member`/`auditor` roles via
    `canManageBilling` (`_lib.ts:142-155`), consistent with the RBAC roles
    defined in `lib/rbac.ts`.

---

## What's broken (file:line, exact symptom)

1. **`usageBlocked` is computed but never enforced anywhere that matters.**
   `refreshOrgMeters` returns `usageBlocked: llmFlags.overHard ||
   waMeterFlags.overHard` (`_lib.ts:1110`), and the only two places this
   value is referenced in the whole dashboard app are
   `apps/dashboard/app/api/billing/route.ts:82` (returned in the JSON
   response) and `apps/dashboard/app/(dashboard)/billing/page.tsx:210-217`
   (renders a red banner). A repo-wide grep for `usageBlocked` outside the
   billing route/page returns zero hits — it is **not** checked in
   `services/workflows/src/tool-executor.ts`, `lib/plan-generator.ts`,
   `app/api/ask-ai/*`, or anywhere in the agent execution path. A tenant
   that hits its hard LLM-cost or WhatsApp cap sees a warning banner on
   `/billing` but the agent keeps running, keeps calling the LLM, and keeps
   accruing cost with no server-side circuit breaker. This is the single
   most consequential gap in the whole billing domain: the enforcement half
   of "usage-based billing" doesn't exist, only the observability half.

2. **No cancel-subscription endpoint; cancellation is 100% delegated to the
   Stripe billing portal, and Razorpay has none at all.**
   `find apps/dashboard/app/api/billing -type f` lists exactly `route.ts`,
   `checkout/route.ts`, `meters/route.ts`, `portal/route.ts`, and `_lib.ts`
   — there is no `cancel/route.ts` or equivalent. `assertPortalReady()`
   (`_lib.ts:363-369`) only checks `stripeSecretKey()`, and
   `portal/route.ts:50-51` only ever looks up a Stripe
   `provider_customer_id` (`subs.find((s) => s.provider === 'stripe')`).
   Razorpay subscriptions created via `createRazorpaySubscription`
   (`_lib.ts:1216-1260`) have **no** downgrade, upgrade, or cancel path
   anywhere in this codebase — a Razorpay-paying customer who wants to
   cancel or change plans has no in-app mechanism at all.

3. **Checkout is reused as the only "plan change" mechanism — no explicit
   upgrade/downgrade flow, no proration awareness.**
   `POST /api/billing/checkout` (`checkout/route.ts:27-153`) always creates
   a brand-new Checkout Session / Razorpay subscription
   (`createStripeCheckout`/`createRazorpaySubscription`) even when the org
   already has an active subscription for that provider (it looks up the
   existing `customerId` at line 71-73 but does nothing else with the
   existing subscription state). There is no `stripe subscriptions.update`
   call anywhere in `_lib.ts` (grep for `subscriptions/` finds only
   `/checkout/sessions` and `/customers`), so an org upgrading from
   `starter`→`growth` gets a second, parallel Stripe Checkout flow rather
   than a modify-in-place with proration. This will silently create
   duplicate/conflicting subscriptions for the same org+provider unless
   Stripe's own customer-level de-dup catches it (it will not, since a new
   Checkout Session is not tied to the existing subscription id).

4. **`invoice.finalized` webhook event is parsed and classified but its
   business effect is identical to `invoice.paid`/`invoice.payment_failed`
   with `failed=false`** — `_lib.ts:1362-1411`: `case 'invoice.paid':
   case 'invoice.payment_failed': case 'invoice.finalized': { ... const
   failed = kind === 'invoice.payment_failed'; ... }`. A `finalized`
   invoice (issued but not yet paid — Stripe's "open" state) is written to
   `billing_invoices` with `status = mapInvoiceStatus(asString(data.status),
   false)` (line 1387), which for a fresh invoice is usually `'open'`
   (`mapInvoiceStatus`, `_lib.ts:615-631`) — that part is fine — but no
   dunning action (reminder, grace-period countdown, in-app notice) is
   triggered on this event; it's purely a DB row update. There is no
   distinct handling for "invoice created and awaiting payment" vs "invoice
   paid" beyond the raw status string reaching the UI table.

5. **No audit log of billing/settings changes.** Repo-wide grep for
   `audit_log`/`auditLog` under `apps/dashboard/app`, `apps/dashboard/lib`,
   and `infra/db/migrations` returns **zero matches**. Plan changes
   (`billing_set_org_plan`, `017_billing.sql:315-330`), subscription
   upserts, and seat changes are not written to any audit trail — only the
   current-state row in `billing_subscriptions` is kept (old values are
   simply overwritten by the `ON CONFLICT ... DO UPDATE` in
   `upsertSubscription`, `_lib.ts:749-777`). If a webhook is replayed with
   stale seat/plan data due to out-of-order delivery, there is no way to
   reconstruct what changed and when from billing tables alone (though
   `billing_webhook_events` retains event history — see What's missing).

6. **`billing_invoices` upsert has a `WHERE` clause on the `ON CONFLICT
   ... DO UPDATE` that references `EXCLUDED.org_id`, which is a
   near-guaranteed no-op safeguard rather than real protection.**
   `_lib.ts:806-819`:
   ```sql
   ON CONFLICT (provider, provider_invoice_id)
   DO UPDATE SET ...
   WHERE billing_invoices.org_id = EXCLUDED.org_id
   ```
   Since `provider_invoice_id` is unique per provider and always belongs to
   one org, `EXCLUDED.org_id` will always equal the existing row's org_id in
   practice (the conflict target already identifies the same invoice) — this
   clause reads like a tenant-isolation guard but doesn't actually add one;
   if a caller ever passed a mismatched `orgId` for an existing
   `provider_invoice_id`, the `WHERE` silently skips the update (invoice
   status desyncs) rather than raising or logging an error. Low severity,
   but a silent skip on data-integrity mismatch (no error, no log) is worth
   flagging per the "no silently-ignored failure" rule.

7. **Active Subscription Demotion to `incomplete` on Checkout Initiation (`apps/dashboard/app/api/billing/checkout/route.ts:121-134` & `_lib.ts:754-762`) (P0)**:
   - *User Impact*: Instant loss of paid tier features. If an active paying Pro/Growth subscriber visits the checkout flow (e.g. to preview Enterprise pricing or explore upgrading), their existing active subscription in `billing_subscriptions` is immediately overwritten with `status = 'incomplete'`. Because `hasActiveSubscription()` checks `status === 'active' || status === 'trialing'`, the paying customer is immediately locked out of their paid features and demoted to the Free tier, even if they close the checkout tab without paying!
   - *Code Cause*: `checkout/route.ts:123` calls `upsertSubscription(write.client, { ..., status: 'incomplete', planKey: plan })`. In `_lib.ts:754`, the upsert statement blindly overwrites the active subscription:
     ```sql
     ON CONFLICT (org_id, provider) DO UPDATE SET
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, billing_subscriptions.provider_customer_id),
       provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, billing_subscriptions.provider_subscription_id),
       plan_key = EXCLUDED.plan_key,
       status = EXCLUDED.status,
       seats = EXCLUDED.seats,
     ```
     It contains no conditional check to preserve `status = 'active'` when `EXCLUDED.status = 'incomplete'`.
   - *Fix*: The upsert MUST preserve active subscriptions or store draft checkout sessions in a separate table:
     ```sql
     ON CONFLICT (org_id, provider) DO UPDATE SET
       status = CASE 
         WHEN billing_subscriptions.status = 'active' AND EXCLUDED.status = 'incomplete' THEN billing_subscriptions.status 
         ELSE EXCLUDED.status 
       END,
       plan_key = CASE 
         WHEN billing_subscriptions.status = 'active' AND EXCLUDED.status = 'incomplete' THEN billing_subscriptions.plan_key 
         ELSE EXCLUDED.plan_key 
       END,
       seats = CASE 
         WHEN billing_subscriptions.status = 'active' AND EXCLUDED.status = 'incomplete' THEN billing_subscriptions.seats 
         ELSE EXCLUDED.seats 
       END
     ```

8. **`POST /api/billing/portal` 404s on Razorpay Subscriptions (`apps/dashboard/app/api/billing/portal/route.ts:50-64`) (P1)**:
   - *User Impact*: Razorpay customers clicking "Manage Subscription" receive a raw HTTP 404 `Customer not found on Stripe` error.
   - *Code Cause*: `portal/route.ts` hardcodes a filter `subs.find((s) => s.provider === 'stripe')`. Because Razorpay lacks an out-of-the-box hosted customer portal like Stripe, the route simply fails instead of rendering an in-app management dialog for Razorpay invoices and payment methods.

---

## What's missing vs full product vision

- **No self-serve upgrade/downgrade with proration** — see broken #3.
  A paying SaaS customer expects "change plan" to modify the existing
  subscription in place (Stripe `subscriptions.update` with
  `proration_behavior`), not start a second checkout.
- **No self-serve cancel for Razorpay**, and Stripe cancel only exists via
  redirecting into Stripe's hosted portal (no in-app "cancel at period end"
  toggle backed by `subscriptions.update({cancel_at_period_end: true})`).
- **No enforcement of hard usage caps** — see broken #1. This is the gap
  between "meters exist" and "usage-based billing" in the full sense: caps
  are advisory only.
- **No dunning sequence.** A `past_due`/`unpaid` subscription
  (`SubscriptionStatus`, `_lib.ts:48-55`) changes DB state
  (`upsertSubscription`, called from `invoice.payment_failed` handling,
  `_lib.ts:1396-1406`) but there is no reminder email, no escalating grace
  period, and no automatic downgrade-to-free after N days unpaid — the org
  simply sits in `past_due` indefinitely with billing access unaffected
  (again tying back to gap #1: nothing reads subscription status to gate
  access either).
- **No seat-enforcement at signup/employee-add time.** `seatMax()`
  (`_lib.ts:222-224`) is only checked in `checkout/route.ts:50-51` (how
  many seats you may *purchase*); nothing in `apps/dashboard/app/api/
  employees/route.ts` (or wherever users/employees are added) checks
  current `seatsUsed` against the org's purchased seat count before adding
  a new user — i.e., an org can have more active users than seats they pay
  for, and the only visibility is the `seats` meter's `overSoft`/`overHard`
  flags on the billing page.
- **No webhook retry/backoff visibility.** `billing_webhook_events` records
  status (`received`/`processed`/`ignored`/`error`) but nothing surfaces
  `error`-status events to an operator (no alerting, no admin UI to list
  failed webhook applies) — a persistently failing webhook (e.g. a
  transient DB error inside `processStripeEvent`) is invisible outside
  server logs (`console.error`, `webhooks/billing/route.ts:100`).
- **No invoice PDF/download beyond `hosted_invoice_url`** passthrough (this
  is arguably fine since Stripe hosts it, but Razorpay's
  `invoiceEntity.short_url` (`_lib.ts:1479`) is only stored for
  `subscription.charged`/`subscription.pending`, not for every invoice
  event Razorpay could send).
- **No team/org billing history export** (CSV/PDF statement of invoices
  across a date range) — only the last 50 invoices via `listInvoices`
  (`_lib.ts:1114-1125`, `LIMIT 50`, no pagination).

*(Team invites, RBAC roles, and SSO already exist elsewhere in the repo —
`apps/dashboard/app/api/auth/invite/[token]/route.ts`,
`apps/dashboard/app/api/auth/sso/[provider]/route.ts`,
`apps/dashboard/lib/rbac.ts` — so they are not billing-domain gaps; noted
here only to avoid over-claiming they're missing product-wide.)*

---

## What to add for full SaaS

1. **P0-adjacent: wire `usageBlocked` into the actual execution path.**
   Add a check in `services/workflows/src/tool-executor.ts` (or the
   `ask-ai` classify/execute entrypoints) that calls `refreshOrgMeters`
   (or a cheaper cached read of `billing_meters`) before running a paid LLM
   call, and short-circuits with a clear "usage cap reached, upgrade or
   contact billing" response when `overHard` is true. This turns the
   existing meter infrastructure into real usage-based billing enforcement
   instead of a dashboard-only warning.
2. **Real upgrade/downgrade endpoint** (`PATCH /api/billing/subscription` or
   similar): call Stripe `subscriptions.update` on the existing
   `provider_subscription_id` with the new price + `proration_behavior:
   'create_prorations'`, and the Razorpay equivalent
   (`subscriptions.update`/cancel-and-recreate, since Razorpay's plan change
   model differs) — gated by `requireBillingManager` like checkout/portal
   already are.
3. **Real cancel endpoint** for both providers: `DELETE
   /api/billing/subscription` → Stripe `subscriptions.update({
   cancel_at_period_end: true })` or `subscriptions.cancel`, Razorpay
   `subscriptions.cancel`. Currently Razorpay orgs are stuck.
4. **Dunning workflow**: on `invoice.payment_failed` /
   `subscription.pending`/`halted`, schedule a Temporal workflow (matching
   the existing Temporal usage pattern in `services/workflows`) that sends
   a reminder email (`lib/mail.ts` already exists) at set intervals and
   auto-downgrades to `free` after a configurable grace period if still
   unpaid — reusing `setOrgPlan`/`billing_set_org_plan` which already exists
   for this exact purpose.
5. **Seat enforcement at user-add time**: when adding a user/employee to an
   org (wherever that route lives), query `billing_meters` (kind=`seats`)
   or re-derive `seatsUsed` and block/soft-warn against the org's purchased
   seat count from `billing_subscriptions.seats`, not just the meter
   display.
6. **Audit trail for billing-relevant changes**: a `billing_audit_log` (or
   generic `audit_log`) table recording who/when/what for plan changes,
   subscription upserts, and manual admin overrides — the
   `billing_webhook_events` table already captures raw event history for
   provider-triggered changes; extend the same idea to human-triggered
   actions (checkout initiated, portal opened, plan changed by X).
7. **Alerting on `billing_webhook_events.status = 'error'`**: a periodic
   sweep (matching the "kickPeriodicSweeps" pattern already used in
   `lib/employee-provision.ts`) that pages/alerts on repeated webhook apply
   failures so a broken billing sync doesn't go unnoticed.
8. **Invoice history pagination** beyond the current hardcoded `LIMIT 50`
   in `listInvoices` (`_lib.ts:1114-1125`).

---

## Fix priority

**P0**
- Active subscription demoted to `incomplete` on checkout visit (`apps/dashboard/app/api/billing/checkout/route.ts:121-134` & `_lib.ts:754-762`) (What's broken #7) — paying subscribers visiting checkout immediately lose paid access. Guard SQL upsert with `CASE WHEN billing_subscriptions.status = 'active' THEN billing_subscriptions.status`.
- `usageBlocked` not enforced anywhere in the execution path (What's
  broken #1) — orgs can exceed hard usage caps indefinitely with zero
  server-side stop, meaning the "hard cap" promise on the billing page is
  currently false.
- No cancel path for Razorpay subscriptions at all (What's broken #2) —
  a paying customer on that provider cannot self-serve cancel, a real
  compliance/support-burden risk for a billing system.

**P1**
- Checkout-as-upgrade creates parallel subscriptions instead of modifying
  in place (What's broken #3) — will cause billing data drift/double-charge
  risk once a customer tries to upgrade rather than cancel-and-resubscribe.
- `POST /api/billing/portal` 404s for Razorpay subscriptions (What's broken #8) — render an in-app portal for Razorpay customers.
- No dunning/grace-period handling — `past_due` orgs are functionally
  unaffected and un-notified (What's missing).
- No audit trail of plan/subscription changes (What's broken #5 / What's
  missing #6) — makes any billing dispute or incident post-mortem harder
  than it needs to be given the RLS/security care taken everywhere else.
- No seat enforcement at add-user time (What's missing) — seats meter is
  purely informational.

**P2**
- `invoice.finalized` handling is functionally identical to
  paid/payment_failed with no distinct dunning trigger (What's broken #4).
- Invoice list hardcoded to `LIMIT 50` with no pagination.
- The `EXCLUDED.org_id` WHERE clause in `upsertInvoice` is a no-op safeguard
  that silently no-ops instead of failing loud on a real mismatch (What's
  broken #6).
- No alerting on failed webhook applies beyond `console.error`.
