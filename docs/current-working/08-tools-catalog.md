# 08 — Tools catalog

Source: `services/workflows/src/tool-executor.ts` + `mcp-bridge.ts`.

Status values: `'executed' | 'simulated' | 'error'`. **`simulated` is never
returned.** Missing OAuth → `notConnected()` → `status: 'error'`,
`connected: false`, `setupUrl: '/connectors'`.

Allowlist: caller list **or** union of all active `ai_employees.tool_allowlist`
+ connected `channels` + always-allowed core tools. Matching is case-insensitive
and treats `_` / `-` as equal.

---

## Core (no OAuth — always allowed)

| Aliases | Actions | Live? | Needs |
|---------|---------|-------|-------|
| `sandbox`, `code_execution`, `execute_code` | execute python/node/bash | **If sandbox image exists** | `SANDBOX_API_URL` |
| `web_search`, `search`, `google_search` | search | Yes | `JINA_API_KEY` (Bearer) |
| `web_extract`, `fetch_url`, `read_url` | extract | Yes | Jina `r.jina.ai` |
| `database_query`, `db_query`, `sql_analytics` | query | Yes | RLS SELECT/WITH, max 25 rows |
| `file_ops`, `file_system`, `workspace_file` | read_file, write_file | Yes | `workspace_storage/{orgId}/` basename-only |

Sandbox is on MCP as `code_execution`. Plan execute and `POST /api/agent/tools`
can still call it. Compose service exists; `infra/docker/sandbox/` is in the tree.

---

## Gmail — MCP: fetch, send, triage, extract_otp, extract_attachment, draft_email

Real Gmail API via Nango (`gmail` / `google-mail` / `google`). Draft/send need
`gmail.compose`. Re-connect if the token is old.

---

## Google Calendar — MCP: list_events, create_event, check_availability

Real Calendar API. Availability computes free/busy slots. Create can add Meet.

---

## GitHub — MCP: fetch_repos, create_repo, create_issue

Real GitHub API via Nango.

---

## WhatsApp — MCP: `whatsapp_send`

Meta Graph v18. Token from `channels.meta`, legacy `manual_json:`, Nango, or
`WHATSAPP_PHONE_NUMBER_ID`. Outbound currently 401 on expired env token.

---

## HubSpot — MCP: create_contact, update_contact

CRM v3. Needs real HubSpot OAuth client in Nango.

---

## Ads

| Tool | MCP | Extra |
|------|-----|-------|
| `meta-ads` `fetch_campaign_metrics` | `meta_ads_metrics` | `adAccountId` or `META_AD_ACCOUNT_ID` |
| `google-ads` `fetch_campaign_metrics` | `google_ads_metrics` | `customerId` + `GOOGLE_ADS_DEVELOPER_TOKEN` |

---

## Slack / Notion / Stripe / Shopify / Zendesk / Intercom

All real APIs when Nango is connected. Extra ids:

- Shopify: `shopDomain`
- Zendesk: `subdomain`
- Stripe: payment link on MCP; customer create/get **also** on MCP
- Intercom: fetch **and** reply/create (`intercom_reply`, `intercom_create_conversation`)

Need real OAuth client IDs in Nango UI before connect popups complete.

---

## Razorpay — MCP: `razorpay_create_payment_link`

Uses **per-org** `channels.meta` keys first, then env
`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`, then `notConnected`.

---

## Google Drive / Docs / Sheets / Slides / Forms / Contacts / Tasks

| Tool | MCP actions | Live? |
|------|-------------|-------|
| google-drive | search, list, get_text, upload, share | Yes if connected |
| google-docs | create, read, append | Yes (docs_create live-verified) |
| google-sheets | create, read, append_row | Yes (sheets_create live-verified) |
| google-slides | slides_create | Yes if connected |
| google-forms | forms_get | Yes if connected |
| google-contacts | contacts_list | Yes if connected |
| google-tasks | tasks_list (lists only) | Yes if connected |

---

## Google Chat / Meet / Analytics / Search Console / Business / Cloud

Executors are **real HTTP** (Nango token or `notConnected`). MCP names:
`chat_list_spaces`, `chat_send_message`, `meet_create_space`, `meet_get_space`,
`analytics_report`, `search_console_sites`, `search_console_query`,
`business_list_locations`, `cloud_list_projects`.

The `/integrations` catalog marks these **live**. Google Cloud uses the same
Nango Google OAuth popup as the other Google apps (`cloud-platform` scope).

Unknown tool → `"Unknown tool — no executor registered"`.

---

## MCP name → executor (62)

`whatsapp_send`, `gmail_fetch`, `gmail_send`, `gmail_triage`, `gmail_extract_otp`,
`gmail_extract_attachment`, `gmail_draft_email`, `calendar_list_events`,
`calendar_create_event`, `calendar_check_availability`, `github_fetch_repos`,
`github_create_repo`, `github_create_issue`, `hubspot_create_contact`,
`hubspot_update_contact`, `meta_ads_metrics`, `google_ads_metrics`,
`slack_send`, `notion_create_page`, `notion_append_page_content`,
`notion_search`, `stripe_create_payment_link`, `shopify_fetch_products`,
`shopify_fetch_orders`, `zendesk_fetch_tickets`, `zendesk_create_ticket`,
`zendesk_update_ticket`, `intercom_fetch_conversations`,
`razorpay_create_payment_link`, `web_search`, `web_extract`, `database_query`,
`file_ops`, `drive_search`, `drive_list`, `drive_get_text`, `drive_upload`,
`drive_share`, `docs_create`, `docs_read`, `docs_append`, `sheets_create`,
`sheets_read`, `sheets_append_row`, `slides_create`, `forms_get`,
`contacts_list`, `tasks_list`, `code_execution`, `stripe_create_customer`,
`stripe_get_customer`, `intercom_reply`, `intercom_create_conversation`,
`chat_list_spaces`, `chat_send_message`, `meet_create_space`, `meet_get_space`,
`search_console_sites`, `search_console_query`, `business_list_locations`,
`cloud_list_projects`, `analytics_report`.

atomic-agent prefixes them `mcp.darex.*`.

---

## Connectors package vs executor

`@darex/connectors` covers 7 thin Nango-proxy helpers. Used only by
`/api/integrations/test`. Agent path does not import it. `nango.yaml` lists
more providers than the executor implements.
