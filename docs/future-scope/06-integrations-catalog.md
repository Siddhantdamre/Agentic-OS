# 06 — Integrations master catalog

This is the nervous system of the Brain OS. **Nango remains the OAuth
and token plane.** Our TypeScript executors remain the action plane.
Disconnected always returns `connected: false` + `/connectors` (or
pack-specific setup URL). Never fabricate.

**How to use this file:** implement in priority waves (`13`). A P3 row
is still a *designed* integration so the registry schema can tag it.
Do not implement P3 before P0/P1 of the active wave.

**Legend**

| Col | Meaning |
|-----|---------|
| Status now | `live` = real executor, `stub` = UI only, `none` = not in product |
| Wire | `nango` OAuth, `byok` org keys in secrets, `webhook` inbound, `public` key-based API, `feed` licensed |
| Risk | `read` `draft` `send` `write_sor` `pay` `delete` `publish` `sign` |
| P | 0 launch-critical, 1 90 days, 2 year-1, 3 later |

---

## 1. Already in Darex (complete or finish)

Finish stubs before adding vanity logos.

| id | Name | Status now | Wire | Risk | P | Notes |
|----|------|------------|------|------|---|-------|
| whatsapp | WhatsApp Business Cloud | live | byok + webhook | send | 0 | Rotate Meta token; inbound live |
| gmail | Gmail | live | nango | send | 0 | Re-connect for compose scopes |
| google-calendar | Google Calendar | live | nango | write_sor | 0 | |
| google-drive | Google Drive | live | nango | write_sor | 0 | |
| google-docs | Google Docs | live | nango | write_sor | 0 | |
| google-sheets | Google Sheets | live | nango | write_sor | 0 | First-class SoR fallback |
| google-slides | Google Slides | live | nango | publish | 1 | |
| google-forms | Google Forms | live | nango | read | 1 | Lead capture |
| google-contacts | Google Contacts | live | nango | write_sor | 1 | |
| google-tasks | Google Tasks | live | nango | write_sor | 2 | |
| google-chat | Google Chat | stub | nango | send | 2 | Build executor |
| google-meet | Google Meet | stub | nango | write_sor | 1 | Showing/demo links |
| google-analytics | GA4 | stub | nango | read | 1 | Agencies + ecom |
| google-search-console | Search Console | stub | nango | read | 1 | Agencies |
| google-business-profile | GBP | stub | nango | publish | 0 | RE + hospitality reviews |
| google-cloud | GCP/BigQuery | stub | nango | read | 3 | Warehouse later |
| google-ads | Google Ads | live | nango | publish | 1 | Confirm spend |
| meta-ads | Meta Ads | live | nango | publish | 1 | Confirm spend |
| hubspot | HubSpot | live | nango | write_sor | 0 | |
| stripe | Stripe | live | nango | pay | 0 | |
| razorpay | Razorpay | live | byok | pay | 0 | Move to per-org Nango/BYOK vault |
| notion | Notion | live | nango | write_sor | 0 | KB |
| slack | Slack | live | nango | send | 0 | |
| shopify | Shopify | live | nango | write_sor | 1 | Ecom pack |
| zendesk | Zendesk | live | nango | write_sor | 1 | |
| intercom | Intercom | live | nango | send | 1 | |
| github | GitHub | live | nango | write_sor | 2 | SaaS pack |
| web_search | Jina search | live | public | read | 0 | Cite; not SoR |
| web_extract | Jina extract | live | public | read | 0 | |
| database_query | Postgres RLS SELECT | live | internal | read | 0 | Semantic layer later |
| file_ops | workspace files | live | internal | write_sor | 0 | |
| sandbox | code_execution | live* | internal | read | 0 | Commit Docker context |
| chatwoot | Chatwoot webhook | live ingest | webhook | send | 0 | **Wire to agent** |

`live*` sandbox: executor exists; image context must be in git.

---

## 2. Communication & channels (new)

