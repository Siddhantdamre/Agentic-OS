# Auth

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 18 handlers across 16 paths.

## Paths

- `POST` `/api/auth/forgot-password`
- `GET, POST` `/api/auth/invite/:token`
- `POST` `/api/auth/login`
- `GET` `/api/auth/logout`
- `GET, POST` `/api/auth/mfa`
- `GET` `/api/auth/oauth/:provider`
- `GET` `/api/auth/oauth/callback/:provider`
- `POST` `/api/auth/register`
- `POST` `/api/auth/reset-password`
- `GET` `/api/auth/session`
- `POST` `/api/auth/signin`
- `GET` `/api/auth/signout`
- `POST` `/api/auth/signup`
- `GET` `/api/auth/sso`
- `GET` `/api/auth/sso/:provider`
- `GET` `/api/auth/sso/callback/:provider`

## Endpoints

### POST `/api/auth/forgot-password`

POST /api/auth/forgot-password.

**Auth.** Public. Middleware does not require a session cookie.

**JSON body fields the handler reads.**

- `email`

**JSON responses.**

- **200** keys: `status`

**Source.** `apps/dashboard/app/api/auth/forgot-password/route.ts`

### GET `/api/auth/invite/:token`

GET /api/auth/invite/:token.

**Auth.** Public. Middleware does not require a session cookie.

**Path params.** `token`

**JSON responses.**

- **404** keys: `error`
- **409** keys: `error`
- **410** keys: `error`, `expired`
- **200** keys: `email`, `role`, `orgName`, `expiresAt`

**Error strings in this handler.**
- Invite not found
- Invite already accepted
- Invite expired

**Source.** `apps/dashboard/app/api/auth/invite/[token]/route.ts`

### POST `/api/auth/invite/:token`

POST /api/auth/invite/:token.

**Auth.** Public. Middleware does not require a session cookie.

**Path params.** `token`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **401** keys: `error`
- **404** keys: `error`
- **409** keys: `error`
- **410** keys: `error`, `expired`
- **403** keys: `error`
- **200** keys: `status`, `orgId`, `role`, `onboardingComplete`
- **500** keys: `error`

**Error strings in this handler.**
- Unauthorized
- Invite not found
- Invite already accepted
- Invite expired
- This invite was sent to a different email address.
- Invite org mismatch
- Failed to accept invite
- This account already belongs to another organization.

**Source.** `apps/dashboard/app/api/auth/invite/[token]/route.ts`

### POST `/api/auth/login`

