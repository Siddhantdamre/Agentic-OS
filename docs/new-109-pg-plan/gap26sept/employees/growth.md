# Growth — employee capability spec

> Spec only. Status: no 🟢. 🟡 = code exists, not live-proven from `/ask-ai`. 🔴 = missing tool, allowlist gap, silent fail, or missing hand-off.

## Job

Growth is the B2B pipeline strategist: build ICP lookalikes from closed-won CRM, surface buying signals, revive dormant leads, and draft executive outreach that a human must approve before send. It does not own refunds, payments, or support tickets.

## Roster (provision)

| Field | Value | Evidence |
|---|---|---|
| Name | `Growth` | `employee-provision.ts:120-125` |
| Role | `Growth` | same |
| Persona text | B2B Growth & Pipeline strategist — high-intent visitors, lookalikes, buying signals, targeted executive outreach drafts | `employee-provision.ts:122` |
| `tool_allowlist` | `hubspot`, `web_search`, `web_extract`, `apollo`, `gmail`, `slack`, `growth` | `employee-provision.ts:123` |

### Allowlist vs role-capability

- Provision allowlist (above) is the seeded grant. Runtime unions active-employee allowlists ∪ connected channels ∪ core, then `filterAllowlistForPersona` (`tool-executor.ts:99-150`, `258`).
- Role string `Growth` → `normalizeEmployeePersona` → `'growth'` (`role-capability.ts:27`).
- Growth persona **denies tools**: `stripe`, `shopify`, `zendesk`, `intercom`, `razorpay` (`role-capability.ts:4`).
- Growth persona **denies actions**: `delete`, `refund` (`role-capability.ts:11`).
- Picking Growth / `@Growth` must not widen tools beyond allowlist + core + connected (`employee-mentions.ts:4-5`, `28-30`). Mentions lock persona, not a private allowlist.

### System prompt

`buildUnifiedSystemPrompt` injects name, role, persona, plus Growth preferred-tools and hand-off block (`system-prompt-builder.ts:20-24`). Shared tool/safety rules unchanged.

### Memory scope

- Persona token budget **1600** when role normalizes to `growth` (`memory/retrieve.ts:26-30`, `626-627`).
- Citation filter: exclude `conversation` tier (`retrieve.ts:604-606`).
- Facts-first retrieve for growth (`retrieve.ts:630-631`).
- Org/user always from session/workflow; RLS via scoped client (`retrieve.ts:615-616`).

### Routing / crew

- Lookalike / Apollo / buying-signal keywords prefer Growth (`route-employee.ts:97-100`; `crew-planner.ts:36-38`).
- Lead/demo/pipeline keywords prefer Sarah (`route-employee.ts:102-106`) — hand-off should offer Sarah when locked on Growth; **hand-off UX not implemented** (see below).
- **Crew cap drift:** `route-employee.ts:7` and runtime `MAX_CREW_SPAWN = 8` (`crew-contract.ts:7`, `packages/shared-types/src/crew.ts:5`, `crew-contract.test.ts:11-12`). Product docs / `AGENTS.md` still say cap **3**. Enforce product intent (3) or update docs — do not assume 3 at runtime.

### Engines (background, not chat tools)

| Engine | Path | Notes |
|---|---|---|
| ICP from closed-won | `activities/growth.ts:65-122` `loadOrBuildIcpActivity` | Honest `connected: false` without HubSpot |
| Apollo lookalikes | `activities/growth.ts:125+`, `growth/lookalike.ts` | Via `executeProvider` apollo |
| Buying signals | `activities/growth.ts` `pollSignalsActivity`, `growth/signals.ts` | Jina when keyed |
| Dormant leads | `activities/growth.ts:462-510` `listDormantLeadsActivity` | Conversation + signal join |
| Opportunity + draft | `activities/growth.ts:342-406` | `draftedMessage` on `work_items` |
| ROI write | `activities/growth.ts:513-544` `recordGrowthRoiActivity` | `growth_pipeline_attribution` |
| ROI read (tab) | `api/growth/brief/route.ts:106-119` | Shown on `/employees/growth` |
| Approve outreach | `api/growth/opportunities/[id]/decision/route.ts` | UI: `employees/growth/page.tsx:61-87` |
| Listing ↔ inquiry | `api/growth/listings/match/route.ts:13-17` | Creates `waiting_approval` cards; no send |

---

## Capabilities (chat)

