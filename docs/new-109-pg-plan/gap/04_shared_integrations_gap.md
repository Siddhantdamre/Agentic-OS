# 04 — Shared Integrations & DareXAI Connect: Comprehensive Technical Gap Analysis

> **Blueprint Target:** Tab 4 (Pages 99–106)  
> **Core Mandate:** *“Connect your business once through DareXAI Connect. Integrations are not the product; they provide shared context to the employee.”*  
> **Current Status Score:** 🟢 6 Built (37.5%) | 🟡 6 Partial (37.5%) | 🔴 4 Missing (25.0%)

---

## 1. Executive Summary & Core Architectural Premise

The blueprint establishes a vital architectural principle that prevents DareXAI from degenerating into a fragile automation builder:
- **Automation Platform Failure (Zapier / Make):** The user connects HubSpot three times, sets up 15 separate triggers, builds brittle multi-step canvases, and manually configures field mappings.
- **DareXAI Connect Model:** The customer connects HubSpot, Gmail, WhatsApp, and Google Calendar **a single time** at the organization level.
- **The Role-Scoped Context Layer:** Once connected, each AI Employee interacts with the integration according to its distinct operational role:
  - **Growth Employee:** Queries HubSpot for unassigned accounts, researches company details, prepares cold outreach, updates lead stages.
  - **Customer Employee:** Queries HubSpot for customer ticket history, lifetime value, and past complaints; updates contact notes upon resolving an inquiry.
  - **Operations Employee:** Audits HubSpot records for missing mandatory fields, identifies unassigned enterprise leads, detects stalled deals.

---

## 2. Granular Tier 1 & Tier 2 Integration Audit

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         INTEGRATION READINESS AUDIT                         │
 ├────┬─────────────────────────────┬──────────┬────────┬──────────────────────┤
 │ #  │ Integration Name            │ Priority │ Status │ Codebase State       │
 ├────┼─────────────────────────────┼──────────┼────────┼──────────────────────┤
 │ 1  │ Gmail                       │ 🔴 Must  │ 🟢 LIVE│ Nango OAuth + tools  │
 │ 2  │ Outlook / Microsoft 365     │ 🔴 Must  │ 🟡 PART│ Graph API scaffolded │
 │ 3  │ Google Calendar             │ 🔴 Must  │ 🟢 LIVE│ Event creation live  │
 │ 4  │ WhatsApp Business           │ 🔴 Must  │ 🟢 LIVE│ Cloud API decoupled  │
 │ 5  │ HubSpot CRM                 │ 🔴 Must  │ 🟢 LIVE│ Contacts/deals live  │
 │ 6  │ Zoho CRM                    │ 🔴 Must  │ 🟢 LIVE│ C6 wave executor live│
 │ 7  │ Google Drive                │ 🔴 Must  │ 🟢 LIVE│ drive_list verified  │
 │ 8  │ Google Sheets               │ 🔴 Must  │ 🟢 LIVE│ sheets_create live   │
 │ 9  │ Website / Web Forms         │ 🔴 Must  │ 🟢 LIVE│ /embed/widget.js live│
 │ 10 │ Slack                       │ 🟠 Imprt │ 🟡 PART│ Message sending live │
 ├────┼─────────────────────────────┼──────────┼────────┼──────────────────────┤
 │ 11 │ Microsoft Calendar          │ 🟠 Imprt │ 🟡 PART│ Graph API stubbed    │
 │ 12 │ Microsoft Teams             │ 🟠 Imprt │ 🟡 PART│ Webhook stubbed      │
 │ 13 │ Meta / Facebook Ads & Leads │ 🟡 Tier2 │ 🟡 PART│ Ad signals live      │
 │ 14 │ Google Ads                  │ 🟡 Tier2 │ 🟢 LIVE│ Nango OAuth live     │
 │ 15 │ LinkedIn Signals & Prospect │ 🟡 Tier2 │ 🔴 GAP │ No integration       │
 │ 16 │ Apollo.io Discovery         │ 🟡 Tier2 │ 🟡 PART│ Executor built       │
 │ 17 │ Zendesk / Intercom / Fresh. │ 🟡 Tier2 │ 🟡 PART│ Seeded in Nango      │
 │ 18 │ Notion Knowledge Base       │ 🟡 Tier2 │ 🟡 PART│ Nango config seeded  │
 │ 19 │ Jira / Asana / ClickUp      │ 🟡 Tier2 │ 🟡 PART│ Task tools stubbed   │
 │ 20 │ Shopify / Commerce Orders   │ 🟡 Tier2 │ 🟡 PART│ Connector scaffolded │
 └────┴─────────────────────────────┴──────────┴────────┴──────────────────────┘