| id | Name | Wire | Risk | P | Verticals |
|----|------|------|------|---|-----------|
| microsoft-outlook | Outlook mail | nango | send | 0 | Core (Microsoft shops) |
| microsoft-calendar | Outlook calendar | nango | write_sor | 0 | Core |
| microsoft-teams | Teams | nango | send | 1 | Core enterprise |
| microsoft-onedrive | OneDrive | nango | write_sor | 1 | Core |
| microsoft-sharepoint | SharePoint | nango | write_sor | 1 | Core / CRE data rooms |
| twilio-sms | Twilio SMS | byok | send | 0 | US RE, SaaS |
| twilio-voice | Twilio Voice + record | byok | send | 1 | Missed call → inquiry |
| exotel | Exotel | byok | send | 0 | IN RE, wholesale |
| knowlarity | Knowlarity | byok | send | 1 | IN |
| plivo | Plivo | byok | send | 2 | |
| messagebird | MessageBird | byok | send | 2 | |
| instagram | Instagram Messaging | nango/meta | send | 0 | RE, hospitality, ecom |
| messenger | Facebook Messenger | nango/meta | send | 1 | |
| telegram | Telegram Bot | byok | send | 2 | Some IN wholesale |
| line | LINE | byok | send | 3 | APAC |
| apple-business-chat | ABC | partner | send | 3 | |
| discord | Discord | byok | send | 3 | Dev communities |
| zoom | Zoom meetings | nango | write_sor | 1 | Showings/demos |
| webex | Webex | nango | write_sor | 3 | |
| cal-com | Cal.com | nango | write_sor | 1 | Scheduling |
| calendly | Calendly | nango | read | 1 | |
| typeform | Typeform | nango | read | 2 | Intake |
| jotform | Jotform | nango | read | 2 | |
| tally-forms | Tally.so | public | read | 2 | Not Tally ERP |
| crisp | Crisp chat | nango | send | 2 | |
| freshchat | Freshchat | nango | send | 2 | |
| livekit | LiveKit voice AI | byok | send | 2 | Voice employee |

Inbound unification: every channel becomes a `work_item` + `messages`
row with `channel_key`. Meta signature verification stays mandatory.

---

## 3. CRM & sales (new)

| id | Name | Wire | Risk | P | Verticals |
|----|------|------|------|---|-----------|
| salesforce | Salesforce | nango | write_sor | 0 | Core, RE, SaaS |
| zoho-crm | Zoho CRM | nango | write_sor | 0 | IN B2B, RE |
| pipedrive | Pipedrive | nango | write_sor | 1 | SMB |
| zoho-bigin | Bigin | nango | write_sor | 2 | Micro-SMB |
| freshsales | Freshsales | nango | write_sor | 2 | |
| copper | Copper | nango | write_sor | 2 | Gmail-native teams |
| close | Close.com | nango | write_sor | 2 | |
| attio | Attio | nango | write_sor | 2 | Modern SaaS |
| twenty | Twenty CRM | nango | write_sor | 3 | OSS |
| follow-up-boss | Follow Up Boss | nango/byok | write_sor | 0 | US RE |
| kvcore | kvCORE | byok | write_sor | 1 | US RE |
| sierra | Sierra Interactive | byok | write_sor | 2 | US RE |
| boomtown | BoomTown | byok | write_sor | 2 | US RE |
| lofty | Lofty/Chime | byok | write_sor | 2 | US RE |
| liondesk | LionDesk | byok | write_sor | 2 | US RE |
| leadsquared | LeadSquared | nango | write_sor | 1 | IN RE/dev |
| selldo | Sell.Do | byok | write_sor | 1 | IN developers |
| dynamics | Microsoft Dynamics 365 | nango | write_sor | 2 | Enterprise |
| sap-c4c | SAP C4C | nango | write_sor | 3 | |

CRM sync-worker: contacts, deals/inquiries, notes, activities.
Webhooks preferred over poll. Idempotent on `source_ref`.

---

## 4. Support & success (new)

