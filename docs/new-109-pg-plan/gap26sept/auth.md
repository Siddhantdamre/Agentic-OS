# Auth Audit

## Status: 🟢 auth hardening closed (rate limits, lockout, MFA TOTP, audit, session rebind)

Core session/login/OAuth/SSO/invite/reset flows are real and functionally wired
end-to-end against Postgres and (for SSO) SuperTokens' `ThirdParty` recipe with
real token exchange. However: SuperTokens `EmailPassword`/`Session` recipes are
initialized but **not actually used** for the primary session mechanism (a
custom HMAC cookie is used instead, with SuperTokens calls wrapped in
try/catch fallbacks to Postgres on any failure); there is **no MFA/2FA**
anywhere in the codebase; there is **no rate limiting on login, register,
forgot-password, reset-password, invite, OAuth or SSO endpoints** (brute-force
and password-spray exposed); and audit logging of security events is
inconsistent (only SSO login is audited; password login, OAuth login, invite
accept, and password reset are not).

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

- **Custom signed session cookie, real HMAC-SHA256 verification.**
  `apps/dashboard/lib/session-cookie.ts:66-98` — `signSessionValue()` computes
  `HMAC-SHA256(secret, userId)` via WebCrypto (`crypto.subtle`), cookie value
  is `${userId}.${hmacHex}`. `parseSessionCookie()` re-derives the HMAC and
  compares it with `timingSafeEqualHex()` (constant-time compare,
  `session-cookie.ts:44-51`) before trusting the `userId`. This is a real,
  non-stubbed signing scheme — not a fake/plaintext cookie.

- **Session secret is required in production, no hardcoded fallback shipped.**
  `session-cookie.ts:31-42` — `sessionSecret()` throws
  `'DAREX_SESSION_SECRET (or SUPERTOKENS_API_KEY) must be set in production'`
  when `NODE_ENV=production` and neither var is set. Dev-only fallback
  `'darex-dev-session-secret'` is gated behind the non-production branch.

- **Cookies are httpOnly, sameSite=lax, secure in prod, path scoped.**
  `session-cookie.ts:17-29` (`cookieSecure()` returns `NODE_ENV==='production'`;
  `sessionCookieOptions()` sets `httpOnly:true, secure, sameSite:'lax', path:'/'`).
  Applied uniformly via `applySessionCookies()` (`session-cookie.ts:107-125`),
  used by login/register (`app/api/auth/[[...path]]/route.ts:41-55`), invite
  accept (`app/api/auth/invite/[token]/route.ts:86-90`), OAuth callback
  (`app/api/auth/oauth/callback/[provider]/route.ts:157-170`), and SSO callback
  (`app/api/auth/sso/callback/[provider]/route.ts:145-149`).

- **Centralized auth enforcement at the edge via `middleware.ts`, not
  per-route.** `apps/dashboard/middleware.ts:29-39` — every non-static
  request (including **all** `/api/*` routes) is parsed for the session
  cookie; unauthenticated API requests get a blanket `401` unless the path is
  explicitly allow-listed by `isPublicApiPath()`
  (`lib/session-cookie.ts:153-168`, covers only `/api/health`,
  `/api/webhooks/*`, `/api/widget*`, and the specific `/api/auth/*` sign-in/
  sign-up/session/oauth/sso/invite endpoints). This means the vast majority of
  the 95 API routes get session enforcement for free and don't need to
  individually call `getSession`/`parseSessionCookie` — confirmed only 2 files
  under `app/api/` call `parseSessionCookie` directly
  (`app/api/auth/[[...path]]/route.ts`, `app/api/auth/invite/[token]/route.ts`)
  because the rest rely on `getScopedClient()` (`lib/db.ts:42-72`), which
  itself calls `parseSessionCookie` and throws `'Unauthorized'` if there is no
  valid cookie.

- **Legacy unsigned-cookie bypass is dev-only and explicitly double-gated.**
  `session-cookie.ts:90-96` — an unsigned raw UUID cookie is accepted **only**
  when `NODE_ENV !== 'production'` **and** `ALLOW_LEGACY_UNSIGNED_SESSION==='true'`.
  Comment at `session-cookie.ts:74-77` explicitly calls out that a misconfigured
  `NODE_ENV` alone must not make sessions forgeable — this is a deliberate,
  documented security control, not an oversight.

