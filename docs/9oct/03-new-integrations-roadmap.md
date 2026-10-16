# New Integrations Roadmap (2026-10-09)

> Planning document. Nothing here is built yet. Every integration listed below
> was checked for absence in code on 2026-10-09 (see Appendix A). Tool specs
> for the Wave 1 set live in [`04-integration-tool-specs.md`](04-integration-tool-specs.md).

---

## 0. How to read this document

- **Section 1** is the baseline: what already exists, so nothing here
  duplicates it.
- **Section 2** defines the tiers, effort scale, and the auth legend used in
  every table.
- **Section 3** is the catalog: 19 categories, 80+ integrations not yet in
  the codebase.
- **Section 4** covers generic connectors. They give the long tail of
  integrations (thousands of SaaS apps) at the cost of a handful of modules.
- **Section 5** covers the MCP-server ecosystem: letting a workspace plug in
  any remote MCP server and expose its tools to its employees safely.
- **Section 6** rolls the waves up into a build order.
- **Section 7** lists the platform prerequisites that block or speed up the
  waves (credential types, multi-account, inbound webhooks, Nango pinning).
- **Section 8** is risks and open questions.
- **Appendix A** is the absence verification. **Appendix B** maps each
  employee to the integrations that grow its job.

The product rule that shapes every choice here comes from `CLAUDE.md` §0 and
`AGENTS.md` §4a: **the Ask AI chat is the front door**. An integration is only
"done" when the right employee can use it from `/ask-ai`, a send/pay/sign/
publish/delete action parks for human approval, and a missing connection
returns an honest `notConnected` result with a `/connectors?connect=<id>`
link. A connector that only appears on the `/connectors` grid but has no chat
tool does not count.

---

## 1. Baseline: what already exists

### 1.1 Tool modules (services/workflows/src/tools/)

The registry in `services/workflows/src/tools/index.ts` (`TOOL_MODULES`,
`PROVIDER_KEYS`, `moduleForProvider`) has these provider modules today:

| Group | Modules |
|---|---|
| Google | `gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-sheets`, `google-slides`, `google-forms`, `google-chat`, `google-meet`, `google-contacts`, `google-tasks`, `google-analytics`, `google-search-console`, `google-business-profile`, `google-cloud`, `google-ads`, `maps` |
| Microsoft | `microsoft-outlook`, `microsoft-calendar` |
| CRM | `hubspot`, `salesforce`, `zoho` (zoho-crm) |
| Messaging | `whatsapp`, `instagram`, `slack`, `twilio` (SMS) |
| Support | `zendesk`, `intercom` |
| Payments / finance | `stripe`, `razorpay`, `quickbooks`, `billing` (internal usage) |
| Commerce | `shopify` |
| Knowledge | `notion`, `cognee` (memory) |
| Dev | `github` |
| E-sign | `docusign`, `leegality` |
| Sales intel | `apollo`, `linkedin` |
| Ads | `meta-ads`, `google-ads` |
| Real estate | `realestate` (`re`), `mls` (stub returning `notConnected`), `rera` (public lookup) |
| Internal / platform | `sandbox`, `web_search`, `web_extract`, `database_query`, `file_ops`, `metrics`, `connectors`, `customer-ops`, `operations`, `growth`, `daily_brief` |

`docs/new-109-pg-plan/gap26sept/chat-coverage.md` lists **154 chat tools**
across these modules. All 154 rows are still 🔴 (not yet proved live from
`/ask-ai`).

### 1.2 Connector catalog (apps/dashboard)

`apps/dashboard/lib/integrations-catalog.ts` (`INTEGRATION_CATALOG`) and
`packages/shared-types/src/connector-signin.ts` (`CONNECTOR_SIGN_IN_IDS`)
carry 31 sign-in ids: whatsapp, gmail, the Google family, google-ads,
meta-ads, hubspot, stripe, notion, slack, shopify, zendesk, intercom, github,
razorpay, quickbooks, microsoft-outlook, microsoft-calendar,
google-workspace, google. Salesforce, Zoho, Twilio, DocuSign, Leegality,
Apollo and LinkedIn have tool modules but **no sign-in id**, so their
`notConnected` results fall back to `/connectors` with no `?connect=`
deep link. That is a pre-existing gap worth closing alongside Wave 1 (it is
the same edit each new integration needs).

### 1.3 How an integration is wired today (summary)

Full playbook in `04-integration-tool-specs.md` §2. In short, a new provider
touches:

1. `services/workflows/src/tools/<provider>.ts`: a `ToolModule`
   (`actions`, `risk`, `confirm`, `execute`).
2. `services/workflows/src/tools/index.ts`: import, `TOOL_MODULES`,
   `PROVIDER_KEYS`, `moduleForProvider` case.
3. `services/workflows/src/tool-definitions.ts` **and** the duplicate `TOOLS`
   array in `services/workflows/src/mcp-bridge.ts`: the chat tool names,
   descriptions and zod schemas.
4. `services/workflows/src/local-tool-select.ts` (intent regex),
   `services/workflows/src/inbound-hitl.ts` (`isSendRisk`), and
   `apps/dashboard/lib/confirm-classes.ts` (`SEND_TOOLS` / `PAY_TOOLS` /
   `SIGN_TOOLS` / `PUBLISH_TOOLS`).
5. Connector surface: `connector-signin.ts`, `integrations-catalog.ts`,
   `connector-registry.ts` (`CONNECTOR_REGISTRY_META`),
   `services/connectors/src/providers.ts` (`NANGO_PROVIDER_ALIASES`,
   `NANGO_PING_SPECS`).
6. Employees: `apps/dashboard/lib/employee-provision.ts`
   (`DEFAULT_EMPLOYEE_ROSTER`), an additive backfill migration (pattern:
   `infra/db/migrations/112_growth_sales_employee_tools.sql`), and
   `services/workflows/src/tools/role-capability.ts` persona denials.
7. Tests registered in the explicit list in
   `services/workflows/package.json` `"test"`, then
   `pnpm --filter @darex/workflows chat-coverage`, then `BUILD_STATE.md`.

Because step 3 to 7 are the same for every provider, **effort in this
document is dominated by provider API surface, auth quirks and webhooks**, not
by Darex wiring.

---

## 2. Legend

### 2.1 Waves

| Wave | Meaning | Target |
|---|---|---|
| **Wave 1** | Directly unlocks a core employee job that users already ask for in chat, or gives cheap long-tail coverage (generic connectors). Specced in `04`. | Next 4 to 6 weeks |
| **Wave 2** | Strong demand in a segment (India SMB, e-commerce, agencies, real estate), or a second provider in a category Wave 1 already opened. | Following quarter |
| **Wave 3** | Niche, enterprise-only, licence-gated, or well covered by a generic connector until demand proves otherwise. | On demand |

### 2.2 Effort

Effort covers the tool module, chat tool definitions, wiring, tests, catalog
entry, ping spec, roster/migration change, and chat-coverage + BUILD_STATE
updates. It excludes registering OAuth apps with the vendor (human-only, 🔴
per `CLAUDE.md` §0) and vendor app review.

| Code | Size | Typical shape |
|---|---|---|
| **S** | 1 to 2 days | 2 to 4 tools, single REST API, Nango OAuth or API key, no webhooks |
| **M** | 3 to 5 days | 5 to 8 tools, pagination, a config value (subdomain, site id), one webhook or a send path with special rules |
| **L** | 1 to 2 weeks | Several resource types, inbound webhooks, provider-specific rules (24-hour windows, templates, compliance), new DB rows |
| **XL** | 2+ weeks | New runtime capability (voice, streaming, generic importers, remote MCP), security design, UI work |

### 2.3 Auth column

The auth column names how credentials are obtained and stored.

- **Nango `key`**: the provider template key in Nango's provider catalog.
  - ✔ means the key is in Nango's published provider list as far as this
    team currently knows.
  - **?** means the key is a best guess and is **unverified**.
  - Before building, confirm every key against the provider list of the
    *running* Nango server. `infra/docker-compose.yml` pins
    `nangohq/nango-server:latest`, so the list can change on any pull (see
    §7.5).
- **OAuth2 / API key / Basic** is the auth type inside Nango. API-key and
  Basic connections need the credential-type extension in §7.1, because
  `resolveNangoAuth` in `services/workflows/src/tools/shared.ts` only reads
  `credentials.access_token` today.
- **BYOK** means a per-org secret stored like the WhatsApp/Razorpay paths
  (`channels.meta`). Prefer Nango API-key mode over new BYOK columns. Use
  BYOK only where Nango has no template.
- **Platform key** means one Darex-owned key in env (like web search). Only
  for providers where the data is not tenant-owned.

### 2.4 Employee column

Employee names match `DEFAULT_EMPLOYEE_ROSTER` in
`apps/dashboard/lib/employee-provision.ts` and the persona families in
`services/workflows/src/tools/role-capability.ts`:

| Short | Roster employee | Persona family |
|---|---|---|
| CUS | Customer (Customer Resolution) | `customer` |
| SUP | Emma (Customer Support) | `customer` |
| OPS | Operations | `operations` |
| GRO | Growth | `growth` |
| SAL | Sarah (Sales & Lead Gen) | `sales` |
| MKT | Marcus (Marketing & Analytics) | `marketing` |
| RES | Research | none (no persona denial) |
| EXE | Executive | none |
| FIN | Finance | `finance` |

---

## 3. Integration catalog by category

Each table row: integration, who uses it and why, auth, the top chat use
cases (phrased as a user would ask), wave, effort. Risk notes call out any
action that must park for approval.

### 3.1 CRM

