# 04 — End-to-end: Auth and onboarding

## Auth & org creation flow

```mermaid
flowchart TD
  Start["User visits /login"] --> Route{Auth method?}
  
  Route -->|Email + password| EmailPW["POST /api/auth/login<br/>or /api/auth/register"]
  Route -->|OAuth| OAuth["GET /api/auth/oauth/[provider]<br/>(Google/GitHub/Meta/MS)"]
  Route -->|Invite link| Invite["GET /invite/{token}"]
  
  EmailPW --> TryST["Try SuperTokens<br/>(lib/supertokens.ts)"]
  TryST -->|API key OK| STAuth["SuperTokens handles<br/>email verification + hash"]
  TryST -->|API key mismatch| STFail["Fall back to Postgres"]
  STFail --> PgAuth["Query users.password_hash<br/>verifyPassword(scrypt)"]
  PgAuth -->|ok| CreateSession["Create session"]
  PgAuth -->|fail| Deny["401 Unauthorized"]
  
  OAuth --> IdP["Redirect to IdP"]
  IdP --> Grant["User grants permissions"]
  Grant --> Callback["GET /api/auth/oauth/callback<br/>with code"]
  Callback -->|IDs set| Exchange["Exchange code for token"]
  Callback -->|IDs missing + ALLOW_DEMO_AUTH| DemoAuto["Auto-provision demo user<br/>(dev only)"]
  Exchange --> UpsertUser["UPSERT users<br/>(email + provider id)"]
  DemoAuto --> UpsertUser
  
  Invite --> ValidToken["Validate token<br/>in org_invites"]
  ValidToken -->|ok| JoinOrg["Accept invite<br/>INSERT org_members"]
  ValidToken -->|expired| Reject["403 Forbidden"]
  
  CreateSession --> EnsureOrg["ensureUserOrg() or<br/>createOrgForEmail()"]
  UpsertUser --> EnsureOrg
  JoinOrg --> EnsureOrg
  
  EnsureOrg --> SetCookie["Set cookies:<br/>darex_session = users.id<br/>darex_org_id = org.id"]
  SetCookie --> Redirect["Redirect to /dashboard<br/>or /onboarding/name"]
```

## Email + password flow (detail)

```mermaid
sequenceDiagram
  participant User as User
  participant Login as POST /api/auth/login or register
  participant ST as SuperTokens :3567
  participant Fallback as Postgres scrypt
  participant DB as Postgres users table
  participant Session as Cookie setter

  User->>Login: POST { email, password }
  Login->>ST: try emailpassword.signInUp()
  alt ST responds
    ST->>ST: hash + verify password
    ST-->>Login: { userId, email, ... }
  else ST timeout or key mismatch
    Login->>Fallback: verifyPassword(password)
    Fallback->>DB: SELECT password_hash FROM users WHERE email=$1
    DB-->>Fallback: hash (or NULL if pre-migration)
    alt hash exists
      Fallback->>Fallback: bcrypt/scrypt compare
      Fallback-->>Login: ok or error
    else no hash
      Fallback-->>Login: 401 Unauthorized<br/>(re-register required)
    end
  end
  
  alt login ok
    Login->>DB: UPDATE users SET last_login_at=now()
    Login->>Session: Set darex_session = users.id
    Login-->>User: 200 + redirect
  else login failed
    Login-->>User: 401 Unauthorized
  end
```

## OAuth callback flow (detail)

```mermaid
sequenceDiagram
  participant UI as UI /login
  participant Auth as GET /api/auth/oauth/callback/[provider]
  participant IdP as Google / GitHub / Meta / Microsoft
  participant Env as Environment vars
  participant DB as Postgres users

  UI->>Auth: GET ?code=<auth_code>&state=<state>
  Auth->>Env: Read CLIENT_ID + CLIENT_SECRET
  
  alt IDs present
    Auth->>IdP: POST token endpoint<br/>{ code, client_id, client_secret }
    IdP-->>Auth: { access_token, id_token, ... }
  else IDs missing
    Auth->>Env: Check ALLOW_DEMO_AUTH
    alt true (dev only)
      Auth->>Auth: auto-provision demo user
    else false
      Auth-->>UI: 400 OAuth not configured
    end
  end
  
  Auth->>Auth: decode JWT or extract user info
  Auth->>Auth: { provider_id, email, name, ... }
  Auth->>DB: UPSERT users<br/>ON CONFLICT (email) DO UPDATE
  DB-->>Auth: { users.id, org_id, ... }
  
  alt new user
    Auth->>DB: ensureUserOrg() → create org
    DB-->>Auth: org_id
  else existing
    Auth->>DB: use existing org_id
  end
  
  Auth->>Auth: Set darex_session = users.id<br/>Set darex_org_id = org.id
  Auth-->>UI: 302 redirect /dashboard
```

