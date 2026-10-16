# Integrations credentials runbook (human-only steps)

These are the rows the code cannot close. Every value below is entered by a
person in a provider console, the Nango UI, or the deployment env. Never paste a
value into the repo, a doc, or a commit. Tracker: `integrations-connectors.md`
row 9, `billing.md`.

## 0. Shared facts (derived from the repo)

- Nango UI and API: `NEXT_PUBLIC_NANGO_HOST` (browser/UI link) or `NANGO_HOST`
  (server), default `http://localhost:3003` (`lib/integrations-catalog.ts`
  `nangoUiUrl`). Compose sets the public base via `NANGO_SERVER_URL`
  (`infra/docker-compose.yml`, `nango-server`).
- Redirect/callback URL for every OAuth provider below: `${NANGO_SERVER_URL}/oauth/callback`.
  The repo never hard-codes it (Nango owns the route), so copy the exact value
  from the integration's page in the Nango UI ("Callback URL") when you register
  the provider app, and confirm it uses your public `NANGO_SERVER_URL`, not localhost.
- Nango integration unique key must equal the Darex catalog id (`configByKey` in
  `app/api/integrations/route.ts`): `gmail`, `google-calendar`, `google-drive`,
  `google-docs`, `google-sheets`, `google-ads`, `meta-ads`, `hubspot`, `stripe`,
  `notion`, `slack`, `shopify`, `zendesk`, `intercom`, `github`, `quickbooks`,
  `microsoft-outlook`, `microsoft-calendar` (WhatsApp checks `whatsapp` then
  `whatsapp-business`). Provider defaults and scopes live in
  `services/connectors/nango.yaml` (scopes below are from it).
- "Configured" means the Nango config exists and its OAuth client ID is not empty
  or a placeholder (`lib/nango-server.ts`). Client secret is not inspected.
- Universal check for rows 1 to 12:
  `GET /api/integrations` (signed in) returns `integrations[].oauthConfigured === true`
  for that id and no `missingConfigReason`. Then connect once from the card and
  confirm `connected: true`.
- Seeding shortcut for Google only: after ONE Google config has a real client ID
  and secret, `infra/scripts/seed-nango-configs.sql` clones them to the other
  `google-*` keys (see header for the command), then restart `nango-server`.

## 1. NEXT_PUBLIC_NANGO_PUBLIC_KEY

- Console: Nango UI (`NEXT_PUBLIC_NANGO_HOST`) environment settings, public key.
- Goes in: dashboard env `NEXT_PUBLIC_NANGO_PUBLIC_KEY` (build-time public var,
  so rebuild/redeploy the dashboard). Also set `NANGO_SECRET_KEY` (server) to the
  same Nango environment's secret key.
- Check: `GET /api/integrations` -> `nango.publicKeyConfigured === true` and
  `nango.secretConfigured === true`; the connectors grid banner disappears.

## 2. OAuth providers (Nango UI > Integrations > the key from section 0)

Fields per provider in Nango: Client ID, Client Secret, Scopes. Scope lists
come from `services/connectors/nango.yaml` (broad by design; the provider app
must be allowed to grant them).

