# Integrations status matrix (2026-10-09)

Every integration, connector and channel that exists anywhere in the repo, checked against code.
Where this file and an older doc disagree, the code citation here is what was read on 2026-10-09.
Fixes for every 🟡 and 🔴 row are in [`02-broken-integrations-fix-plan.md`](02-broken-integrations-fix-plan.md).

## How to read this file

Status legend:

| Mark | Meaning |
|---|---|
| 🟢 | Code path complete, connectable from the product, and `BUILD_STATE.md` records at least one live call against a real account. |
| 🟡 | Code path complete and unit-tested (or at least type-checked), but never proved live, or works only after a human-only setup step that the product does not guide. |
| 🔴 | Cannot work as shipped: no way to connect it from the UI, a known-broken call, a sunset API version, or an inbound path that can never resolve an org. |

Column meanings:

- **Auth**: how the credential is obtained. *Nango OAuth* means the tool calls `resolveNangoAuth` / `resolveGoogleAuth` (`services/workflows/src/tools/shared.ts:311`, `:401`) against connection id `{orgId}_{key}`. *BYOK* means a key pasted into `/connectors` and stored in `channels.meta`. *Env* means a process environment variable.
- **Chat tools**: exact MCP/chat tool names from `services/workflows/src/tool-definitions.ts` (154 definitions, mirrored in `docs/new-109-pg-plan/gap26sept/chat-coverage.md`).
- **R/W/S**: R = read, W = write to a system of record, S = sends something to a third party (email, message, invite, payment).
- **Risk / approval**: the module's `riskFor()` result and whether `confirmForRisk` (`services/workflows/src/tools/risk.ts:15`) parks the call for approval. `read` and `draft` run without approval; `send`, `pay`, `sign`, `publish`, `delete`, `execute` park.
- **In / Out**: inbound webhook exists / outbound send path exists outside the chat tool (for example `apps/dashboard/lib/channel-outbound.ts`).
- **Tests**: test files that exercise this integration specifically. "none" means no integration-specific test was found; the generic gate tests still cover risk routing.
- **Live (BUILD_STATE)**: what `BUILD_STATE.md` says was run against a real provider. "no" means every entry for it says "Not verified".

## Sources read

| Layer | Files |
|---|---|
| Chat tool executor | `services/workflows/src/tool-executor.ts` (545 lines), `services/workflows/src/tools/index.ts` (374), `services/workflows/src/tools/shared.ts` (433), `services/workflows/src/tools/risk.ts`, `services/workflows/src/tools/provider-rate-limit.ts`, every module in `services/workflows/src/tools/` |
| Chat tool definitions | `services/workflows/src/tool-definitions.ts` (154 `name:` entries) |
| MCP bridge | `services/workflows/src/mcp-bridge.ts` (exposes the same definitions as `mcp.darex.*`) |
| Connector SDK | `services/connectors/src/providers.ts`, `client.ts`, `test-connection.ts`, `nango.yaml` |
| Nango infra | `infra/docker-compose.yml:238-270`, `deploy/docker-compose.prod.yml:58-62`, `infra/scripts/seed-nango-configs.sql`, `infra/db/seeds/connector_defs*.sql` |
| Dashboard integrations API | `apps/dashboard/app/api/integrations/route.ts` (603), `nango-token/route.ts`, `razorpay/route.ts`, `whatsapp/**`, `[provider]/ping`, `test/route.ts`, `webhooks/route.ts` |
| Catalog | `apps/dashboard/lib/integrations-catalog.ts` (31 static entries), `apps/dashboard/lib/connector-registry.ts` (DB `connector_defs`), `packages/shared-types/src/connector-signin.ts:6-39` |
| Outbound | `apps/dashboard/lib/channel-outbound.ts` (609), `packages/whatsapp-gateway/src/**` |
| Webhooks | `apps/dashboard/app/api/webhooks/*/route.ts` (13 receivers) |
| Frontend | `NEW-FRONTEND/src/mocks/integrations.ts`, `NEW-FRONTEND/src/lib/api/integrations.ts`, `NEW-FRONTEND/src/components/integrations/*` |

## Headline numbers

| Measure | Count | Evidence |
|---|---|---|
| Provider modules registered in the executor | 54 keys in `TOOL_MODULES` | `services/workflows/src/tools/index.ts:70-126` |
| Chat tools defined | 154 | `tool-definitions.ts`, `chat-coverage.md` "Chat tools (154)" |
| Chat tools proved live from `/ask-ai` | 0 | every row in `chat-coverage.md` is 🔴 |
| Static catalog entries (connect UI, sign-in ids) | 31 (+ `google` alias) | `packages/shared-types/src/connector-signin.ts:6-39` |
| `connector_defs` seed rows | 27 base + 9 wave A/B + 2 LinkedIn/Apollo | `infra/db/seeds/connector_defs.sql`, `connector_defs_wave_ab.sql`, `connector_defs_linkedin_apollo.sql` |
| Integrations with tools but no way to connect from any UI | 10 (Salesforce, Zoho CRM, DocuSign, Leegality, Twilio, LinkedIn, Apollo, Instagram, Google Maps, MLS) | see "Backend-only orphans" |
| Frontend tiles with no backend at all | 2 (`zillow`, `calls` as voice) | see "Catalog-only ghosts" |
| Webhook receivers | 13 route files (+2 accidental nested duplicates) | `apps/dashboard/app/api/webhooks/` |
| Integrations with any live call recorded in `BUILD_STATE.md` | Gmail (fetch), Google Sheets (create), Google Drive (list), WhatsApp via QR/Evolution, plan-execute Gmail draft (failed on scope at the time) | `BUILD_STATE.md:1796-1797`, `:1853-1858`, `:1920-1923`, `:428`, `:552` |

## Cross-cutting facts every row depends on

These apply to all Nango-backed rows and are not repeated per row.

1. **One Nango environment, secret key required.** Every Nango call returns `never-configured` when `NANGO_SECRET_KEY` is unset (`services/workflows/src/tools/shared.ts:316-318`; dashboard `apps/dashboard/lib/nango-server.ts:22-24`). Compose ships a hardcoded default secret (`infra/docker-compose.yml:261`) and an unpinned image `nangohq/nango-server:latest` (`:239`).
2. **Browser popup needs `NEXT_PUBLIC_NANGO_PUBLIC_KEY`.** Empty in both example env files (`.env.example:27`, `deploy/env.production.example:37`). The NEW-FRONTEND connect flow throws "Nango public key is not configured on the backend" when it is missing (`NEW-FRONTEND/src/lib/api/integrations.ts:151`). This blocks 100 % of OAuth connects, not just some.
3. **"Configured" only checks the client id.** `listNangoConfigs` marks a config usable when `oauth_client_id` is non-empty and not a placeholder (`apps/dashboard/lib/nango-server.ts:60-91`). The client secret, scopes and redirect URL are not checked, so a card can show as ready and still fail inside the provider popup.
4. **Sign-in is limited to a fixed id list.** `GET /api/integrations/nango-token` rejects any provider not in `CONNECTOR_SIGN_IN_IDS` with 400 (`apps/dashboard/app/api/integrations/nango-token/route.ts:25-28`, list at `packages/shared-types/src/connector-signin.ts:6-39`). The confirm `POST` does the same (`:85-87`). Any integration outside that list cannot be connected from either UI, even if a Nango config exists.
5. **`nango.yaml` is not deployed.** `services/connectors/nango.yaml` (1373 lines, custom `version: "2"` schema) is not read by any code (no reference in `*.ts`, `*.js`, `*.sh`, `*.json`). Real scopes live in the `nango._nango_configs` table, seeded only for Google by `infra/scripts/seed-nango-configs.sql:28-89`. The runbook's statement that scopes "come from nango.yaml" describes intent, not mechanism.
6. **Token cache.** A resolved access token is cached in-process for 60 s (`shared.ts:210-211`, `:371`) with no eviction when a provider answers 401. A token revoked mid-minute keeps being sent until the cache expires.
7. **Provider retry wrapper rarely fires.** `withProviderRateLimit` retries only when the module *throws* a 429/503 (`provider-rate-limit.ts:80-85`). Almost every module catches its own HTTP errors and returns `status: 'error'`, so the retry and backoff never trigger for them. The per-org token bucket (20 burst, 2/s) is in-process only and is not shared across worker and dashboard processes (`provider-rate-limit.ts:8`, `:23-36`).
8. **No per-integration circuit breaker.** `services/workflows/src/circuit-breaker.ts` is used only by model failover in `local-turn.ts:976-986`; no tool module calls it.
9. **Chat allowlist depends on `channels` rows.** `mergeRuntimeAllowlist` unions the employee allowlist with connected channel types (`tool-executor.ts:108-113`). A provider whose connect flow never writes a `channels` row (every backend-only orphan below) only reaches chat if an employee's `tool_allowlist` names it explicitly.
10. **OAuth/core split is stale.** `AUTONOMOUS_TOOL_CATALOG` (`tool-executor.ts:488-531`) lists 43 providers; `isOAuthTool` is derived from it (`:539-545`). Microsoft Outlook and Calendar, Salesforce, Zoho, DocuSign, Twilio, Leegality, QuickBooks-Nango-only paths and Instagram are missing, so `isOAuthTool('microsoft-outlook')` returns false.
11. **Risk class `draft` is used for system-of-record writes.** CRM creates and updates, ticket creates, Notion pages, Sheets appends, Drive uploads and Stripe customer creation all return `draft` and run without approval (for example `services/workflows/src/tools/hubspot.ts:17-22`, `notion.ts:13-17`, `google-drive.ts:18-23`). `connector_defs` has a `write_sor` risk class that the executor never uses.
12. **Errors reported as "not connected".** Several read paths fall through to `notConnected()` after a provider error while the token is valid: Meta Ads (`meta-ads.ts:26-45`), Google Ads (`google-ads.ts:44-74`), GitHub `fetch_user_repos` (`github.ts:105-129`), Shopify reads (`shopify.ts:84-124`), Zendesk `fetch_tickets` / `create_support_ticket` (`zendesk.ts:63-103`). A 400, 429 or 500 becomes "connect it at /connectors", which sends the user to reconnect a working account.

## Master matrix (one row per integration)

Abbreviations in the Auth column: N = Nango OAuth, NG = Nango through the shared Google login (`resolveGoogleAuth`), B = BYOK in `channels.meta`, E = env var, Q = QR pairing (Evolution), DB = Darex Postgres only.

