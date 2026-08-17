# 05 — End-to-end: Integrations (Nango)

Nango (`:3003`) is the OAuth vault. The agent never stores provider refresh
tokens itself. Connection id convention: **`{orgId}_{provider}`**.

## Nango architecture

```mermaid
graph TB
  subgraph Integrations["Integrations UI"]
    List["Integrations page"]
    Connect["Connectors page"]
    Test["Connector test page"]
  end

  subgraph ClientLib["Browser OAuth Helper"]
    NangoClient["lib/nango-client.ts<br/>startRealNangoOAuth()"]
  end

  subgraph ServerLib["Server OAuth Verify"]
    NangoServer["lib/nango-server.ts<br/>nangoConnectionExists()"]
  end

  subgraph NangoService["Nango Service :3003"]
    NangoUI["Nango UI<br/>(OAuth popup)"]
    NangoAPI["Nango API<br/>(credential store)"]
    Vault["OAuth Vault<br/>(encrypted)"]
  end

  subgraph Providers["Provider APIs"]
    Gmail["Gmail / Google"]
    GitHub["GitHub"]
    Stripe["Stripe"]
    HubSpot["HubSpot"]
    Meta["Meta (WhatsApp, Ads, Insta)"]
    Zoho["Zoho CRM"]
    QBO["QuickBooks"]
  end

  subgraph Dashboard["Dashboard API"]
    IntegAPI["POST /api/integrations<br/>GET /api/integrations"]
    TestAPI["POST /api/integrations/test"]
    TokenAPI["GET/POST /api/integrations/nango-token"]
  end

  subgraph DB["Postgres"]
    Channels["channels table<br/>(org, provider, meta)"]
  end

  List --> Connect
  Connect --> Test
  NangoClient --> NangoUI
  NangoServer --> NangoAPI
  Vault --> Providers
  IntegAPI --> NangoServer
  TestAPI --> Vault
  TokenAPI --> NangoUI
  IntegAPI --> Channels
  Channels --> Vault
```

## OAuth connect flow (detailed)

```mermaid
sequenceDiagram
  participant UI as Connectors UI
  participant BrowserLib as lib/nango-client.ts
  participant Dashboard as GET/POST /api/integrations/nango-token
  participant NangoUI as Nango UI :3003
  participant NangoAPI as Nango API
  participant Vault as OAuth Vault
  participant DB as channels table

  UI->>Dashboard: GET ?provider=gmail
  Dashboard->>NangoAPI: verify no existing connection
  Dashboard->>Dashboard: connectionId = {orgId}_gmail
  Dashboard-->>UI: { publicKey, connectionId, nango_url }

  UI->>BrowserLib: startRealNangoOAuth(provider, connectionId)
  BrowserLib->>NangoUI: Open popup nango.auth()
  NangoUI->>NangoUI: Show "Connect to Gmail"
  NangoUI->>Gmail: Redirect to consent screen
  Gmail-->>NangoUI: Grant permissions
  NangoUI->>Vault: Store credentials (encrypted)
  NangoUI-->>BrowserLib: Success, close popup
  
  BrowserLib-->>UI: OAuth complete
  UI->>Dashboard: POST /api/integrations/nango-token<br/>{ connectionId, provider }
  Dashboard->>NangoAPI: GET /connections/{connectionId}
  NangoAPI-->>Dashboard: { connectionId, credentials }
  
  alt connection exists
    Dashboard->>DB: UPSERT channels<br/>{ org_id, channel_type=gmail<br/>connected=true, meta={connectionId} }
    DB-->>Dashboard: upserted
    Dashboard-->>UI: 200 success
  else connection not found
    Dashboard-->>UI: 400 Connection failed
  end
```

## Connect via POST (no fabrication)

```mermaid
flowchart TD
  Request["POST /api/integrations<br/>{ action: connect, provider }"]
  Auth["Auth + getScopedClient(org_id)"]
  Check["Check Nango for connection<br/>{org_id}_{provider}"]
  
  Check -->|found| Verify["Verify connection still valid<br/>(ping Nango)"]
  Check -->|not found| Deny["400 Not connected"]
  
  Verify -->|valid| Insert["INSERT channels<br/>{ org_id, channel_type, connected=true }"]
  Verify -->|invalid/expired| Deny
  
  Insert --> Success["200 success"]
  Deny --> Error["{ error: Connect via UI first }"]
```

## Disconnect flow

```mermaid
sequenceDiagram
  participant UI as UI (disconnect button)
  participant API as POST /api/integrations
  participant Nango as Nango API
  participant DB as Postgres

  UI->>API: POST /api/integrations<br/>{ action: disconnect, provider }
  API->>API: getScopedClient(org_id)
  API->>Nango: DELETE /connections/{connectionId}
  Nango-->>API: 200 connection deleted
  API->>DB: DELETE FROM channels<br/>WHERE org_id=$1 AND channel_type=$2
  DB-->>API: ok
  API-->>UI: 200 disconnected
  UI->>UI: Refresh integrations list
```

