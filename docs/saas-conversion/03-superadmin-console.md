# 03 — Superadmin console

A platform surface for Darex operators. It is not an org-admin page with a wider query. Org owners keep `/settings`, `/billing`, `/api/org/kill-switch`, and `/api/org/rollout` (those routes already require `canManageOrgSettings`).

Route group `apps/dashboard/app/(platform)/admin/...` and API `apps/dashboard/app/api/platform/...` exist. Gate via `requirePlatformAdmin` + migration `119` (not applied on live DB).

## Gate

Route group: `apps/dashboard/app/(platform)/admin/...`.
API: `apps/dashboard/app/api/platform/...`.

`apps/dashboard/middleware.ts` today allows any signed session cookie through (`middleware.ts:29-38` for APIs, `:44-49` for pages). Add a branch:

- `/admin` and `/api/platform` require a session user who has a `platform_admins` row.
- Lookup is `SELECT platform_role FROM platform_admins WHERE user_id = app.current_user_id` on the normal `darex_app` pool, using the self-row policy from migration `119`. That query does not set a foreign `app.current_org_id` and does not call `getScopedClient()` to read another org.
- Everyone else gets 404 on the page and 403 on the API. The response body does not say whether the user failed the role check or the path is unknown.
- A normal org session that also belongs to a customer org can still use the product. Opening `/admin` is the only place `platform_role` applies.

Cross-org data uses a second pool logged in as `darex_platform` (password from env, never committed). Each request starts a transaction, calls `platform_begin(...)` ([02](02-data-model-migrations.md)), then runs the read or write, then commits. A handler that calls `getScopedClient()` for a cross-org read is a bug.

Dedicated hostname (for example `admin.`) is optional. **Human blocker:** DNS and a certificate for that hostname. The path-based console ships without it. Until DNS exists, this row stays 🔴 and the path console is a separate row.

## Roles on the platform

| `platform_role` | Directory, search, drill-in | Suspend, disconnect, revoke | Overrides | Impersonation |
|-----------------|-----------------------------|-----------------------------|-----------|---------------|
| `support` | yes | no | no | yes, consent path only |
| `operator` | yes | yes | yes | yes, including break-glass |

Both roles write `admin_audit_log` for every cross-org read and write, including directory page loads (action `org.list` / `org.read`, reason required, a short preset such as `directory` is enough for reads). Kill switches require a free-text reason of at least 12 characters.

The first `platform_admins` row is inserted by a human with superuser SQL. Signup cannot create one.

## Directory (read-only)

`GET /api/platform/orgs`.

Columns: org name, slug, `orgs.status`, `orgs.plan`, subscription status, seat count versus seat cap, last `audit_events.created_at` or last `messages.created_at` as last activity, count of `org_connectors` in `connected`, dunning flag (`billing_subscriptions.dunning_grace_ends_at`), `suspended_by`.

Health for the row is the org's latest observability alert count when a daily snapshot exists, otherwise `unknown`. It is never a hardcoded healthy zero. Platform-wide process health is `GET /api/health/ready`, linked from the console header, not recomputed per org ([05](05-observability-monitoring.md)).

**Ship class: read-only.** Still audited.

## Drill-in (read-only, plus actions below)

`GET /api/platform/orgs/:orgId`.

- Members: `organization_memberships` role, email, `users.session_epoch`, last login if present on `audit_events` kind `login`.
- Usage: `billing_meters` for the open period, Langfuse cost via the existing `org-cost.ts` helper (throw / `unknown` when Langfuse is down, same as the billing page).
- Errors: count of `failed_webhooks` for that `org_id` plus unresolved NULL rows only on this audited screen.
- Org audit: last page of `audit_events` for that org, same redaction as `GET /api/audit-logs` (`apps/dashboard/app/api/audit-logs/route.ts:7-20`).
- Platform audit: `admin_audit_log` rows whose `target_org_id` is this org.
- Billing health: plan, provider, subscription status, grace end, last invoice status. Payment method edits are a link out ([04](04-billing-plans.md)).

**Ship class: read-only.**

## Search (read-only)

`GET /api/platform/search?q=`.

Match one of:

- user email, case-insensitive, exact or prefix on `users.email`
- org name or slug, substring
- connector id: `org_connectors.nango_connection_id` or the connector definition id stored on the row

Results are org cards, not raw webhook bodies. Each search writes one audit row (`platform.search`, reason = the query string, truncated). Cap 50 rows.

**Ship class: read-only.**

## Incident controls

Each of these is **human confirmation required before it can ship**. The UI asks for a reason, shows the target org name and id, and requires an explicit confirm control. The API rejects a missing `confirm: true` and a reason shorter than 12 characters. The audit insert happens in `platform_begin` before the mutation.

| Control | API | Effect | Who |
|---------|-----|--------|-----|
| Suspend org | `POST /api/platform/orgs/:orgId/suspend` | `status = suspended`, `suspended_by = platform`, `suspended_at = now()` | operator |
| Clear platform suspension | `POST /api/platform/orgs/:orgId/unsuspend` | Sets `active` only when `suspended_by = platform`. Refuses when status is `soft_deleted`. | operator |
| Force-disconnect connector | `POST /api/platform/orgs/:orgId/connectors/:id/disconnect` | Same local + Nango delete the product already runs in `apps/dashboard/app/api/integrations/route.ts` (`action === 'disconnect'` at line 331), invoked server-side with the platform transaction's org, plus `admin_audit_log` action `connector.force_disconnect`. Also writes the existing org `audit_events` kind `connector.disconnect` so the customer audit page shows it. | operator |
| Revoke sessions | `POST /api/platform/orgs/:orgId/users/:userId/revoke-sessions` | Increments `users.session_epoch` (migration `121`). Outstanding HMAC cookies for that user fail `getScopedClient`. | operator |
| Soft-delete org | `POST /api/platform/orgs/:orgId/soft-delete` | `status = soft_deleted`, `deletion_requested_at = now()`, then `scheduleOrgPurge` (known Temporal + connectors + listed memory tables; not a full Cognee wipe). | operator |

There is no silent variant and no query-string override that skips confirm.

Org-level autonomy kill switch (`POST /api/org/kill-switch`) stays an org-admin control. The platform drill-in also flips `org_runtime_controls.kill_switch` via `POST /api/platform/orgs/:orgId/kill-switch` behind `ConfirmReasonDialog` (operator-only; support hides the buttons). It does not replace suspend.

## Overrides

`PUT /api/platform/orgs/:orgId/overrides` writes `org_plan_overrides` inside `platform_begin`.

- `seat_cap`: integer ≥ 1 or null (null means "use the subscription").
- `meter_caps`: object whose keys are the existing meter kinds (`llm_tokens`, `whatsapp_conversations`, `seats`, `embeddings`, `successful_actions`, `disconnected_actions`). Values are `{ soft, hard }`. The usage gate reads them ahead of `DAREX_METER_*`.
- `feature_flags`: string keys to booleans. Allowed keys ship as a const in the dashboard, not free-form JSON from the client. Unknown keys 400.

**Human confirmation required before ship** when the change raises a hard cap above the plan default, sets a flag the registry marks `safety`, or clears `seat_cap` upward. Lowering a cap is operator-confirmed too (same dialog). A flag must not disable `platform_audit_ok`, RLS, or the confirm field. Those are not flags.

Drill-in ships a writable overrides form (seat cap, soft/hard meter caps, registry feature flags) behind confirm for operators; support sees read-only values. Session product code reads flags via `lib/org-feature-flags.ts`.

## Impersonation

**Human confirmation required before it can ship.**

`POST /api/platform/impersonation`.

1. `platform_begin` with action `impersonation.start`, target user, target org, reason.
2. Insert `impersonation_sessions` with `expires_at` ≤ now + 30 minutes, `audit_id` from step 1.
3. Consent path (`support` and `operator`): `consent_recorded_at` is set only when the org has an explicit support-access opt-in stored on `orgs` (column added with this feature: `support_access_enabled boolean not null default false`, owner-toggled in `/settings`). Missing opt-in → 403.
4. Break-glass (`operator` only): `break_glass = true`, reason ≥ 12 characters, confirm dialog states that the org has not opted in. Still banners. Still expires in 30 minutes.
5. The response sets a session cookie for the **target** user via the epoch-aware signer, plus an httpOnly `darex_impersonation` cookie holding the session id. The platform admin's own browser is now that user until expiry or `POST /api/platform/impersonation/end`.
6. Dashboard shell, for any session whose user id matches an open `impersonation_sessions` row (the target-read policy in `121`), renders a persistent banner: who is impersonating, when it ends, and that actions are logged. The banner is visible to the impersonated user if they are also logged in elsewhere, because the row is readable by `target_user_id`.
7. End, expiry, or epoch revoke sets `ended_at` and increments `session_epoch` so the impersonation cookie dies.