| id | Name | Wire | Risk | P | Verticals |
|----|------|------|------|---|-----------|
| freshdesk | Freshdesk | nango | write_sor | 1 | Core |
| helpscout | Help Scout | nango | write_sor | 2 | |
| gorgias | Gorgias | nango | write_sor | 1 | Ecom |
| front | Front | nango | send | 2 | |
| linear | Linear | nango | write_sor | 1 | SaaS |
| jira | Jira | nango | write_sor | 1 | SaaS/agency |
| asana | Asana | nango | write_sor | 2 | Agency |
| monday | monday.com | nango | write_sor | 2 | |
| clickup | ClickUp | nango | write_sor | 2 | |
| trello | Trello | nango | write_sor | 3 | |
| productboard | Productboard | nango | read | 3 | SaaS |

---

## 5. Payments, billing, accounting, ERP

| id | Name | Wire | Risk | P | Verticals |
|----|------|------|------|---|-----------|
| payu | PayU | byok | pay | 1 | IN |
| cashfree | Cashfree | byok | pay | 1 | IN |
| paypal | PayPal | nango | pay | 2 | |
| square | Square | nango | pay | 2 | Hospitality US |
| chargebee | Chargebee | nango | read | 2 | SaaS |
| zoho-books | Zoho Books | nango | write_sor | 1 | IN |
| tally-erp | Tally | byok/gateway | read | 1 | IN wholesale — **read first** |
| quickbooks | QuickBooks | nango | write_sor | 1 | US |
| xero | Xero | nango | write_sor | 1 | AU/GB |
| freshbooks | Freshbooks | nango | write_sor | 2 | |
| wave | Wave | nango | read | 3 | |
| sage | Sage | nango | read | 3 | |
| gstn-einvoice | GST e-invoice | public/gov | read | 3 | IN wholesale |
| unicommerce | Unicommerce | byok | read | 2 | IN ecom/wholesale |
| vinculum | Vinculum | byok | read | 3 | |

Darex never holds client funds, never is escrow, never auto-captures
cards without confirm class `pay`.

---

## 6. E-commerce & logistics

| id | Name | Wire | Risk | P | Verticals |
|----|------|------|------|---|-----------|
| woocommerce | WooCommerce | nango | write_sor | 1 | Ecom |
| magento | Adobe Commerce | nango | read | 3 | |
| bigcommerce | BigCommerce | nango | read | 3 | |
| amazon-sp | Amazon SP-API | byok | read | 2 | Ecom |
| shiprocket | Shiprocket | byok | read | 1 | IN ecom |
| delhivery | Delhivery | byok | read | 2 | IN |
| easypost | EasyPost | byok | read | 2 | US |
| shipstation | ShipStation | nango | read | 2 | |
| klaviyo | Klaviyo | nango | send | 1 | Ecom |
| mailchimp | Mailchimp | nango | send | 1 | Core |
| sendgrid | SendGrid | byok | send | 2 | Transactional |
| postmark | Postmark | byok | send | 2 | |
| judgeme | Judge.me | byok | read | 2 | Reviews |
| stamped | Stamped | byok | read | 2 | |

---

## 7. Marketing, ads, analytics, SEO (beyond current)

| id | Name | Wire | Risk | P | Verticals |
|----|------|------|------|---|-----------|
| linkedin-ads | LinkedIn Ads | nango | publish | 2 | SaaS/agency |
| tiktok-ads | TikTok Ads | nango | publish | 2 | Ecom/agency |
| twitter-ads | X Ads | nango | publish | 3 | |
| pinterest-ads | Pinterest | nango | publish | 3 | |
| mixpanel | Mixpanel | nango | read | 2 | SaaS |
| posthog | PostHog | nango | read | 2 | SaaS |
| amplitude | Amplitude | nango | read | 3 | |
| segment | Twilio Segment | nango | write_sor | 3 | |
| hotjar | Hotjar | nango | read | 3 | |
| semrush | Semrush | byok | read | 2 | Agency |
| ahrefs | Ahrefs | byok | read | 2 | Agency |
| similarweb | Similarweb | byok | read | 3 | |
| canva | Canva | nango | publish | 2 | RE marketing |
| figma | Figma | nango | read | 2 | Agency |
| hootsuite | Hootsuite | nango | publish | 3 | |
| buffer | Buffer | nango | publish | 3 | |
| later | Later | nango | publish | 3 | |