## Test connector

```mermaid
sequenceDiagram
  participant UI as Test form /connectors/[id]
  participant API as POST /api/integrations/test
  participant Executor as @darex/connectors
  participant Nango as Nango Vault
  participant Provider as Provider API

  UI->>API: POST /api/integrations/test<br/>{ provider, action, payload? }
  API->>Executor: new TestProxy(provider, orgId)
  Executor->>Nango: fetch token {orgId}_{provider}
  Nango-->>Executor: token (if connected)
  
  alt connected
    Executor->>Provider: call test action<br/>(e.g., listEmails for Gmail)
    Provider-->>Executor: result
    Executor-->>API: 200 { success, data }
  else not connected
    Executor-->>API: 200 { success: false, error: notConnected }
  end
  
  API-->>UI: response
  UI->>UI: display result
```

## WhatsApp BYOK (bring your own key)

```mermaid
flowchart TD
  UI["Connectors → WhatsApp BYOK modal"]
  Input["Enter:<br/>Access Token<br/>Phone Number ID<br/>WABA ID"]
  Verify["POST /api/integrations/whatsapp<br/>Graph verify token"]
  Graph["Meta Graph API<br/>verify_token()"]
  
  Input --> Verify
  Verify -->|token valid| Store["UPSERT channels<br/>{ org_id, channel_type=whatsapp<br/>meta = {token, phoneId, wabaId} }"]
  Verify -->|token invalid| Error["400 Invalid token"]
  
  Store --> Success["200 Connected"]
  Error --> Fail["Show error"]
```

## UI

| Page | File | Job |
|------|------|-----|
| `/integrations` | `app/(dashboard)/integrations/page.tsx` | Hub + test runner |
| `/connectors` | `app/(dashboard)/connectors/page.tsx` | Catalog + OAuth + WhatsApp BYOK modal |
| `/connectors/[id]` | `app/(dashboard)/connectors/[id]/page.tsx` | Per-provider test form |

Browser OAuth helper: `lib/nango-client.ts` → `startRealNangoOAuth()`.
Server verify: `lib/nango-server.ts` → `nangoConnectionExists()`, `getNangoConnection()`.

## Catalog (27 apps in `ALL_INTEGRATIONS`)

Messaging: whatsapp, slack, google-chat  
Email / calendar: gmail, google-calendar  
Ads: google-ads, meta-ads  
CRM / support: hubspot, zendesk, intercom  
Payments: stripe, razorpay  
Knowledge / shop: notion, shopify  
Dev: github  
Google productivity: drive, docs, sheets, slides, forms, contacts, tasks  
Also listed: google-analytics, google-search-console, google-business-profile,
google-cloud, google-meet, google-chat — executors and UI catalog are **live**
(see [08](./08-tools-catalog.md)).

## Connect flow (real OAuth)

1. UI `GET /api/integrations/nango-token?provider=` → public key, host,
   `connectionId`.
2. Browser `nango.auth(provider, connectionId)` against Nango.
3. UI `POST /api/integrations/nango-token` confirm.
4. Server checks Nango **before** upserting `channels` (`status='connected'`).
5. Optional `POST /api/integrations` `{ action: 'connect' }` — **400** if Nango
   has no connection (no fabricated rows).

`GET /api/integrations` re-verifies every DB-connected row against Nango in
parallel. UI “Connected” means Nango agrees.

Disconnect: `POST /api/integrations` `{ action: 'disconnect' }` **deletes**
the Nango connection then clears `channels`.

## WhatsApp BYOK (bypasses Nango)

`POST /api/integrations/whatsapp` Graph-pings then stores
`{ accessToken, phoneNumberId, wabaId }` in `channels.meta`.

## Test proxy (not the agent)

`POST /api/integrations/test` is a **read-only ping** by default (Nango /
WhatsApp Graph / Razorpay). Writes `channel_logs`. This is a diagnostic, not
the MCP path. Shopify/Zendesk require shop/subdomain **before** the OAuth
popup. Missing OAuth client IDs point at Nango UI `:3003`.

The **agent** uses `tool-executor.ts` direct HTTP + Nango tokens. It does not
import `@darex/connectors`.

## What works

- Nango as source of truth (fake-connect removed 2026-08-11).
- Gmail / Calendar / GitHub / Google Ads / Docs / Sheets live-verified when
  connected.
- Google Drive correctly reports not connected until browser OAuth.
- Gmail scopes include `gmail.send gmail.readonly gmail.compose gmail.modify`
  (need a **re-connect** if the token predates `compose`).
- Intercom + Notion `oauth_scopes` filled (`read write`).

## What does not

- HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Meta Ads need
  **real OAuth client IDs** in the Nango UI (`http://localhost:3003`) before
  the popup can finish.
- WhatsApp outbound needs a rotated `META_ACCESS_TOKEN`.
- `POST /api/integrations/webhooks` is an authenticated **logger**, not Meta’s
  public webhook.