`support` cannot set `break_glass`. The API rejects it even if the UI is bypassed.

## What is not in the console

- Editing a card, bank account, or Stripe customer. Link to the processor dashboard ([04](04-billing-plans.md)).
- Creating a customer org on behalf of a stranger without the normal signup path.
- `BYPASSRLS`, `SET row_security = off`, or running as `darex`.
- Reading `password_reset_tokens` or `billing_webhook_events` raw secrets. Those stay deny-all.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Middleware is session-only | — | `apps/dashboard/middleware.ts:12-67` | 🟢 Done | Correct for product pages. Platform branch is row 2. |
| 2 | `/admin` + `/api/platform` gated by `platform_admins` | P0 | `middleware.ts:12-18`; `lib/platform-admin.ts` `requirePlatformAdmin`; `app/(platform)/admin/` | 🟢 Done | Edge middleware: session only. Routes call `requirePlatformAdmin` (403). UI shows forbidden when not admin. |
| 3 | `darex_platform` pool + `platform_begin` on every cross-org call | P0 | `lib/platform-db.ts` | 🟢 Done | Separate pool; 503 when unconfigured / `platform_begin` missing. No `getScopedClient` for other orgs. |
| 4 | Directory, drill-in, search | P1 | `api/platform/orgs/route.ts`; `orgs/[orgId]/route.ts`; `search/route.ts`; `admin/page.tsx`; `admin/orgs/[orgId]/page.tsx` | 🟢 Done | Audited APIs + UI. Drill-in: kill-switch confirm, overrides form (seat / soft-hard / flags). Support hides operator buttons. Health unknown rather than fake 0. |
| 5 | Suspend, unsuspend, soft-delete | P1 | `api/platform/orgs/[orgId]/{suspend,unsuspend,soft-delete}/route.ts` | 🟢 Done | Confirm + reason ≥ 12; `suspended_by = platform`. Soft-delete schedules `org-purge` after commit. |
| 6 | Force-disconnect connector | P1 | `api/platform/orgs/[orgId]/connectors/[id]/disconnect/route.ts` | 🟢 Done | Platform wrapper + confirm. Product disconnect still for org session. |
| 7 | Revoke sessions | P1 | `api/platform/orgs/[orgId]/users/[userId]/revoke-sessions/route.ts`; `session-cookie.ts` | 🟢 Done | Increments `users.session_epoch`. Confirmation required. |
| 8 | Plan overrides API + drill-in form | P1 | `api/platform/orgs/[orgId]/overrides/route.ts`; `admin/orgs/[orgId]/page.tsx`; `lib/org-feature-flags.ts`; `120_*.sql` | 🟢 Done | Seat / soft-hard / flags form behind confirm. Session org reads flags via `org-feature-flags.ts`. |
| 9 | Impersonation + banner | P1 | `api/platform/impersonation/**`; `ImpersonationBanner.tsx`; `121_*.sql` | 🟢 Done | Epoch-aware cookie; 30-min cap; break-glass operator-only; banner honest-empty. |
| 10 | Admin subdomain | P2 | DNS | 🔴 Blocked | Human: hostname and certificate. Path `/admin` does not wait. |
| 11 | First operator row | P0 | `platform_admins` | 🔴 Blocked | Human: superuser insert with a named person and reason. Signup must not create it. |
| 12 | `org_runtime_controls` platform_audit_ok + kill-switch UI | P1 | `122_platform_runtime_controls_audit.sql`; `api/platform/orgs/[orgId]/kill-switch`; drill-in page | 🟢 Done | Kill-switch UPSERT under audited platform role; drill-in confirm UI for operators. Not applied on live DB. |
