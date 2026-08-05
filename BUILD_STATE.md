# Darex Build State

> Source of truth for agent context across sessions. Read this before starting any phase.

---

## Current Phase: 2 (COMPLETED) → Phase 3 (READY TO START)

## Phases Completed
- ✅ **Phase 0 — Foundations** (Completed: 2026-08-05)
- ✅ **Phase 1 — Multi-Tenant Core** (Completed: 2026-08-05)
- ✅ **Phase 2 — Connector Layer** (Completed: 2026-08-05)

---

## Phase 2 — Connector Layer

**Status:** ✅ COMPLETED

**Objective:** Wire OAuth for WhatsApp Business, Gmail, Google Calendar, HubSpot, Razorpay, Meta Ads, Google Ads via self-hosted Nango. Each connector = versioned TypeScript function in `/services/connectors`, callable by name from agent layer. Build Figma Integrations page (`/integrations`).

### What Was Completed
- [x] `services/connectors/nango.yaml` — Nango integration manifest registering OAuth & API key providers (`whatsapp`, `gmail`, `google-calendar`, `hubspot`, `razorpay`, `meta-ads`, `google-ads`).
- [x] `@darex/connectors` TypeScript package (`services/connectors/src/*`):
  - `client.ts`: `NangoConnectorClient` wrapper with tenant connection isolation (`darex_<org_id>_<provider>`).
  - `whatsapp.ts`: `sendWhatsAppMessage()` Meta Cloud API wrapper.
  - `gmail.ts`: `sendGmailEmail()` Gmail RFC 2822 base64 API wrapper.
  - `calendar.ts`: `createGoogleCalendarEvent()` Google Calendar API wrapper.
  - `hubspot.ts`: `createHubspotContact()` HubSpot CRM API wrapper.
  - `razorpay.ts`: `createRazorpayInvoice()` Razorpay API wrapper.
  - `meta-ads.ts`: `getMetaAdsInsights()` Meta Marketing API wrapper.
  - `google-ads.ts`: `getGoogleAdsPerformance()` Google Ads API wrapper.
  - `types.ts` & `index.ts`: Shared typescript definitions.
- [x] Integrations API (`apps/dashboard/app/api/integrations/route.ts`):
  - GET endpoint querying channels & Nango connection status per tenant.
  - POST endpoint handling connect / disconnect actions & persisting state to Postgres channels with RLS session context.
- [x] Integrations Page UI (`apps/dashboard/app/(dashboard)/integrations/page.tsx`):
  - 4-Stat Header Bar (Connected Apps, Total Syncs Today, Failed Webhooks, API Quota Used).
  - Grid of 7 integration cards with "Connected" badge / "Connect via Nango" button.
  - Detail drawer displaying tenant security scope keys & live webhook log feeds.
- [x] Verified Phase 2 Exit Criteria: Executed `node infra/scripts/check-phase2.js` returning **ALL CHECKS PASSED (8/8)**.

---

## Phase 1 — Multi-Tenant Core

**Status:** ✅ COMPLETED

---

## Phase 0 — Foundations

**Status:** ✅ COMPLETED

---

## Next Phase: Phase 3 — Conversation & Inbox Layer

**Objective:** Chatwoot fork setup into `/apps/inbox`, sync webhooks to Postgres `conversations` & `messages` tables, multi-channel inbox UI.

**Start with:**
1. Read BUILD_STATE.md (this file)
2. Populate Chatwoot fork into `/apps/inbox`
3. Build Webhook Handler (`/apps/dashboard/app/api/webhooks/chatwoot/route.ts`) to ingest incoming messages into Postgres `conversations` & `messages` with RLS session context
4. Build Inbox UI (`/apps/dashboard/app/(dashboard)/conversations/page.tsx`) matching Figma spec Section 4.3 (3-pane layout: Filter Sidebar, Conversation List, Chat Canvas & Context Drawer)
5. Verify Phase 3 exit criteria: An inbound message on any channel appears in the inbox in <500ms and creates a `conversations` row with `org_id`.

---

## Architecture Log

| Decision | Rationale | Phase |
|---|---|---|
| Postgres + pgvector as single DB | Avoids extra vector DB service; pgvector handles all 3 memory tiers | 0 |
| Temporal via auto-setup image | Bundles Temporal server + worker + UI in one container for local dev | 0 |
| Nango for all OAuth | Self-hosted, inspectable credential storage; avoids Composio | 0 |
| Langfuse for LLM tracing | Self-hosted; per-tenant cost tagging via org_id metadata on every trace | 0 |
| RLS policy pattern | `current_setting('app.current_org_id', true)::UUID` — enforced at DB level | 0 |
| Idempotency keys table | Temporal activities use this to ensure exactly-once semantics for external side-effects | 0 |
| Graphify for context persistence | Knowledge graph built from docs + code, queryable across build sessions | 0 |
| SuperTokens for Auth | Open-source multi-tenant auth with built-in Session & User Management | 1 |
| Figma Design System Tokens | Custom Tailwind theme palette (`#FAF9F0`, `#F0C05A`, `#1E2B27`) | 1 |
| Nango Connector Pattern | Versioned TypeScript function per app in `services/connectors`, zero agent infra coupling | 2 |