- **Real OAuth (Google, GitHub, Facebook/Meta, Microsoft) with genuine
  authorization-code exchange and provider userinfo calls.**
  `app/api/auth/oauth/callback/[provider]/route.ts:38-155` — `getUserInfo()`
  does a real `POST` to each provider's token endpoint
  (`getOAuthTokenUrl`, per-provider handling of `grant_type`/`scope` quirks,
  e.g. GitHub omits `grant_type` at `:52`, Microsoft adds
  `scope: 'openid email profile User.Read'` at `:55`), then a real `GET` to
  the provider's userinfo endpoint (Google `:87-94`, GitHub `:96-121`
  including the fallback to `/user/emails` for private-email accounts, Meta
  Graph API `:124-131`, Microsoft Graph `:133-149`). No mocked responses in
  this path when client id/secret are configured.

- **OAuth CSRF/state protection is implemented and checked.**
  `app/api/auth/oauth/[provider]/route.ts:29-41` sets a random 16-byte hex
  `state` in an httpOnly cookie (`oauth_state_${provider}`, 10 min TTL); the
  callback at `app/api/auth/oauth/callback/[provider]/route.ts:200-205`
  requires the cookie state to exist and exactly match the returned `state`
  param, else it redirects to `/login?error=Invalid+OAuth+state`. Same pattern
  for SSO (state cookie `sso_state_${provider}` set at
  `app/api/auth/sso/[provider]/route.ts:65-67`, verified at
  `app/api/auth/sso/callback/[provider]/route.ts:63-67`), plus PKCE code
  verifier round-tripped through a cookie for SSO (`sso/[provider]/route.ts:69-70`,
  consumed at `sso/callback/[provider]/route.ts:71,85-90`).

- **SSO (SAML/OIDC) goes through the real SuperTokens `ThirdParty` recipe, not
  a stub.** `app/api/auth/sso/[provider]/route.ts:49-57` calls
  `ThirdParty.getProvider()` then `tp.getAuthorisationRedirectURL()` — real
  SDK calls, not hardcoded URLs. The callback
  (`app/api/auth/sso/callback/[provider]/route.ts:85-105`) calls
  `tp.exchangeAuthCodeForOAuthTokens()`, `tp.getUserInfo()`, and
  `ThirdParty.manuallyCreateOrUpdateUser()` — genuine SuperTokens SDK usage.
  SAML uses BoxyHQ (`jackson`) as the underlying IdP broker
  (`lib/supertokens.ts:95-115`, `thirdPartyId: 'boxy-saml'`,
  `additionalConfig: { boxyURL }`), which is the standard SuperTokens SAML
  integration pattern, not a home-grown fake.

- **SSO providers are only "configured" (and thus selectable) when real env
  vars are present**, never hardcoded secrets: `lib/supertokens.ts:79-175`
  (`samlConfigured()`, `buildGoogleWorkspacesProvider()`,
  `buildMicrosoftProvider()`, `buildOktaProvider()` all check
  `process.env.*` and return `null` if client id/secret are absent).
  `listSsoProviders()` (`lib/supertokens.ts:191-234`) reports `configured:false`
  for anything unset, and the login page only renders configured providers
  (`app/(auth)/login/page.tsx:33-45`).

- **Production explicitly forbids the SAML test IdP and demo OAuth.**
  `lib/boot-guards.ts:123-130` (`assertProductionSsoConfig` throws if
  `SUPERTOKENS_SAML_TEST_IDP=true` in prod) and
  `lib/boot-guards.ts:44-48` (`assertProductionBoot` throws if
  `ALLOW_DEMO_AUTH=true` in prod). `lib/oauth-providers.ts` `demoAuthAllowed()`
  (referenced from `app/api/auth/oauth/[provider]/route.ts:53`,
  `oauth/callback/[provider]/route.ts:212`) is hardcoded to `false` whenever
  `NODE_ENV==='production'`, independent of the env var — a second, redundant
  guard against demo auto-login ever reaching prod. This is a real,
  security-conscious fail-fast, not a silent stub.