HubSpot, Salesforce and Zoho CRM exist. The gap is the SMB and agency CRMs
that small sales teams in the target market actually run on.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 1 | **Pipedrive** | SAL, GRO: the most common SMB sales CRM outside HubSpot; Sarah cannot move deals for these orgs today | Nango `pipedrive` ✔ OAuth2 | "Which deals in Proposal stage haven't moved in 10 days?" · "Create a deal for Acme, 4 lakh, owner me" · "Log a call note on Priya's person record" · "Move the Acme deal to Negotiation" | **Wave 1** | M |
| 2 | **Attio** | SAL, GRO: modern startup CRM; flexible objects | Nango `attio` ✔ OAuth2 | "Add this founder to the Investors list" · "Find records where last interaction > 30 days" | Wave 2 | M |
| 3 | **Close** | SAL: call-heavy inside sales CRM | Nango `close` ? API key | "Show my leads with no activity this week" · "Create a task to call back Ravi tomorrow" | Wave 2 | M |
| 4 | **Freshsales (Freshworks CRM)** | SAL: strong in India and SMB | Nango `freshsales` ? API key + domain | "List hot leads from this week" · "Update deal amount" | Wave 2 | M |
| 5 | **Microsoft Dynamics 365 Sales** | SAL, OPS: enterprise accounts | Nango `microsoft` family ? OAuth2 (Dataverse scope per org URL) | "Find the opportunity for Contoso" · "Update close date" | Wave 3 | L |
| 6 | **Copper** | SAL: Google Workspace-native CRM | Nango `copper` ? API key | "Which opportunities close this month?" | Wave 3 | S |
| 7 | **LeadSquared** | SAL: dominant in Indian education, real estate and BFSI lead management | BYOK (access key + secret key), Nango template unverified | "New leads from 99acres today" · "Change lead stage to Site Visit Done" | Wave 2 | M |
| 8 | **Bitrix24** | SAL, OPS: popular all-in-one SMB suite in India and EMEA | Nango `bitrix24` ? OAuth2 | "Create a lead" · "List today's tasks" | Wave 3 | M |

Risk notes. Create/update of CRM records is `draft` today (HubSpot,
Salesforce, Zoho all classify create/update as `draft`, see
`chat-coverage.md`), so it does not park. Keep that consistent. Any
`delete_*` action is `delete` and parks; the persona map already denies
`delete` for growth, customer, operations, sales and marketing
(`role-capability.ts` `PERSONA_DENIED_ACTIONS`). The customer persona is
denied `create_deal` / `update_deal`, which applies automatically as long as
new action names keep those substrings.

### 3.2 Email and calendar

Gmail, Google Calendar, Outlook mail and Outlook calendar exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 9 | **Generic IMAP/SMTP mailbox** | SUP, CUS, SAL: Zoho Mail, GoDaddy, Hostinger, cPanel and self-hosted inboxes are very common among Indian SMBs and cannot use Gmail/Outlook tools | BYOK (host, port, username, app password), see §4.5 | "Any unread mail from the bank?" · "Reply to the last mail from Mehta Builders" | **Wave 1** | L |
| 10 | **Zoho Mail** | SUP, SAL: Zoho Workplace orgs already on Zoho CRM | Nango `zoho-mail` ? OAuth2 (data-centre specific host) | "Search mail for invoice 2231" · "Send the brochure to the lead" | Wave 2 | M |
| 11 | **Generic CalDAV** | OPS, SUP: iCloud, Fastmail, Zoho Calendar, Nextcloud | BYOK (server URL, username, app password), see §4.6 | "What's on my calendar Friday?" · "Book a site visit 4 pm Saturday" | Wave 2 | L |
| 12 | **Zoho Calendar** | OPS | Nango `zoho-calendar` ? OAuth2 | "Check my availability next Tuesday" | Wave 3 | S |
| 13 | **Microsoft To Do / Planner** | OPS, EXE: task lists for Microsoft orgs, mirror of `google-tasks` | Nango `microsoft` ✔ (Graph, `Tasks.ReadWrite`) | "Add 'renew lease' to my list for Monday" | Wave 2 | S |
| 14 | **Exchange on-prem (EWS)** | OPS: enterprises not on Microsoft 365 | BYOK | Same as Outlook | Wave 3 | L |

Risk notes. Every send/reply is `send` and parks (same as `gmail_send`,
`outlook_reply`). Drafts are `draft`. The operations persona is denied
`send_email` and `draft_email` substrings, so the new mailbox tools must keep
those substrings in their action names for the denial to apply.

### 3.3 Messaging, chat and social

WhatsApp, Instagram DMs, Slack, Google Chat and Twilio SMS exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 15 | **Microsoft Teams** | OPS, EXE, SUP: the Slack equivalent for Microsoft orgs; decision cards and internal notifications | Nango `microsoft-teams` ✔ OAuth2 (Graph) | "Post the daily brief to #ops in Teams" · "What did the team say in the Leasing channel today?" · "Reply in that thread: approved" | **Wave 1** | M |
| 16 | **Telegram Bot** | SUP, CUS: common customer channel in some markets; cheap to add | BYOK (bot token from BotFather), Nango template unverified | "Show today's Telegram messages" · "Reply to Arjun on Telegram" | **Wave 1** | M |
| 17 | **Facebook Page Messenger** | SUP, CUS: Page inbox alongside Instagram DMs; same Graph send API and 24-hour rule | Reuse Meta channel credentials (same as `instagram`) | "Any new Messenger messages?" · "Reply to that Messenger lead" | Wave 2 | M |
| 18 | **Facebook / Instagram Page publishing** | MKT: schedule and publish posts | Nango `facebook` ✔ OAuth2 (pages_manage_posts) | "Schedule this post for Friday 7 pm" · "How did yesterday's post perform?" | Wave 2 | M |
| 19 | **LinkedIn Company Page posts** | MKT, GRO | Nango `linkedin` ✔ OAuth2 (Community Management API, partner approval) | "Post the hiring update on our page" | Wave 3 | M |
| 20 | **X (Twitter)** | MKT: post and read mentions | Nango `twitter-v2` ✔ OAuth2 (paid API tier) | "Draft a thread about the launch" · "Any mentions today?" | Wave 3 | M |
| 21 | **Discord** | SUP: community support for developer/creator brands | Nango `discord` ✔ OAuth2 + bot token | "Summarise #support today" · "Reply in that thread" | Wave 3 | M |
| 22 | **YouTube** | MKT: channel analytics, comment replies | Nango `youtube` ✔ OAuth2 | "Top videos this month by watch time" · "Reply to the new comments" | Wave 3 | M |
| 23 | **Gupshup / Interakt / WATI (WhatsApp BSPs)** | SUP, MKT: Indian SMBs often hold their WhatsApp number on a BSP, not on Meta Cloud API directly | BYOK (API key) | "Send the template 'site_visit_reminder' to these 20 leads" | Wave 2 | L (per BSP M; build one gateway transport in `packages/whatsapp-gateway`) |
| 24 | **Google Business Messages / Reviews reply** | SUP, MKT: reply to Google reviews (extends existing `google-business-profile` which only lists locations) | Existing Google auth | "Reply to the 2-star review politely" | Wave 2 | S |

Risk notes. Every outbound message is `send`. Posting to a public feed is
`publish`. Both park. Meta channels must keep the 24-hour window check that
`instagram.ts` `sendDm` implements. Bulk/template sends must go through the
existing quiet-hours and critic checks in `tool-gate.ts` (they run for
`send` risk already).

### 3.4 Voice and telephony

Twilio SMS exists. There is no calling, call logs, or voice agent.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 25 | **Exotel** | SUP, SAL: the default Indian cloud telephony for SMBs; call logs and click-to-call | BYOK (API key, token, SID, subdomain) | "How many missed calls today?" · "Connect me to Ravi" (click-to-call) · "Pull the recording of the 3 pm call" | Wave 2 | M |
| 26 | **Twilio Voice (extend `twilio`)** | SUP, SAL: call logs, recordings, outbound calls | Existing Twilio credentials | "Call logs for +91… this week" · "Start a call bridging me and the lead" | Wave 2 | M |
| 27 | **Vapi** | SUP, SAL: AI voice agent for inbound/outbound calls, built on top of employees' knowledge | Platform or BYOK API key | "Have the voice agent call these 10 leads to confirm site visits" · "Summarise yesterday's AI calls" | Wave 2 | XL |
| 28 | **Retell AI** | Same as Vapi (alternative) | BYOK API key | Same | Wave 3 | XL |
| 29 | **Aircall** | SUP, SAL: call-center phone for SMB support teams | Nango `aircall` ✔ OAuth2 | "Missed calls in the last hour" · "Add a note to the last call with Acme" | Wave 2 | M |
| 30 | **RingCentral** | SUP, OPS: enterprise phone + SMS | Nango `ringcentral` ✔ OAuth2 | "Send an SMS from our main line" · "Call history today" | Wave 3 | M |
| 31 | **Plivo** | SUP: SMS/voice alternative to Twilio with India routes | BYOK (auth id + token) | "Send SMS reminder" | Wave 3 | S |
| 32 | **Knowlarity / MyOperator** | SUP, SAL: Indian IVR/virtual number providers | BYOK | "Missed calls from the IVR today" | Wave 3 | M |

Risk notes. Placing a call is `send` and must park. Initiating an AI voice
call campaign is a bulk send; it must park once per batch with the full
recipient list in the approval card. Recordings are personal data: a DSR
delete must reach stored transcripts (`services/workflows/src/dsr/`).

### 3.5 Payments, finance and accounting