```

---

## 3. The Core Architectural Gap: Role-Scoped Connector Permissions

### The Problem in Current Code
In `services/workflows/src/tool-executor.ts`, the function `resolveOrgToolAllowlist()` currently executes the following logic:
1. It queries `ai_employees` for active employees.
2. It returns the **union of ALL active employees' tool allowlists** PLUS all always-allowed core tools.
3. It further unions **every single connector the organization has connected** in the `channels` table.

### Why This Violates the Blueprint
- If an organization connects HubSpot, **every single agent gets full write/delete access to HubSpot**.
- Under this architecture, the Customer Employee could accidentally delete an entire sales pipeline, or the Operations Employee could blast marketing outreach emails to customer contacts.
- **Blueprint Rule:** The connection is unified, but the **tool exposure must be strictly role-scoped per employee persona**:

```text
                        CONNECT HUBSPOT ONCE
                                 │
         ┌───────────────────────┼───────────────────────┐
         ↓                       ↓                       ↓
  GROWTH EMPLOYEE         CUSTOMER EMPLOYEE       OPERATIONS EMPLOYEE
         ↓                       ↓                       ↓
  Allowed Tools:          Allowed Tools:          Allowed Tools:
  - hubspot_search_leads  - hubspot_get_contact   - hubspot_audit_fields
  - hubspot_update_stage  - hubspot_list_tickets  - hubspot_flag_duplicate
  - hubspot_draft_note    - hubspot_create_ticket - hubspot_reassign_owner
  Restricted:             Restricted:             Restricted:
  - Cannot delete contacts- Cannot modify deals   - Cannot send cold emails
```

### Required Implementation
Refactor `resolveOrgToolAllowlist(orgId, employeeRole)` in `tool-executor.ts` to accept the `employeeRole` and filter permitted MCP tool descriptors against a deterministic role-capability matrix.

---

## 4. Deep Technical Status: Tier 1 Core Integrations

### 1. Gmail (🟢 LIVE)
- **Implementation:** Nango integration `google-mail` via OAuth 2.0.
- **Tools:** `gmail_send_email`, `gmail_draft_email`, `gmail_read_thread`, `gmail_search`.
- **Note:** Recently updated with scopes: `gmail.send gmail.readonly gmail.compose gmail.modify` to support real draft creation.

### 2. Outlook / Microsoft 365 (🟡 PARTIAL)
- **Implementation:** Microsoft Graph API client in `services/connectors`.
- **Status:** Scaffolding complete; pending live Azure AD enterprise app registration and multi-tenant consent testing.

### 3. Google Calendar (🟢 LIVE)
- **Implementation:** Nango integration `google-calendar`.
- **Tools:** `calendar_create_event`, `calendar_list_events`, `calendar_check_availability`.
- **Status:** Fully functional and used in real estate showing schedules.

### 4. WhatsApp Business (🟢 LIVE)
- **Implementation:** Meta Cloud API with webhook ingress at `apps/dashboard/app/api/webhooks/whatsapp/route.ts`.
- **Status:** Sub-3s acknowledgment, signature verification via `X-Hub-Signature-256`, and asynchronous worker execution.

### 5. HubSpot CRM (🟢 LIVE)
- **Implementation:** Nango integration `hubspot`.
- **Tools:** `hubspot_search_contacts`, `hubspot_create_deal`, `hubspot_update_contact`.
- **Status:** Active in `tool-executor.ts`.

### 6. Zoho CRM (🟢 LIVE)
- **Implementation:** Built in C6 wave (`services/workflows/src/tools/zoho.ts`).
- **Tools:** `mcp.darex.zoho_search_records`, `zoho_create_lead`, `zoho_update_record`.
- **Status:** Full honesty implementation (disconnected returns `connected:false` + `/connectors` URL).

### 7. Google Drive & Google Sheets (🟢 LIVE)
- **Implementation:** Nango OAuth.
- **Tools:** `drive_list` (retrieves real Drive files), `sheets_create`, `sheets_append_row`.
- **Status:** Live and verified in `apps/dashboard/app/api/integrations/test/`.

### 8. Website / Web Forms Embed (🟢 LIVE)
- **Implementation:** Custom script `apps/dashboard/public/embed/widget.js`.
- **Status:** Embedded on customer sites, validates site key hash, ingests visitor chat sessions, and triggers background agents.

### 9. Slack (🟡 PARTIAL)
- **Implementation:** Slack bot token configuration in `channels` table.
- **Tools:** `slack_post_message`, `slack_read_channel`.
- **The Gap:** Missing interactive Slack Block Kit buttons (`[Approve] / [Reject]`) allowing managers to resolve `work_items` directly within Slack.

---

## 5. Token Lifecycle, Rate Limiting & Nango Management

- **OAuth Refresh Mechanism (🟢 LIVE):** Nango server runs in Docker (`infra/docker-compose.yml`), managing token refreshes automatically before expiration.
- **Rate Limit Resilience (🟡 PARTIAL):**
  - External APIs enforce strict rate limits (HubSpot: 100 req / 10s; Google Calendar: 500 req / 100s).
  - Currently, if an Operations Employee runs a batch sweep across 100 contacts, it can trigger `429 Too Many Requests`.
  - **Required Implementation:** Implement token bucket rate limiter in `services/workflows/src/tool-executor.ts` with exponential backoff on HTTP 429.

---

## 6. Shared Integrations Gap Summary

To achieve 100% parity with Tab 4 of the Blueprint, DareXAI must build:
1. **Role-Scoped Capability Gate:** Filter shared connector tools per employee persona in `tool-executor.ts`.
2. **Interactive Decision Slack Cards:** Block Kit integration for 1-click approvals.
3. **LinkedIn & Apollo Firmographic Feed:** Ingestion for hiring, funding, and leadership changes.
4. **Token Bucket Rate Limiter:** Protecting external CRM and Google APIs from batch burst exhaustion.