---

## 8. Documents, e-sign, knowledge, storage

| id | Name | Wire | Risk | P | Verticals |
|----|------|------|------|---|-----------|
| docusign | DocuSign | nango | sign | 0 | RE, prof-services |
| adobe-sign | Adobe Sign | nango | sign | 1 | |
| leegality | Leegality | byok | sign | 0 | IN |
| pandadoc | PandaDoc | nango | sign | 1 | |
| dropbox | Dropbox | nango | write_sor | 2 | |
| box | Box | nango | write_sor | 2 | CRE |
| s3 | AWS S3 / R2 | byok | write_sor | 1 | Media lake |
| confluence | Confluence | nango | read | 2 | SaaS |
| outline | Outline wiki | byok | read | 3 | |
| coda | Coda | nango | read | 3 | |
| airtable | Airtable | nango | write_sor | 1 | Many SMBs as SoR |
| smartsheet | Smartsheet | nango | read | 3 | |
| dotloop | Dotloop | byok | write_sor | 1 | US RE txn |
| skyslope | SkySlope | byok | write_sor | 2 | US RE |
| brokermint | Brokermint | byok | write_sor | 2 | US RE |

---

## 9. HR / ATS (recruiting pack)

| id | Name | Wire | Risk | P |
|----|------|------|------|---|
| greenhouse | Greenhouse | nango | write_sor | 1 |
| lever | Lever | nango | write_sor | 1 |
| ashby | Ashby | nango | write_sor | 1 |
| workable | Workable | nango | write_sor | 2 |
| bamboo | BambooHR | nango | read | 3 |
| gusto | Gusto | nango | read | 3 |
| linkedin | LinkedIn | nango | read | 2 | Jobs API only; no scrape |

---

## 10. Real estate specialty (also listed in `05`)

| id | Name | Wire | Risk | P |
|----|------|------|------|---|
| mls-reso | RESO Web API / Bridge / Trestle / Spark | feed | read | 0 US |
| idx-broker | IDX Broker | byok | read | 1 |
| showingtime | ShowingTime+ | byok | write_sor | 1 |
| appfolio | AppFolio | nango/byok | write_sor | 1 |
| buildium | Buildium | nango | write_sor | 1 |
| yardi | Yardi | byok | read | 2 |
| realpage | RealPage | byok | read | 2 |
| mri | MRI | byok | read | 2 |
| entrata | Entrata | byok | read | 2 |
| rent-manager | Rent Manager | byok | write_sor | 2 |
| matterport | Matterport | byok | read | 1 |
| cloudcma | CloudCMA | byok | read | 2 |
| rpr | Realtors Property Resource | byok | read | 2 |
| attom | ATTOM | public | read | 2 |
| corelogic | CoreLogic | feed | read | 3 |
| costar | CoStar | feed | read | 2 |
| loopnet | LoopNet | feed | read | 2 |
| crexi | CREXi | byok | read | 2 |
| google-maps | Maps/Places/Geocoding | public | read | 0 |
| mapbox | Mapbox | public | read | 1 | Dashboard map |

Portal partner APIs (99acres, MagicBricks, Housing, NoBroker, Bayut,
Rightmove, Zoopla, Domain): **P1–P2 only with contract**. Email parse
of leads the org already receives is P0 and is a Gmail skill, not a
portal scrape.

---

## 11. Maps, enrichment, public / government