Stripe, Razorpay and QuickBooks exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 33 | **Xero** | FIN: second most common SMB ledger globally; Finance cannot reconcile for Xero orgs | Nango `xero` ✔ OAuth2 (tenant id from connections endpoint) | "Which invoices are overdue more than 30 days?" · "Create a draft invoice for Acme for 3 months retainer" · "What's our cash position?" | **Wave 1** | M |
| 34 | **Zoho Books** | FIN: very common in India alongside Zoho CRM; GST-aware | Nango `zoho-books` ? OAuth2 (org id + DC host) | "Outstanding receivables" · "Create invoice with GST 18%" | Wave 2 | M |
| 35 | **Tally (TallyPrime)** | FIN: the dominant Indian desktop ledger | No cloud API; needs a local connector (Tally XML/ODBC over a tunnel) or a sync partner | "Ledger balance for Sharma Traders" | Wave 3 | XL |
| 36 | **PayPal** | FIN, CUS: payments, refunds, invoices for cross-border sellers | Nango `paypal` ✔ OAuth2 (client credentials per merchant) | "Did order 552 get paid via PayPal?" · "Send an invoice to this client" | Wave 2 | M |
| 37 | **Cashfree / PayU / PhonePe PG** | FIN: Indian payment gateways besides Razorpay | BYOK (app id + secret) | "Create a payment link for 15,000" · "Settlements this week" | Wave 2 | M each |
| 38 | **Chargebee** | FIN, CUS: subscription billing | Nango `chargebee` ? API key + site | "Which subscriptions churned this month?" · "Pause Acme's subscription" | Wave 2 | M |
| 39 | **FreshBooks** | FIN: freelancers and agencies | Nango `freshbooks` ✔ OAuth2 | "Unbilled time this month" · "Create invoice" | Wave 3 | S |
| 40 | **Wise Business** | FIN: payouts and FX | BYOK API token | "Balance in USD" · "Send payout" (pay) | Wave 3 | M |
| 41 | **Brex / Ramp** | FIN: card spend and expenses | Nango `brex` ✔ / `ramp` ✔ OAuth2 | "Card spend by department this month" | Wave 3 | S each |
| 42 | **Plaid (bank feeds)** | FIN: bank balances and transactions for reconciliation (US/EU) | Platform key + per-org Link token | "Match last week's deposits to invoices" | Wave 3 | L |
| 43 | **Account Aggregator (India, e.g. via Setu/Finvu)** | FIN: consented bank statements | Partner contract, 🔴 licence | "Pull last month's statement" | Wave 3 | XL |

Risk notes. Creating a charge, payout, payment link or refund is `pay` and
parks. `tool-gate.ts` `payloadDenial` already refuses a `pay` action without
a positive `amount`; new payment tools must use `amount` (or `amount_cents`)
as the field name so that check applies. Creating a draft invoice is `draft`;
**sending** or **approving** an invoice (status change that emails the
customer or posts to the ledger) is `send`. The marketing persona is denied
`charge` and `payout` substrings; customer is the only persona allowed to
`refund` when granted.

### 3.6 E-commerce

Shopify (orders and products, read) exists.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 44 | **WooCommerce** | CUS, OPS: the largest self-hosted store platform; order status questions are the #1 support ask | Nango `woocommerce` ? Basic (consumer key/secret) + store URL | "Where is order 1043?" · "Which orders are pending payment?" · "Add a note to order 1043" | **Wave 1** | M |
| 45 | **Shopify write actions (extend `shopify`)** | CUS, OPS: cancel, refund, fulfil, tag orders; update inventory | Existing Shopify auth | "Refund order #1002 shipping only" (pay) · "Mark #1003 fulfilled with tracking" | Wave 2 | M |
| 46 | **BigCommerce** | CUS, OPS | Nango `bigcommerce` ✔ OAuth2 | Order lookups and status | Wave 3 | M |
| 47 | **Amazon Seller Central (SP-API)** | OPS, FIN: orders, inventory, settlements | Nango `amazon` ? OAuth2 (LWA) + app registration, 🔴 developer approval | "Units sold this week" · "Low inventory SKUs" | Wave 3 | L |
| 48 | **Shiprocket** | CUS, OPS: Indian shipping aggregator; tracking questions | BYOK (email + password token) | "Track AWB 1234" · "Create a return pickup" | Wave 2 | M |
| 49 | **Delhivery / Blue Dart** | CUS | BYOK | "Track shipment" | Wave 3 | S each |
| 50 | **Etsy** | OPS: craft/creator sellers | Nango `etsy` ? OAuth2 | "New orders today" | Wave 3 | S |
| 51 | **Flipkart / Meesho seller APIs** | OPS: Indian marketplaces | Partner access 🔴 | "Pending dispatch orders" | Wave 3 | L |

Risk notes. Refunds are `pay`. Cancelling an order is `delete`-class in
effect (irreversible for the customer); classify `cancel_order` as `delete`
so it parks and the persona map blocks it for growth/marketing. Order notes
are `draft` when internal and `send` when "notify customer" is set.

### 3.7 Project management and work tracking

Nothing exists except Google Tasks (read) and the internal `operations`
work-item tools.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 52 | **Jira (Cloud)** | OPS, EXE, RES: engineering and service teams track work here | Nango `jira` ✔ OAuth2 (3LO, cloudId) | "What's blocking the release?" · "Create a bug: checkout fails on iOS" · "Move PROJ-142 to In Review" · "Comment on PROJ-142" | **Wave 1** | M |
| 53 | **Asana** | OPS, EXE: most common non-engineering task tool | Nango `asana` ✔ OAuth2 | "My overdue tasks" · "Create a task in Marketing: launch checklist due Friday" · "Mark the brochure task complete" | **Wave 1** | M |
| 54 | **Linear** | OPS, RES: startup engineering | Nango `linear` ✔ OAuth2 (GraphQL) | "Open urgent issues" · "Create an issue in the Web team" | **Wave 1** | S |
| 55 | **ClickUp** | OPS | Nango `clickup` ✔ OAuth2 | "Tasks due this week in Ops space" · "Create a task" | Wave 2 | M |
| 56 | **Trello** | OPS: very small teams | Nango `trello` ✔ OAuth1 | "Add a card to To Do" · "What's in Doing?" | Wave 2 | S |
| 57 | **monday.com** | OPS, SAL (often used as a light CRM) | Nango `monday` ✔ OAuth2 (GraphQL) | "Items in the Leads board with status Stuck" · "Update item status" | Wave 2 | M |
| 58 | **Basecamp** | OPS | Nango `basecamp` ✔ OAuth2 | "Today's to-dos" · "Post a message to the project" | Wave 3 | S |
| 59 | **Microsoft Planner** | OPS | Nango `microsoft` ✔ Graph | "Tasks in the Leasing plan" | Wave 3 | S |
| 60 | **Wrike / Smartsheet** | OPS: enterprise PMO | Nango `wrike` ✔ / `smartsheet` ✔ OAuth2 | Status rollups | Wave 3 | M each |

Risk notes. Creating/updating issues and tasks is `draft` (internal, reversible)
consistent with `work_item_create`. **Commenting** on an issue that notifies
external collaborators or customers (Jira Service Management public comment)
is `send`. Deleting is `delete`.

### 3.8 Docs and knowledge

Notion, Google Docs/Drive and the internal brain (cognee) exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 61 | **Confluence** | RES, EXE, SUP: the team wiki for Jira orgs; grounding answers in internal policy | Nango `confluence` ✔ OAuth2 (3LO, cloudId) | "What's our refund policy page say?" · "Create a page summarising this week's incidents" · "Append the meeting notes" | **Wave 1** | M |
| 62 | **Coda** | RES, OPS | Nango `coda` ? API key | "Read the pricing table doc" | Wave 3 | S |
| 63 | **SharePoint pages / lists** | RES, OPS | Nango `sharepoint-online` ✔ OAuth2 (Graph) | "Find the leasing SOP" | Wave 2 (with §3.12) | M |
| 64 | **Guru / Slab / Document360** | SUP: knowledge base for support agents | API key, Nango unverified | "Answer from the KB" | Wave 3 | S each |
| 65 | **Obsidian / Markdown repo** | RES | Covered by GitHub module or generic file sync | — | Wave 3 | — |
| 66 | **Knowledge ingestion connectors (Confluence, SharePoint, Drive full sync into cognee)** | All: the brain should index, not just fetch on demand | Same auth as each provider | "Re-index our Confluence space" | Wave 2 | L |

Risk notes. Reads are `read`. Creating/appending pages is `draft` (matches
`notion_create_page`, `docs_append`). Sharing a page externally or changing
permissions is `publish`.

### 3.9 Developer tools

GitHub (list repos, create repo, create issue) exists.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 67 | **GitHub (extend)**: PRs, reviews, workflow runs, releases | OPS, EXE | Existing | "Which PRs are waiting for review?" · "Did main's CI pass?" · "Draft release notes from merged PRs" | Wave 2 | M |
| 68 | **GitLab** | OPS | Nango `gitlab` ✔ OAuth2 | Same as GitHub | Wave 2 | M |
| 69 | **Bitbucket** | OPS | Nango `bitbucket` ✔ OAuth2 | Same | Wave 3 | M |
| 70 | **Sentry** | OPS: incident triage | Nango `sentry` ✔ OAuth2 | "New errors since the last deploy" · "Resolve issue 123" | Wave 2 | S |
| 71 | **PagerDuty / Opsgenie** | OPS: on-call | Nango `pagerduty` ✔ OAuth2 | "Who's on call?" · "Acknowledge the incident" | Wave 3 | S |
| 72 | **Vercel / Netlify** | OPS | Nango `vercel` ? OAuth2 | "Did the last deploy succeed?" | Wave 3 | S |
| 73 | **Datadog / Grafana** | OPS | API key | "Error rate in the last hour" | Wave 3 | M |

### 3.10 HR and recruiting

Nothing exists. This opens an HR employee (custom role) without new runtime
work.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 74 | **BambooHR** | OPS, EXE, custom HR employee | Nango `bamboohr` ✔ API key + subdomain | "Who's on leave this week?" · "Headcount by department" | Wave 2 | S |
| 75 | **Greenhouse** | Custom recruiter employee | Nango `greenhouse` ✔ Basic (Harvest key) | "Candidates in onsite stage for Backend role" · "Schedule a debrief" | Wave 2 | M |
| 76 | **Lever** | Recruiter | Nango `lever` ✔ OAuth2 | Same as Greenhouse | Wave 3 | M |
| 77 | **Workable** | Recruiter, SMB | Nango `workable` ✔ OAuth2/API key | "New applicants today" | Wave 3 | S |
| 78 | **Keka / Darwinbox / Zoho People** | OPS: Indian HRMS | BYOK, partner API access 🔴 for some | "Leave balance" · "Who's out today" | Wave 3 | M each |
| 79 | **Gusto / Deel / Rippling** | FIN: payroll (read-only first) | Nango `gusto` ✔ / `deel` ✔ / `rippling` ? OAuth2 | "Payroll cost this month" | Wave 3 | M each |