| # | Provider (Nango key) | Console to open | Scopes (from nango.yaml) | Notes |
|---|---|---|---|---|
| 1 | Google (`gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-sheets`, ...) | Google Cloud Console > APIs & Services > Credentials > OAuth client (Web). Add the Nango callback to Authorized redirect URIs. Enable Gmail/Calendar/Drive/Docs/Sheets APIs. | gmail: `openid email profile https://mail.google.com/ .../gmail.modify .../gmail.compose .../gmail.send .../gmail.labels`; calendar `.../auth/calendar(.events)`; drive `.../auth/drive`; sheets `.../auth/spreadsheets`; docs `.../auth/documents` | Restricted Gmail/Drive scopes need Google app verification for production. `access_type=offline`, `prompt=consent` are set in nango.yaml. |
| 2 | Meta (`meta-ads`, `whatsapp-business`) | developers.facebook.com > My Apps > app > Facebook Login > Valid OAuth Redirect URIs | meta-ads: `public_profile email business_management ads_read ads_management pages_show_list pages_read_engagement instagram_basic instagram_manage_insights`; whatsapp-business: `business_management whatsapp_business_management whatsapp_business_messaging public_profile` | Graph v24.0 URLs. Advanced access needs Meta business verification. WhatsApp via the card is BYOK (system-user token), not this OAuth. |
| 3 | HubSpot (`hubspot`) | developers.hubspot.com > Apps > app > Auth > Redirect URL | `crm.objects.{contacts,companies,deals,tickets,products,quotes,line_items,custom}.{read,write}`, `crm.schemas.*.read`, `automation`, `files`, `conversations.read/write`, `marketing.campaigns.read/write` | Sensitive-data scopes require HubSpot approval. |
| 4 | Stripe connector (`stripe`) | dashboard.stripe.com > Settings > Connect > Settings > OAuth > Redirects | read/write on customers, payments, payment_intents, refunds, subscriptions, products, prices, invoices, payment_links, checkout_sessions; read on balance, payouts, disputes | This is the org's own Stripe (agent tools). Separate from Darex platform billing (section 4). |
| 5 | Notion (`notion`) | notion.so/my-integrations > Public integration > Redirect URIs | pages, databases, blocks, comments (read/write), users.read, search | Notion scopes are capability toggles on the integration, not an OAuth scope string. |
| 6 | Slack (`slack`) | api.slack.com/apps > app > OAuth & Permissions > Redirect URLs | bot: `channels:read channels:history channels:join groups:read groups:history im:read im:history im:write mpim:read mpim:history chat:write chat:write.public files:read files:write users:read users:read.email team:read reactions:read reactions:write` (full list in nango.yaml) | Distribution must be enabled for other workspaces. Events webhook is separate (`/api/webhooks/slack`). |
| 7 | Shopify (`shopify`) | partners.shopify.com > Apps > app > Configuration > Allowed redirection URL(s) | `read_products write_products read_orders write_orders read_customers write_customers read_inventory write_inventory read_fulfillments write_fulfillments read_discounts write_discounts read_price_rules write_price_rules read_shipping read_analytics read_reports` | Popup also asks for the shop subdomain (catalog `operatorHint`). |
| 8 | Zendesk (`zendesk`) | Zendesk Admin Center > Apps and integrations > APIs > OAuth Clients > Redirect URLs | `read write` (plus tickets/users/organizations in nango.yaml) | Popup asks for the account subdomain. |
| 9 | Intercom (`intercom`) | developers.intercom.com > app > Authentication > Redirect URLs | contacts, conversations, companies, tags, articles, notes, admins (read/write per nango.yaml) | Set permissions on the Intercom app; scopes are not sent as a string. |
| 10 | GitHub (`github`) | github.com > Settings > Developer settings > OAuth Apps (or GitHub App) > Authorization callback URL | catalog: `repo read:org`; nango.yaml mode is `GITHUB_APP` (repo/contents/issues/pull_requests/actions permissions) | Pick one mode in Nango to match the integration's `auth_mode`; GitHub App needs App ID, private key and slug in Nango. |
| 11 | QuickBooks (`quickbooks`) | developer.intuit.com > app > Keys & credentials > Redirect URIs | `com.intuit.quickbooks.accounting` | Production keys need Intuit app review. `QUICKBOOKS_API_BASE_URL`, `QUICKBOOKS_ENVIRONMENT`, `QUICKBOOKS_REALM_ID` are env (see `.env.example`). |
| 12 | Microsoft (`microsoft-outlook`, `microsoft-calendar`) | Azure Portal > Entra ID > App registrations > Authentication > Web redirect URIs | `offline_access openid email profile User.Read Mail.Read Mail.ReadWrite Mail.Send` / `Calendars.Read Calendars.ReadWrite` | Uses the `common` tenant endpoints; admin consent is needed for org tenants that restrict user consent. |

