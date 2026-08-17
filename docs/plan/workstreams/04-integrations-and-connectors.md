# Workstream 04 — Integrations and connectors

Nango remains the OAuth and token plane. TypeScript executors remain
the action plane. Disconnected always returns `connected: false` +
`/connectors`. Never fabricate. Never Composio.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/05-e2e-integrations.md`,
`08-tools-catalog.md`, `14-what-does-not-work.md`,
`16-updates-2026-08-13.md`.

- Nango `:3003` is source of truth. Connection id
  `{orgId}_{provider}`. GET `/api/integrations` re-verifies every
  DB row against Nango. POST connect 400s without a real connection.
  Disconnect deletes the Nango connection.
- 27 apps in `ALL_INTEGRATIONS`. Agent path is `tool-executor.ts`
  (62 MCP tools). `@darex/connectors` is test-proxy only.
- Live-verified when connected: Gmail fetch, Calendar, GitHub,
  Docs create, Sheets create, Drive list, web_search, sandbox,
  `database_query`.
- Executors exist (not stubs) for Google Chat/Meet/Analytics/GSC/
  Business/Cloud, Intercom write, Stripe customer ops. UI catalog
  may still say `catalog_only` — stale hints.
- WhatsApp BYOK Graph-pinged into `channels.meta`. Razorpay
  per-org `channels.meta` then env.
- **Ops-blocked:** HubSpot, Stripe, Notion, Slack, Shopify,
  Zendesk, Intercom, Meta Ads need real OAuth client IDs in Nango
  UI. Gmail compose needs re-connect. Meta token expired.
- Future-scope `06` status column still says GBP/Meet/GA4/GSC are
  stubs and Chatwoot is ingest-only — update that file when
  absorbing; do not rebuild executors.

---

## 2. Target

Sources: `docs/future-scope/06-integrations-catalog.md`,
`02` §4.3 and §5, `13` Phase 10, `15` §6.

- `connector_defs` / `org_connectors` / `sync_cursors` tables.
  UI is registry-driven.
- `tool-executor.ts` split into `services/workflows/src/tools/*.ts`.
  Single gateway. One MCP server.
- Waves A–E as in future-scope `06` §16, minus absorbed stubs.
  Wave A: catalog hints + Outlook/Calendar + operator client IDs.
  Wave B: Salesforce/Zoho, DocuSign, Leegality, Twilio/Exotel,
  Instagram, Maps, Mailchimp, QuickBooks or Zoho Books.
  Wave C: RE CRMs, Sheets inventory, licensed MLS only.
  Wave D–E: GTM/ecom then pull.

---

## 3. Gaps

**Audit 2026-08-14:** C3/C4/C5 **done**. C6 leftovers **done** as
executors (SF + Zoho CRM + DocuSign + Leegality + Maps + Twilio +
QuickBooks). Live Nango/BYOK still **ops**. C1 still **ops**.

| Item | Status |
|------|--------|
| Nango truth + honest notConnected | **done** |
| Core Google + many SaaS executors | **done** / **ops-blocked** |
| GBP/Meet/GA4/GSC executors | **done** (future `06` stale) |
| UI `catalog_only` hints | **partial** |
| Registry tables | **missing** |
| Executor module split | **missing** |
| Outlook / Salesforce / Zoho / DocuSign / Leegality / Maps / QuickBooks | **done** as executors (live creds ops) |
| RE CRMs / MLS feed | **missing** (after memory) |

---

## 4. Work items

### C1 — Operator: real OAuth client IDs + scope re-connects

- **What:** Paste client IDs in Nango UI `:3003`. Re-connect Gmail
  for `gmail.compose`. Run `seed-nango-configs.sql` after scope
  changes.
- **Where:** Nango UI; `infra/scripts/seed-nango-configs.sql`.
- **Depends on:** nothing (ops).
- **DoD:** Popup completes; Connected only when Nango agrees.
  Never fabricated Connected.

### C2 — Fix catalog hints

- **What:** Stop saying “no executor” for Chat/Meet/Analytics/GSC/
  Business/Cloud. Google Cloud stays `service_account` until a
  real connect path exists.
- **Where:** `apps/dashboard/lib/integrations-catalog.ts`.
- **Depends on:** none.
- **DoD:** UI matches `08-tools-catalog.md`.

### C3 — Registry schema + seed

- **What:** `connector_defs`, `org_connectors`, `sync_cursors`.
  Seed from today’s 27 apps + risk classes. GET still verifies
  Nango.
- **Where:** `infra/db/migrations/014_connector_registry.sql`;
  `apps/dashboard/app/api/integrations/route.ts`.
- **Depends on:** C2 helpful.
- **DoD:** Pack can recommend a connector without marking it
  connected.

### C4 — Split `tool-executor.ts`

- **What:** Keep `executeAutonomousToolAction`. Modules under
  `src/tools/<provider>.ts`. Exhaustive switch on provider key.
- **Where:** `services/workflows/src/tool-executor.ts`,
  `src/mcp-bridge.ts`, `src/tools/`.
- **Depends on:** R5 can land during the split.
- **DoD:** All 62 MCP names still resolve. Unknown tool still
  errors honestly.

### C5 — Wave A: Outlook + Calendar

- **What:** Nango configs + executors + MCP. Confirm `send` on mail.
- **Where:** `tools/microsoft-outlook.ts`, `microsoft-calendar.ts`.
- **Depends on:** C3, C4 preferred.
- **DoD:** Connected lists events / drafts mail. Disconnected gets
  setupUrl. One connected + one disconnected eval.

### C6 — Wave B P0 connectors

- **What:** Salesforce or Zoho CRM (at least one), DocuSign,
  Leegality, Exotel or Twilio, Instagram Messaging, Maps
  geocoding, Zoho Books or QuickBooks. Follow `06` §15.
- **Where:** `services/workflows/src/tools/`; Nango; registry.
- **Depends on:** C3–C4. Maps is P0 for RE.
- **DoD:** E-sign confirm class works. GBP reviews real when
  connected. No portal scrape.
- **2026-08-14 leftovers:** Zoho CRM + Leegality + QuickBooks
  executors, seed, MCP, honesty goldens shipped. Live OAuth/BYOK
  still ops. Happy path when connected: `zoho_list_contacts`,
  `leegality_list_documents`, `quickbooks_list_customers`.

### C7 — Wave C (after Phase 6 memory)

- **What:** Follow Up Boss, Sheets/CSV inventory as SoR, RESO/MLS
  only if licensed, ShowingTime, AppFolio/Buildium or Sheets PM.
  Portal lead **email parse** is a Gmail skill, not a scrape.
- **Where:** `tools/realestate/*`.
- **Depends on:** M3, C6 Maps, pack entities.
- **DoD:** “2BHK under Y in X” returns only sheet/MLS rows. Zero
  matches does not invent inventory.

---

## 5. End-to-end connections

Runtime allowlist unions connected channels. Knowledge uses
sync_cursors. Channels add Instagram/SMS as inbound. Security
confirm classes on `pay`/`sign`/`publish`. Packs recommend
connectors, never mark connected.

---

## 6. Non-goals

Composio; building an MLS; scraping portals; P3 before P0/P1 of
the active wave; a second MCP server per vertical.

---

## 7. Verification

Every new connector: Langfuse span; golden connected + disconnected;
Nango-verified Connected; `channel_logs` row; no secret in git.
Keep and extend `check-phase2.js`.

Related: [05-data-sources-and-knowledge.md](./05-data-sources-and-knowledge.md),
[13-vertical-packs.md](./13-vertical-packs.md).