Email and password sign-in. Same handler as [POST `/api/auth/signin`](#post-apiauthsignin) (catch-all `[[...path]]`). Sets darex_session, darex_org_id, and darex_onboarding cookies.

**Auth.** Public. Middleware does not require a session cookie.

**JSON body fields the handler reads.**

- `email`
- `password`
- `rememberMe`
- `inviteToken`
- `mfaCode`

**JSON responses.**

- **200** keys: `status`, `userId`, `email`, `orgId`, `onboardingComplete`
- **401** keys: `status`, `message`
- **400** keys: `status`, `message`
- **423** keys: `status`, `message`

**Error strings in this handler.**
- Email and password are required
- A valid email address is required
- Incorrect email or password.
- Authenticator code required
- Invalid authenticator code.
- Account temporarily locked due to failed sign-in attempts. Try again later.

**Source.** `apps/dashboard/app/api/auth/[[...path]]/route.ts`

### GET `/api/auth/logout`

Clears the session cookies and redirects the browser to /login. Same handler as [GET `/api/auth/signout`](#get-apiauthsignout) (catch-all `[[...path]]`).

**Auth.** Public. Middleware does not require a session cookie.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Error strings in this handler.**
- Redirects to /login. No JSON body.

**Source.** `apps/dashboard/app/api/auth/[[...path]]/route.ts`

### GET `/api/auth/mfa`

GET: MFA status for the session user (never returns the secret once enabled).

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `enabled`, `configured`
- **500** keys: `error`

**Error strings in this handler.**
- Internal Server Error

**Source.** `apps/dashboard/app/api/auth/mfa/route.ts`

### POST `/api/auth/mfa`

- setup: mint a new secret + otpauth URL (not enabled until confirm) - confirm: verify code and enable TOTP - disable: verify code and disable

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `orgId`
- `org_id`
- `action`
- `code`

**JSON responses.**

- **400** keys: `error`
- **501** keys: `error`
- **200** keys: `status`, `otpauthUrl`, `enabled`
- **401** keys: `error`
- **200** keys: `status`, `enabled`
- **400** keys: `status`, `enabled`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- org_id is not accepted from the client; it is resolved from the session.
- MFA schema not migrated yet (run migration 097)
- Call setup first
- Invalid authenticator code
- Invalid action
- Internal Server Error

**Source.** `apps/dashboard/app/api/auth/mfa/route.ts`

### GET `/api/auth/oauth/:provider`

GET /api/auth/oauth/:provider.

**Auth.** Public. Middleware does not require a session cookie.

**Path params.** `provider`

**Query.**
- `invite`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/auth/oauth/[provider]/route.ts`

### GET `/api/auth/oauth/callback/:provider`

GET /api/auth/oauth/callback/:provider.

**Auth.** Public. Middleware does not require a session cookie.

**Path params.** `provider`

**Query.**
- `code`
- `state`
- `error`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/auth/oauth/callback/[provider]/route.ts`

### POST `/api/auth/register`

Same handler as [POST `/api/auth/signup`](#post-apiauthsignup) (catch-all `[[...path]]`).

**Auth.** Public. Middleware does not require a session cookie.

**JSON body fields the handler reads.**

- `email`
- `password`
- `agreedTerms`
- `inviteToken`

**JSON responses.**

- **200** keys: `status`, `userId`, `email`, `orgId`, `onboardingComplete`

**Source.** `apps/dashboard/app/api/auth/[[...path]]/route.ts`

### POST `/api/auth/reset-password`

POST /api/auth/reset-password.

**Auth.** Public. Middleware does not require a session cookie.

**JSON body fields the handler reads.**

- `token`
- `password`

**JSON responses.**

- **400** keys: `status`, `message`
- **200** keys: `status`
- **500** keys: `status`, `message`

**Error strings in this handler.**
- A valid token and password of at least 8 characters are required.
- Invalid or expired reset link.
- Could not reset password.

**Source.** `apps/dashboard/app/api/auth/reset-password/route.ts`

### GET `/api/auth/session`

Current session. Public. Returns the signed-in user, or 401 when the cookie is missing or the user row is gone.

**Auth.** Public. Middleware does not require a session cookie.

**JSON responses.**

- **200** keys: `authenticated`, `userId`, `email`, `role`, `orgId`, `onboardingComplete`
- **401** keys: `authenticated`

**Source.** `apps/dashboard/app/api/auth/[[...path]]/route.ts`

### POST `/api/auth/signin`

Same handler as [POST `/api/auth/login`](#post-apiauthlogin) (catch-all `[[...path]]`).

**Auth.** Public. Middleware does not require a session cookie.

**JSON body fields the handler reads.**

- `email`
- `password`
- `rememberMe`
- `inviteToken`
- `mfaCode`

**JSON responses.**

- **200** keys: `status`, `userId`, `email`, `orgId`, `onboardingComplete`

**Source.** `apps/dashboard/app/api/auth/[[...path]]/route.ts`

### GET `/api/auth/signout`

Same handler as [GET `/api/auth/logout`](#get-apiauthlogout) (catch-all `[[...path]]`).

**Auth.** Public. Middleware does not require a session cookie.

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Error strings in this handler.**
- Redirects to /login. No JSON body.

**Source.** `apps/dashboard/app/api/auth/[[...path]]/route.ts`

### POST `/api/auth/signup`

Create an account. Same handler as [POST `/api/auth/register`](#post-apiauthregister) (catch-all `[[...path]]`). agreedTerms must be accepted. Password must be at least 8 characters. Sets the session cookies.

**Auth.** Public. Middleware does not require a session cookie.

**JSON body fields the handler reads.**

- `email`
- `password`
- `agreedTerms`
- `inviteToken`
- `rememberMe`

**JSON responses.**

- **200** keys: `status`, `userId`, `email`, `orgId`, `onboardingComplete`
- **400** keys: `status`, `message`
- **409** keys: `status`, `message`

**Error strings in this handler.**
- Please agree to the Terms of Service & Privacy Policy.
- Password must be at least 8 characters.
- An account with this email already exists. Please sign in.

**Source.** `apps/dashboard/app/api/auth/[[...path]]/route.ts`

### GET `/api/auth/sso`

GET /api/auth/sso.

**Auth.** Public. Middleware does not require a session cookie.

**JSON responses.**

- **200** keys: `providers`, `passwordEnabled`, `testIdp`

**Source.** `apps/dashboard/app/api/auth/sso/route.ts`

### GET `/api/auth/sso/:provider`

Password path is not involved. Unsigned/forged is N/A here (browser redirect).

**Auth.** Public. Middleware does not require a session cookie.

**Path params.** `provider`

**Query.**
- `invite`
- `state`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/auth/sso/[provider]/route.ts`

### GET `/api/auth/sso/callback/:provider`

Completes SuperTokens ThirdParty SAML/OIDC and issues the Darex session cookie. Does not replace EmailPassword. Does not use demo OAuth.

**Auth.** Public. Middleware does not require a session cookie.

**Path params.** `provider`

**Query.**
- `error`
- `state`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/auth/sso/callback/[provider]/route.ts`