For each: paste the Client ID and Client Secret into the Nango integration,
confirm scopes match, save. If the integration is missing, create it with the
exact unique key from section 0 and the matching provider template.
Check: universal check in section 0 (`oauthConfigured`).

## 3. Google Ads developer token

- Console: Google Ads (manager account) > Tools > API Center > Developer token.
  Apply for Basic access for production; test-level tokens work only on test accounts.
- OAuth client: same Google client as row 1, `google-ads` key in Nango, scope
  `https://www.googleapis.com/auth/adwords`.
- Goes in: env `GOOGLE_ADS_DEVELOPER_TOKEN` on BOTH the dashboard (connection
  test, `services/connectors/src/test-connection.ts`) and the worker
  (`services/workflows/src/tools/google-ads.ts`, `services/connectors/src/google-ads.ts`).
  Restart both. Without it Ads stays `catalog_only`.
- Check: connect `google-ads`, run the card's Test (add the Google Ads customer
  ID): the missing-token message ("GOOGLE_ADS_DEVELOPER_TOKEN is not set")
  disappears and the ping returns Ads data. `oauthConfigured` alone does not prove this.

## 4. Live Stripe and Razorpay runs (Darex platform billing)

These bill Darex subscriptions and are separate from the org-owned `stripe`
connector above. Env names are in `.env.example`; boot guards are in
`lib/boot-guards.ts` and `app/api/billing/_lib.ts`.

Stripe
- Console: dashboard.stripe.com (live mode) > Developers > API keys and Products
  (create three prices + one seat add-on) and Developers > Webhooks > Add
  endpoint `https://<NEXT_PUBLIC_APP_URL host>/api/webhooks/billing`.
- Goes in: `DAREX_STRIPE_SECRET_KEY`, `DAREX_STRIPE_WEBHOOK_SECRET` (endpoint
  signing secret), `DAREX_STRIPE_PRICE_STARTER|GROWTH|ENTERPRISE|ADDON_SEAT`.
  Set `DAREX_BILLING_REQUIRED=true` so a partial config refuses boot.
- Events: at least the subscription, invoice and checkout-session events the
  handler processes (`processStripeEvent` in `_lib.ts`); the route detects Stripe
  by the `stripe-signature` header.

Razorpay
- Console: dashboard.razorpay.com (live mode) > Account & Settings > API keys;
  Subscriptions > Plans (create one per tier); Webhooks > Add endpoint
  `https://<NEXT_PUBLIC_APP_URL host>/api/webhooks/billing` (same route; detected
  by `x-razorpay-signature`).
- Goes in: `DAREX_RAZORPAY_KEY_ID`, `DAREX_RAZORPAY_KEY_SECRET`,
  `DAREX_RAZORPAY_WEBHOOK_SECRET`, `DAREX_RAZORPAY_PLAN_STARTER|GROWTH|ENTERPRISE`.
- Org-owned Razorpay for rent payments is BYOK per org on the connectors card
  (`/api/integrations/razorpay`), not these vars.

Checks (both): `NEXT_PUBLIC_APP_URL` must be the public HTTPS URL. Run one real
low-value checkout from `/billing`, then confirm (a) the provider dashboard shows
the webhook delivered with 2xx, (b) the org's subscription row flips to active,
(c) `POST /api/webhooks/billing` with a bad signature returns a signature error,
not 200. Only after this can billing.md mark live runs done.

## 5. Optional but related

- Nango connection webhooks: set `NANGO_WEBHOOK_SECRET` first (receiver returns
  503 until set), then point Nango's webhook URL at `/api/webhooks/nango`. Check:
  Nango delivery log shows 2xx (`X-Nango-Signature` verified).