- **Password hashing uses Node's built-in scrypt, real salting, constant-time
  compare.** `lib/password.ts:7-27` — `hashPassword()` uses
  `crypto.scryptSync(password, salt, 64)` with a fresh random 16-byte salt per
  password, stored as `scrypt$<salt>$<hash>`; `verifyPassword()` uses
  `crypto.timingSafeEqual()`. This is a legitimate, standard-library password
  hash, not a fake/plaintext check.

- **Password reset tokens are real, single-use, hashed at rest, time-boxed.**
  `infra/db/migrations/009_auth_tenancy.sql:300-345` —
  `auth_create_password_reset()` inserts a row keyed by `token_hash` (SHA-256
  of a 32-byte random token, `lib/password.ts:29-35`, generated in
  `app/api/auth/forgot-password/route.ts:14-15`) with a 1-hour expiry
  (`forgot-password/route.ts:19`); `auth_consume_password_reset()`
  (migration `:322-345`) takes a row lock (`FOR UPDATE`), rejects
  `RESET_ALREADY_USED` and `RESET_EXPIRED`, and marks `used_at` atomically in
  the same statement that returns the `user_id` — genuine single-use
  semantics, not a no-op.

- **Forgot-password does not leak account existence.** `forgot-password/route.ts:10-12`
  always returns `{status:'OK'}` regardless of whether the email exists or the
  DB lookup fails (`:33-37` catches and swallows lookup errors, logging only
  server-side) — correct anti-enumeration behavior.

- **Invite flow: hashed token, expiry check, email-match enforcement, replay
  protection, and org-conflict handling — all real.**
  `app/api/auth/invite/[token]/route.ts:40-120` (`POST`) requires a valid
  session (`:46-49`), checks `invite.accepted_at` for replay
  (`:57-59`, also enforced atomically in
  `auth_accept_invite()` migration `:220-281` under `FOR UPDATE`), checks
  `inviteExpired()` (`:60-61` and DB-side `:239-241`), enforces the
  accepting user's session email matches the invite email
  (`:68-73`, and DB-side `:247-249` raises `INVITE_EMAIL_MISMATCH`), and
  refuses to silently reassign a user who already has other org members
  (`auth_accept_invite` migration `:250-258`, `USER_ALREADY_IN_ORG`). Invite
  creation (`app/api/settings/route.ts:122-186`) hashes the token
  (`sha256Hex`, `:147`), sets a 7-day TTL (`:15,148`), and is gated by RBAC
  (see below) — not open to any authenticated user.

- **RBAC exists and is enforced for org-management actions.** `lib/rbac.ts`
  defines `owner/admin/member/auditor` roles with explicit capability
  functions (`canManageOrgSettings`, `canReadAudit`, `canDisableEmployee`,
  `canCallPayTools`, `canExportDsr`, `canDeleteDsr`, each an exhaustive
  `switch` with a `never` default — compiler-enforced completeness).
  `app/api/settings/route.ts:98-101` calls `loadHumanRole()` +
  `canManageOrgSettings()` and returns `403 Forbidden` before allowing
  `invite_member`/`update_org`/widget actions — invite creation is **not**
  self-service for `member`/`auditor` roles.

- **`org_id` is never trusted from the request body anywhere in the auth or
  settings surface.** `app/api/settings/route.ts:106-111` explicitly rejects
  a body-supplied `orgId`/`org_id` with a `400`; the same pattern repeats
  across `app/api/org/kill-switch/route.ts:23`, `app/api/org/create/route.ts:77`,
  `app/api/org/rollout/route.ts:23`, `app/api/decisions/route.ts:21`,
  `app/api/insight/route.ts:88`, `app/api/dsr/{delete,export}/route.ts`, and
  `app/api/packs/_lib.ts:19` — org identity is always resolved server-side via
  `getScopedClient()` (`lib/db.ts:42-72`), which derives `orgId` from the
  session-authenticated `userId`, matching the repo-wide rule in `AGENTS.md`
  section 3.1.

- **Row-level tenancy scoping is session-scoped and reset on release, not
  connection-pool-leakable.** `lib/db.ts:65-137` — `getScopedClient()` and
  `getOrgScopedClient()` set `app.current_org_id` via
  `set_config(..., false)` (session-level, not transaction-level) and
  `wrapClientRelease()` wraps `client.release()` to `RESET app.current_org_id`
  before the client returns to the pool — prevents one tenant's scoping from
  leaking to the next request that reuses the same pooled connection.