Risk notes. HR data is sensitive personal data. Default every HR tool to
read-only, put the provider on **no** default roster allowlist, and require
an explicit grant on a custom employee card. Moving a candidate stage or
sending a rejection is `send`.

### 3.11 Marketing, ads and analytics

Meta Ads, Google Ads (metrics), Google Analytics, Search Console and Business
Profile exist, all read-mostly.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 80 | **Mailchimp** | MKT, GRO: email campaigns and audiences | Nango `mailchimp` ✔ OAuth2 (dc from metadata) | "How did last week's newsletter do?" · "Add these 40 leads to the 'Site visit' audience" · "Draft a campaign for the Diwali offer" · "Send the campaign" (send, parks) | **Wave 1** | M |
| 81 | **Klaviyo** | MKT: e-commerce email/SMS flows | Nango `klaviyo` ✔ OAuth2 | "Flow revenue this month" · "Add profile to list" | Wave 2 | M |
| 82 | **Brevo (Sendinblue)** | MKT: popular low-cost ESP in India/EU | Nango `brevo` ? API key | "Send transactional email" · "Campaign stats" | Wave 2 | S |
| 83 | **SendGrid** | OPS, MKT: transactional email deliverability | Nango `sendgrid` ✔ API key | "Bounces today" · "Suppression list check" | Wave 3 | S |
| 84 | **ActiveCampaign** | MKT, SAL | Nango `active-campaign` ? API key + account URL | "Contacts who opened but didn't click" | Wave 3 | M |
| 85 | **LinkedIn Ads** | MKT | Nango `linkedin` ✔ (Marketing API, partner approval 🔴) | "Spend and CPL by campaign" | Wave 2 | M |
| 86 | **TikTok Ads** | MKT | Nango `tiktok-ads` ✔ OAuth2 | "Spend yesterday" | Wave 3 | M |
| 87 | **Microsoft Ads (Bing)** | MKT | Nango `microsoft-ads` ? OAuth2 + developer token | "Clicks and conversions" | Wave 3 | M |
| 88 | **Google Ads write (extend `google-ads`)** | MKT | Existing, needs developer token (🔴, see gap doc row 7) | "Pause campaign X" (publish) · "Raise budget 10%" (pay) | Wave 2 | M |
| 89 | **Mixpanel / Amplitude / PostHog** | MKT, EXE, GRO: product analytics | Nango `mixpanel` ? / `amplitude` ? / `posthog` ? API key | "Signup-to-activation conversion this week" · "Top events yesterday" | Wave 2 | S each |
| 90 | **Segment** | MKT, OPS: track events, list sources | Nango `segment` ✔ OAuth2 | "Which sources are sending events?" | Wave 3 | S |
| 91 | **Typeform** | GRO, SAL, SUP: lead and feedback forms; new responses become leads | Nango `typeform` ✔ OAuth2 | "New responses on the Contact Us form today" · "Summarise this month's NPS responses" · webhook: new response → lead | **Wave 1** | S |
| 92 | **Jotform / Tally forms** | GRO | Nango `jotform` ? API key / webhook-in | Same | Wave 3 | S |
| 93 | **Semrush / Ahrefs** | MKT: SEO research | API key (paid) | "Keyword ranking changes this week" | Wave 3 | S |
| 94 | **Hotjar / Microsoft Clarity** | MKT | API key | "Rage-click pages" | Wave 3 | S |

Risk notes. Sending a campaign is `send`. Changing an ad budget or bid is
`pay` (it spends money). Pausing/enabling a live ad or publishing a creative
is `publish`. `confirm-classes.ts` `PUBLISH_TOOLS` must gain each new ads
provider. Adding contacts to a list is `draft`, but **importing** contacts
into a list that auto-triggers a flow is `send`; specs must say which.

### 3.12 Storage and files

Google Drive exists.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 95 | **Microsoft OneDrive + SharePoint files** | RES, EXE, OPS: the Drive equivalent for Microsoft orgs | Nango `one-drive` ✔ / `sharepoint-online` ✔ OAuth2 (Graph) | "Find the latest lease template" · "Read the Q3 board deck" · "Save this summary to the Reports folder" · "Share the folder with the auditor" (publish) | **Wave 1** | M |
| 96 | **Dropbox** | RES, OPS | Nango `dropbox` ✔ OAuth2 | "Search for the floor plan PDF" · "Upload this report" · "Create a share link" (publish) | **Wave 1** | S |
| 97 | **Box** | RES, OPS: enterprise | Nango `box` ✔ OAuth2 | Same as Dropbox | Wave 2 | S |
| 98 | **Amazon S3 / Cloudflare R2 bucket** | OPS: data drops | BYOK (access key, scoped to one bucket) | "List files dropped today in the exports bucket" | Wave 3 | S |
| 99 | **Google Photos** | — | Not needed | — | — | — |

### 3.13 Support desks

Zendesk and Intercom exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 100 | **Freshdesk** | CUS, SUP: very common in India and SMB; Customer cannot work tickets for these orgs | Nango `freshdesk` ✔ API key + domain (Basic) | "Open urgent tickets" · "Reply to ticket 4412" (send) · "Add a private note" · "Set status Pending" | **Wave 1** | M |
| 101 | **Help Scout** | CUS, SUP | Nango `helpscout-mailbox` ? OAuth2 | "Unassigned conversations" · "Reply" | Wave 2 | M |
| 102 | **Front** | CUS, SUP, OPS: shared inbox | Nango `front` ✔ OAuth2 | "Conversations waiting > 4h" · "Reply" | Wave 2 | M |
| 103 | **Gorgias** | CUS: Shopify support | Nango `gorgias` ✔ OAuth2 (per-account domain) | "Tickets about delayed shipping" | Wave 2 | M |
| 104 | **Freshchat / Crisp / Tawk.to** | SUP: website chat | API key | "Live chats waiting" | Wave 3 | S each |
| 105 | **ServiceNow** | OPS, CUS: enterprise ITSM | Nango `servicenow` ✔ OAuth2 (instance URL) | "Open P1 incidents" | Wave 3 | L |
| 106 | **Chatwoot (as a tool, not only webhook)** | SUP: inbound webhook exists at `apps/dashboard/app/api/webhooks/chatwoot`, but chat cannot list or reply | BYOK (API token + base URL) | "Open Chatwoot conversations" · "Reply to that one" | Wave 2 | S |

Risk notes. A public reply to a ticket is `send` (matches `intercom_reply`).
A private/internal note is `draft`. Status, priority, assignee changes are
`draft` (matches `zendesk_update_ticket`). Merging or deleting tickets is
`delete`.

### 3.14 Scheduling and meetings

