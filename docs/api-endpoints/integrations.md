# Integrations

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 11 handlers across 7 paths.

## Paths

- `GET, POST` `/api/integrations`
- `POST` `/api/integrations/:provider/ping`
- `GET, POST` `/api/integrations/nango-token`
- `POST, GET` `/api/integrations/razorpay`
- `POST` `/api/integrations/test`
- `POST` `/api/integrations/webhooks`
- `POST, GET` `/api/integrations/whatsapp`

## Endpoints

### GET `/api/integrations`

GET /api/integrations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `stats`, `logs`, `nango`
- **500** keys: `message`, `integrations`, `stats`, `logs`

**Source.** `apps/dashboard/app/api/integrations/route.ts`

### POST `/api/integrations`

POST /api/integrations.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `provider`
- `action`
- `extra`

**JSON responses.**

- **400** keys: `message`
- **400** keys: `success`, `message`
- **400** keys: `success`, `connected`, `message`, `reconnectUrl`, `setupUrl`, `nangoUiUrl`
- **200** keys: `success`, `message`, `connectionId`
- **503** keys: `success`, `message`
- **502** keys: `success`, `message`
- **200** keys: `success`, `message`
- **500** keys: `message`

**Error strings in this handler.**
- provider and action are required
- NANGO_SECRET_KEY is not set — cannot revoke the OAuth connection. Local status left unchanged.
- Invalid action. Use 

**Source.** `apps/dashboard/app/api/integrations/route.ts`

### POST `/api/integrations/:provider/ping`

Live diagnostic ping; updates org_connectors health fields when migration 093 is applied.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Path params.** `provider`

**JSON body fields the handler reads.**

_No named JSON fields. The handler either takes no body, or only rejects a client-supplied org id._

**JSON responses.**

- **400** keys: `error`
- **200** keys: `success`, `connected`, `message`, `reconnectUrl`, `undefined`, `setupUrl`, `data`
- **502** keys: `success`, `connected`, `error`, `reconnectUrl`

**Source.** `apps/dashboard/app/api/integrations/[provider]/ping/route.ts`

### GET `/api/integrations/nango-token`

Returns Nango public key and scoped connection metadata for the authenticated user's org

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**Query.**
- `provider`

**JSON responses.**

- **400** keys: `error`
- **200** keys: `nangoPublicKey`, `providerConfigKey`, `authMode`, `extraConnectFields`, `oauthConfigured`, `true`, `missingConfigReason`, `operatorHint`, `nangoUiUrl`, `authorizationParams`
- **500** keys: `error`

**Error strings in this handler.**
- A valid provider query param is required
- Internal Server Error

**Source.** `apps/dashboard/app/api/integrations/nango-token/route.ts`

### POST `/api/integrations/nango-token`

Called after Nango OAuth popup completes to confirm connection in PostgreSQL database

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `provider`
- `connectionId`
- `success`
- `extra`

**JSON responses.**

- **400** keys: `error`
- **400** keys: `success`, `error`
- **200** keys: `success`, `connected`, `connectionId`, `message`, `nangoUiUrl`
- **500** keys: `error`

**Error strings in this handler.**
- Invalid JSON body
- provider is required
- connectionId does not belong to this organization

**Source.** `apps/dashboard/app/api/integrations/nango-token/route.ts`

Per-org Razorpay API-key connect (not Nango OAuth). Callers: apps/dashboard/lib/nango-client.ts connectRazorpayByok, connectors + integrations UI modals. Glob of app/api/integrations has whatsapp but no razorpay route (confirmed). Writes channels.meta JSONB: { keyId, keySecret, key_id, key_secret } — never returned to the client.

### GET `/api/integrations/razorpay`

GET /api/integrations/razorpay.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `connected`, `hasPerOrgKeys`, `hasEnvKeys`, `connectedAt`
- **500** keys: `message`

**Source.** `apps/dashboard/app/api/integrations/razorpay/route.ts`

### POST `/api/integrations/razorpay`

POST /api/integrations/razorpay.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `keyId`
- `key_id`
- `keySecret`
- `key_secret`

**JSON responses.**

- **400** keys: `message`
- **400** keys: `success`, `connected`, `message`, `setupUrl`
- **200** keys: `success`, `connected`, `message`
- **500** keys: `message`

**Error strings in this handler.**
- Razorpay keyId and keySecret are required
- Razorpay keys verified and stored for this org. Agent tools use these per-org keys.

**Source.** `apps/dashboard/app/api/integrations/razorpay/route.ts`

### POST `/api/integrations/test`

POST /api/integrations/test.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `provider`
- `payload`
- `status`
- `meta`
- `nango_connection_id`

**JSON responses.**

- **400** keys: `message`
- **200** keys: `success`, `executorStatus`, `reconnectUrl`, `undefined`, `setupUrl`
- **500** keys: `message`

**Source.** `apps/dashboard/app/api/integrations/test/route.ts`

### POST `/api/integrations/webhooks`

POST /api/integrations/webhooks.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `provider`
- `type`
- `event`

**JSON responses.**

- **200** keys: `success`, `message`
- **500** keys: `message`

**Error strings in this handler.**
- Webhook logged successfully

**Source.** `apps/dashboard/app/api/integrations/webhooks/route.ts`

### GET `/api/integrations/whatsapp`

GET /api/integrations/whatsapp.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON responses.**

- **200** keys: `connected`, `wabaId`, `connectedAt`
- **500** keys: `message`

**Source.** `apps/dashboard/app/api/integrations/whatsapp/route.ts`

### POST `/api/integrations/whatsapp`

POST /api/integrations/whatsapp.

**Auth.** Signed session cookie. Middleware returns 401 `{ error: "Unauthorized" }` when the cookie is missing. Org id is taken from the session (`getScopedClient`), never from the body.

**JSON body fields the handler reads.**

- `accessToken`
- `phoneNumberId`
- `wabaId`

**JSON responses.**

- **400** keys: `message`
- **200** keys: `success`, `connected`, `message`, `setupUrl`
- **200** keys: `success`, `connected`, `message`, `phone`
- **500** keys: `message`

**Error strings in this handler.**
- Access Token and Phone Number ID are required
- WhatsApp connected successfully

**Source.** `apps/dashboard/app/api/integrations/whatsapp/route.ts`