- **Production DB user is forced to a least-privilege role, never the
  superuser.** `lib/boot-guards.ts:20-36` (`resolveRuntimeDbUser`) throws if
  `DB_USER` is unset or is `darex`/`postgres` in production. Auth-related SQL
  functions (`auth_insert_user`, `auth_lookup_invite_by_token_hash`,
  `auth_accept_invite`, `auth_create_password_reset`,
  `auth_consume_password_reset`) are defined `SECURITY DEFINER` and have
  `REVOKE ALL ... FROM PUBLIC` followed by a narrow `GRANT EXECUTE ... TO
  darex_app` (migration `:351-369`) — the app's runtime DB role cannot query
  `password_reset_tokens`/`org_invites` directly outside these functions'
  validated logic paths (defense in depth beyond RLS).

- **SuperTokens connection URI is mandatory in production.**
  `lib/supertokens.ts:236-244` — `ensureSuperTokensInit()` throws if
  `SUPERTOKENS_CONNECTION_URI` is unset in production (outside the Next.js
  build phase). No silent `localhost:3567` fallback ships to prod.

---

## What's broken (file:line, exact symptom)

- **[SECURITY-SENSITIVE] No rate limiting on any authentication endpoint.**
  `lib/rate-limit.ts:20` defines `RateLimitKind = 'webhook' | 'ask_ai' |
  'embed'` only — there is no `'login'`, `'register'`, `'forgot_password'`,
  `'reset_password'`, `'oauth'`, or `'sso'` kind. Grepping
  `app/api/auth/[[...path]]/route.ts`, `forgot-password/route.ts`,
  `reset-password/route.ts`, `oauth/[provider]/route.ts`, and
  `sso/[provider]/route.ts` shows **zero** calls to
  `consumeOrgRateLimit`/`assertOrgRateLimit`/`denyIfLimited`. The
  login handler (`app/api/auth/[[...path]]/route.ts:160-211`) will attempt an
  unlimited number of `EmailPassword.signIn` + Postgres `verifyPassword`
  calls per IP/email with no backoff, lockout, or CAPTCHA — a working
  brute-force/credential-stuffing vector against every account. Same absence
  on `reset-password` (token-guessing is mitigated by 256-bit token entropy,
  but request volume for `forgot-password` — which sends real email via
  Resend — is also unthrottled, enabling email-bombing of arbitrary users).

- **[SECURITY-SENSITIVE] No account lockout / no failed-login tracking.**
  There is no `failed_attempts`, `locked_until`, or similar column referenced
  anywhere in `infra/db/migrations/009_auth_tenancy.sql` or `lib/auth-user.ts`
  — confirmed by grep, no hits for `lockout|locked_until|failed_attempt`.
  Combined with the rate-limit gap above, an attacker has no friction at all
  against the login endpoint.

- **Dual/parallel auth paths add real complexity and a silent SuperTokens
  fallback that is easy to miss in monitoring.** `app/api/auth/[[...path]]/route.ts:160-211`
  — login first tries `EmailPassword.signIn('public', ...)` (SuperTokens),
  and on **any** thrown error (not just "SuperTokens down") falls back
  silently to a second, independent Postgres-only credential check
  (`:195-211`, only a `console.warn`, no alerting/metric). Register has the
  identical pattern (`:220-305`). This means SuperTokens can be fully broken
  or misconfigured in production and login/signup will keep working via the
  Postgres fallback with no operator visibility beyond log lines — a latent
  "SuperTokens is dead and nobody noticed" failure mode. Not a mock, but a
  design smell that undermines "is SuperTokens really wired end-to-end" — in
  practice, the **Postgres path is the one that always executes reliably**;
  SuperTokens is a best-effort decoration on top.

