---
name: nango-integrations-playbook
description: "Master playbook for all DarexAI Nango-connected integrations (Google Workspace & Cloud, Meta, HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, GitHub, Razorpay). Use when the user requests operations on any connected software or cloud provider."
version: 1.0.0
requires_tools:
  - mcp.darex.whatsapp_send
  - mcp.darex.gmail_fetch
  - mcp.darex.gmail_send
  - mcp.darex.gmail_draft_email
  - mcp.darex.calendar_list_events
  - mcp.darex.calendar_create_event
  - mcp.darex.drive_search
  - mcp.darex.drive_get_text
  - mcp.darex.docs_create
  - mcp.darex.docs_read
  - mcp.darex.sheets_read
  - mcp.darex.sheets_append_row
  - mcp.darex.github_fetch_repos
  - mcp.darex.github_create_issue
  - mcp.darex.hubspot_create_contact
  - mcp.darex.hubspot_update_contact
  - mcp.darex.meta_ads_metrics
  - mcp.darex.google_ads_metrics
  - mcp.darex.slack_send
  - mcp.darex.notion_create_page
  - mcp.darex.notion_search
  - mcp.darex.stripe_create_payment_link
  - mcp.darex.shopify_fetch_products
  - mcp.darex.shopify_fetch_orders
  - mcp.darex.zendesk_fetch_tickets
  - mcp.darex.zendesk_create_ticket
  - mcp.darex.intercom_fetch_conversations
  - mcp.darex.razorpay_create_payment_link
dangerous: false
---

# Nango Integrations Playbook

The DarexAI Organization Brain connects 28+ business tools & cloud services via Nango OAuth2 and API integrations.

## Connector Categories & Tools

### 1. Google Ecosystem
- **Gmail**: `gmail_fetch`, `gmail_send`, `gmail_draft_email`, `gmail_triage`, `gmail_extract_otp`
- **Google Calendar**: `calendar_list_events`, `calendar_create_event`, `calendar_check_availability`
- **Google Drive**: `drive_search`, `drive_list`, `drive_get_text`, `drive_upload`, `drive_share`
- **Google Docs**: `docs_create`, `docs_read`, `docs_append`
- **Google Sheets**: `sheets_create`, `sheets_read`, `sheets_append_row`
- **Google Ads**: `google_ads_metrics`

### 2. CRM & Sales
- **HubSpot**: `hubspot_create_contact`, `hubspot_update_contact`

### 3. Advertising & Marketing
- **Meta Ads**: `meta_ads_metrics`

### 4. Payments & Billing
- **Stripe**: `stripe_create_payment_link`
- **Razorpay**: `razorpay_create_payment_link`

### 5. Messaging & Collaboration
- **WhatsApp**: `whatsapp_send`
- **Slack**: `slack_send`

### 6. Knowledge & Productivity
- **Notion**: `notion_create_page`, `notion_append_page_content`, `notion_search`

### 7. Support & Ticketing
- **Zendesk**: `zendesk_fetch_tickets`, `zendesk_create_ticket`, `zendesk_update_ticket`
- **Intercom**: `intercom_fetch_conversations`

### 8. E-Commerce & Dev
- **Shopify**: `shopify_fetch_products`, `shopify_fetch_orders`
- **GitHub**: `github_fetch_repos`, `github_create_repo`, `github_create_issue`

## Execution Guidelines
1. Always pass `org_id` as retrieved from your authoritative system context.
2. Never hardcode credentials, secrets, tokens, or static org IDs.
3. Handle "simulated" or "not connected" responses by informing the user that authorization via Nango at `/connectors` is needed.