## Org resolution & tenancy (getScopedClient)

```mermaid
sequenceDiagram
  participant API as GET /api/conversations
  participant Middleware as middleware.ts
  participant DBLib as lib/db.ts getScopedClient()
  participant Pool as Postgres Pool
  participant RLS as Postgres RLS

  API->>Middleware: Extract darex_session cookie
  Middleware->>DBLib: getScopedClient(userId)
  
  DBLib->>Pool: Acquire client from pool
  DBLib->>Pool: SELECT org_id FROM users WHERE id=$1
  Pool-->>DBLib: org.id
  
  alt org_id exists
    DBLib->>Pool: BEGIN TRANSACTION
    DBLib->>Pool: SET app.current_org_id = $org_id
    Pool-->>DBLib: session variable set
  else org_id missing
    DBLib->>Pool: ensureUserOrg() → create org
    Pool-->>DBLib: new org_id
  end
  
  DBLib-->>API: Scoped client ready
  API->>Pool: SELECT * FROM conversations<br/>(queries use RLS automatically)
  RLS->>RLS: Filter: org_id = current_setting('app.current_org_id')
  Pool-->>API: filtered results (this org only)
  
  API->>API: Process response
  API->>Pool: Release client back to pool<br/>(resets app.current_org_id)
  Pool-->>API: ready for next request
```

## Onboarding wizard sequence

```mermaid
sequenceDiagram
  participant UI as Onboarding UI
  participant Store as Zustand lib/store.ts
  participant API as POST /api/org/create
  participant DB as Postgres

  UI->>Store: Initialize state
  UI->>UI: /onboarding/name
  UI->>Store: setName(input)
  UI->>UI: /onboarding/team-size
  UI->>Store: setTeamSize(option)
  UI->>UI: /onboarding/business-type
  UI->>Store: setBusinessType(option)
  UI->>UI: /onboarding/channels<br/>(Gmail, WhatsApp, etc.)
  UI->>Store: setSelectedChannels([])
  UI->>UI: "Create my org" button
  
  UI->>API: POST /api/org/create<br/>{ name, team_size, business_type, channels }
  API->>API: getScopedClient() → org_id
  API->>DB: UPDATE orgs<br/>SET name=?, slug=?, metadata=?
  DB-->>API: ok
  
  loop per selected channel
    API->>DB: INSERT channels<br/>{ org_id, channel_type, connected=false }
  end
  
  API->>API: Set darex_org_id cookie
  API-->>UI: 200 { orgId }
  
  UI->>UI: Redirect to /?warmup=true
  UI->>UI: Show progress bar (UI only)<br/>no real provisioning job
  UI->>UI: Auto-navigate to /dashboard<br/>after 2-3s
```

## Invite flow (accept while signed in)

```mermaid
sequenceDiagram
  participant Email as Email app
  participant Invite as /invite/{token}
  participant API as GET /api/invites/{token}
  participant DB as Postgres org_invites
  participant Org as Org table

  Email->>Invite: User clicks invite link
  Invite->>API: GET /api/invites/{token}
  API->>DB: SELECT * FROM org_invites<br/>WHERE token=$1 AND claimed_at IS NULL
  DB-->>API: invite record (if valid)
  
  alt token valid + not expired + not claimed
    API->>Org: SELECT * FROM orgs WHERE id=invite.org_id
    Org-->>API: org details
    API-->>Invite: { org, invite }
    Invite->>Invite: Show "Join {org}"<br/>accept/decline buttons
    Invite->>API: POST /api/invites/{token}/accept<br/>(with session auth)
    API->>DB: INSERT org_members<br/>{ org_id, user_id, role, joined_at }
    API->>DB: UPDATE org_invites SET claimed_at=now()
    DB-->>API: ok
    API-->>Invite: 200 redirect /dashboard
  else token invalid / expired / claimed
    API-->>Invite: 403 Forbidden
  end
```

