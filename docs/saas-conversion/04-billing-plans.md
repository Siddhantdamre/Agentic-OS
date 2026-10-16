# 04 — Billing and plans

Darex already bills itself through Stripe and Razorpay. This file maps the SaaS control plane onto that stack. A second payment integration, a stored card, or a superadmin "edit payment method" form is out of scope.

Org Stripe and Razorpay **connectors** (payment links the employees send) stay in the tool executor. They are not Darex's subscription. `017_billing.sql` lines 1–6 already draw that line.

## Plans (keep these keys)

`orgs.plan` and `billing_subscriptions.plan_key` allow `free | starter | growth | enterprise` (`017_billing.sql:21-24` and `:50-52`). Checkout plans are `starter | growth | enterprise`. `free` is the unpaid default and the dunning downgrade target.

Amounts, currency, Stripe price ids, and Razorpay plan ids come from env inside `catalogPlans()` (`apps/dashboard/app/api/billing/_lib.ts:399-406`). The repo does not hardcode live prices. **Human blocker:** production `STRIPE_SECRET_KEY` (or the env name the `_lib` reader already uses), `STRIPE_WEBHOOK_SECRET`, a price id per paid plan, and the Razorpay key id, secret, and plan ids. Missing ids stay null in the catalog. Do not invent price ids to mark this row done.

## Meters (keep these kinds)

`billing_meters.meter_kind` (`017_billing.sql:150-158`):

| Kind | Source today | What it measures |
|------|----------------|------------------|
| `llm_tokens` | `langfuse` | LLM usage. Cost dollars come from `apps/dashboard/lib/org-cost.ts`, which throws when Langfuse is down instead of returning `$0`. |
| `whatsapp_conversations` | `conversations` | Conversation count for the org. |
| `seats` | `users` | `COUNT(*)` of users on the org, compared with `billing_subscriptions.seats`. |
| `embeddings` | `env` / meter row | Embedding volume against env caps. |
| `successful_actions` | meter row | Actions that completed. |
| `disconnected_actions` | meter row | Actions that returned not-connected. Distinct from success. |

Soft and hard caps are env `DAREX_METER_*` via `meterCaps()`, stored on the meter row. `assertUsageAllowed` blocks tool execution when a hard cap is exceeded (`services/workflows/src/tool-executor.ts:231`). Ask AI returns 402 on the same gate. Invite-time seats use `checkSeatAvailability` (`apps/dashboard/app/api/settings/route.ts:180`).

Per-org overrides (`org_plan_overrides`, migration `120`) are read before the env cap. They do not create a new meter kind.

## Flows that already exist

| Flow | Route | Behavior to keep |
|------|-------|------------------|
| Read plan, invoices, meters, dunning, billing audit | `GET /api/billing` (`billing/route.ts:24`) | Session org. Rejects client `org_id`. |
| New subscription | `POST /api/billing/checkout` (`checkout/route.ts:32`) | Stripe Checkout or Razorpay subscription. Owner/admin via `requireBillingManager` (`_lib.ts:159-166`). |
| Change paid plan in place | `PATCH /api/billing/subscription` (`subscription/route.ts:30`) | Stripe proration. Razorpay schedule change. |
| Portal and cancel | `POST /api/billing/portal` (`portal/route.ts:49`) | Stripe billing portal. Razorpay in-app manage. `action=cancel` for both. |
| Provider events | `POST /api/webhooks/billing` | Signature before JSON. Idempotent `billing_webhook_events`. Org resolved from provider customer/subscription id, with metadata org id only as a checked fallback. |
| Dunning | `applyDunningState` (`_lib.ts:1266-1317`) | Grace from `DAREX_BILLING_DUNNING_GRACE_DAYS` (default 7, `_lib.ts:1260`). Writes `billing_audit_log` actions `dunning_entered` and `downgrade_to_free`. |

`billing_audit_log` actions (`104_billing_packs_gaps.sql:17-26`): `checkout_started`, `plan_changed`, `cancel_requested`, `cancel_immediate`, `portal_opened`, `dunning_entered`, `dunning_cleared`, `downgrade_to_free`. That table stays the customer billing trail. `admin_audit_log` is a different table for platform staff.

## Lifecycle wiring still missing

`applyDunningState` updates the subscription, `orgs.plan`, and `orgs.status`
(`past_due` while grace open; `suspended` + `suspended_by = 'dunning'` when
grace elapsed; clears only dunning suspensions on recovery).

