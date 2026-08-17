# 05 — Authentication & Authorization

Darex uses a **hybrid auth**: SuperTokens is the identity provider, with a **direct Postgres fallback** so auth never hard-fails when SuperTokens is down. Sessions are plain HttpOnly cookies; tenant isolation is enforced by Postgres RLS, not by the session layer.

## Auth flow (dashboard `apps/dashboard/app/api/auth/[...path]/route.ts`)

Endpoints (all under `/api/auth/*`, catch-all route):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/auth/signup` (or `register`) | POST | Create account + fresh org; sets session cookies |
| `/api/auth/login` (or `signin`) | POST | Sign in; sets session cookies |
| `/api/auth/session` | GET | Session check; returns user + org |
| `/api/auth/signout` (or `logout`) | GET | Clears cookies, redirects to `/login` |

> Note: the check scripts and README reference `/api/auth/register` / `/api/auth/login` — both aliases are accepted by the catch-all.

### Registration
1. If SuperTokens SDK is available (`lib/supertokens.ts` initializes EmailPassword + Session + Dashboard recipes against `http://supertokens:3567`, `apiKey` from `SUPERTOKENS_API_KEY`): call `EmailPassword.signUp('public', email, password)`. On OK → create an org (`createOrgForEmail`), insert `users` row (email, role `owner`, `supertokens_id`).
2. If SuperTokens throws, fall back to pure Postgres: create org, insert `users` with `supertokens_id = st_<uuid>` and **`password_hash` = `scrypt$<saltHex>$<hashHex>`** (`crypto.scryptSync`, migration 004).
3. Response sets two cookies: `darex_session` (= **users.id PK**, 7 days) and `darex_org_id` (= org id, 7 days).

### Login
1. Try SuperTokens `signIn`. On OK, resolve the DB user by `email OR supertokens_id`, ensure an org exists (`ensureUserOrg`/`createOrgForEmail`), set cookies with the **DB users.id**.
2. If SuperTokens fails, Postgres fallback: look up `users` by email, verify `password_hash` with `verifyPassword` (timing-safe scrypt compare). Set cookies.

### Session check (`GET /api/auth/session`)
Reads `darex_session`; if missing → 401. Looks up `users` by id; if the row is gone, clears cookies → 401. Returns `{ authenticated, userId, email, role, orgId }`.

### Middleware (`apps/dashboard/middleware.ts`)
- Never intercepts `/api/*` or static assets.
- Public pages: `/login*`, `/register*`.
- No `darex_session` on a protected page → redirect to `/login?redirect=<path>`.
- Has session on `/login`/`/register` → redirect to `/`.

## Per-request DB scoping — `getScopedClient()` (`apps/dashboard/lib/db.ts`)

Every authenticated API route that touches tenant data calls this helper:
1. Reads `darex_session` cookie → if missing, throws `Unauthorized`.
2. Resolves the user's `org_id` from `users` (if the user has no org, **auto-provisions one** and links it).
3. Sets `app.current_org_id` on the pooled connection → **RLS filters all queries to that org**.

`createOrgForEmail(client, email)` and `ensureUserOrg(client, userId, email)` are the org-provisioning helpers used during registration and first login. Every org is a fresh per-user org (no shared demo org).

## Webhook auth (no session cookie)

Webhooks are server-to-server, so they use other mechanisms:

### Chatwoot webhook (`/api/webhooks/chatwoot`)
- **HMAC signature (enforced when `CHATWOOT_WEBHOOK_SECRET` is set):** header `x-chatwoot-signature` must equal `sha256=<hex HmacSHA256(rawBody, secret)>`. Mismatch or missing → `401 Invalid webhook signature`.
- Org resolution order: `?org_id=` query → `Authorization: Bearer <webhook_secret>` matching `orgs.meta->>'webhook_secret'` → `X-Darex-Org-Id` header → single-active-org fallback. Unresolved → 400.
- Callers (check scripts, test harness) must HMAC-sign. `infra/scripts/check-phase3.js` computes the signature with `CHATWOOT_WEBHOOK_SECRET` (fallback `darex-chatwoot-webhook-secret-dev`).

### WhatsApp webhook (`/api/webhooks/whatsapp`)
- `GET`: Meta verification challenge — returns `hub.challenge` if `hub.verify_token === VERIFY_TOKEN`, else 403.
- `POST`: **always returns 200** (prevents Meta retry storms). Org resolution by channel meta: `phone_number_id` first, then `whatsapp_business_account_id`, then single-active-org fallback.

## Secrets & keys (dev values — present but never commit real creds)

| Env var | Value (dev) | Used by |
|---|---|---|
| `DB_USER/DB_PASSWORD` | `darex` / `darex_dev_secret` | Postgres |
| `SUPERTOKENS_API_KEY` | `darex-supertokens-api-key-dev` | dashboard auth SDK (matches compose `API_KEYS`) |
| `SUPERTOKENS_CONNECTION_URI` | `http://supertokens:3567` (in-container) | dashboard |
| `NANGO_SECRET_KEY` | dev UUID — get from Nango UI (Settings → API keys) or `apps/dashboard/.env.local` | tool-executor / bridge |
| `CHATWOOT_WEBHOOK_SECRET` | `darex-chatwoot-webhook-secret-dev` | chatwoot webhook HMAC |
| `ATOMIC_AGENT_API_KEY` | `darex-atomic-agent-dev-key` | dashboard/worker → atomic-agent |
| Langfuse keys | `pk-lf-darex-dev-public` / `sk-lf-darex-dev-secret` | `lib/langfuse-trace.ts` |
| LiteLLM master key | `sk-darex-litellm-dev-key` | litellm |

## Known auth-related caveats

- The session cookie holds a raw DB id — anyone with the cookie value can act as that user (RLS limits blast radius to that user's org). No JWT/opaque SuperTokens session is used for the app's own API.
- Check scripts (`check-phase3.js`, `check-auth-nango.js`, `e2e-live-llm.js`) register throwaway users; they rely on `/api/auth/register` returning the `set-cookie` header to drive authenticated calls.
- `META_ACCESS_TOKEN` has **expired** (session ended 2026-06-12) — rotate before real WhatsApp sends. Google Ads/Shopify/Zendesk/Razorpay env values are intentionally empty (connectors exist but aren't wired to live accounts).