| Capability | Example chat message | Tool(s) | Simple / plan | Approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| ICP / lookalikes | "Find lookalike accounts for our ICP and shortlist VP Sales contacts" | `apollo_search_people`, `apollo_enrich_company`; HubSpot contacts for CRM context. Full ICP centroid is Temporal-only (`loadOrBuildIcpActivity`) — **no chat tool** for ICP build | plan (multi-step) | No for search; CRM writes follow autonomy | 🟡 | `tool-definitions.ts:240-251`; `apollo.ts:35-38` (`notConnected`); `activities/growth.ts:65-122`; allowlist `employee-provision.ts:123` |
| Buying signals | "What buying signals do we have on Acme this week?" | `web_search` / `web_extract` in chat; Temporal `pollSignalsActivity` + `lead_intent_signals` not exposed as a chat tool | simple or plan | No (read) | 🟡 | `tool-definitions.ts:354-364`; `activities/growth.ts:176+`; `growth/signals.ts` |
| Dormant-lead revival | "Revive dormant leads that just showed intent" | `growth_list_dormant_leads` (read); outreach still via `gmail_draft_email` + approval | simple or plan | Yes for send/draft send | 🟡 | `tools/growth.ts:10,63`; `tool-definitions.ts:1140`; allowlist `employee-provision.ts:123` |
| Outreach drafts (approval) | "Draft outreach to the top lookalike — don't send" | `gmail_draft_email` (chat); opportunity `draftedMessage` + Approve on Growth page | plan | **Yes** — `draft_email` / `send_external_email` seeded `requires_human_approval: true`; send never auto | 🟡 | `tool-definitions.ts:71-83`; `employee-provision.ts:20,24`; `employees/growth/page.tsx:61-87`; decision route |
| Pipeline attribution | "Show pipeline attribution for Growth opportunities" | `growth_list_pipeline_attribution` (read-only chat). Writer remains `recordGrowthRoiActivity` | simple | N/A (read) | 🟡 | `tools/growth.ts:10,111`; `tool-definitions.ts:1148`; Temporal write still `activities/growth.ts:513-544` |
| ROI | "What's Growth pipeline ROI this month?" | `growth_pipeline_roi` (chat read); tab still `GET /api/growth/brief` | simple | N/A | 🟡 | `tools/growth.ts:10,169`; `tool-definitions.ts:1156`; brief `api/growth/brief/route.ts:106-119` |

### Related (not in required rows, tracked as gaps)

| Capability | Status | Notes |
|---|---|---|
| Slack opportunity ping | 🟡 | `slack` on allowlist; dossier path in `compileMeetingDossiersActivity` |
| HubSpot **deals** | 🟡 | `hubspot_list_deals` / `create_deal` / `update_deal` (`hubspot.ts:8-12,72`; `tool-definitions.ts:181-220`) — Sales-owned; Growth allowlist still contacts-focused |
| LinkedIn prospecting | — | **Not a Growth gap.** LinkedIn enrichment is Sales-owned (`sales-lead-gen.md`; Sarah allowlist `employee-provision.ts:130`). Do not add LinkedIn to Growth. |
| Inquiry → listing match from chat | 🟡 | `re_inquiry_listing_match` on Sales (`realestate/index.ts` `inquiry_listing_match`; `tool-definitions.ts:1132`); Growth tab API still live |
| Hand-off to Sarah / Customer | 🟡 | Rules exported `apps/dashboard/lib/handoffs/growth-sales.ts:12`; prompt blocks `system-prompt-builder.ts:22-23` — Ask AI page not wired yet |

---

## Persona bug impact (Sales / Marketing names)

`normalizeEmployeePersona` maps `sales|lead|sarah` → `'sales'` and keeps `marcus` → `'growth'` (`role-capability.ts:25-30`). Sales denies ads tools + delete/refund (`:7,14`). Duplicate matcher in `role-scoped-tools.ts:9-10` still maps `sarah` → customer (dashboard-only path; G4 owns Marcus/marketing side).

---

## Hand-offs

| From Growth → | When | Status |
|---|---|---|
| Sarah (Sales & Lead Gen) | Demo, pricing, qualify a named inbound lead | 🟡 `handoffs/growth-sales.ts:36-40`; prompt `system-prompt-builder.ts:23` |
| Customer / Emma | Refund, ticket, post-sale support | 🟡 `handoffs/growth-sales.ts:14-18` |
| Finance | Invoice / payment link | 🟡 `handoffs/growth-sales.ts:28-32` |
| Research | Company / founder / cite-heavy web research | 🟡 `handoffs/growth-sales.ts:39-43`; prompt `system-prompt-builder.ts:23` |

---

## Invariants (must hold)

- Org and user from session only; RLS via `getScopedClient()` / `withOrgScopedClient`.
- Unconnected connector → `connected: false` + Connect URL; never fabricate (`apollo.ts:38`, system prompt).
- Release pool clients before SSE/LLM.
- Send / pay / refund / delete / sign / autonomy / DSR → plan or approval.
- Allowlist + core + connected only; role-capability denials apply; pick never widens.
- Crew: runtime cap **8**; product docs say **3** — document, don't invent a third number.

## Human-only blockers

| Blocker | Why |
|---|---|
| HubSpot OAuth client ID in Nango | ICP from closed-won + CRM context |
| Apollo connection / API key via Nango | Lookalike search |
| `JINA_API_KEY` / `JINA_READ_API_KEY` | Signal scrape quality |
| Gmail + Slack OAuth | Drafts / dossier delivery |
| `NEXT_PUBLIC_NANGO_PUBLIC_KEY` | Connect UI from chat |

Mark 🔴 Blocked on live proof until those exist; do not fake results.