- **Auth audit logging is inconsistent — only SSO login is recorded.**
  `app/api/auth/sso/callback/[provider]/route.ts:151-170` is the **only**
  place under `app/api/auth/` that calls `recordAuditEvent`. Password
  login/register (`app/api/auth/[[...path]]/route.ts`), OAuth login/callback
  (`app/api/auth/oauth/callback/[provider]/route.ts`), password reset
  (`forgot-password`, `reset-password`), and invite acceptance
  (`app/api/auth/invite/[token]/route.ts`) never call `recordAuditEvent`. A
  paying customer with the `auditor` role (which exists specifically to read
  audit trails, `lib/rbac.ts:65-78`) cannot see who logged in via password or
  OAuth, or when passwords were reset, or when invites were accepted — a
  materially incomplete audit trail for a product that markets itself on
  agent/action auditability (per `AGENTS.md`, audit is a first-class concern
  elsewhere in the app).

- **OAuth demo auto-login path exists in shipped code, not test-only files.**
  `app/api/auth/oauth/[provider]/route.ts:53-89` and
  `oauth/callback/[provider]/route.ts:211-244` contain a full
  "auto-provision a demo user and log them in" branch gated only by
  `demoAuthAllowed()`. While production is triple-guarded against it
  (`boot-guards.ts`, `oauth-providers.ts` hardcoded `false` check), this is
  still a meaningful amount of production-reachable code whose only purpose
  is to fabricate a session without real credentials whenever
  `ALLOW_DEMO_AUTH=true` — worth flagging explicitly as security-sensitive
  surface even though currently defused for prod. A misconfigured staging
  environment with `NODE_ENV` unset/misspelled would not be caught by
  `demoAuthAllowed()`'s `NODE_ENV==='production'` check.

- **No CAPTCHA / bot-mitigation on register, login, or forgot-password
  forms** (`app/(auth)/login/page.tsx`, `app/(auth)/register/page.tsx`,
  `app/(auth)/forgot-password/page.tsx` — no captcha widget, no
  `hCaptcha`/`Turnstile`/reCAPTCHA references anywhere under
  `apps/dashboard` per grep). Combined with no rate limiting, this is a
  fully open registration/login surface for automated abuse.

- **`GOOGLE_WORKSPACE_HD` defaults to `'*'` (accept any Google Workspace
  domain) if unset.** `lib/supertokens.ts:129` —
  `additionalConfig: { hd: process.env.GOOGLE_WORKSPACE_HD || '*' }`. If an
  operator enables Google Workspace SSO intending to restrict it to their own
  corporate domain but forgets to set `GOOGLE_WORKSPACE_HD`, the provider
  silently accepts sign-in from **any** Google Workspace domain rather than
  failing closed. This is a configuration footgun with real security impact
  (SSO meant to be an org perimeter control, defaulting open).

---

## What's missing vs full product vision

- **No 2FA/MFA anywhere.** Confirmed via `grep -rin "mfa|2fa|totp|otp"` across
  `lib/supertokens.ts` and all of `app/api/auth/` — zero matches. SuperTokens
  itself supports a `TOTP`/`MultiFactorAuth` recipe, but it is not in
  `recipeList` (`lib/supertokens.ts:259-267` only lists `EmailPassword`,
  `ThirdParty`, `Session`). For a B2B SaaS handling connected business tools
  (Gmail, HubSpot, WhatsApp, SQL per `AGENTS.md`), the absence of even
  optional TOTP is a significant gap against customer security expectations
  (many enterprise buyers require MFA as a purchase gate).

- **No session revocation / "log out all devices" / active-session
  management.** The custom HMAC cookie scheme has no server-side session
  table — a signed cookie is valid for its full TTL (`SESSION_MAX_AGE_SECONDS`
  = 7 days, or 30 days with "remember me", `lib/session-cookie.ts:14-15`)
  with no way to invalidate it early (e.g. on password change, on suspected
  compromise, from a "sign out everywhere" button). `updatePasswordHash()`
  (`lib/auth-user.ts:109-116`) does not rotate/invalidate any other
  outstanding session cookies for that user.

- **No self-serve role change / member removal UI-backed API found.**
  `app/api/settings/route.ts` supports `invite_member`, `update_org`,
  `rotate_widget_key`, `update_widget_origins` — no `remove_member`,
  `change_role`, or `revoke_invite` action. An owner/admin can invite people
  but the audit found no endpoint to demote/remove them or cancel a pending
  invite once sent.