| # | Integration | Auth | Chat tools | R/W/S | Approval on | In | Out (non-chat) | Tests | Live (BUILD_STATE) | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | WhatsApp (Meta Cloud API) | B (sealed), N fallback, E fallback | `whatsapp_send`, `whatsapp_list_messages` | R, S | send | yes | yes | many (dashboard `whatsapp-*.test.ts`, `messaging-actions.test.ts`) | no for Meta Cloud (`BUILD_STATE.md:528`) | 🟡 |
| 2 | WhatsApp (QR via Evolution) | Q | same as above | R, S | send | yes | yes | `whatsapp-provider-routing.test.ts`, evolution route test | yes (`BUILD_STATE.md:428`, `:552`) | 🟢 |
| 3 | Owner WhatsApp (approvals number) | E | none | S, in | n/a | yes | yes | none found | no | 🟡 |
| 4 | Instagram DMs | B by hand only, E fallback | `instagram_list_messages`, `instagram_send` | R, S | send | yes | yes | `messaging-actions.test.ts` | no (`BUILD_STATE.md:14`) | 🔴 |
| 5 | Twilio SMS | N, B by hand, E fallback | `twilio_send_sms`, `twilio_list_messages` | R, S | send | yes | yes | none specific | no | 🔴 |
| 6 | Chatwoot inbox | E / B | none | in, S | n/a | yes | yes | `outbound-delivery.test.ts` (partly) | yes (SSE event, `BUILD_STATE.md:1937`) | 🟡 |
| 7 | Web widget | DB + widget token | none | in, out | n/a | yes | polling | widget tests in dashboard | not in this audit | 🟡 |
| 8 | Gmail | NG | `gmail_fetch`, `gmail_triage`, `gmail_read_email`, `gmail_extract_otp`, `gmail_extract_attachment`, `gmail_draft_email`, `gmail_draft_reply`, `gmail_send`, `gmail_reply` | R, S | send, reply | yes (unreachable) | yes | `gmail.test.ts`, `gmail-http.test.ts` | fetch yes (`:1920`); send/reply no (`:34`) | 🟡 (out) / 🔴 (in) |
| 9 | Microsoft Outlook mail | N | `outlook_list_messages`, `outlook_read_message`, `outlook_draft_email`, `outlook_draft_reply`, `outlook_send`, `outlook_reply` | R, S | send, reply | no | no | `messaging-actions.test.ts`, ping coverage | no (`:23`) | 🟡 |
| 10 | Microsoft Calendar | N | `outlook_calendar_list_events`, `outlook_calendar_check_availability`, `outlook_calendar_create_event` | R, S | create | no | no | ping coverage only | no | 🟡 |
| 11 | Google Calendar | NG | `calendar_list_events`, `calendar_check_availability`, `calendar_create_event`, `calendar_update_event` | R, S | create, update | yes (watch) | no | `google-calendar.test.ts` | connection only (`:1921`) | 🟡 |
| 12 | Google Drive | NG | `drive_search`, `drive_list`, `drive_get_text`, `drive_upload`, `drive_create_folder`, `drive_share` | R, W, publish | share | no | no | `google-drive.test.ts` | list yes (`:1797`) | 🟢 (read) / 🟡 (write) |
| 13 | Google Docs | NG | `docs_create`, `docs_read`, `docs_append` | R, W | none | no | no | `google-docs-sheets.test.ts` | no | 🟡 |
| 14 | Google Sheets | NG | `sheets_create`, `sheets_read`, `sheets_append_row` | R, W | none | no | no | `google-docs-sheets.test.ts` | create yes (`:1796`) | 🟢 |
| 15 | Google Slides | NG | `slides_create`, `slides_get`, `slides_add_slide`, `slides_update_slide`, `slides_delete_slide` | R, W, delete | delete | no | no | none specific | no | 🟡 |
| 16 | Google Forms | NG | `forms_get` (action `forms_get_responses` has no chat tool) | R | none | no | no | none | no | 🟡 |
| 17 | Google Chat | NG | `chat_list_spaces`, `chat_send_message` | R, S | send | no | no | none | no | 🟡 |
| 18 | Google Meet | NG | `meet_create_space`, `meet_get_space` | R, W | none | no | no | none | no | 🟡 |
| 19 | Google Contacts | NG | `contacts_list` | R | none | no | no | none | no | 🟡 |
| 20 | Google Tasks | NG | `tasks_list` (action `tasks_create` has no chat tool) | R | none | no | no | none | no | 🟡 |
| 21 | Google Analytics (GA4) | NG | `analytics_report` | R | none | no | no | none | no | 🟡 |
| 22 | Google Search Console | NG | `search_console_sites`, `search_console_query` | R | none | no | no | none | no | 🟡 |
| 23 | Google Business Profile | NG | `business_list_locations` | R | none | no | no | none | no | 🟡 |
| 24 | Google Cloud (Resource Manager) | NG | `cloud_list_projects` | R | none | no | no | none | no | 🟡 |
| 25 | Google Ads | NG + E developer token | `google_ads_metrics` | R | none | no | no | none | connection only (`:1921`) | 🔴 |
| 26 | Meta Ads | N | `meta_ads_metrics` | R | none | no | no | none | no | 🟡 |
| 27 | HubSpot | N | `hubspot_search_contacts`, `hubspot_create_contact`, `hubspot_update_contact`, `hubspot_list_deals`, `hubspot_create_deal`, `hubspot_update_deal` | R, W | none | no | no | `hubspot-sync-deal-schedule.test.ts` | no | 🟡 |
| 28 | Salesforce | N | `salesforce_list_contacts`, `salesforce_create_contact`, `salesforce_create_lead`, `salesforce_list_deals`, `salesforce_create_deal`, `salesforce_update_deal` | R, W | none | no | no | `wave-b-c6-honesty.test.ts` (not-connected paths) | no | 🔴 |
| 29 | Zoho CRM | N | `zoho_list_contacts`, `zoho_create_contact`, `zoho_create_lead`, `zoho_list_deals`, `zoho_create_deal`, `zoho_update_deal` | R, W | none | no | no | `wave-b-c6-honesty.test.ts` | no | 🔴 |
| 30 | Notion | N | `notion_search`, `notion_read_page`, `notion_query_database`, `notion_create_page`, `notion_append_page_content` | R, W | none | no | no | `notion.test.ts` | no | 🟡 |
| 31 | Slack | N | `slack_list_channels`, `slack_read_channel`, `slack_read_thread`, `slack_send`, `slack_reply_thread`, `slack_post_decision_card` | R, S | send | interactions only | decision cards | `slack-interact.test.ts`, `messaging-actions.test.ts` | no (`:23`) | 🟡 |
| 32 | Zendesk | N | `zendesk_fetch_tickets`, `zendesk_create_ticket`, `zendesk_update_ticket` | R, W (public comment emails requester) | none | no | no | none | no | 🟡 |
| 33 | Intercom | N | `intercom_fetch_conversations`, `intercom_reply`, `intercom_create_conversation` | R, S | reply, create | no | no | none | no | 🟡 |
| 34 | Shopify | N + shop domain | `shopify_fetch_products`, `shopify_fetch_orders` (action `update_order_address` has no chat tool) | R, W | none | no | no | `shopify.test.ts` | no | 🔴 (connect) |
| 35 | Stripe (org's own) | N | `stripe_create_payment_link`, `stripe_create_customer`, `stripe_get_customer`, `stripe_create_refund`, `stripe_create_charge` | R, W, pay | pay | no | no | `stripe.test.ts`, `provider-idempotency.test.ts` | no | 🟡 |
| 36 | Razorpay (org's own) | B (sealed) | `razorpay_create_payment_link` | pay | pay | yes (rent-payment) | no | `razorpay-secret-seal.test.ts` | no | 🟡 |
| 37 | QuickBooks | N + realm id | `quickbooks_list_customers`, `quickbooks_list_invoices`, `quickbooks_create_customer` | R, W | none | no | no | `wave-b-c6-honesty.test.ts` | no | 🟡 |
| 38 | DocuSign | N | `docusign_list_envelopes`, `docusign_create_envelope`, `docusign_send_envelope` | R, W, sign | send | no | no | `wave-b-c6-honesty.test.ts` | no | 🔴 |
| 39 | Leegality | B (no UI), N, E | `leegality_list_documents`, `leegality_create_document`, `leegality_send_document` | R, sign | create, send | no | no | `wave-b-c6-honesty.test.ts` | no | 🔴 |
| 40 | GitHub | N | `github_fetch_repos`, `github_create_repo`, `github_create_issue` | R, publish, S | create repo, issue | no | no | none | connection only (`:1921`) | 🟡 |
| 41 | LinkedIn | N | `linkedin_search_people`, `linkedin_company_signals` | R | none | no | no | `wave-linkedin-apollo-honesty.test.ts` | no | 🔴 |
| 42 | Apollo.io | N (API key) | `apollo_search_people`, `apollo_enrich_company` | R | none | no | no | `wave-linkedin-apollo-honesty.test.ts` | no | 🔴 |
| 43 | Google Maps Geocoding | E | `maps_geocode`, `maps_reverse_geocode` | R | none | no | no | none | no | 🟡 |
| 44 | MLS | none | none (catalog `mls_listings_search` has no definition) | n/a | n/a | no | no | none | no | 🔴 (stub) |
| 45 | RERA public lookup | E / public | `rera_lookup` | R | none | no | no | none | no | 🟡 |
| 46 | Nango lifecycle webhooks | E secret | none | in | n/a | yes (log-only) | n/a | none | no | 🟡 |
| 47 | Darex billing (Stripe, Razorpay platform) | E | `billing_usage` (read) | R | n/a | yes | checkout | billing tests | no live run (runbook §4) | 🟡 |
| 48 | Web search (Jina, SearXNG, DuckDuckGo, Wikipedia, Google News) | E / keyless | `web_search` | R | none | n/a | n/a | `web-search-*.test.ts` | Google News fallback yes (`:1630`) | 🟢 |
| 49 | Web extract (Crawl4AI, Jina reader) | E | `web_extract` | R | none | n/a | n/a | `safe-url.test.ts` | not recorded | 🟡 |
| 50 | Code sandbox | E (`SANDBOX_API_URL`) | `code_execution`, `python_execute`, `terminal_run_command` | execute | execute | n/a | n/a | `sandbox-no-host.test.ts` | partly (`:1798+`) | 🟡 |
| 51 | Memory (Cognee, Hindsight) | E | `cognee_memory_search`, `cognee_memory_remember` | R, W | none | n/a | n/a | `cognee.test.ts`, memory tests | yes (`:535`, `:574`, `:581`) | 🟢 |
| 52 | Internal data tools (DB, metrics, file_ops, ops, growth, customer, re, daily brief, connectors_status) | DB | 30+ tools (see chat-coverage) | R, W (DB) | per tool | n/a | n/a | many | `database_query`, `metrics_query` yes (`:396`) | 🟢 / 🟡 |

## Detailed rows

Each section gives the code path, what is solid, what is not, the blockers, and the reason for the status mark.

### Messaging channels

#### 1. WhatsApp through the Meta Cloud API (🟡)

- **Connect.** BYOK form posts to `/api/integrations/whatsapp` (`NEW-FRONTEND/src/lib/api/integrations.ts:173-183`); the server verifies the token against Graph before saving (`integrations-connectors.md` "What works" #2, confirmed by the `whatsappByokConnected` check at `apps/dashboard/app/api/integrations/route.ts:43`, `:172-178`). Embedded Signup also exists (`apps/dashboard/app/api/integrations/whatsapp/embedded-signup/route.ts`). Several numbers per workspace are supported (`apps/dashboard/lib/whatsapp-numbers.ts`, `BUILD_STATE.md:422`).
- **Secrets.** Tokens are sealed with `CHANNEL_SECRETS_KEY`; the chat tool opens them with `openSecret` (`services/workflows/src/tools/whatsapp.ts:131-143`) and the gateway does the same (`packages/whatsapp-gateway/src/providers/meta-cloud.ts:10-13`). A legacy `manual_json:` branch still parses plaintext credentials out of `channels.nango_connection_id` (`whatsapp.ts:145-148`).
- **Chat tools.** `whatsapp_send` (risk `send`, parks for approval) and `whatsapp_list_messages` (reads `messages.channel_key = 'whatsapp'`, RLS-scoped, `whatsapp.ts:24-65`).
- **Inbound.** `POST /api/webhooks/whatsapp` checks `X-Hub-Signature-256` (`apps/dashboard/app/api/webhooks/whatsapp/route.ts:1`), persists and fires the agent without awaiting it.
- **Outbound outside chat.** `sendChannelReply` → `@darex/whatsapp-gateway` (`apps/dashboard/lib/channel-outbound.ts:161-179`), used by conversation replies and the inbound agent.
- **Gaps.**
  - Chat sends call Graph directly (`whatsapp.ts:166-182`) instead of the gateway; the two paths diverge (no retry, different error handling, Graph `v18.0` pinned in the tool).
  - No template send. Outside the 24-hour window Meta returns error 131047; the tool turns it into a clear message (`whatsapp.ts:217-219`) but offers no way to send an approved template. There is no `whatsapp_send_template` tool.
  - Messages sent from chat are not written to `messages`, so the inbox does not show them (stated at `BUILD_STATE.md:14`; no insert in `whatsapp.ts`).
  - The channel lookup has no `account_key` or status filter (`whatsapp.ts:101-104`); with more than one number the row picked is arbitrary.
  - Graph API version `v18.0` (`whatsapp.ts:168`). Meta retires Graph versions about two years after release; whether `v18.0` is still served on 2026-10-09 is unverified and must be checked.
- **Live.** `BUILD_STATE.md:528` says nothing was run against a real Meta number (template fallback, media, Embedded Signup).
- **Why 🟡.** The code path is complete and well tested, but no live Meta Cloud send has been recorded.

#### 2. WhatsApp through QR pairing (Evolution) (🟢)

- **Connect.** `POST /api/integrations/whatsapp/evolution` creates an Evolution instance and returns the QR (`apps/dashboard/app/api/integrations/whatsapp/evolution/route.ts`, route test in `__tests__/route.test.ts`).
- **Inbound.** `POST /api/webhooks/whatsapp-evolution`, authenticated with a shared secret header (`apps/dashboard/app/api/webhooks/whatsapp-evolution/route.ts:33`).
- **Outbound.** Chat: `whatsapp.ts:109-129` routes to `sendViaGateway` when `providerIdOf(meta) === 'evolution'`. Replies: gateway in `channel-outbound.ts:161`.
- **Live.** Two numbers paired and answered live on the dev server (`BUILD_STATE.md:428`); QR, status poll, simulated `connection.update` and `messages.upsert` live (`:552`).
- **Caveats.** Unofficial WhatsApp Web protocol: number bans are a business risk the UI should state. The same "chat sends not written to `messages`" gap applies.
- **Why 🟢.** Live pairing and replies recorded.

#### 3. Owner WhatsApp (approval channel) (🟡)

- **What it is.** A second, distinct number used to send approval prompts to the business owner and receive their answers. `GET/POST /api/webhooks/owner-whatsapp` (354 lines) verifies the Meta signature (`apps/dashboard/app/api/webhooks/owner-whatsapp/route.ts:3`, `:236`).
- **Config.** Env only: `OWNER_WHATSAPP_PHONE_NUMBER_ID`, `OWNER_WHATSAPP_VERIFY_TOKEN`, `OWNER_WHATSAPP_OWNER_PHONE` (`.env.example:138-143`). One owner phone per deployment, not per org.
- **Tests.** No test file for this route was found.
- **Why 🟡.** Single-tenant by configuration and unverified live.

#### 4. Instagram DMs (🔴)

- **Chat tools.** `instagram_list_messages` and `instagram_send` (`services/workflows/src/tools/instagram.ts`). The send enforces the 24-hour window and a numeric IGSID before calling Graph (`instagram.ts:77-114`).
- **Inbound.** `POST /api/webhooks/instagram` verifies the Meta signature and resolves the org from a `channels` row of type `instagram` whose meta has `ig_user_id`, `instagram_account_id` or `page_id` (`apps/dashboard/app/api/webhooks/instagram/route.ts:96-130`).
- **Outbound outside chat.** `sendInstagram` in `channel-outbound.ts:393-504`.
- **Blocker: nothing creates the channel row.** No route, page or seed writes a `channels` row with `channel_type = 'instagram'` and an `ig_user_id` (searched `apps/dashboard` and `NEW-FRONTEND` for `ig_user_id`: only the readers above). Instagram is not in `CONNECTOR_SIGN_IN_IDS`, not in the static catalog and not in `connector_defs`. Inbound events are dropped with "Cannot resolve org" (`instagram/route.ts:123-129`) unless someone inserts the row by hand.
- **Secrets.** Read as plaintext from `meta.meta_access_token` / `accessToken` / `page_access_token` (`instagram.ts:106-107`); not sealed, unlike WhatsApp.
- **Env fallback.** Falls back to the platform `META_ACCESS_TOKEN` (`instagram.ts:107`, `channel-outbound.ts:417`), which is a cross-tenant credential.
- **Echo loop risk.** `collectInstagramMessages` does not skip `message.is_echo` (`instagram/route.ts:52-64`). If the app is subscribed to `message_echoes`, the business's own replies come back as inbound "user" messages and can fire the agent. Unverified whether the subscription is enabled.
- **Window check mismatch.** The outbound path in `channel-outbound.ts:443-451` does not filter `m.channel_key = 'instagram'`, so a recent message from the same contact id on another channel would open the window; the chat tool does filter (`instagram.ts:97`).
- **Why 🔴.** Cannot be connected from the product; inbound cannot resolve an org without manual SQL.

#### 5. Twilio SMS (🔴)

- **Chat tools.** `twilio_send_sms` (send, parks) and `twilio_list_messages` (`services/workflows/src/tools/twilio.ts`).
- **Credentials.** Tried in order: Nango connection `{org}_twilio`, then `channels` row of type `twilio`, then env `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` (`twilio.ts:29-62`). The env fallback has no production guard (Razorpay has one at `razorpay.ts:34`), so any org's chat can send SMS from the platform's Twilio account.
- **Connect.** `connector_defs` lists `twilio` as `byok` (`infra/db/seeds/connector_defs_wave_ab.sql:131-137`) but the only BYOK routes are WhatsApp and Razorpay; `POST /api/integrations` answers a BYOK connect with "Use POST /api/integrations/whatsapp for WhatsApp BYOK" (`apps/dashboard/app/api/integrations/route.ts:282-294`). `twilio` is not a sign-in id, so the NEW-FRONTEND "Calls" tile (mapped to `twilio`, `NEW-FRONTEND/src/lib/api/integrations.ts:28-32`) fails at `GET /api/integrations/nango-token` with 400.
- **Inbound.** `POST /api/webhooks/sms` verifies `X-Twilio-Signature` and resolves the org from `channels` of type `sms`/`twilio` by `phone`/`from_number` (`apps/dashboard/app/api/webhooks/sms/route.ts:16-48`). Lines 42-43 also try the env `TWILIO_FROM_NUMBER`, which only helps if some org has a row with that number.
- **Secret storage.** `auth_token` is read as plaintext from channel meta (`twilio.ts:54`, `channel-outbound.ts:119-120`, `:326-330`).
- **Two channel types.** The tool reads `channel_type = 'twilio'` (`twilio.ts:47`); the webhook and outbound read `sms` or `twilio` (`sms/route.ts:38-43`, `channel-outbound.ts:314`). An `sms` row works for inbound but not for the chat tool.
- **Why 🔴.** No supported way to connect; the env fallback is a tenant-isolation problem.

#### 6. Chatwoot inbox (🟡)

- **Inbound.** `POST /api/webhooks/chatwoot` (483 lines) verifies `x-chatwoot-signature` (`apps/dashboard/app/api/webhooks/chatwoot/route.ts:203`). `POST /api/webhooks/outbound` is the inbox-gateway send path with the same signature (`outbound/route.ts:1-30`).
- **Outbound.** `sendChatwoot` (`channel-outbound.ts:181-222`); credentials from channel meta or env `CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID` (`:108-114`). Env fallback is again platform-wide.
- **Chat tools.** None. Ask AI cannot read or reply to Chatwoot conversations except through the generic conversation routes.
- **Live.** SSE `needs_attention` event after a Chatwoot webhook verified live (`BUILD_STATE.md:1937`). No live outbound recorded.
- **Why 🟡.** Inbound proved; outbound and chat coverage missing.

#### 7. Website widget (🟡)

In scope only as a channel: widget routes persist visitor messages and the reply is polled. `gap26sept/widget.md` lists the open issues (polling stops after 60 s, `/api/widget/intent` unthrottled). Not re-audited here.

### Email

#### 8. Gmail (🟡 outbound / 🔴 inbound)

- **Auth.** `resolveGoogleAuth(orgId, 'gmail')` (`services/workflows/src/tools/gmail.ts:424`) tries eight connection ids and six config keys in parallel and checks the token scope contains `gmail` or `mail.google.com` (`shared.ts:288-303`, `:401-417`).
- **Chat tools.** Nine, listed in the master table. Sends and replies are `send` risk (`gmail.ts` `riskFor`), drafts are `draft`. All outgoing mail goes through `buildRawEmail`, which strips CR/LF from headers and RFC 2047-encodes subjects (`BUILD_STATE.md:31-33`).
- **Outbound outside chat.** `sendGmail` in `channel-outbound.ts:249-296` builds its own MIME with `encodeGmailRaw` (`:231-247`) and does **not** strip CR/LF or encode non-ASCII subjects, unlike the chat path. It also takes the token via `getNangoConnection(orgId, 'gmail')` (`:224-229`), which ignores scope and cannot tell revoked from missing.
- **Inbound: unreachable.**
  1. Nothing calls Gmail `users.watch`. The only `watch` call in the repo is Google Calendar (`services/connectors/src/calendar.ts:242`). Without a watch, Google never pushes to `/api/webhooks/gmail`.
  2. Even with a watch set up by hand, the webhook resolves the org from a `gmail` channel row whose meta has `email`, `emailAddress` or `email_address` (`apps/dashboard/app/api/webhooks/gmail/route.ts:229-232`). The connect flows only write `PUBLIC_META_KEYS` (`shopDomain`, `subdomain`, `adAccountId`, `customerId`, `phoneNumberId`, `wabaId`; `apps/dashboard/lib/integrations-catalog.ts:683`), so the mailbox address is never stored.
  3. `fetchRecentMail` passes the pushed `historyId` as `startHistoryId` (`gmail/route.ts:96-101`). Gmail returns changes *after* that id, so the message that triggered the push is usually missing; the code then lists the five newest messages with no label filter (`:113-122`), which includes the org's own sent mail. Raw `fetch` with no timeout.
  4. When the token is missing it still persists a "[Gmail push] … not connected" message into the conversation tables (`gmail/route.ts:249-262`).
- **Live.** `gmail` fetch returned three real emails (`BUILD_STATE.md:1920`). A plan-execute `draft_email` failed with 403 insufficient scopes at the time (`:1856-1858`). Read, reply and reply-all are unverified live (`:27`, `:34`).
- **Why 🟡 / 🔴.** Outbound and reading work in code and partly live; inbound cannot fire.

#### 9. Microsoft Outlook mail (🟡)

- **Auth.** `resolveNangoAuth` on `{org}_microsoft-outlook` then `{org}_microsoft` (`services/workflows/src/tools/microsoft-outlook.ts:24-26`).
- **Chat tools.** List with search, read, draft, draft reply, send (`/me/sendMail`, `:189`), reply / reply-all (`:118`). Drafts are `draft`; everything else that is not a read is `send`.
- **Connect.** `microsoft-outlook` is a sign-in id and a catalog entry (`integrations-catalog.ts:590-600`). Needs an Entra app registration in Nango (runbook row 12). `oauthConfigured` will be false until then.
- **Inbound.** None. No Graph subscription, no webhook route. Inbound Outlook mail never reaches the inbox or the auto-reply agent.
- **Tests.** `messaging-actions.test.ts` (URL building, id validation, risk), `connector-ping-coverage.test.ts`.
- **Why 🟡.** Complete outbound and read path; credentials and live proof missing; no inbound.

#### 10. Microsoft Calendar (🟡)

- `microsoft-calendar.ts` lists via `calendarView` (`:101`, `:128`) and creates via `/me/events` (`:173`). No update action, no Graph change notifications, no inbound. Same Entra app as Outlook. Unverified live.

### Google Workspace

All Google tools share one login: `resolveGoogleAuth` accepts a token from any of the Google connections if its scope covers the tool (`shared.ts:288-303`). The connect flow fans one Google connect out to seven `channels` rows (`apps/dashboard/app/api/integrations/nango-token/route.ts:157-188`, mirrored in `route.ts` POST). Scope checks exist only for 11 keys; Ads, Analytics, Search Console, Business Profile and Cloud fall through to `return true` (`shared.ts:302`), so a token lacking those scopes is used anyway and fails at Google with 403. The seed script grants those scopes only on per-key configs (`infra/scripts/seed-nango-configs.sql:69-83`), while the umbrella `google` config omits them (`:36-38`).

#### 11. Google Calendar (🟡)

- Tools `calendar_list_events`, `calendar_check_availability`, `calendar_create_event`, `calendar_update_event` (`services/workflows/src/tools/google-calendar.ts`). Create and update use `sendUpdates=all` (`:186`, `:285`), so they email attendees; both are `send` risk and park.
- Inbound: `POST /api/webhooks/google-calendar` fails closed unless `X-Goog-Channel-Token` matches a stored hash (`apps/dashboard/app/api/webhooks/google-calendar/route.ts:23-26`, `:92`). Watches are registered from showings (`apps/dashboard/app/api/showings/calendar-watch/route.ts`, `apps/dashboard/lib/gcal-watch.ts`). An accidental nested copy exists at `webhooks/google-calendar/google-calendar/route.ts` (differs by one line: it drops `orgId: watch.org_id` at line 94) and a similar nested copy at `showings/calendar-watch/calendar-watch/route.ts`.
- Test: `google-calendar.test.ts`. Live: the connection existed in the test org (`BUILD_STATE.md:1921`); no live create recorded.

#### 12. Google Drive (🟢 read / 🟡 write)

- Tools: search, list, get text, upload (`draft`), create folder (`draft`), share (`publish`, parks) (`google-drive.ts:8-23`). Honest error propagation on non-2xx was added (`BUILD_STATE.md:826`). Live `drive_list` returned 27 files (`:1797`). Uploads and shares unverified.

#### 13. Google Docs (🟡) and 14. Google Sheets (🟢)

- Docs: create, read, append (`google-docs.ts`). Sheets: create, read, append row (`google-sheets.ts`). All writes are `draft` (no approval). `sheets_create` executed live (`BUILD_STATE.md:1796`).
- `google-docs.ts:159-164` sends a styling `batchUpdate` whose HTTP status is ignored on purpose (styling is non-fatal); the text insert itself throws on failure (`google-docs.ts:119`).

#### 15-24. Slides, Forms, Chat, Meet, Contacts, Tasks, Analytics, Search Console, Business Profile, Cloud (🟡)

| Integration | Module | Notes |
|---|---|---|
| Slides | `google-slides.ts` (632 lines) | Delete is `delete` risk and parks; other writes `draft`. No test. |
| Forms | `google-forms.ts` | `forms_get_responses` action exists (`:5`, `:25`) but has no chat tool definition. |
| Chat | `google-chat.ts` | Send is `send` risk. Google Chat API needs a Chat app configured in the Cloud project even for user OAuth; unverified. |
| Meet | `google-meet.ts` | `meet_create_space` is `draft`. Ping spec uses `conferenceRecords`, which needs a different scope from the one seeded (`providers.ts:152` vs seed `:60-62`). |
| Contacts | `google-contacts.ts` | List only. |
| Tasks | `google-tasks.ts` | `tasks_create` exists (`:5`, `:49`) with no chat tool definition. |
| Analytics | `google-analytics.ts` | Needs a GA4 property id in the payload; scope not validated (`shared.ts:302`). |
| Search Console | `google-search-console.ts` | Requires `siteUrl` for queries (`:21`). |
| Business Profile | `google-business-profile.ts` | The Business Profile APIs need per-project access approval from Google; without it the calls return 403 (provider policy, unverified for this project). |
| Cloud | `google-cloud.ts` | Lists projects with `cloud-platform` scope, a sensitive scope requiring verification. |

None of these has a live call recorded; most have no test file.

#### 25. Google Ads (🔴)

- `google-ads.ts:45` calls `https://googleads.googleapis.com/v14/customers/{id}/googleAds:search`. Google Ads API versions are sunset roughly a year after release and requests to a sunset version are rejected; v14 dates from 2023. The ping spec uses `/v14/customers:listAccessibleCustomers` (`services/connectors/src/providers.ts:147`). Treat both as broken until a current version is confirmed live.
- Requires env `GOOGLE_ADS_DEVELOPER_TOKEN` on worker and dashboard (`google-ads.ts:19`); the catalog marks Ads `catalog_only` (`integrations-catalog.ts:152`), but the tool and chat definition are still exposed.
- `customerId` is put into the URL unencoded and with dashes intact (`:18`, `:45`); Ads expects ten digits without dashes. No `login-customer-id` header for manager accounts.
- Non-OK responses fall through to `notConnected` (`:44-74`).

#### 26. Meta Ads (🟡)

- `meta-ads.ts` reads `/{adAccountId}/insights` on Graph `v18.0` (`:26`). The ad account id must carry the `act_` prefix; the code passes the payload value or `META_AD_ACCOUNT_ID` as-is.
- Any non-OK Graph response falls through to `notConnected` (`:26-45`), including an expired token (code 190), which should be `revoked`.
- Advanced access for `ads_read` needs Meta app review (runbook row 2).

### CRM

#### 27. HubSpot (🟡)

- Nine module actions (`hubspot.ts:5-15`); six are chat tools. `sync_deal_schedule` and `reassign_owner` are internal (used by sweeps; test `hubspot-sync-deal-schedule.test.ts`).
- Every write is `draft` (`hubspot.ts:17-22`), so creating or updating deals and contacts, and reassigning owners, runs without approval.
- After a contact create, dedup and enrichment fire in the background (`tool-executor.ts:349-390`).
- Needs a real HubSpot app in Nango (runbook row 3). Unverified live.

#### 28. Salesforce (🔴) and 29. Zoho CRM (🔴)

- Modules exist (`salesforce.ts`, API `v59.0` at `:14`; `zoho.ts`), with list/create/update for contacts, leads and deals. All writes `draft`.
- **Cannot be connected.** Neither id is in `CONNECTOR_SIGN_IN_IDS`, so `nango-token` GET returns 400 (`nango-token/route.ts:25-28`). Zoho is also mis-keyed: `connector_defs` key is `zoho-crm`, the NEW-FRONTEND tile id is `zoho` (`NEW-FRONTEND/src/mocks/integrations.ts:19`), and there is no `BACKEND_ID` mapping for it (`NEW-FRONTEND/src/lib/api/integrations.ts:28-32`).
- Salesforce instance URL falls back to env `SALESFORCE_INSTANCE_URL` (`salesforce.ts:34`), a single-tenant value.
- Tests cover only the not-connected honesty path (`wave-b-c6-honesty.test.ts`).

### Productivity and collaboration

#### 30. Notion (🟡)

- Search, read page, query database, create page, append (`notion.ts:5-11`). Writes `draft`. `notion.test.ts` covers parsing. Needs a Notion public integration in Nango (runbook row 5); scopes are set on the Notion side. Unverified live.

#### 31. Slack (🟡)

- Six chat tools; sends park. `slack_post_decision_card` posts Block Kit approval cards; button clicks return to `POST /api/webhooks/slack/interactions` with signature verification (`apps/dashboard/app/api/webhooks/slack/interactions/route.ts:7-18`, test `slack-interact.test.ts`).
- **No Events API receiver.** The runbook says "Events webhook is separate (`/api/webhooks/slack`)" (`integrations-credentials-runbook.md` row 6), but only `slack/interactions/route.ts` exists. Inbound Slack messages never reach Darex; chat can only poll with `slack_read_channel`.
- The Slack token may lack `channels:read` / `groups:history`; Slack then answers `missing_scope` (`BUILD_STATE.md:22-23`).

### Support

#### 32. Zendesk (🟡)

- Fetch, create, update tickets (`zendesk.ts`). Subdomain from channel meta or env `ZENDESK_SUBDOMAIN` (`:23`).
- `update_ticket` posts `comment: { body }` without `public: false` (`zendesk.ts:40`), so Zendesk treats it as a public reply and emails the requester, yet the action is `draft` and runs without approval. `create_support_ticket` sends no requester (`zendesk.ts:84`), so the connected agent becomes the requester.
- Read and create fall through to `notConnected` on API errors (`:63-103`).

#### 33. Intercom (🟡)

- Fetch, reply, create conversation (`intercom.ts`). Reply and create are `send` and park. Each reply first calls `/me` to get the admin id (`:33`, `:51`), an extra round trip per call. Unverified live.

### Commerce and finance

#### 34. Shopify (🔴 connect)

- Fetch products, fetch orders, `update_order_address` (no chat tool) (`shopify.ts:5`). Admin API `2024-01` pinned (`:43-102`, ping `providers.ts:163`). Shopify keeps a version for about a year and then serves the oldest supported one instead; behaviour on 2026-10-09 is unverified.
- **Connect from NEW-FRONTEND cannot work.** Shopify requires the shop domain before the popup (`integrations-catalog.ts:271-272`); NEW-FRONTEND's `oauthConnect` never collects or passes `extraConnectFields` (`NEW-FRONTEND/src/lib/api/integrations.ts:144-170`). The legacy dashboard page collected them (`connectors.md` "What works" #3). The same applies to Zendesk (`integrations-catalog.ts:292-293`).
- Read failures fall through to `notConnected` (`shopify.ts:84-124`).

#### 35. Stripe, org-owned (🟡)

- Payment link, customer create/get, refund, charge (`stripe.ts:6`). Refund, charge and payment link are `pay` and park. Writes carry an idempotency key (`BUILD_STATE.md:133`, `provider-idempotency.test.ts`).
- `stripe_create_charge` creates a PaymentIntent with `confirm: 'false'` (`stripe.ts:31-50`): approving it moves no money. The tool name and description promise a charge.
- Needs Stripe Connect OAuth in Nango (runbook row 4). Unverified live.

#### 36. Razorpay, org-owned (🟡)

- BYOK keys verified and sealed (`BUILD_STATE.md:183`, `razorpay.ts:17-31`). Env fallback only outside production with `ALLOW_GLOBAL_RAZORPAY_DEV=true` (`:34`). Payment link is `pay`. Payment webhooks arrive at `/api/webhooks/rent-payment` with HMAC checks (`rent-payment/route.ts:20-38`). Unverified live.

#### 37. QuickBooks (🟡)

- List customers, list invoices, create customer (`quickbooks.ts`). Realm id from the Nango connection config, else env `QUICKBOOKS_REALM_ID` (`:33-43`), a single-tenant fallback. Sign-in id exists. Ping exempt from coverage (needs realm id). Unverified live.

### Documents and e-signature

#### 38. DocuSign (🔴)

- List, create (draft), send (`sign`, parks) (`docusign.ts`). Resolves account and base URI from `/oauth/userinfo` (`:36-47`). Not a sign-in id, so it cannot be connected from the UI. Defaults to the production account host unless `DOCUSIGN_OAUTH_BASE_URL` is set (`:27`).

#### 39. Leegality (🔴)

- List, create, send; both create and send are `sign` (`leegality.ts` risk). Credentials: Nango, then channel meta, then env `LEEGALITY_API_TOKEN` (`:42-86`). `connector_defs` says BYOK "paste Auth Token … into /connectors" (`connector_defs_wave_ab.sql:176-195`) but there is no BYOK route for it; the env fallback is platform-wide.

### Developer

#### 40. GitHub (🟡)

- Fetch repos (`read`), create repo (`publish`), create issue (`send`) (`github.ts`). Runbook notes a mismatch: catalog asks for an OAuth App with `repo read:org`, `nango.yaml` describes a GitHub App (`integrations-credentials-runbook.md` row 10). `fetch_user_repos` errors fall through to `notConnected` (`github.ts:105-129`). A connection existed in the test org (`BUILD_STATE.md:1921`); no live call recorded.

### Prospecting

#### 41. LinkedIn (🔴)

- `linkedin.ts:47` calls `/v2/organizationAcls?q=roleAssignee…&keywords=` and `:72` calls `/v2/peopleTypeahead`. `organizationAcls` lists organisations the signed-in member administers; it is not a company-signals API, and people search is not available to standard LinkedIn apps (provider policy; unverified against this app). Not a sign-in id. Treat the tools as unable to deliver what their descriptions promise.

#### 42. Apollo.io (🔴)

- Uses the Nango token as `X-Api-Key` (`apollo.ts:27-33`), which matches Apollo's API-key auth if the Nango integration is API-key mode. Not a sign-in id and no BYOK form, so it cannot be connected.

### Location and real estate

#### 43. Google Maps Geocoding (🟡)

- Env `GOOGLE_MAPS_API_KEY` or `MAPS_API_KEY` (`maps.ts:18`), one key for all orgs; billing is the platform's. Honest on missing key and `ZERO_RESULTS` (seed hint, `connector_defs_wave_ab.sql:107-126`). No test.

#### 44. MLS (🔴, stub)

- `mls` module always returns `notConnected` (`services/workflows/src/tools/realestate/index.ts:802-808`). `AUTONOMOUS_TOOL_CATALOG` advertises `mls_listings_search` with `oauth: true` (`tool-executor.ts:527`), but no chat tool definition exists. Blocked on a licensed MLS client (`AGENTS.md` §4).

#### 45. RERA lookup (🟡)

- `public/rera.ts` caches official lookups with URL and timestamp; without `RERA_LOOKUP_URL` it builds a search link (`:23-30`, `:85`). No test.

### Platform plumbing

#### 46. Nango lifecycle webhooks (🟡)

- `POST /api/webhooks/nango` verifies `X-Nango-Signature` and only logs to `channel_logs` (`apps/dashboard/app/api/webhooks/nango/route.ts:16-25`, `:61-80`). It never updates `channels` or `org_connectors`, so a refresh failure or revocation event Nango sends does not change the connector's health. Returns 503 until `NANGO_WEBHOOK_SECRET` is set.

#### 47. `/api/integrations/webhooks` (stub)

- An authenticated route that writes any JSON body to `channel_logs` as a "webhook received" success (`apps/dashboard/app/api/integrations/webhooks/route.ts:6-28`). It receives nothing from any provider (it needs a user session) and has no caller found in either frontend. Dead surface.

#### 48. Connector health and status

- `connectors_status` chat tool (`services/workflows/src/tools/connectors.ts`) reports per-connector state with an optional live probe; `POST /api/integrations/[provider]/ping` updates `org_connectors` health columns. No scheduled health sweep exists (searched for a periodic job calling the ping: none in `periodic-registry.ts`; `infra/scripts/alerting-connector-401s.js` is an ops script).
- `GET /api/integrations` returns `apiQuotaUsed` computed as today's `channel_logs` count divided by 1000 (`apps/dashboard/app/api/integrations/route.ts:227`). There is no such quota; the figure is invented.

## Catalog-only ghosts (advertised in a UI or catalog, no working backend)

These appear somewhere a user or the model can see them, but no executor, connect path or data exists behind them.

| Ghost | Where it is advertised | What is missing | Evidence |
|---|---|---|---|
| Zillow | NEW-FRONTEND Settings tile "Property leads" | No module, no connector def, no Nango key, no webhook. Clicking connect calls `nango-token?provider=zillow`, which returns 400. | `NEW-FRONTEND/src/mocks/integrations.ts:20`; no `zillow` in `services/` or `apps/dashboard` |
| "Calls" (AI calling) | NEW-FRONTEND Settings tile "AI calling", mapped to `twilio` | Twilio module is SMS only; no voice API, no call webhooks. `twilio` is not a sign-in id, so connect returns 400. | `NEW-FRONTEND/src/mocks/integrations.ts:15`, `NEW-FRONTEND/src/lib/api/integrations.ts:31`, `services/workflows/src/tools/twilio.ts:14` |
| Zoho (tile id `zoho`) | NEW-FRONTEND Settings tile | Backend key is `zoho-crm`; no id mapping; not a sign-in id. Tile never shows connected and cannot connect. | `NEW-FRONTEND/src/mocks/integrations.ts:19`, `connector_defs_wave_ab.sql:154` |
| "Meta Ads – Lead form sync" | NEW-FRONTEND tile blurb | Meta Ads module reads campaign insights only; no lead-form webhook or lead retrieval. | `NEW-FRONTEND/src/mocks/integrations.ts:12`, `services/workflows/src/tools/meta-ads.ts:5` |
| "HubSpot – Two-way contact sync" | NEW-FRONTEND tile blurb | No HubSpot webhook receiver and no sync job; only on-demand chat calls. | `NEW-FRONTEND/src/mocks/integrations.ts:14`; no `webhooks/hubspot` |
| "Razorpay – Revenue + churn signals" | NEW-FRONTEND tile blurb | Module creates payment links only; no revenue or churn read. | `NEW-FRONTEND/src/mocks/integrations.ts:13`, `razorpay.ts:6` |
| "Google Ads – Spend + lead source attribution" | NEW-FRONTEND tile blurb | Module reads last-7-day campaign metrics on a sunset API version; catalog marks it `catalog_only`. | `NEW-FRONTEND/src/mocks/integrations.ts:11`, `integrations-catalog.ts:152`, `google-ads.ts:45` |
| MLS | `AUTONOMOUS_TOOL_CATALOG` entry with `mcpName: 'mls_listings_search'` | No chat tool definition, executor is a permanent `notConnected` stub. | `tool-executor.ts:527`, `realestate/index.ts:802-808` |
| `nango.yaml` "every integration gets sync + webhook + MCP exposure" | `services/connectors/nango.yaml:13-17` | File is not loaded by Nango or code; no syncs or provider webhooks are deployed. | no reference to `nango.yaml` in code |
| Webhook events in catalog (`message_template_status_update`, `lead_created`, `event_created`, `message_received`, …) | `integrations-catalog.ts` `webhookEvents`, `connector_defs*.sql` `webhook_events` | Displayed on connector detail pages; no receivers exist for Salesforce, HubSpot, Microsoft, Zoho, Shopify, Stripe Connect (org) or WhatsApp template status. | e.g. `integrations-catalog.ts:93`, `connector_defs_wave_ab.sql:33`, `:56`, `:79` |
| Slack events endpoint `/api/webhooks/slack` | `integrations-credentials-runbook.md` row 6 | Only `/api/webhooks/slack/interactions` exists. | `apps/dashboard/app/api/webhooks/slack/` |
| "API quota used" stat | `GET /api/integrations` `stats.apiQuotaUsed` | Invented ratio of log rows to 1000. | `apps/dashboard/app/api/integrations/route.ts:227` |
| Legacy dashboard connector specs | `apps/dashboard/app/(dashboard)/connectors/[id]/page.tsx` `CONNECTOR_SPECS` | Static spec table for 7 connectors; the page is not the live UI (NEW-FRONTEND is). | `connectors.md` "What's broken" #2 |

## Backend-only orphans (tools exist, the product cannot connect them)

Tools are defined, appear in `chat-coverage.md`, and can be put on an employee allowlist, but no UI flow can create the credential. In each case `GET /api/integrations/nango-token?provider=<id>` returns 400 because the id is not in `CONNECTOR_SIGN_IN_IDS` (`packages/shared-types/src/connector-signin.ts:6-39`), and the BYOK path in `POST /api/integrations` only knows WhatsApp and Razorpay (`apps/dashboard/app/api/integrations/route.ts:282-294`).

| Orphan | Chat tools | How it could get credentials today | Risk while orphaned |
|---|---|---|---|
| Salesforce | 6 | Nango connection created by hand in the Nango UI with id `{orgId}_salesforce`; or env `SALESFORCE_INSTANCE_URL` plus a hand-made connection | None beyond confusion; tools return `notConnected`. |
| Zoho CRM | 6 | Hand-made Nango connection `{orgId}_zoho-crm` | Same. |
| DocuSign | 3 | Hand-made Nango connection | Same. |
| Leegality | 3 | Env `LEEGALITY_API_TOKEN` (platform-wide), or hand-written channel meta | Env token makes every org sign through the platform's Leegality account. |
| Twilio | 2 | Env `TWILIO_*` (platform-wide), or hand-written channel meta | Env fallback sends SMS for any org from the platform number. |
| Instagram | 2 | Hand-written `channels` row; env `META_ACCESS_TOKEN` fallback | Env fallback uses the platform's Meta token. |
| LinkedIn | 2 | Hand-made Nango connection | None (and the APIs used are not generally available). |
| Apollo | 2 | Hand-made Nango connection | None. |
| Google Maps | 2 | Env only (by design) | Platform pays for every org's geocoding; no per-org quota. |
| MLS | 0 | Nothing | Advertised in the internal catalog only. |

## Chat coverage gaps (module actions with no chat tool)

These actions are implemented in a module but have no `tool-definitions.ts` entry, so Ask AI cannot call them.

| Module | Action | File:line |
|---|---|---|
| Shopify | `update_order_address` | `services/workflows/src/tools/shopify.ts:5`, `:36-80` |
| Google Tasks | `tasks_create` | `google-tasks.ts:5`, `:49` |
| Google Forms | `forms_get_responses` | `google-forms.ts:5`, `:25` |
| HubSpot | `reassign_owner`, `sync_deal_schedule`, `list_contacts` | `hubspot.ts:5-15` |
| MLS | `listings_search` | `realestate/index.ts:803` |
| Microsoft Calendar | no update or cancel action exists at all | `microsoft-calendar.ts:13` |
| Chatwoot | no module at all | — |
| WhatsApp | template send does not exist | `whatsapp.ts:6` |

And the reverse: channels with inbound traffic but no chat tool to read or answer it: Chatwoot, SMS conversations via `messages` (only `twilio_list_messages`, which reads Twilio's API, not the stored inbox), Gmail inbox items stored by the webhook, and web widget threads.

## Human-only blockers (cannot be closed in code)

| Blocker | Unblocks | Where to set it | Check |
|---|---|---|---|
| `NEXT_PUBLIC_NANGO_PUBLIC_KEY` (+ `NANGO_SECRET_KEY` of the same environment) | Every OAuth connect | Dashboard env, rebuild | `GET /api/integrations` → `nango.publicKeyConfigured: true` |
| `NEXT_PUBLIC_NANGO_HOST` set to the public Nango URL | Popup in production (container DNS refused, `NEW-FRONTEND/src/lib/api/integrations.ts:156-160`) | Dashboard env | popup opens on the public host |
| Google OAuth client + Google app verification for restricted scopes (`mail.google.com`, `drive`) | Gmail and Drive beyond test users | Google Cloud Console → Nango `gmail`/`google` configs | `oauthConfigured` true, connect a non-test account |
| Google Ads developer token (Basic access) | Google Ads | env `GOOGLE_ADS_DEVELOPER_TOKEN` on worker and dashboard | runbook §3 |
| Google Business Profile API access approval | Business Profile | Google form, per Cloud project | `business_list_locations` returns accounts |
| Meta app review (`ads_read`, `instagram_manage_messages`, `whatsapp_business_messaging`) and business verification | Meta Ads, Instagram, WhatsApp at scale | developers.facebook.com | Graph calls return data for non-admin users |
| HubSpot, Stripe Connect, Notion, Slack, Shopify, Zendesk, Intercom, GitHub, QuickBooks, Microsoft Entra OAuth apps | Each provider | Provider console → Nango config with the catalog id as unique key | runbook §2 |
| Salesforce Connected App, Zoho, DocuSign, LinkedIn, Apollo apps | These five (after the code fixes in file 02) | Provider console → Nango | — |
| Licensed MLS feed | MLS | Contract | — |
| `NANGO_WEBHOOK_SECRET` and Nango webhook URL | Nango lifecycle events | env + Nango UI | Nango delivery log 2xx |
| Gmail Pub/Sub topic and `GMAIL_PUSH_TOKEN` | Gmail inbound (after the code fixes) | Google Cloud Pub/Sub + env | push reaches `/api/webhooks/gmail` |
| Twilio account per org (or a Twilio subaccount model) | SMS | Twilio console | — |

## Status roll-up

| Status | Count | Integrations |
|---|---|---|
| 🟢 | 6 | WhatsApp QR (Evolution), Google Sheets, Google Drive (read), web search, memory (Cognee/Hindsight), internal DB/metrics tools |
| 🟡 | 36 | WhatsApp Meta Cloud, owner WhatsApp, Chatwoot, widget, Gmail (outbound), Outlook, Microsoft Calendar, Google Calendar, Drive (write), Docs, Slides, Forms, Chat, Meet, Contacts, Tasks, Analytics, Search Console, Business Profile, Cloud, Meta Ads, HubSpot, Notion, Slack, Zendesk, Intercom, Stripe, Razorpay, QuickBooks, GitHub, Maps, RERA, Nango webhooks, Darex billing, web extract, sandbox |
| 🔴 | 13 | Gmail (inbound), Instagram, Twilio, Google Ads, Salesforce, Zoho CRM, Shopify (connect), DocuSign, Leegality, LinkedIn, Apollo, MLS, Zillow/Calls ghosts |

(Some integrations appear twice because inbound and outbound differ.)

## What "done" looks like for this matrix

A row can move to 🟢 when all of these hold, and the evidence is written into `BUILD_STATE.md` and the row's status cell in `chat-coverage.md`:

1. It can be connected from NEW-FRONTEND by an org admin, with no SQL and no Nango UI work beyond the one-time provider app registration.
2. One read and one write (or send) tool call succeed from `/ask-ai` against a real account, and a send parks for approval first.
3. A revoked or expired credential produces the `revoked` message, not `notConnected` and not a generic error.
4. If the integration has an inbound path, one real inbound event lands in `messages` for the right org.
5. A chat-initiated send appears in the inbox (`messages`) for that conversation.

## Identifier cross-reference

An integration only works end to end when its id agrees across seven places. Mismatches in this table are the root cause of several 🔴 rows.

Columns: **Sign-in** = in `CONNECTOR_SIGN_IN_IDS` (`packages/shared-types/src/connector-signin.ts:6-39`); **Catalog** = in static `INTEGRATION_CATALOG` (`apps/dashboard/lib/integrations-catalog.ts:71-645`); **SQL def** = in `infra/db/seeds/connector_defs*.sql`; **Alias** = in `NANGO_PROVIDER_ALIASES` (`services/connectors/src/providers.ts:40-72`); **Seeded Nango config** = created by `infra/scripts/seed-nango-configs.sql`; **Ping** = in `NANGO_PING_SPECS` (`providers.ts:135-169`); **Executor key** = provider key in `services/workflows/src/tools/index.ts:129-197`; **FE tile** = NEW-FRONTEND tile id (`NEW-FRONTEND/src/mocks/integrations.ts`).

| Integration | Sign-in | Catalog | SQL def | Alias | Seeded Nango config | Ping | Executor key | FE tile |
|---|---|---|---|---|---|---|---|---|
| WhatsApp | yes | yes (byok) | yes | yes | no (BYOK) | n/a | `whatsapp` | `whatsapp` |
| Gmail | yes | yes | yes | yes | updated if present | yes | `gmail` | `email` → `gmail` |
| Google Workspace (umbrella) | yes | yes | **no** | yes | `google` | yes | none (umbrella) | `google-workspace` |
| Google Calendar | yes | yes | yes | yes | yes | yes | `google-calendar` | `google-calendar` |
| Google Drive / Docs / Sheets / Slides | yes | yes | yes | yes | yes | yes | yes | yes |
| Google Forms / Chat / Meet / Contacts / Tasks | yes | yes | yes | yes | yes | yes | yes | no tile (appended from backend) |
| Google Analytics / Search Console / Business Profile / Cloud | yes | yes | yes | yes | yes | yes | yes | no tile |
| Google Ads | yes | yes (`catalog_only`) | yes | yes | yes | yes (v14) | `google-ads` | `google-ads` |
| Meta Ads | yes | yes | yes | yes | no | yes | `meta-ads` | `meta-ads` |
| HubSpot | yes | yes | yes | yes | no | yes | `hubspot` | `hubspot` |
| Stripe | yes | yes | yes | yes | no | yes | `stripe` | no tile |
| Notion | yes | yes | yes | yes | scopes only if config exists | yes | `notion` | no tile |
| Slack | yes | yes | yes | yes | no | yes | `slack` | `slack` (settings) |
| Shopify | yes | yes (needs shop domain) | yes | yes | no | yes (2024-01) | `shopify` | no tile |
| Zendesk | yes | yes (needs subdomain) | yes | yes | scopes only if config exists | yes | `zendesk` | no tile |
| Intercom | yes | yes | yes | yes | scopes only if config exists | yes | `intercom` | no tile |
| GitHub | yes | yes | yes | yes | no | yes | `github` | no tile |
| Razorpay | yes | yes (api_key) | yes | yes | no (BYOK) | n/a | `razorpay` | `razorpay` |
| QuickBooks | yes | yes | yes | **no** | no | exempt | `quickbooks` | no tile |
| Microsoft Outlook | yes | yes | yes | yes | no | yes | `microsoft-outlook` | `outlook` → `microsoft-outlook` |
| Microsoft Calendar | yes | yes | yes | yes | no | yes | `microsoft-calendar` | no tile |
| Salesforce | **no** | **no** | yes | no | no | **no** | `salesforce` | no tile |
| Zoho CRM | **no** | **no** | yes (`zoho-crm`) | no | no | **no** | `zoho` / `zoho-crm` | `zoho` (**unmapped**) |
| DocuSign | **no** | **no** | yes | no | no | **no** | `docusign` | no tile |
| Leegality | **no** | **no** | yes (byok) | no | no | **no** | `leegality` | no tile |
| Twilio | **no** | **no** | yes (byok) | no | no | **no** | `twilio` | `calls` → `twilio` |
| Google Maps | **no** | **no** | yes (`maps`, nango key `google-maps`) | no | no | n/a | `maps` | no tile |
| LinkedIn | **no** | **no** | yes | no | no | **no** | `linkedin` | no tile |
| Apollo | **no** | **no** | yes | no | no | **no** | `apollo` | no tile |
| Instagram | **no** | **no** | **no** | no | no | n/a | `instagram` | no tile |
| Zillow | no | no | no | no | no | no | **none** | `zillow` |

Two sources of truth for `connector_defs`: when the table is empty, `ensureConnectorDefsSeeded` fills it from the static catalog (31 rows, including `google-workspace`, excluding Salesforce and the other wave-B rows) (`apps/dashboard/lib/connector-registry.ts:420-431`). When `pnpm db:seed` ran first, the SQL seeds win (27 + 9 + 2 rows, no `google-workspace`). Which cards a deployment shows therefore depends on the order of first boot and seeding. The cards for Salesforce, Zoho, DocuSign, Leegality, Twilio, Maps, LinkedIn and Apollo appear only in the SQL-seeded case, and then their connect buttons fail as described above.

## Webhook receiver inventory

| Route | Provider | Auth check | Org resolution | Fires agent | Writes `messages` | Test | Status |
|---|---|---|---|---|---|---|---|
| `POST /api/webhooks/whatsapp` | Meta WhatsApp | `X-Hub-Signature-256` (`whatsapp/route.ts:1`) | channel meta phone number id | yes | yes | `whatsapp-inbound.test.ts` | 🟡 (no live Meta event) |
| `POST /api/webhooks/whatsapp-evolution` | Evolution | shared secret header (`whatsapp-evolution/route.ts:33`) | Evolution instance | yes | yes | evolution route test | 🟢 |
| `POST /api/webhooks/owner-whatsapp` | Meta (owner number) | `X-Hub-Signature-256` (`owner-whatsapp/route.ts:3`) | env owner phone | approvals | n/a | none | 🟡 |
| `POST /api/webhooks/instagram` | Meta Instagram | `X-Hub-Signature-256` (`instagram/route.ts:96`) | channel meta `ig_user_id` (never created) | yes | yes | none | 🔴 |
| `POST /api/webhooks/sms` | Twilio | `X-Twilio-Signature` (`sms/route.ts:18`) | channel meta `phone`/`from_number` (no UI creates it) | yes | yes | none | 🔴 |
| `POST /api/webhooks/gmail` | Gmail Pub/Sub | push token (`gmail/route.ts` `assertGmailPushToken`) | channel meta `email` (never written) | yes | yes | none | 🔴 |
| `POST /api/webhooks/google-calendar` | Google Calendar | channel token hash (`google-calendar/route.ts:92`) | `calendar_watches` row | no (updates showings) | no | none found | 🟡 |
| `POST /api/webhooks/google-calendar/google-calendar` | duplicate | same | same, minus `orgId` field | no | no | none | remove |
| `POST /api/webhooks/chatwoot` | Chatwoot | `x-chatwoot-signature` (`chatwoot/route.ts:203`) | conversation/channel | yes | yes | partial | 🟡 |
| `POST /api/webhooks/outbound` | inbox gateway | `x-chatwoot-signature` (`outbound/route.ts`) | conversation row | no | yes | partial | 🟡 |
| `POST /api/webhooks/slack/interactions` | Slack | signing secret (`slack/interactions/route.ts:18`) | decision card payload | approvals | no | `slack-interact.test.ts` | 🟡 |
| `POST /api/webhooks/nango` | Nango | `X-Nango-Signature` (`nango/route.ts:29`) | connection id prefix | no | no (log only) | none | 🟡 |
| `POST /api/webhooks/rent-payment` | Stripe / Razorpay (org) | HMAC (`rent-payment/route.ts:20-38`) | payment metadata | no | no | none found | 🟡 |
| `POST /api/webhooks/billing` | Stripe / Razorpay (Darex) | provider signature (`billing/route.ts:69`) | subscription metadata | no | no | billing tests | 🟡 |
| `POST /api/integrations/webhooks` | none (session-authenticated) | user session | session org | no | no | none | stub |

## Environment variables that act as credentials

Variables in this table are read by integration code. "Platform-wide fallback" means the value is used for any org that has no own credential, which crosses tenant boundaries.

| Variable | Read by | Platform-wide fallback? | Production guard |
|---|---|---|---|
| `NANGO_SECRET_KEY`, `NANGO_HOST` | `tools/shared.ts:8-9`, `lib/nango-server.ts:13-19` | n/a (infrastructure) | compose default secret at `infra/docker-compose.yml:261` |
| `NEXT_PUBLIC_NANGO_PUBLIC_KEY`, `NEXT_PUBLIC_NANGO_HOST` | `lib/nango-server.ts:17`, `integrations-catalog.ts:697` | n/a | none (empty allowed) |
| `META_ACCESS_TOKEN` | `channel-outbound.ts:107`, `:417`, `tools/instagram.ts:107` | **yes** | none |
| `WHATSAPP_PHONE_NUMBER_ID` | `channel-outbound.ts:105`, `tools/whatsapp.ts:162` | **yes** | none |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | `tools/twilio.ts:57-61`, `channel-outbound.ts:118-124`, `:321-335` | **yes** | none |
| `CHATWOOT_BASE_URL`, `CHATWOOT_API_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID` | `channel-outbound.ts:108-114` | **yes** | none |
| `LEEGALITY_API_TOKEN`, `LEEGALITY_PROFILE_ID` | `tools/leegality.ts:81-86` | **yes** | none |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | `tools/razorpay.ts:34-37` | yes in dev | `NODE_ENV !== 'production'` and `ALLOW_GLOBAL_RAZORPAY_DEV=true` |
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | `tools/google-ads.ts:18-19` | customer id **yes** | none |
| `META_AD_ACCOUNT_ID` | `tools/meta-ads.ts:19` | **yes** | none |
| `SHOPIFY_SHOP_DOMAIN`, `ZENDESK_SUBDOMAIN` | `tools/shopify.ts:21`, `tools/zendesk.ts:23` | **yes** | none |
| `SALESFORCE_INSTANCE_URL`, `ZOHO_API_DOMAIN`, `QUICKBOOKS_REALM_ID` | `tools/salesforce.ts:34`, `tools/zoho.ts:36`, `tools/quickbooks.ts:43` | **yes** (routes one org's token at another tenant's instance) | none |
| `GOOGLE_MAPS_API_KEY` | `tools/maps.ts:18` | yes (by design) | none |
| `JINA_API_KEY`, `SEARXNG_URL`, `CRAWL4AI_URL`, `CRAWL4AI_API_TOKEN` | `tools/search-providers.ts:77-99`, `tools/web-extract.ts:39-40` | yes (by design) | Crawl4AI token has a hardcoded default `darex-crawl4ai-token` (`web-extract.ts:40`) |
| `GMAIL_PUSH_TOKEN` | Gmail webhook | n/a | "Required in production" per `.env.example:136` |
| `VERIFY_TOKEN`, `INSTAGRAM_VERIFY_TOKEN`, `META_APP_SECRET` | Meta webhooks | n/a | — |

## Chat tool → provider endpoint map (external providers only)

Every chat tool that leaves the Darex network, with the provider endpoint it calls and the risk it gets. Internal tools (DB, metrics, ops, growth, customer, real estate, daily brief, memory, sandbox, files) are omitted; see `chat-coverage.md`. Paths are relative to `services/workflows/src/tools/`.

| Chat tool | Provider endpoint | Method | Risk | Code |
|---|---|---|---|---|
| `whatsapp_send` | `graph.facebook.com/v18.0/{phone_number_id}/messages`, or Evolution via gateway | POST | send | `whatsapp.ts:109-129`, `:166-182` |
| `whatsapp_list_messages` | Darex `messages` table | SQL | read | `whatsapp.ts:24-65` |
| `instagram_send` | `graph.facebook.com/v18.0/{ig_user_id}/messages` | POST | send | `instagram.ts:118` |
| `instagram_list_messages` | Darex `messages` table | SQL | read | `instagram.ts:40-74` |
| `twilio_send_sms` | `api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json` | POST | send | `twilio.ts:121` |
| `twilio_list_messages` | same, `PageSize` ≤ 50 | GET | read | `twilio.ts:87` |
| `gmail_fetch` / `gmail_triage` | `gmail.googleapis.com/gmail/v1/users/me/messages` (+ per-message metadata) | GET | read | `gmail.ts:30-45`, `:201` |
| `gmail_read_email` | `…/messages/{id}?format=full` | GET | read | `gmail.ts:131` |
| `gmail_extract_attachment` | `…/messages/{id}/attachments/{aid}` | GET | read | `gmail.ts:226` |
| `gmail_extract_otp` | message list + bodies | GET | read | `gmail.ts` |
| `gmail_draft_email` / `gmail_draft_reply` | `…/users/me/drafts` | POST | draft | `gmail.ts:492`, `:724` |
| `gmail_send` / `gmail_reply` | `…/users/me/messages/send` | POST | send | `gmail.ts:492`, `:794` |
| `outlook_list_messages` | `graph.microsoft.com/v1.0/me/messages?$search=…` | GET | read | `microsoft-outlook.ts:72` |
| `outlook_read_message` | `/me/messages/{id}` | GET | read | `microsoft-outlook.ts:60` |
| `outlook_draft_email` | `/me/messages` | POST | draft | `microsoft-outlook.ts:168` |
| `outlook_draft_reply` / `outlook_reply` | `/me/messages/{id}/createReply[All]` / `reply[All]` | POST | draft / send | `microsoft-outlook.ts:118` |
| `outlook_send` | `/me/sendMail` | POST | send | `microsoft-outlook.ts:189` |
| `outlook_calendar_list_events` / `_check_availability` | `/me/calendarView` | GET | read | `microsoft-calendar.ts:101`, `:128` |
| `outlook_calendar_create_event` | `/me/events` | POST | send | `microsoft-calendar.ts:173` |
| `calendar_list_events` / `calendar_check_availability` | `www.googleapis.com/calendar/v3/calendars/primary/events` | GET | read | `google-calendar.ts:71`, `:123` |
| `calendar_create_event` | `…/events?conferenceDataVersion=1&sendUpdates=all` | POST | send | `google-calendar.ts:285` |
| `calendar_update_event` | `…/events/{id}?sendUpdates=all` | PATCH | send | `google-calendar.ts:186` |
| `drive_search` / `drive_list` | `www.googleapis.com/drive/v3/files?q=…` | GET | read | `google-drive.ts:280`, `:375` |
| `drive_get_text` | `drive/v3/files/{id}` (+ export / media) | GET | read | `google-drive.ts:494-582` |
| `drive_create_folder` | `drive/v3/files` | POST | draft | `google-drive.ts:437` |
| `drive_upload` | `upload/drive/v3/files?uploadType=multipart` | POST | draft | `google-drive.ts:660` |
| `drive_share` | `drive/v3/files/{id}/permissions` | POST | publish | `google-drive.ts` share branch |
| `docs_create` / `docs_read` / `docs_append` | `docs.googleapis.com/v1/documents[/{id}[:batchUpdate]]` | POST / GET | draft / read | `google-docs.ts:110`, `:178`, `:213`, `:247` |
| `sheets_create` / `sheets_read` / `sheets_append_row` | `sheets.googleapis.com/v4/spreadsheets…` | POST / GET | draft / read | `google-sheets.ts:74`, `:143`, `:173` |
| `slides_*` | `slides.googleapis.com/v1/presentations…` | POST / GET | draft / read / delete | `google-slides.ts:231-570` |
| `forms_get` | `forms.googleapis.com/v1/forms/{id}` | GET | read | `google-forms.ts:42` |
| `chat_list_spaces` / `chat_send_message` | `chat.googleapis.com/v1/spaces[/{space}/messages]` | GET / POST | read / send | `google-chat.ts:26`, `:35` |
| `meet_create_space` / `meet_get_space` | `meet.googleapis.com/v2/spaces` | POST / GET | draft / read | `google-meet.ts:24`, `:31` |
| `contacts_list` | `people.googleapis.com/v1/people/me/connections` | GET | read | `google-contacts.ts:19` |
| `tasks_list` | `tasks.googleapis.com/tasks/v1/users/@me/lists`, `/lists/{id}/tasks` | GET | read | `google-tasks.ts:21`, `:68` |
| `analytics_report` | `analyticsdata.googleapis.com/v1beta/properties/{id}:runReport` | POST | read | `google-analytics.ts:29` |
| `search_console_sites` / `_query` | `www.googleapis.com/webmasters/v3/sites[/{site}/searchAnalytics/query]` | GET / POST | read | `google-search-console.ts:25`, `:36` |
| `business_list_locations` | `mybusinessaccountmanagement…/v1/accounts`, `mybusinessbusinessinformation…/locations` | GET | read | `google-business-profile.ts:19`, `:31` |
| `cloud_list_projects` | `cloudresourcemanager.googleapis.com/v1/projects` | GET | read | `google-cloud.ts:19` |
| `google_ads_metrics` | `googleads.googleapis.com/v14/customers/{id}/googleAds:search` | POST | read | `google-ads.ts:45` |
| `meta_ads_metrics` | `graph.facebook.com/v18.0/{adAccountId}/insights` | GET | read | `meta-ads.ts:26` |
| `hubspot_*` | `api.hubapi.com/crm/v3/objects/{contacts,deals,notes}[/search]`, `/crm/v3/owners` | GET / POST / PATCH | read / draft | `hubspot.ts:38-474` |
| `salesforce_*` | `{instance}/services/data/v59.0/{query,sobjects/…}` | GET / POST / PATCH | read / draft | `salesforce.ts:71-199` |
| `zoho_*` | `{api_domain}/crm/v*/{Deals,Leads,Contacts}` | GET / POST / PUT | read / draft | `zoho.ts:65-212` |
| `notion_*` | `api.notion.com/v1/{search,pages,blocks,databases}` | GET / POST / PATCH | read / draft | `notion.ts:89-319` |
| `slack_list_channels` / `slack_read_channel` / `slack_read_thread` | `slack.com/api/conversations.{list,history,replies}` | GET | read | `slack.ts:53`, `:88`, `:122` |
| `slack_send` / `slack_reply_thread` / `slack_post_decision_card` | `slack.com/api/chat.postMessage` | POST | send | `slack.ts:102`, `:153`, `:213` |
| `zendesk_*` | `{subdomain}.zendesk.com/api/v2/tickets[/{id}].json` | GET / POST / PUT | read / draft | `zendesk.ts:44-81` |
| `intercom_*` | `api.intercom.io/{me,conversations[/{id}/reply]}` | GET / POST | read / send | `intercom.ts:33-72` |
| `shopify_fetch_products` / `shopify_fetch_orders` | `{shop}/admin/api/2024-01/{products,orders}.json` | GET | read | `shopify.ts:86`, `:102` |
| `stripe_*` | `api.stripe.com/v1/{payment_links,customers,payment_intents,refunds,charges}` | GET / POST | read / draft / pay | `stripe.ts:55-171` |
| `razorpay_create_payment_link` | `api.razorpay.com/v1/payment_links` | POST | pay | `razorpay.ts:51` |
| `quickbooks_*` | `{quickbooks.api,sandbox-quickbooks.api}.intuit.com/v3/company/{realm}/{query,customer}` | GET / POST | read / draft | `quickbooks.ts:66`, `:132` |
| `docusign_*` | `{base_uri}/restapi/v2.1/accounts/{id}/envelopes` | GET / POST / PUT | read / draft / sign | `docusign.ts:102-141` |
| `leegality_*` | `{LEEGALITY_API_BASE_URL}/v3.0/sign/request[/list]` | GET / POST | read / sign | `leegality.ts:155`, `:198` |
| `github_*` | `api.github.com/{user,user/repos,repos/{r}/issues}` | GET / POST | read / publish / send | `github.ts:36-106` |
| `linkedin_*` | `api.linkedin.com/v2/{organizationAcls,peopleTypeahead}` | GET | read | `linkedin.ts:47`, `:72` |
| `apollo_*` | `api.apollo.io/api/v1/{mixed_people/search,organizations/enrich}` | POST | read | `apollo.ts:49`, `:75` |
| `maps_geocode` / `maps_reverse_geocode` | `maps.googleapis.com/maps/api/geocode/json` | GET | read | `maps.ts:11` |
| `rera_lookup` | `RERA_LOOKUP_URL` or state RERA site | GET | read | `public/rera.ts:23-30`, `:85` |
| `web_search` | Jina `s.jina.ai`, SearXNG, DuckDuckGo HTML, Wikipedia, Google News RSS | GET | read | `search-providers.ts:77-189` |
| `web_extract` | Crawl4AI, then `r.jina.ai` | POST / GET | read | `web-extract.ts:39-136` |

## Module size and last change

Last commit that touched each provider module (`git log -1`, run 2026-10-09). Modules untouched since mid-August (Twilio, Microsoft Calendar, QuickBooks, DocuSign, Leegality, Maps) predate the honesty, abort-signal and idempotency work and are the least exercised.

| Module | Lines | Last change | Commit |
|---|---|---|---|
| `whatsapp.ts` | 245 | 2026-10-06 | 15201583 feat(connectors): read and reply on Outlook, Slack and WhatsApp from As |
| `instagram.ts` | 149 | 2026-10-09 | e0e32f14 feat(connectors): read and reply to Instagram DMs from Ask AI |
| `twilio.ts` | 147 | 2026-08-14 | 73b0451d fix: resolve stats endpoint syntax errors (#3) |
| `gmail.ts` | 853 | 2026-10-06 | 3c82f4a9 feat(connectors): reply-all to Gmail threads from Ask AI |
| `microsoft-outlook.ts` | 215 | 2026-10-06 | 15201583 feat(connectors): read and reply on Outlook, Slack and WhatsApp from As |
| `microsoft-calendar.ts` | 206 | 2026-08-14 | 73b0451d fix: resolve stats endpoint syntax errors (#3) |
| `google-calendar.ts` | 344 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `google-drive.ts` | 720 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `google-docs.ts` | 290 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `google-sheets.ts` | 211 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `google-slides.ts` | 632 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `google-forms.ts` | 68 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `google-chat.ts` | 52 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `google-meet.ts` | 50 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `google-contacts.ts` | 45 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `google-tasks.ts` | 94 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `google-analytics.ts` | 59 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `google-search-console.ts` | 53 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `google-business-profile.ts` | 55 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `google-cloud.ts` | 43 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `google-ads.ts` | 82 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `meta-ads.ts` | 53 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `hubspot.ts` | 517 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `salesforce.ts` | 246 | 2026-09-27 | 516adc92 feat(ask-ai): growth/sales hand-offs and SF/Zoho deal tools |
| `zoho.ts` | 272 | 2026-09-27 | 516adc92 feat(ask-ai): growth/sales hand-offs and SF/Zoho deal tools |
| `notion.ts` | 363 | 2026-10-05 | 6573beb2 chore(infra): merge vm-backup-2026-10-05 into main |
| `slack.ts` | 249 | 2026-10-06 | 15201583 feat(connectors): read and reply on Outlook, Slack and WhatsApp from As |
| `zendesk.ts` | 111 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `intercom.ts` | 96 | 2026-09-20 | d48a8592 feat(tools): enhance connector tools with scope verification, folder re |
| `shopify.ts` | 132 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `stripe.ts` | 203 | 2026-10-05 | afa9a6b3 fix(tools): send an idempotency key with stripe writes |
| `razorpay.ts` | 84 | 2026-10-05 | a53804ad fix(connectors): store razorpay key secrets encrypted |
| `quickbooks.ts` | 181 | 2026-08-14 | 73b0451d fix: resolve stats endpoint syntax errors (#3) |
| `docusign.ts` | 181 | 2026-08-14 | 73b0451d fix: resolve stats endpoint syntax errors (#3) |
| `leegality.ts` | 242 | 2026-08-14 | 73b0451d fix: resolve stats endpoint syntax errors (#3) |
| `github.ts` | 137 | 2026-09-28 | 9bbefd7d fix(tools): abort provider requests when the executor deadline passes |
| `linkedin.ts` | 101 | 2026-09-20 | 8f8fee07 feat(connectors): role-scope tools, slack HITL, and memory write-back |
| `apollo.ts` | 106 | 2026-09-20 | 8f8fee07 feat(connectors): role-scope tools, slack HITL, and memory write-back |
| `maps.ts` | 123 | 2026-08-14 | 73b0451d fix: resolve stats endpoint syntax errors (#3) |

## Live verification checklist (to move a row to 🟢)

Run each from `/ask-ai` on a deployed stack, signed in as an org admin, after connecting the integration from NEW-FRONTEND. Record the outcome in `BUILD_STATE.md` and set the matching `chat-coverage.md` status cells. "Park" means the call must stop at an approval card before anything is sent.

| Integration | Read prompt and expected result | Write / send prompt and expected result | Revocation check | Inbound check |
|---|---|---|---|---|
| WhatsApp (Meta) | "Show my last 5 WhatsApp messages" → rows from `messages` | "Reply 'test' to +<number>" → park → approve → wamid returned, message in inbox | Rotate the system-user token → send returns "token cannot be read" or Graph 401 text | Text the number → conversation row + auto-reply |
| WhatsApp (QR) | same | same, `provider: 'evolution'` in result | Unlink phone → send error from gateway | same |
| Instagram | "List my Instagram DMs" | "Reply to <IGSID>" within 24 h → park → approve → `message_id` | Expire page token → Graph 190 surfaced | DM the account → conversation row; reply from the app must not echo |
| Twilio SMS | "List my last SMS" | "Text <number> 'test'" → park → SID | Wrong auth token → 401 shown as revoked | SMS the number → conversation row |
| Gmail | "What are my unread emails?" | "Reply to <thread> saying thanks" → park → threaded reply in Gmail Sent | Revoke Darex in Google account → "revoked" message | Send mail to the box → Pub/Sub push → conversation row |
| Outlook | "Search my Outlook for 'invoice'" | "Reply all to <id>" → park → reply in Sent Items | Revoke consent in Entra → revoked | (none until inbound exists) |
| Microsoft Calendar | "What's on my Outlook calendar tomorrow?" | "Book 30 min with x@y.com Friday 3pm" → park → event | revoke → revoked | — |
| Google Calendar | "Am I free Thursday 2-4pm?" | "Schedule a call with x@y.com" → park → event with Meet link | revoke → revoked | Edit a watched event → showing updated |
| Drive / Docs / Sheets / Slides | "Find the Q3 deck in Drive" | "Create a sheet named Test and add a row" → link returned (no park: draft) | revoke → revoked | — |
| Forms / Chat / Meet / Contacts / Tasks | one read each | `chat_send_message` parks | revoke → revoked | — |
| Analytics / Search Console / Business Profile / Cloud | one report each | — | missing scope → clear scope error, not "not connected" | — |
| Google Ads | "Google Ads spend last 7 days" → campaign rows | — | missing developer token → explicit message | — |
| Meta Ads | "Meta Ads performance last week" | — | expired token → revoked, not "not connected" | — |
| HubSpot | "Find contact jane@acme.com" | "Create a deal for Acme, 5000" → executes (draft class today; after fix 02 it should park) | revoke → revoked | — |
| Salesforce / Zoho | (after connect fix) "List my open deals" | "Create a lead" | revoke → revoked | — |
| Notion | "Search Notion for onboarding" | "Create a page 'Test' under <parent>" | revoke → revoked | — |
| Slack | "What was said in #general today?" | "Post 'test' in #general" → park | remove app → `invalid_auth` shown as revoked | (none until Events API exists) |
| Zendesk / Intercom | "Show my open tickets / conversations" | "Reply to conversation <id>" → park | revoke → revoked | — |
| Shopify | "Show open orders" | — | uninstall app → revoked | — |
| Stripe | "Find customer x@y.com" | "Create a payment link for 10 USD" → park → URL | revoke → revoked | — |
| Razorpay | — | "Payment link for ₹100" → park → short URL | wrong key → 401 surfaced | Pay the link → `rent-payment` webhook row |
| QuickBooks | "List unpaid invoices" | "Create customer Acme" | revoke → revoked | — |
| DocuSign / Leegality | "List envelopes / documents" | "Send envelope <id>" → park | revoke → revoked | — |
| GitHub | "List my repos" | "Open an issue in <repo>" → park | revoke → revoked | — |
| Maps | "Geocode 221B Baker Street" | — | bad key → explicit error | — |