## Cookies

| Cookie | Value | Notes |
|--------|-------|-------|
| `darex_session` | Postgres `users.id` | httpOnly, 7 days. **Not** the SuperTokens user id. |
| `darex_org_id` | Org UUID | Set at login / register / OAuth / org create |

| Cookie | Value | Notes |
|--------|-------|-------|
| `darex_session` | Postgres `users.id` | httpOnly, 7 days. **Not** the SuperTokens user id. |
| `darex_org_id` | Org UUID | Set at login / register / OAuth / org create |

`middleware.ts` only checks `darex_session` on non-API pages. Unauthenticated
→ `/login?redirect=`. It does **not** force onboarding completion.

## Email + password

`POST /api/auth/login` and `POST /api/auth/register` in
`app/api/auth/[[...path]]/route.ts`.

1. Try SuperTokens EmailPassword (`lib/supertokens.ts`).
2. If SuperTokens is down or `SUPERTOKENS_API_KEY` mismatches the server
   `API_KEYS`, fall back to Postgres:
   - Register: scrypt `password_hash` on `users`.
   - Login: `verifyPassword`; missing hash or wrong password → 401.
   - **No auto-provision on bad password** (that hole was closed in Phase 4.5).

Users created **before** migration `004_password_hash.sql` have NULL
`password_hash` and must re-register to use the Postgres path.

## Session GET / logout

- `GET /api/auth/session` → `{ authenticated, userId, email, role, orgId }`
- `GET /api/auth/logout` and `/api/auth/signout` clear cookies and redirect `/login`

## Social OAuth

`GET /api/auth/oauth/[provider]` and `GET /api/auth/oauth/callback/[provider]`

Providers: `google`, `github`, `meta`/`facebook`, `microsoft`.

- Real path: redirect to IdP with env client IDs/secrets, exchange code,
  upsert user, set cookies.
- If `ALLOW_DEMO_AUTH=true` **and** client IDs are missing: auto-provision a
  demo user (dev only).

## Org resolution (`lib/db.ts`)

`getScopedClient()` / `getOrgScopedClient()`:

1. Read `darex_session`.
2. Load `users.org_id`.
3. If missing, `ensureUserOrg()` / `createOrgForEmail()` — **one org per user**,
   never “first org in the table”.
4. `SET app.current_org_id` at **session** level on the pooled client.
5. Reset on release (pool max is 10 — do not hold across SSE).

APIs must not take `org_id` from the JSON body.

## Onboarding wizard

Pages under `app/(onboarding)/onboarding/`:

1. `/onboarding/name` — Zustand `lib/store.ts`
2. `/onboarding/team-size`
3. `/onboarding/business-type`
4. `/onboarding/channels` — `POST /api/org/create` then `/?warmup=true`

`POST /api/org/create` updates/creates the org, seeds `channels` rows for
selected types, sets `darex_org_id`.

Home `?warmup=true` shows a **UI-only** progress bar (no real provisioning job).

## What works

- Register → unique org → login → scoped APIs.
- SuperTokens when keys match; Postgres fallback when they don’t.
- OAuth callbacks with real client IDs; `?invite=` survives the round-trip.
- Forgot / reset password; invite accept while signed in.
- Onboarding writes org + channel stubs. Body `org_id` is rejected.

## What does not

- Middleware does not send users without an org into onboarding (it uses the
  onboarding cookie).
- Invite email needs `RESEND_API_KEY`; without it Settings still returns a
  copyable `/invite/{token}` link (`org_invites`).
- Demo OAuth bypass is dangerous if `ALLOW_DEMO_AUTH` leaks to prod.
- SuperTokens Dashboard recipe is initialized; not a product surface.