- **No login/settings-change audit UI gap noted above compounds a broader
  "no security event timeline" gap** — no visible page/API surfacing failed
  login attempts, password changes, or new-device logins to the account
  owner (a common SaaS security-hygiene feature, e.g. "new sign-in from
  Chrome on Windows").

- **No email verification step for email/password signup.** `EmailPassword.signUp`
  is called (`app/api/auth/[[...path]]/route.ts:221`) but there is no
  `EmailVerification` recipe in `recipeList` (`lib/supertokens.ts:259-267`),
  and the Postgres fallback path (`:288-296`) creates the account and issues
  a session immediately with no verification step at all — an attacker can
  register with someone else's email address (no ownership proof) and,
  while they can't read that inbox, this is still a gap against the "email
  is a verified identity" assumption invite-matching and password-reset both
  lean on.

- **No IP/device/geo anomaly detection** on login — expected by security-
  conscious SaaS buyers, not present.

---

## What to add for full SaaS

- **P0 — add rate limiting to auth endpoints.** Extend
  `RateLimitKind` (`lib/rate-limit.ts:20`) with `login`, `register`,
  `forgot_password`, `reset_password`, `oauth`, `sso`, keyed by IP (and
  additionally by email for login/register), with `assertOrgRateLimit`-style
  enforcement returning `429` — reuse the existing `rate-limit.ts` primitives,
  this is a small, well-scoped addition given the module already exists.
- **P0 — add failed-login tracking + lockout** (e.g. exponential backoff or a
  hard lockout after N failures per account/IP, surfaced to the user as
  "too many attempts, try again in Xm").
- **P0 — add optional TOTP-based MFA** via SuperTokens' `TOTP`/MFA recipes
  (already on `supertokens-node` — package is `^17.0.0`, MFA is supported)
  gated per-org or per-user, at minimum for `owner`/`admin` roles.
- **P1 — audit every auth event, not just SSO login**: extend
  `recordAuditEvent` calls into password login/register, OAuth login,
  password reset (request + consume), and invite accept, matching the
  pattern already proven at `sso/callback/[provider]/route.ts:151-170`.
- **P1 — add session revocation.** Either move session state into a real
  server-side table (session id + revoked flag) or add a "password changed
  at" timestamp check on every request that invalidates cookies issued
  before it.
- **P1 — add email verification** for the password-only signup path (
  SuperTokens `EmailVerification` recipe, or a custom verify-token email
  flow mirroring the existing password-reset token pattern).
- **P1 — add member management**: role change and remove-member actions in
  `app/api/settings/route.ts`, gated by the existing `canManageOrgSettings`/
  a new `canManageMembers` RBAC check, plus revoke-pending-invite.
  A member/user cannot currently be demoted or removed from an org through
  the API surface examined.
- **P2 — fix `GOOGLE_WORKSPACE_HD` default from `'*'` to fail-closed** (no
  default, force the operator to explicitly opt into "any domain" if that's
  really intended) — small change, real impact.
- **P2 — CAPTCHA/bot mitigation** on register and login forms once rate
  limiting is in place (defense in depth, not a substitute).
- **P2 — surface a "recent sign-ins" / security activity view** to
  account owners, built on the audit events once auth events are logged
  consistently (depends on the P1 audit-logging item above).
- **P2 — consolidate the SuperTokens/Postgres dual auth path** or at minimum
  add a metric/alert when the SuperTokens call fails and the Postgres
  fallback is used, so an operator can tell if SuperTokens has silently
  stopped working in production.

---

## Fix priority

**P0 (blocks core flow — security/tenancy):**
- No rate limiting on login/register/forgot-password/reset-password/oauth/sso
  (`lib/rate-limit.ts:20` missing kinds; zero enforcement calls in
  `app/api/auth/**`).
- No failed-login tracking / account lockout.
- No MFA/2FA option at all.

**P1 (degrades — security/product completeness):**
- Audit logging only covers SSO login, not password/OAuth login, password
  reset, or invite accept (`app/api/auth/sso/callback/[provider]/route.ts:151-170`
  is the only auth call site).
- No session revocation / "log out everywhere" / password-change session
  invalidation.
- No email verification on password signup.
- No role-change / remove-member / revoke-invite API in
  `app/api/settings/route.ts`.
- Silent SuperTokens→Postgres fallback with no alerting
  (`app/api/auth/[[...path]]/route.ts:195-211,263-266`).

**P2 (polish):**
- `GOOGLE_WORKSPACE_HD` defaults to `'*'` instead of failing closed
  (`lib/supertokens.ts:129`).
- No CAPTCHA/bot mitigation on public auth forms.
- No "recent sign-ins"/security activity UI.
- Demo OAuth auto-login code path present in shipped code, defused only by
  env checks, not removed for prod builds
  (`app/api/auth/oauth/[provider]/route.ts:53-89`,
  `oauth/callback/[provider]/route.ts:211-244`).

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Pool checkout can leak RLS GUC across requests | P0 | `lib/db.ts` | 🟢 Done | Global `pool.connect` guard + `wrapClientRelease` RESET on every release |
| 2 | Org cookie drift after invite/create | P0 | `org/switch`, create, invite | 🟢 Done | `applySessionCookies` on switch/create/invite accept |
| 3 | Auth endpoint rate limiting | P0 | `lib/rate-limit.ts` + auth routes | 🟢 Done | login/register/forgot/reset/oauth/sso/invite kinds + IP helpers |
| 4 | Failed-login lockout | P0 | `097` + `auth-security.ts` + login | 🟢 Done | `failed_login_count` / `locked_until`; 423 when locked |
| 5 | MFA / TOTP | P0 | `lib/totp.ts` + `/api/auth/mfa` + login | 🟢 Done | Optional TOTP; login returns `MFA_REQUIRED` when enabled |
| 6 | Auth audit coverage beyond SSO | P1 | login/register/invite/mfa | 🟢 Done | `recordAuditEvent` for login, register, invite.accept, mfa.enable/disable |
| 7 | Epoch-0 cookies after revoke → permanent lockout; platform admin / session check ignore epoch (SEC-A01/A02) | P0 | `lib/session-epoch.ts`, auth routes, `platform-admin.ts` | 🟡 Partial | All mint paths read `session_epoch`; epoch-checked parse for platform admin + `/api/auth/session`. Unit-tested; not exercised live |
| 8 | Session cookie had no expiry; dev-secret / SuperTokens-key fallback (SEC-A03/A12) | P1 | `lib/session-cookie.ts` | 🟡 Partial | Signed `exp`; legacy formats refused; prod needs `DAREX_SESSION_SECRET` ≥ 32 chars |
| 9 | `GOOGLE_WORKSPACE_HD` defaulted to `*` (SSO perimeter open) | P2 | `lib/google-workspace-hd.ts`, `lib/supertokens.ts` | 🟢 Done | Unset HD now disables the Google Workspace provider; `*` must be set explicitly. Unit-tested |
| 10 | Password reset did not revoke existing sessions | P1 | `app/api/auth/reset-password/route.ts` | 🟡 Partial | Reset bumps `users.session_epoch`; `getScopedClient`, `/api/auth/session`, invite accept and platform admin all compare the cookie epoch to the DB (every data API goes through getScopedClient, so a stale cookie gets 401 on all of them). Edge middleware only verifies the signature (Next 14 Edge cannot query Postgres), so a stale cookie can still load a page shell until its first API call 401s. Not exercised live (needs DB) |
| 11 | Password reset request + consume left no audit trail | P1 | `forgot-password`, `reset-password` routes | 🟢 Done | `password.reset` audit rows (`password.reset_requested` only when an account exists, response unchanged; `password.reset_completed` with sessionsRevoked). Unit-tested |
| 12 | No way to cancel a pending invite | P1 | `app/api/org/invites/[id]/route.ts` | 🟢 Done | `DELETE` owner/admin only (`canManageOrgSettings`), org from session, pending only, audited as `member.remove` / `invite.revoked`. Unit-tested; no UI button yet |
| 13 | No email verification on password signup | P1 | `lib/supertokens.ts`, register route | 🟡 Built, unverified | Migration 209 (`email_verified_at`, existing users backfilled), token table, verify/resend routes, `/verify-email` page, signup mail and a login gate behind `REQUIRE_EMAIL_VERIFICATION=true`. Not yet run against a live DB or mail; NEW-FRONTEND must handle `VERIFY_EMAIL` / `EMAIL_NOT_VERIFIED` before the flag is enabled |