| id | Name | Wire | Risk | P | Use |
|----|------|------|------|---|-----|
| clearbit | Clearbit | public | read | 2 | SaaS enrich |
| apollo | Apollo | public | read | 2 | |
| hunter | Hunter | public | read | 3 | |
| pdl | People Data Labs | public | read | 3 | |
| companies-house | UK Companies House | public | read | 2 | |
| mca21 | India MCA (if API/partner) | public | read | 2 | |
| data-gov-in | data.gov.in datasets | public | read | 2 | |
| rera-public | State RERA search | public | read | 1 | Cite+TTL |
| census-us | Census ACS | public | read | 2 | CRE research |
| openstreetmap | Nominatim | public | read | 1 | Geocode fallback |
| weather | OpenWeather | public | read | 3 | Hospitality / construction |

Enrichment tools must honor do-not-contact and never buy scraped
personal data of dubious origin. Prefer systems the org already has.

---

## 12. Voice, transcription, media

| id | Name | Wire | Risk | P |
|----|------|------|------|---|
| deepgram | Deepgram STT | public | read | 1 |
| whisper-lite | Whisper via LiteLLM | public | read | 1 |
| elevenlabs | TTS | public | send | 2 | Confirm voice-of-brand |
| assemblyai | AssemblyAI | public | read | 2 |
| mux | Mux video | byok | read | 3 | Listing video |

---

## 13. Dev, IT, internal (corporate brain)

| id | Name | Wire | Risk | P |
|----|------|------|------|---|
| gitlab | GitLab | nango | write_sor | 3 |
| bitbucket | Bitbucket | nango | read | 3 |
| pagerduty | PagerDuty | nango | send | 3 |
| datadog | Datadog | nango | read | 3 |
| sentry | Sentry | nango | read | 2 |
| vercel | Vercel | nango | read | 3 |
| cloudflare | Cloudflare | nango | read | 3 |
| okta | Okta (directory read) | nango | read | 2 | SSO is SuperTokens |

---

## 14. Hospitality / construction / clinic (Wave 3–4)

| id | Name | Wire | Risk | P | Vertical |
|----|------|------|------|---|----------|
| cloudbeds | Cloudbeds | nango | write_sor | 2 | hospitality |
| mews | Mews | nango | write_sor | 2 | hospitality |
| opentable | OpenTable | byok | read | 3 | hospitality |
| procore | Procore | nango | read | 3 | construction |
| autodesk-acc | Autodesk Construction Cloud | nango | read | 3 | construction |
| practo | Practo-class PMS | byok | write_sor | 3 | clinic-ops — PHI rules |

---

## 15. How an integration is added (engineering contract)

1. `harness_describe`-style: add `connector_defs` row (key, nango_key,
   risk, confirm, vertical_tags, mcp tool names).
2. Nango provider config (scopes explicit; seed SQL idempotent).
3. `tools/<provider>.ts` implementing actions; register in MCP bridge.
4. Honest `notConnected`.
5. Sync cursor if it is a SoR (not only fire-and-forget tools).
6. Webhook signature if inbound.
7. Langfuse span on every call.
8. Eval: one golden path connected + one disconnected.
9. Docs: current-working tools catalog + this file status column.
10. UI: registry-driven card, not a new hardcoded array forever.

**Do not** add a connector that can only work by violating ToS or by
storing secrets in git.

---

## 16. Implementation waves (connectors only)

**Wave A (hygiene):** GBP, Meet, GA4, GSC executors; Chatwoot → agent;
sandbox git; skills mount; Meta token; Outlook+Calendar (Microsoft).

**Wave B (core OS):** Salesforce, Zoho CRM, Pipedrive, DocuSign,
Leegality, Twilio/Exotel, Instagram, Maps geocoding, Mailchimp,
QuickBooks or Zoho Books.

**Wave C (RE):** Follow Up Boss, Sheets/CSV inventory tools, RESO/MLS
or partner, ShowingTime, AppFolio/Buildium, Matterport, Airtable.

**Wave D (GTM/ecom):** Gorgias, Klaviyo, Woo, Shiprocket, Linear,
Cal.com, Zoom.

**Wave E:** Everything P2–P3 as customers pull.

This catalog is intentionally long. Shipping is intentionally not.

---

## 17. Integration *planes* vs this catalog (research)

This file is **which APIs to wire**. `15` §6 is **which OSS/remote
products people use as the plane**. Binding calls:

| Plane | KEEP | REJECT / WATCH |
|-------|------|----------------|
| OAuth / tokens | **Nango** | Composio; do not rebuild |
| Tool protocol | **MCP** `mcp.darex.*` | Second MCP server per vertical |
| World search | **Jina** | Tavily/Exa/Firecrawl only if Jina fails |
| iPaaS | — | n8n/Zapier as *customer* automation later, not our executor |
| Unified CRM APIs | — | unified.to / Merge **WATCH** if 40 CRMs drown Wave C |
| Browser | Playwright in sandbox, Phase 17 | Browserbase as default muscle |

Connector rows above still ship as TypeScript executors with honest
`notConnected`. A new logo in this catalog is not a reason to add a
new agent runtime.

---

## 18. Alternatives in the world (instead of Nango + our executors)

**What Darex does:** Nango holds OAuth; TypeScript executors act;
honest `notConnected`. MCP names `mcp.darex.*`.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Composio** tool+auth | Huge tool catalog, agent-native | **REJECT** — closed + breach history (original spec) | composio.dev — do not adopt |
| 2 | **Pipedream / Zapier / Workato / Make** | 5000+ apps, no executor code | Not tenant-RLS; not confirm; we would be a thin Zapier | Pipedream GitHub; Zapier |
| 3 | **unified.to / Merge.dev / Knit** | One CRM API for 50 CRMs | WATCH if Wave C drowns us; OAuth still Nango | unified.to; merge.dev |
| 4 | **n8n** self-host iPaaS | OSS, visual, MCP nodes in 2026 | Customer automation later; not the kernel executor | [n8n-io/n8n](https://github.com/n8n-io/n8n) |
| 5 | **Raw Google/Meta SDKs only** (skip Nango) | Fewer moving parts for 3 providers | Token refresh + 40 providers is why Nango exists | Nango [NangoHQ/nango](https://github.com/NangoHQ/nango) |

**Five things to steal anyway**

1. Keep Nango. Finish GBP/Meet/GA4/GSC stubs before vanity logos.
2. MCP spec updates — official TS SDK, not a second bridge.
3. Jina KEEP; Firecrawl/Tavily only if search quality dies.
4. Playwright last-resort (`08` computer-use), confirm every write.
5. E2B/Daytona as *ideas* for sandbox isolation vs our Docker image.

### Open-source GitHub — this file only (iPaaS / MCP / scrape)

Nango + Jina KEEP → `15` §1. Windmill / Trigger → `09`. n8n is listed **only here**.

| Repo | Similar to | We take |
|------|------------|---------|
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | Visual iPaaS + MCP nodes | Customer automation later; not kernel executor |
| [activepieces/activepieces](https://github.com/activepieces/activepieces) | MIT Zapier-class | Same |
| [huginn/huginn](https://github.com/huginn/huginn) | Self-host agent iPaaS | Trigger list, not a runtime |
| [PipedreamHQ/pipedream](https://github.com/PipedreamHQ/pipedream) | Source-available iPaaS | Connector coverage ideas |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Official MCP server examples | `mcp.darex.*` design |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MCP TS SDK | Bridge, not a second server per vertical |
| [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk) | MCP Python SDK | Only if a worker is Python |
| [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl) | Crawl → markdown | WATCH if Jina extract fails |
| [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | OSS crawl for LLMs | Same; cite, not SoR |
| [scrapy/scrapy](https://github.com/scrapy/scrapy) | Classic crawler | **REJECT** for portals (ToS); email-parse is Gmail |
| [apify/crawlee](https://github.com/apify/crawlee) | Browser crawler | Phase 17 last resort |
| [apache/camel](https://github.com/apache/camel) | Enterprise integration patterns | Sync-worker recipes |
| [svix/svix-webhooks](https://github.com/svix/svix-webhooks) | Outbound webhook delivery | Signed org webhooks |
| [microsoft/playwright](https://github.com/microsoft/playwright) | Browser last-resort | Phase 17 sandbox; confirm every write |