When this ships with migration `116`:

1. Subscription enters `past_due` or `unpaid`, grace still open: `orgs.status = 'past_due'`. Session stays allowed. The billing page keeps the dunning banner.
2. Grace elapsed: existing `setOrgPlan(orgId, 'free')` plus `orgs.status = 'suspended'`, `suspended_by = 'dunning'`, `suspended_at = now()`. Session becomes 402 except billing routes (`allowSuspended`).
3. Subscription returns to `active` or `trialing`: clear grace, `billing_audit_log` `dunning_cleared` (already the action name). Set `orgs.status = 'active'` only when `suspended_by` is `dunning` or status is `past_due`. A `platform` suspension stays until an operator unsuspends ([03](03-superadmin-console.md)).

Upgrade: paid → higher paid stays the in-place PATCH. `free` → paid stays Checkout. Downgrade: PATCH where the provider supports proration; otherwise portal. Cancel: portal `action=cancel`, `cancel_at_period_end` on the subscription row. At period end the webhook moves the plan to `free` and status to `active` (a cancelled paid plan is a free active org, not a suspended one), unless dunning already suspended it.

Trial: `billing_subscriptions.status = 'trialing'` and `current_period_end`. `orgs.status` stays `active` during trial. No new `orgs.status = 'trial'` value.

Seat changes: checkout and subscription updates already persist `billing_subscriptions.seats`. The invite gate counts users against that number. A platform `seat_cap` override, when non-null, is the hard ceiling even if the subscription quantity is higher. Raising it is confirmation-gated.

## What the superadmin console shows

Drill-in billing block, all read-only, all behind `platform_begin`:

- `orgs.plan`, subscription `status`, `seats`, `cancel_at_period_end`, `dunning_grace_ends_at`, provider (`stripe` or `razorpay`)
- last invoices (status, amount, period), from `billing_invoices`
- open meter quantities versus soft/hard, including overrides
- last `billing_audit_log` rows for that org

Payment method, invoices PDF, and refunds: link to the processor. Stripe link uses `provider_customer_id` when present: `https://dashboard.stripe.com/customers/{provider_customer_id}`. Razorpay link uses the subscription id on the Razorpay dashboard. The console never receives or stores PAN, CVC, or bank details. If the provider customer id is null, the link is omitted and the UI says the org has no processor customer.

Operators do not call `POST /api/billing/checkout` or portal on the customer's behalf. Comping a plan is an `org_plan_overrides` plus, if a real subscription must change, a human doing it in the processor dashboard. A "set plan without the processor" write is not a console feature.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Plan keys and subscription table | — | `017_billing.sql:21-57` | 🟢 Done | `free/starter/growth/enterprise`. Seats on the subscription. |
| 2 | Meter kinds and usage block | — | `017:150-158`; `tool-executor.ts:231` | 🟢 Done | Six kinds. Hard cap blocks execution. |
| 3 | Checkout, portal, in-place change, cancel | — | `checkout/route.ts:32`; `portal/route.ts:49`; `subscription/route.ts:30` | 🟢 Done | Stripe and Razorpay. Owner/admin gate. |
| 4 | Signed webhooks and billing audit | — | `104_billing_packs_gaps.sql:8-44` | 🟢 Done | Dunning grace column and `billing_audit_log`. |
| 5 | Dunning sets org access status | P0 | `billing/_lib.ts` `applyDunningState` (~1268–1381) | 🟢 Done | Writes `past_due` / `suspended`+`dunning`; clears dunning only. Pairs with migration 116. |
| 6 | Platform billing health is read-only | P1 | `api/platform/orgs/[orgId]/route.ts` `paymentMethodLink` | 🟢 Done | Drill-in links out to Stripe/Razorpay. No card form. |
| 7 | Production price ids and API keys | P0 | `billing/_lib.ts` `catalogPlans` | 🔴 Blocked | Human: Stripe secret, webhook secret, price ids; Razorpay key id, secret, plan ids. |
| 8 | `org_plan_overrides` enforced at seat + meter gate | P1 | `services/workflows/src/usage-gate.ts`; `billing/_lib.ts` `checkSeatAvailability` | 🟢 Done | Override hard meter caps and `seat_cap` read before env / subscription ceilings. Missing table → prior behavior. |