Google Calendar, Outlook Calendar and Google Meet exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 107 | **Calendly** | SAL, SUP, OPS: booking links and scheduled events; new bookings become leads or showings | Nango `calendly` ✔ OAuth2 | "Who booked a demo this week?" · "Send Ravi my 30-min link" · "Cancel tomorrow's 3 pm booking" (delete) · webhook: invitee.created → lead/showing | **Wave 1** | S |
| 108 | **Zoom** | SAL, EXE, OPS: meetings, recordings, transcripts | Nango `zoom` ✔ OAuth2 | "Schedule a Zoom with Acme Thursday 4 pm" · "Get the transcript of yesterday's sales call" · "Summarise last week's recordings" | **Wave 1** | M |
| 109 | **Cal.com** | SAL, SUP: open-source Calendly alternative | Nango `cal-com-v2` ? API key | Same as Calendly | Wave 2 | S |
| 110 | **Microsoft Teams meetings** | Same as Zoom for Microsoft orgs (Graph onlineMeetings) | Nango `microsoft-teams` ✔ | "Create a Teams meeting link" | Wave 2 (with #15) | S |
| 111 | **Fireflies / Otter / Fathom** | SAL, EXE: meeting notes and action items | Nango `fireflies` ? API key | "Action items from today's client calls" | Wave 2 | S |
| 112 | **Gong** | SAL, EXE: revenue intelligence | Nango `gong` ✔ OAuth2 | "Calls where pricing objections came up" | Wave 3 | M |
| 113 | **Acuity / SimplyBook / Setmore** | SUP: appointment-based businesses (clinics, salons) | API key | "Today's appointments" · "Reschedule" | Wave 3 | S each |

Risk notes. Creating a meeting with external invitees is `send` (matches
`calendar_create_event`). Cancelling a booking notifies the invitee and is
irreversible from their side: classify as `delete`.

### 3.15 E-signature

DocuSign and Leegality exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 114 | **Dropbox Sign (HelloSign)** | SAL, OPS, FIN | Nango `dropbox-sign` ? OAuth2 / API key | "Send the NDA to priya@acme.com" (sign) · "Status of the lease envelope" | Wave 2 | S |
| 115 | **PandaDoc** | SAL: proposals with pricing tables + e-sign | Nango `pandadoc` ✔ OAuth2 | "Create a proposal from the standard template for Acme" · "Has Acme opened the proposal?" | Wave 2 | M |
| 116 | **Adobe Acrobat Sign** | SAL, OPS: enterprise | Nango `adobe` ? OAuth2 | Same | Wave 3 | M |
| 117 | **Zoho Sign** | SAL: Zoho orgs | Nango `zoho-sign` ? OAuth2 | Same | Wave 3 | S |
| 118 | **Digio / SignDesk (Aadhaar eSign)** | OPS, SAL: India, alongside Leegality | BYOK | "Send for Aadhaar e-sign" | Wave 3 | M |

Risk notes. Sending for signature is `sign` and parks; it is already in
`confirm-classes.ts` `SIGN_TOOLS` for docusign/leegality, extend the set.

### 3.16 Data and warehouses

`database_query` exists (read-only SQL against the Darex DB).

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 119 | **Airtable** | OPS, SAL, MKT: the SMB database; many orgs run inventory, listings or lead lists in a base | Nango `airtable` ✔ OAuth2 | "Rows in the Listings table with status Available under 80L" · "Add a row for the new lead" · "Update the price on record recXYZ" | **Wave 1** | S |
| 120 | **External Postgres / MySQL (read-only)** | EXE, OPS, RES: query the org's own app database | BYOK (connection string, read-only role required), through a network-restricted runner | "How many signups yesterday in our app DB?" | Wave 2 | L |
| 121 | **BigQuery** | EXE, MKT | Nango `google` service account or OAuth2 ✔ (Google scope `bigquery.readonly`) | "Revenue by channel from the warehouse" | Wave 2 | M |
| 122 | **Snowflake** | EXE | Nango `snowflake` ? OAuth2 / key pair | Same | Wave 3 | M |
| 123 | **Redshift / Databricks** | EXE | BYOK | Same | Wave 3 | M |
| 124 | **Supabase** | OPS | Nango `supabase` ? OAuth2 (management) + project key | "Rows in the profiles table" | Wave 3 | M |
| 125 | **Google Sheets as database (already)** | — | exists | — | — | — |
| 126 | **Baserow / NocoDB / Smartsheet** | OPS | API key | Same as Airtable | Wave 3 | S each |

Risk notes. External SQL must be read-only by construction: require a
read-only DB role, wrap every query in a read-only transaction, apply a
statement timeout and a row cap, and reuse the parser checks in
`services/workflows/src/tools/database.ts` (`database-readonly.test.ts`).
Never run it from the worker's network namespace without egress rules: a
connection string is an SSRF vector into the private network.

### 3.17 Real estate and MLS

`realestate` (internal listings, inquiries, showings), `rera` (public lookup)
and an `mls` stub exist. `AGENTS.md` §4 lists "a licensed MLS API client" as a
known manual item.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 127 | **RESO Web API (generic MLS client)** | SAL, OPS, GRO: one client covers most US MLSs via the RESO standard; replaces the `mls` stub | BYOK per MLS (OAuth2 client credentials), 🔴 licence per MLS | "3-bed listings under 600k in 94110 updated today" · "Sync our active listings" | Wave 2 | L |
| 128 | **Bridge Interactive (Zillow Group)** | SAL: RESO-compliant aggregator | BYOK, 🔴 approval | Same | Wave 2 | M (on top of #127) |
| 129 | **Spark API (FBS)** | SAL | BYOK, 🔴 approval | Same | Wave 3 | M |
| 130 | **99acres / MagicBricks / Housing.com lead feeds** | SAL, GRO: Indian portals deliver leads by email, CSV or partner API | Mostly email parsing (Gmail/IMAP) or partner API 🔴 | "New 99acres leads today" · auto-create inquiry | Wave 2 | M (email parser) |
| 131 | **Zillow / Realtor.com lead delivery** | SAL | Lead webhook (generic webhook-in, §4.3) | Same | Wave 2 | S (on top of §4.3) |
| 132 | **Follow Up Boss** | SAL: US agent CRM | Nango `follow-up-boss` ? API key | "Leads assigned to me today" | Wave 3 | M |
| 133 | **kvCORE / BoldTrail** | SAL | BYOK partner key 🔴 | Same | Wave 3 | M |
| 134 | **AppFolio / Buildium / Yardi** | OPS, FIN: property management (rent, work orders) | Partner API 🔴 | "Units with rent overdue" · "Open maintenance requests" | Wave 3 | L |

Risk notes. Publishing a listing to a portal is `publish` (the
`confirm-classes.ts` `PUBLISH_RE` already matches "went live on 99acres /
housing / zillow"). MLS data carries display rules under each MLS licence:
store attribution fields and never mix MLS data across orgs.

### 3.18 AI, search and browser

Web search (SearXNG, Jina, DuckDuckGo, Google News, Wikipedia fallbacks in
`services/workflows/src/tools/web-search.ts`), web extract and a sandbox
exist.

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 135 | **Tavily / Exa / Brave Search API** | RES, GRO: higher-quality search with citations, as additional providers behind `web_search` (not new chat tools) | Platform key | "Latest funding news for Acme" | Wave 2 | S each |
| 136 | **Firecrawl** | RES, GRO: crawl a whole site to markdown, behind `web_extract` | Platform or BYOK key | "Crawl competitor.com pricing pages and compare" | Wave 2 | S |
| 137 | **Browserbase / Browserless (headless browser)** | OPS, RES: log into a portal with no API and read a page | BYOK key + per-org stored session; `execute` risk | "Download this month's statement from the vendor portal" | Wave 3 | XL |
| 138 | **Perplexity API** | RES: answer engine as a tool | Platform key | "Research the RERA rules for Pune" | Wave 3 | S |
| 139 | **Deepgram / AssemblyAI (speech-to-text)** | SUP, SAL: transcribe call recordings and voice notes from WhatsApp | Platform key | "Transcribe the voice note from Ravi" | Wave 2 | M |
| 140 | **ElevenLabs (TTS)** | MKT, SUP: voice replies, ad voiceovers | Platform or BYOK | "Turn this script into a voice note" | Wave 3 | S |
| 141 | **OCR / document AI (Google Document AI, Azure Document Intelligence)** | FIN, OPS: invoices, ID documents, leases | Platform key | "Extract line items from this invoice PDF" | Wave 2 | M |
| 142 | **Canva** | MKT: create designs from templates | Nango `canva` ? OAuth2 (Connect API) | "Make an Instagram post from the 'Open House' template" | Wave 3 | M |
| 143 | **Figma** | MKT, OPS: read comments and frames | Nango `figma` ✔ OAuth2 | "Unresolved comments on the landing page file" | Wave 3 | S |
| 144 | **Miro** | OPS | Nango `miro` ✔ OAuth2 | "Summarise the retro board" | Wave 3 | S |
| 145 | **Loom** | SAL, SUP | Embed SDK only, no public data API | — | — | — |

### 3.19 MCP-server ecosystem

Covered in depth in §5. Summary rows:

| # | Integration | Employee / why | Auth | Top chat use cases | Wave | Effort |
|---|---|---|---|---|---|---|
| 146 | **Generic remote MCP client** (Streamable HTTP + SSE) | All employees, per-grant: plug any vendor or in-house MCP server into the workspace | Per server: OAuth 2.1 (MCP auth spec), bearer token, or none | "Connect our Linear MCP server" (admin, UI) · then any tool that server exposes, e.g. "list my Linear issues" | **Wave 1** | XL |
| 147 | **Curated MCP directory** (vendor-hosted servers: Atlassian, Asana, Linear, Notion, Stripe, Sentry, Cloudflare, HubSpot, PayPal, Square, Intercom, Box, Canva, monday.com, Zapier) | All | Vendor OAuth through the MCP auth flow | One-click add from `/connectors` | Wave 2 | M (on top of #146) |
| 148 | **Darex as an MCP server for outside clients** | Customers' own agents call Darex employees and tools | Org API key + signed headers (bridge already signs `x-tfg-mcp-headers`) | "From Claude Desktop / Cursor: ask the Finance employee for overdue invoices" | Wave 3 | L |

---

## 4. Generic connectors: long-tail coverage

Native modules give the best chat experience but cost 1 to 10 days each.
Generic connectors cover thousands of apps once. They are worth building
early because they also answer the most common sales objection ("do you
integrate with X?") with "yes, through …" instead of "it's on the roadmap".

Every generic connector shares four non-negotiable rules:

1. **SSRF-safe egress.** Every outbound URL goes through
   `assertPublicUrl` / `safeGet` in `services/workflows/src/tools/safe-url.ts`
   (blocks private, loopback, link-local and metadata addresses, re-checks
   resolved IPs). The host is fixed at **connect time by an admin**, never
   taken from the model's tool arguments.
2. **Risk is declared, not guessed.** An imported operation's risk is set by
   HTTP method by default (GET/HEAD → `read`; POST/PUT/PATCH → `send`;
   DELETE → `delete`) and an admin can only *raise* it, or lower a specific
   POST to `read`/`draft` with an explicit checkbox that is audited. Unknown
   → highest class. This keeps the `confirmForRisk` contract in
   `services/workflows/src/tools/risk.ts`.
3. **Per-employee grant.** A generic connection is never added to
   `CORE_READ_TOOLS` (`tool-gate.ts`) or any default roster allowlist. An
   admin grants it to named employees.
4. **Untrusted output.** Responses are data, not instructions. Truncate to
   the large-tool-response budget and fence text that reaches the model
   (`services/workflows/src/untrusted.ts` `fenceUntrusted`).

### 4.1 Generic REST / OpenAPI importer — Wave 2, XL

**What.** An admin pastes an OpenAPI 3.x (or Swagger 2.0) URL/file, picks the
operations to expose, and supplies auth (API key header/query, bearer, Basic,
or OAuth2 via a Nango "custom OAuth" config). Darex generates one chat tool
per selected operation.

**Why.** Covers every SaaS with a published spec (thousands) and every
customer's in-house API. Sales, Ops and Finance employees all hit "our
internal system" requests.

**Shape.**
- Storage: new tables `custom_connectors (id, org_id, name, base_url,
  auth_kind, nango_connection_id, spec_hash, created_by, ...)` and
  `custom_connector_operations (id, connector_id, op_id, method,
  path_template, input_schema jsonb, risk, enabled)`, RLS on `org_id`,
  `FORCE ROW LEVEL SECURITY` (migration convention in
  `infra/db/migrations/`).
- Runtime: one provider module `custom-api` whose `actions` are resolved per
  org at call time. Tool names are namespaced
  `custom_<connectorSlug>_<opSlug>` and capped at 64 chars.
- The MCP bridge and `tool-definitions.ts` are static today. Per-org dynamic
  tools need a per-session tool list in `mcp-bridge.ts` `createServer(context)`
  (it already receives `SessionContext` with `orgId`), loaded from the tables
  above. This is the main engineering cost.
- Request building: path params validated against `[A-Za-z0-9._~-]+` and
  URL-encoded; body validated against the op's JSON schema with zod
  (convert via a schema converter); response capped (e.g. 64 KB) and JSON
  summarised.
- Limits: max 40 enabled operations per connector, max 10 connectors per org
  (keeps tool lists within the model's context and the `local-tool-select.ts`
  ranking).

**Chat use cases.** "Look up order 551 in our ERP" · "Create a ticket in our
in-house helpdesk" · "What's the stock for SKU 88 in our warehouse API?"

### 4.2 Generic HTTP action (single endpoint) — Wave 2, M

A lighter cousin of 4.1 for APIs with no spec: admin defines one request
template (method, fixed URL, headers, body template with `{{field}}` slots and
a field schema). Useful for "ping our Slack-compatible webhook", "post to our
CRM's lead endpoint". Same rules as 4.1. Build 4.2 first if 4.1 slips; it
shares the storage and runtime.

### 4.3 Generic webhook-in — **Wave 1**, M

**What.** Each org can create inbound webhook endpoints
`POST /api/webhooks/inbound/{endpointId}` with a per-endpoint secret
(HMAC-SHA256 signature header, or a secret token in a header for senders that
cannot sign). Payloads are stored, mapped to a Darex event (new lead, new
order, new form response, generic event), and can trigger an employee run.

**Why.** Zillow lead delivery, Typeform/Jotform/Tally, Facebook Lead Ads
relays, IndiaMART, website forms, Zapier/Make/n8n outputs, payment gateways
without a Darex module: they all speak "POST JSON to a URL". One feature
turns all of them into inputs.

**Shape (matches existing webhook rules in `AGENTS.md` §3).**
- Route in `apps/dashboard/app/api/webhooks/inbound/[endpointId]/route.ts`:
  verify signature with `timingSafeEqual` (see `webhook-crypto.ts` and the
  Nango webhook route), persist the raw event, return 200 fast, then
  fire-and-forget a Temporal workflow. **Never await an agent call inline**
  (rule 2).
- Org is resolved from the endpoint row, never from the body (rule 1).
- Size cap (256 KB), rate cap per endpoint, replay window (timestamp header
  when the sender supports it), and idempotency on a sender event id when
  present.
- Mapping: JSONPath-style field mapping configured in the UI
  (`$.email` → `lead.email`), plus "let the employee read it raw" mode.
- Chat tools: `webhook_list_events` (read; "show me today's leads from the
  website form") and `webhook_replay_event` (draft; re-run mapping).
- The endpoint itself is created on `/connectors` by an owner/admin
  (`lib/connector-rbac.ts` guard), not from chat. Creating credentials is
  human-only.

### 4.4 Zapier / Make / n8n bridge — Wave 2, M

Two directions:

- **Inbound (they call us).** Covered by 4.3. Publish a short guide and,
  later, a Zapier "Darex" app whose action is "Send event to Darex" (that
  needs a Zapier developer account: 🔴 human-only).
- **Outbound (we call them).** A `automation_trigger` chat tool that POSTs to a
  pre-registered catch-hook URL (Zapier Catch Hook, Make custom webhook, n8n
  Webhook node). The URL is registered by an admin, stored per org, and
  validated against an allowlist of host suffixes (`hooks.zapier.com`,
  `hook.*.make.com`, the org's own n8n host). Risk: `send` by default (it can
  do anything downstream), so it parks.
- Chat use cases: "Run the 'new tenant onboarding' Zap for Priya" ·
  "Trigger the n8n flow that syncs Tally".
- Zapier also offers a hosted MCP endpoint per user; once §5 ships, that is a
  second path that needs no custom code.

### 4.5 IMAP / SMTP mailbox — **Wave 1**, L

**What.** Read and send mail for any mailbox that speaks IMAP (read) and SMTP
(send): Zoho Mail, GoDaddy/Titan, Hostinger, Rediffmail Pro, cPanel, Fastmail,
iCloud.

**Why.** A large share of Indian SMB inboxes are not on Google or Microsoft.
Without this, Emma and Customer cannot read or reply for those orgs at all.

**Shape.**
- Credentials: host, port, TLS mode, username, app password. Stored as a
  Nango "Basic" connection if the running Nango supports a generic Basic
  provider, otherwise as encrypted `channels.meta` BYOK (same as WhatsApp).
  Never log them.
- Transport: IMAP over TLS only (port 993) or STARTTLS (143) with
  certificate verification on; SMTP 465/587 TLS. Host validated with
  `assertPublicUrl` semantics (public address, re-resolved) because an admin
  could point it at an internal host.
- Library: one IMAP client and one SMTP client dependency, pinned (per
  `CLAUDE.md` dependency hygiene). Connection per call is fine at chat scale;
  pool later.
- Tools mirror Gmail: `imap_fetch`, `imap_read_email`, `imap_draft_reply`
  (store in Drafts via IMAP APPEND), `smtp_send`, `smtp_reply` (sets
  `In-Reply-To` / `References`). Specs in `04` §3.
- Inbound: optional IMAP IDLE / polling sweep into `messages` so the inbox
  and auto-reply agent see it (Wave 2 add-on; reuse the sweep registry in
  `periodic-registry.ts`).

### 4.6 CalDAV / CardDAV — Wave 2, L

**What.** Calendars and contacts on iCloud, Fastmail, Zoho, Nextcloud,
Synology. Tools mirror `google-calendar`: `caldav_list_events`,
`caldav_check_availability`, `caldav_create_event` (send when attendees are
present, else draft). CardDAV for contacts read.

**Shape.** Same credential and SSRF rules as 4.5. iCalendar (RFC 5545)
parsing via a pinned library; time zones normalised to the org timezone in
`org_onboarding`.

### 4.7 Generic database connector — Wave 2, L

See §3.16 #120. Listed here because it is generic: one module covers
Postgres, MySQL, SQL Server read-only. Must run behind an egress-restricted
runner.

### 4.8 Generic file drop (SFTP / S3) — Wave 3, M

For vendors that only export CSV by SFTP or to a bucket (MLS feeds, bank
statements, ERP exports). Sweep pulls files into Drive-like storage and the
brain. Read-only.

### 4.9 Coverage estimate

| Generic connector | Rough coverage it unlocks |
|---|---|
| Remote MCP client (§5) | Every vendor that ships an MCP server (fast-growing; most major SaaS by now) plus in-house MCP servers |
| Webhook-in | Every app with "send to webhook" (forms, lead portals, payment gateways, CI, monitoring) |
| Zapier/Make/n8n outbound | 7,000+ apps through the customer's existing automation account |
| OpenAPI importer | Every API with a spec, including in-house |
| IMAP/SMTP | Every mailbox |
| CalDAV/CardDAV | Every standards-based calendar |

---

## 5. MCP-server ecosystem

### 5.1 Where Darex stands

- Darex **is** an MCP server today: `services/workflows/src/mcp-bridge.ts`
  serves `mcp.darex.*` tools over SSE on `:8790` to the TrueForge agent.
  Tenancy comes from HMAC-signed headers (`MCP_BRIDGE_SECRET`), `org_id` is
  stripped from every schema, and each tool's `readOnlyHint` /
  `destructiveHint` annotation comes from `resolveToolRisk`.
- The TrueForge agent manifest in `services/workflows/src/trueforge-client.ts`
  `ensureDarexAgent` lists exactly one MCP server, `darex`, with
  `require_approval_for_tools: ['@write', '@destructive']`.
- Darex is **not** an MCP client of any outside server. No code mentions a
  remote MCP client (Appendix A).

### 5.2 Design: remote MCP client inside the gate

There are two ways to let an org plug in an outside MCP server:

| Option | How | Verdict |
|---|---|---|
| A. Add the remote server to the TrueForge manifest's `mcp_servers` | Agent talks to the server directly | **Rejected.** Bypasses `runToolGate` (allowlist, persona denial, autonomy tier, approval parking, critic, quiet hours, ledger, audit), and the manifest is global, not per org. |
| B. Proxy remote tools through Darex's own bridge as a `remote-mcp` provider | Darex connects to the remote server as a client, lists its tools, and re-exposes them as `mcp_<serverSlug>_<toolName>` through the existing executor | **Chosen.** Every call passes the same gate as native tools; tenancy, approvals and audit come for free. |

**Shape of option B.**
- Storage: `remote_mcp_servers (id, org_id, slug, url, transport
  ('streamable-http'|'sse'), auth_kind ('oauth'|'bearer'|'none'),
  nango_connection_id, status, tools_cache jsonb, tools_cached_at,
  created_by)` and `remote_mcp_tools (server_id, name, description,
  input_schema, annotations jsonb, risk, enabled)`. RLS on `org_id`.
- Client: `@modelcontextprotocol/sdk` client (the server SDK is already a
  dependency of `@darex/workflows`, so the client half adds no new package).
- Auth: MCP's OAuth 2.1 flow (protected resource metadata, dynamic client
  registration where the server supports it, PKCE). Tokens stored in Nango as
  a custom OAuth connection where possible, otherwise encrypted per org.
- Risk mapping, in order:
  1. Admin override per tool (raise only, or explicit audited lower).
  2. Remote annotations: `readOnlyHint: true` → `read`;
     `destructiveHint: true` → `delete`; otherwise `send`.
  3. No annotation → `send` (parks). Annotations are hints from an untrusted
     server, so a `readOnlyHint` only *lowers* to `read` if the admin
     ticked "trust this server's read-only hints" at connect time.
- Tool exposure: per-session dynamic registration in `createServer(context)`
  (same mechanism as §4.1), capped at 50 tools per server and 150 remote
  tools per org. Names prefixed and sanitised to `[a-z0-9_]{1,64}`.
- Tool descriptions from the remote server are **untrusted** text that
  reaches the model's context. Strip control characters, cap length (512
  chars), and fence them. This is the main prompt-injection surface ("tool
  poisoning").
- Re-list tools on connect and every 24 h; a tool whose schema changed is
  disabled until an admin re-approves it (protects against a "rug pull"
  where a server changes a tool's behaviour after approval).
- Calls: 15 s budget (`TOOL_EXECUTION_TIMEOUT_MS`), abort signal propagated,
  result content (text/structured) capped and formatted by
  `mcp-bridge-format.ts`. Resources and prompts from remote servers are out
  of scope for Wave 1; tools only.
- Per-employee grant: the server slug (`mcp-<slug>`) goes on an employee's
  `tool_allowlist`. `isToolAllowed` in `tool-executor.ts` then needs to map
  `mcp_<slug>_*` names to that provider key, the same way `TOOL_TO_PROVIDER`
  maps static tools.

### 5.3 Curated directory (Wave 2)

Once §5.2 works, add a curated list on `/connectors` of vendor-hosted remote
MCP servers with their URLs and auth notes, so an admin adds one with a click
instead of pasting a URL. Candidates (vendor-hosted remote MCP servers known
to exist as of this writing; confirm each URL before listing): Atlassian
(Jira/Confluence), Asana, Linear, Notion, Stripe, PayPal, Square, Sentry,
Cloudflare, HubSpot, Intercom, Box, Canva, monday.com, Zapier, GitHub. Where a
native Darex module exists for the same vendor, the native module wins in
`local-tool-select.ts` ranking and the directory entry says so, to avoid two
competing tools for one job.

### 5.4 Darex as an outside MCP server (Wave 3)

Expose a per-org MCP endpoint so a customer's own agent clients can call
Darex employees and tools. It reuses the bridge but needs org API keys
(hashed), per-key scopes, per-key rate limits and audit. Do not reuse
`MCP_BRIDGE_SECRET` (that is the internal trust anchor).

---

## 6. Wave roll-up and build order

### 6.1 Wave 1 (specced in `04-integration-tool-specs.md`)

Ordered by dependency first, then value.

| Order | Integration | Category | Primary employees | Effort | Depends on |
|---|---|---|---|---|---|
| 0 | Credential-type extension (API key / Basic / connection config) | Platform | — | M | — (§7.1) |
| 1 | Generic webhook-in | Generic | GRO, SAL, SUP | M | — |
| 2 | Remote MCP client | MCP | All (per grant) | XL | §7.3 dynamic tools |
| 3 | IMAP/SMTP mailbox | Email | SUP, CUS, SAL | L | §7.1 |
| 4 | Microsoft Teams | Messaging | OPS, EXE, SUP | M | Microsoft OAuth app (🔴 human) |
| 5 | Pipedrive | CRM | SAL, GRO | M | — |
| 6 | Calendly | Scheduling | SAL, SUP, OPS | S | webhook-in for bookings (optional) |
| 7 | Zoom | Meetings | SAL, EXE, OPS | M | — |
| 8 | Xero | Accounting | FIN | M | — |
| 9 | Freshdesk | Support | CUS, SUP | M | §7.1 (API key) |
| 10 | Jira | PM | OPS, EXE, RES | M | Atlassian OAuth app (🔴) |
| 11 | Confluence | Knowledge | RES, EXE, SUP | M | same Atlassian app |
| 12 | Asana | PM | OPS, EXE | M | — |
| 13 | Linear | PM | OPS, RES | S | — |
| 14 | Airtable | Data | OPS, SAL, MKT | S | — |
| 15 | OneDrive / SharePoint files | Storage | RES, EXE, OPS | M | Microsoft app |
| 16 | Dropbox | Storage | RES, OPS | S | — |
| 17 | Mailchimp | Marketing | MKT, GRO | M | — |
| 18 | Typeform | Forms | GRO, SAL, SUP | S | webhook registration |
| 19 | WooCommerce | E-commerce | CUS, OPS | M | §7.1 (Basic) |
| 20 | Telegram Bot | Messaging | SUP, CUS | M | inbound webhook route |

Rough total: about 14 to 18 engineer-weeks including the platform pieces.
Two engineers in parallel can land Wave 1 in 6 to 8 weeks if OAuth apps are
registered early (they are the long pole and human-only).

### 6.2 Wave 2

Attio, Close, Freshsales, LeadSquared, Zoho Mail, CalDAV/CardDAV, Microsoft
To Do, Facebook Messenger, Facebook/Instagram publishing, WhatsApp BSPs,
Google review replies, Exotel, Twilio Voice, Vapi, Aircall, Zoho Books,
PayPal, Cashfree/PayU, Chargebee, Shopify write actions, Shiprocket, ClickUp,
Trello, monday.com, SharePoint pages, knowledge ingestion sync, GitHub
extensions, GitLab, Sentry, BambooHR, Greenhouse, Klaviyo, Brevo, LinkedIn
Ads, Google Ads write, Mixpanel/Amplitude/PostHog, Box, Help Scout, Front,
Gorgias, Chatwoot tools, Cal.com, Teams meetings, Fireflies, Dropbox Sign,
PandaDoc, external Postgres/MySQL, BigQuery, RESO MLS, Bridge, Indian portal
lead parser, Zillow lead webhook, Tavily/Exa/Brave, Firecrawl, speech-to-text,
document OCR, OpenAPI importer, generic HTTP action, Zapier/Make/n8n bridge,
curated MCP directory.

### 6.3 Wave 3

Everything else in §3 marked Wave 3: enterprise (Dynamics, ServiceNow,
Exchange, Snowflake, Adobe Sign), licence-gated (Account Aggregator, Flipkart,
AppFolio/Yardi, kvCORE), niche (Copper, Bitrix24, Basecamp, Wrike, Discord,
YouTube, X, TikTok Ads, Microsoft Ads, Semrush, Hotjar, Canva, Figma, Miro),
Tally, headless browser, Darex-as-outside-MCP-server.

### 6.4 Re-tiering rules

Move an integration up a wave when any of these is true:

- Three or more paying orgs ask for it, or one design partner blocks on it.
- It is the system of record for a vertical pack Darex sells
  (`packs/core-b2b`, `packs/re-brokerage-in`, `packs/real-estate-pm`).
- A generic connector cannot cover it well (needs inbound events, a special
  send rule, or binary files).

Move it down when a vendor-hosted MCP server gives the same chat use cases
through §5 with acceptable quality.

---

## 7. Platform prerequisites

These are not integrations, but several Wave 1 items depend on them. Each is
a separate commit with its own BUILD_STATE entry.

### 7.1 Non-OAuth credentials through Nango (blocks Freshdesk, WooCommerce, IMAP, Telegram, Brevo, …)

`resolveNangoAuth` in `services/workflows/src/tools/shared.ts` reads only
`credentials.raw.access_token` / `credentials.access_token`. For a Nango
API-key or Basic connection it finds no token and returns
`{ kind: 'revoked', detail: 'Nango connection exists but has no access token' }`,
so the tool would tell the user to re-authorise a connection that is fine.

Add a sibling `resolveNangoCredentials(connId, keys)` that returns a
discriminated union:

```ts
type NangoCredentials =
  | { kind: 'oauth'; accessToken: string; connectionConfig: Record<string, unknown>; metadata: Record<string, unknown> }
  | { kind: 'api_key'; apiKey: string; connectionConfig: Record<string, unknown>; metadata: Record<string, unknown> }
  | { kind: 'basic'; username: string; password: string; connectionConfig: Record<string, unknown>; metadata: Record<string, unknown> };
```

Keep `resolveNangoAuth` unchanged for existing modules. Same 60 s cache, same
never-configured vs revoked distinction. Test it with recorded Nango
connection JSON for each auth type. Also extend the dashboard connect flow:
`integrations-catalog.ts` `authMode: 'api_key'` exists as a type but the
Nango API-key connect path (`nango.auth` with credentials) must be wired in
`apps/dashboard/lib/nango-client.ts`.

### 7.2 Connection config never comes from the model

Existing modules accept a host fragment from the tool payload:
`services/workflows/src/tools/zendesk.ts` reads `payload.subdomain` and
`services/workflows/src/tools/shopify.ts` reads `payload.shopDomain` before
falling back to Nango `connection_config`. A model (or a prompt-injected
email) can steer the request host. New modules must read hosts, subdomains,
tenant ids, cloud ids and data-centre regions **only** from Nango
`connection_config` / `metadata` or an admin-set org setting. Fixing the two
existing modules is out of scope here but should be a tracked `fix(connectors)`
row in `gap26sept/integrations-connectors.md`.

### 7.3 Per-session dynamic tools in the MCP bridge (blocks remote MCP and OpenAPI importer)

Static tools are defined twice today, in
`services/workflows/src/tool-definitions.ts` and in a duplicated `TOOLS` array
in `services/workflows/src/mcp-bridge.ts` (both were edited in commit
`e0e32f14`). Before adding dynamic tools:

1. Make `mcp-bridge.ts` import `TOOLS` from `tool-definitions.ts` instead of
   keeping its own copy (one source of truth; removes a step from every
   future integration).
2. In `createServer(context)`, append per-org dynamic tools loaded (and
   cached for 60 s) from `remote_mcp_tools` / `custom_connector_operations`.
3. Extend `resolveCallRisk` and `isToolAllowed` in `tool-executor.ts` to
   resolve dynamic names via a per-org lookup.
4. Extend `chat-coverage.ts` to list a single row per dynamic provider (not
   per org tool), since dynamic tools are tenant data.

### 7.4 Multi-account

Migration 098 added `account_id` to `org_connectors`
(`integrations-connectors.md` row 4), but tool modules still resolve one
connection id `${orgId}_${provider}`. Teams, Freshdesk, Mailchimp, IMAP and
Telegram are all commonly multi-account (several inboxes, several
workspaces). Wave 1 specs accept an optional `account` argument that maps to
`${orgId}_${provider}_${accountId}`; the resolver must validate the account id
belongs to the org (prefix check, same as `nango-token/route.ts`).

### 7.5 Pin the Nango image

`infra/docker-compose.yml` runs `nangohq/nango-server:latest`. Provider
template keys and auth behaviour can change on any pull. Pin a version before
Wave 1 so the Nango keys in this document can be verified once and stay true.

### 7.6 Inbound events

Calendly, Typeform, Telegram, Jira, Asana, Zoom, Freshdesk, Mailchimp and
WooCommerce all deliver webhooks. `integrations-connectors.md` "what's broken"
#11 already notes there is no webhook auto-registration. Wave 1 integrations
should register their webhook on connect (from the Nango `auth` webhook in
`apps/dashboard/app/api/webhooks/nango/route.ts`, which today is log-only) and
route deliveries through the generic webhook-in pipeline (§4.3) so
signature checks, persistence and fire-and-forget are written once.

### 7.7 Rate-limit buckets per provider

`services/workflows/src/tools/provider-rate-limit.ts` gives each
`(org, provider)` a token bucket (default capacity 20, refill 2/s), tunable by
`RATE_LIMIT_<PROVIDER>_CAPACITY` / `_REFILL`. Each Wave 1 spec gives the
right values from the vendor's published limits; add them to
`deploy/env.production.example`.

### 7.8 Credentials runbook rows

Each OAuth integration needs a row in
`docs/new-109-pg-plan/gap26sept/integrations-credentials-runbook.md` (console
URL, redirect URI `https://<nango-host>/oauth/callback`, scopes, verification
step). Registration is human-only and stays 🔴 until done.

---

## 8. Risks and open questions

| # | Risk / question | Mitigation / owner decision needed |
|---|---|---|
| 1 | Tool-list growth: 20 Wave 1 integrations add about 110 chat tools to the current 154. Larger tool lists cost tokens per turn and lower tool-choice accuracy. | Per-turn allowlist already narrows tools (`resolveTurnAllowlist`), and `local-tool-select.ts` ranks by intent. Add each provider's intent regex. Consider grouping rarely used actions behind one tool with an `operation` enum once a provider exceeds 8 tools. |
| 2 | Substring-based risk classification (`riskFor` using `includes('read')`) misclassifies names like `send_reply` vs `read_thread`, or anything containing "thread", "spreadsheet", "already". | Wave 1 modules use an explicit `Record<action, ToolRisk>` with a fail-closed default (`send`). See `04` §2.4. |
| 3 | Persona denial uses action-name substrings (`role-capability.ts`). A new name can accidentally match (`list_charges` contains `charge`, denied for marketing) or miss (`smtp_send` does not contain `send_email`, so the operations denial would not apply). | Specs choose action names deliberately and each provider gets a role-capability test. |
| 4 | Vendor app reviews (Microsoft publisher verification, Atlassian, Zoom Marketplace, Xero certification for >25 connections, LinkedIn partner programs) take weeks. | Start registrations in week 1; mark 🔴 with reason; ship tools behind `executorStatus: 'catalog_only'` until the app is approved. |
| 5 | Remote MCP servers are untrusted code paths: tool poisoning, rug pulls, data exfiltration via arguments. | §5.2 controls: proxied through the gate, admin approval of each tool, schema-change re-approval, description sanitising, `send` default risk, per-employee grant only. |
| 6 | IMAP/SMTP and external DB connectors let an admin point Darex at an internal host. | Public-address validation at connect and at each call; egress-restricted worker. |
| 7 | Data residency: Zoho, Xero and Microsoft use region-specific hosts. | Read region/DC from Nango connection config, never guess. |
| 8 | Nango key accuracy: keys marked ? may not exist. | Verify against the pinned Nango version (§7.5) before the build ticket starts; fall back to a custom Nango provider config or BYOK. |
| 9 | Should Wave 1 include a voice integration? Voice is the most-requested "wow" feature for SMB support. | Recommendation: no. Ship Exotel call logs (Wave 2, M) first; a voice agent (Vapi) is XL and needs its own approval/consent design (call recording consent varies by jurisdiction). |
| 10 | Which employee owns a new provider by default? | Appendix B is the proposal; confirm with the employee spec owners in `gap26sept/employees/`. |

---

## Appendix A: absence verification (2026-10-09)

Method: case-insensitive `grep -rli` over `services/workflows/src`,
`apps/dashboard/lib`, `apps/dashboard/app`, `services/connectors/src` and
`packages/shared-types/src`. Count is the number of files mentioning the term.
Non-zero counts were opened and confirmed to be incidental (no module,
catalog entry, or tool).

| Term | Files | Finding |
|---|---|---|
| pipedrive, attio, close.com, freshsales, zoho-mail | 0 | Absent |
| imap, smtp, caldav | 0 | Absent |
| calendly, zoom | 0 | Absent |
| cal.com | 2 | Incidental (`scripts/chat-coverage.ts`, `org-cost.ts` text), no integration |
| microsoft teams ("teams") | 8 | Incidental wording; no Teams module or catalog id |
| telegram, discord, tiktok, youtube | 0 | Absent |
| twitter / x.com | 5 | Incidental (URLs/text) |
| vapi | 2 | Incidental substring in `web-push-notify.ts` / push route (VAPID), not Vapi |
| retell, bland, plivo, vonage, aircall, ringcentral, openphone | 0 | Absent |
| exotel | 1 | `channel-normalize.ts` channel label only; no module |
| xero, freshbooks, chargebee, paypal, brex | 0 | Absent |
| tally | 1 | `activities/growth.ts` word "tally", not TallyPrime |
| ramp | 1 | `cold-start.ts` word "ramp", not Ramp |
| woocommerce, bigcommerce, amazon-seller | 0 | Absent |
| etsy | 1 | `connector-registry.ts` substring only |
| asana, jira, clickup, trello, basecamp | 0 | Absent |
| linear | 1 | `globals.css` (`linear-gradient`) |
| monday | 3 | Weekday parsing in customer obligation code |
| confluence, coda, airtable, sharepoint, onedrive, dropbox | 0 | Absent |
| box | many | Substring of other words (`inbox`, `checkbox`); no Box module |
| gitlab, bitbucket, sentry, pagerduty | 0 | Absent |
| vercel | 1 | Comment in `local-turn.ts` |
| bamboohr, greenhouse, lever, workable, gusto, deel, rippling | 0 | Absent |
| mailchimp, klaviyo, sendgrid, brevo, activecampaign | 0 | Absent |
| mixpanel, amplitude, posthog | 0 | Absent |
| segment | 4 | Word "segment" (text segmentation), no Segment integration |
| freshdesk, helpscout, gorgias | 0 | Absent |
| front | many | Common word (frontend); no Front module |
| crisp | 1 | Word in `ask-ai/route.ts` prompt text |
| chatwoot | 21 | Inbound webhook + workflows exist; **no chat tool** (listed as #106) |
| hellosign / dropbox-sign, pandadoc, adobe-sign, zoho-sign | 0 | Absent |
| snowflake, redshift, supabase, mongodb | 0 | Absent |
| bigquery | 1 | Text in `integrations-catalog.ts` description; no tool |
| firecrawl, browserbase, perplexity, tavily, serpapi | 0 | Absent |
| exa | many | Substring (`example`, `exact`); no Exa provider |
| zapier, make.com, n8n, openapi | 0 | Absent |
| remote MCP client (`mcp-client`, `mcpClient`, `remote mcp`) | 0 | Absent; the only MCP code is the server in `mcp-bridge.ts` and the manifest in `trueforge-client.ts` |
| typeform | 1 | Text in `insight-engine.ts`; no tool |
| jotform, webflow, wordpress, figma, miro, loom, gong, fireflies, otter | 0 | Absent |
| canva | 2 | Prompt text in `ask-ai/route.ts`, conversations page; no tool |
| dynamics | 1 | Comment in `local-turn.ts` |
| zillow | 1 | Regex in `confirm-classes.ts` `PUBLISH_RE`; no tool |
| RESO / Bridge MLS | — | `mls` module is a stub that always returns `notConnected` (`tools/realestate/index.ts`) |

Re-run before starting any row; this table is a snapshot.

---

## Appendix B: employee → new integrations

Proposed additions to each roster employee's reach. "Default grant" means
added to `DEFAULT_EMPLOYEE_ROSTER` and to an additive backfill migration.
"Opt-in" means available to grant on the employee card but not granted by
default.

| Employee | Wave 1 default grant | Wave 1 opt-in | Wave 2+ |
|---|---|---|---|
| Customer (Customer Resolution) | freshdesk, imap-mail, woocommerce, telegram | calendly | gorgias, help-scout, front, shopify writes, shiprocket, chatwoot, paypal (refund) |
| Emma (Customer Support) | imap-mail, telegram, calendly | freshdesk (read + notes only by persona) | facebook-messenger, chatwoot, exotel |
| Operations | jira, asana, linear, airtable, microsoft-teams | onedrive, dropbox, woocommerce | clickup, trello, monday, sentry, shiprocket |
| Growth | typeform, webhook-in events, pipedrive | mailchimp | attio, leadsquared, klaviyo, firecrawl |
| Sarah (Sales & Lead Gen) | pipedrive, calendly, zoom | typeform, airtable | close, freshsales, leadsquared, pandadoc, dropbox-sign, RESO MLS |
| Marcus (Marketing & Analytics) | mailchimp, typeform | airtable | klaviyo, brevo, linkedin-ads, facebook publishing, mixpanel/amplitude/posthog |
| Research | confluence, onedrive, dropbox | jira (read), linear (read) | box, sharepoint pages, firecrawl, tavily/exa |
| Executive | microsoft-teams, zoom (read), confluence (read) | jira, asana | gong, fireflies, bigquery |
| Finance | xero | — | zoho-books, paypal, chargebee, cashfree, wise |
| Custom (any) | — | remote MCP servers, webhook-in, every Wave 1 provider | OpenAPI importer, HR tools (opt-in only) |

Persona denial additions to `role-capability.ts` `PERSONA_DENIED_TOOLS`
proposed alongside Wave 1:

| Persona | Add to denied tools | Reason |
|---|---|---|
| growth | `xero`, `woocommerce`, `freshdesk` | Money and support systems are not Growth's job (matches existing stripe/shopify/zendesk denials) |
| customer | `mailchimp` | Bulk marketing send is not support (matches ads denials) |
| operations | `mailchimp` | Ops does not send external marketing |
| marketing | `xero`, `woocommerce`, `freshdesk` | Matches existing stripe/shopify/zendesk denials |
| finance | `mailchimp`, `typeform` | Out of scope |
| sales | — | — |
