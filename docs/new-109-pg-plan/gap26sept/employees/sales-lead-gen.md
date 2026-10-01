# Sarah / Sales & Lead Gen — employee capability spec

> Spec only. Status: no 🟢. 🟡 = code exists, not live-proven from `/ask-ai`. 🔴 = missing tool, allowlist gap, silent fail, or missing hand-off.

## Job

Sarah owns front-of-house sales: qualify inbound leads, run demo and pricing conversations, keep CRM contacts current, and move deals forward with human approval on outbound send. She is not Growth (lookalikes / signals) and not Customer Support (refunds / tickets).

## Roster (provision)

| Field | Value | Evidence |
|---|---|---|
| Name | `Sarah` | `employee-provision.ts:127-131` |
| Role | `Sales & Lead Gen` | same |
| Persona text | Enthusiastic and persuasive sales specialist — lead qualification, product demos, pricing negotiations | `employee-provision.ts:129` |
| `tool_allowlist` | `gmail`, `whatsapp`, `hubspot`, `salesforce`, `zoho-crm`, `apollo`, `linkedin`, `google-calendar`, `re` | `employee-provision.ts:130` |

Pack drift: `packs/core-b2b/employees/sarah.yaml` may lag; **seeded roster wins**.

### Allowlist vs role-capability

- Seeded grant as above. Migration `112_growth_sales_employee_tools.sql` backfills additively.
- Runtime: org-union allowlist then `filterAllowlistForPersona` (`tool-executor.ts:165-169`, `258`).
- Role `Sales & Lead Gen` / name `Sarah` → persona **`sales`** (`role-capability.ts:28`).
- Sales **denies tools**: `google-ads`, `meta-ads` (`role-capability.ts:7`).
- Sales **denies actions**: `delete`, `refund` (`role-capability.ts:14`). Deals / apollo / linkedin / calendar allowed.
- **Fixed:** `sarah` no longer maps to `customer` (was stripping apollo/linkedin and blocking create_deal).

#### How the sales persona gates tools

1. Persona is **`sales`**, not customer (`role-capability.ts:28`).
2. Ads tools stripped; apollo/linkedin/calendar kept.
3. `create_deal` / `update_deal` allowed when hubspot is granted (customer still blocked at `:79`).
4. Memory: sales budget **1600** (`retrieve.ts` `PERSONA_TOKEN_BUDGET.sales`).
5. `sdr` → `growth` unchanged (G4 owns Marcus; growth denials for SDR titles).

### System prompt

`buildUnifiedSystemPrompt` adds Sales preferred-tools + hand-off block when role/name matches sales/sarah (`system-prompt-builder.ts:26-29`).

### Memory scope

- Sales persona budget **1600** (`PERSONA_TOKEN_BUDGET.sales`).
- Citation filter keeps conversation; scopes entity when `entityId` set (`retrieve.ts` sales case).

### Routing / crew

- Prefer Sarah on lead / qualify / demo / outreach / pipeline / hubspot / deal / prospect (`route-employee.ts:102-106`; `crew-planner.ts:51-53`).
- Lookalike / Apollo / buying signal prefer **Growth**, not Sarah (`route-employee.ts:97-100`).
- `inferRosterKey`: `sales|lead|isa` → `sales` (`route-employee.ts:157`).
- Crew: product cap **3** (`crew-contract`); Mentions: `@Sarah` locks employee; allowlist mode stays grants + denials — pick never widens.

---

## Capabilities (chat)

| Capability | Example chat message | Tool(s) | Simple / plan | Approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| HubSpot contacts | "Add Jane Doe at Acme as a HubSpot contact and set lifecycle to lead" | `hubspot_create_contact`, `hubspot_update_contact` | plan | Contact create/update = autonomy draft tier; external send separate | 🟡 | `tool-definitions.ts:153-179`; `hubspot.ts:5`; allowlist `employee-provision.ts:130`; `notConnected` via Nango |
| HubSpot **deals** | "Create a HubSpot deal for Acme at $12k" | `hubspot_list_deals`, `hubspot_create_deal`, `hubspot_update_deal` | plan | Create/update = draft risk; never invent deal ids | 🟡 | `hubspot.ts:8-12,72`; `tool-definitions.ts:181-220`; persona sales allows deals `role-capability.ts:7,14,28` |
| Salesforce contacts / leads | "List Salesforce contacts and create a lead for Acme" | `salesforce_list_contacts`, `salesforce_create_contact`, `salesforce_create_lead` | plan | Create = draft risk; send separate | 🟡 | Tools live; now on Sarah allowlist `employee-provision.ts:130`. **No deal tools.** OAuth client often missing |
| Salesforce **deals** | "Update the Acme opportunity stage in Salesforce" | `salesforce_list_deals`, `salesforce_create_deal`, `salesforce_update_deal` | plan | Create/update = draft; never invent ids | 🟡 | `salesforce.ts:13,67+`; `tool-definitions.ts:889+`; honest `notConnected` when unsigned |
| Zoho contacts / leads | "Create a Zoho lead for this inbound" | `zoho_list_contacts`, `zoho_create_contact`, `zoho_create_lead` (`tool: zoho-crm`) | plan | Same as SF | 🟡 | Tools live; allowlist `employee-provision.ts:130`. **No deal tools.** OAuth often missing |
| Zoho **deals** | "Move Zoho deal to Proposal" | `zoho_list_deals`, `zoho_create_deal`, `zoho_update_deal` | plan | Create/update = draft; never invent ids | 🟡 | `zoho.ts:13,63+`; `tool-definitions.ts:1041+`; honest `notConnected` when unsigned |
| Apollo enrichment | "Enrich Acme and find the VP Sales on Apollo" | `apollo_search_people`, `apollo_enrich_company` | simple/plan | No (read) | 🟡 | Tools + Sarah allowlist `employee-provision.ts:130`; sales persona keeps apollo `role-capability.ts:7,28` |
| LinkedIn enrichment | "Find this prospect on LinkedIn and pull company signals" | `linkedin_search_people`, `linkedin_company_signals` | simple/plan | No (read) | 🟡 | Allowlist `employee-provision.ts:130`; sales persona keeps linkedin |
| Schedule a meeting | "Schedule a 30-min demo with jane@acme.com Thursday 3pm" | `calendar_create_event`, `calendar_check_availability`, `calendar_list_events` | plan | Create event visible; external invite careful | 🟡 | `google-calendar` on Sarah allowlist `employee-provision.ts:130` |
| Inquiry → listing match | "Match open inquiries to new listings" | `re_inquiry_listing_match` | plan | Match creates `waiting_approval` only; never sends | 🟡 | `realestate/index.ts` `inquiry_listing_match`; `tool-definitions.ts:1132`; allowlist `re` |
| Qualify / demo / pricing (dialogue) | "Qualify this inbound and propose demo + pricing next steps" | LLM persona + `gmail` / `whatsapp` / HubSpot contacts | plan if CRM or send | **Yes** for `whatsapp_send` / `gmail_send` / external (`employee-provision.ts:24-25`) | 🟡 | Persona `employee-provision.ts:129`; `whatsapp_send` `tool-definitions.ts:15-20`; no dedicated pricing/quote tool |
| Outreach send | "Email the qualified lead the demo invite" | `gmail_send` / `gmail_draft_email` | plan | **Yes** always for send | 🟡 | `tool-definitions.ts:30-83`; autonomy seed |

---

## Hand-offs

| From Sarah → | When | Status |
|---|---|---|
| Growth | Lookalikes, buying signals, ICP scout, dormant revival | 🟡 `handoffs/growth-sales.ts:56-60`; prompt `system-prompt-builder.ts:28-29` |
| Customer / Emma | Refund, ticket, order status | 🟡 `handoffs/growth-sales.ts:42-46` |
| Finance | Payment link / invoice / charge | 🟡 `handoffs/growth-sales.ts:51-55`; prompt `system-prompt-builder.ts:29` (refunds stay Customer) |
| Operations | Dedup / sheets / meeting-prep ops | 🟡 `handoffs/growth-sales.ts:50-54` |

Pick-one / locked thread: product requires out-of-scope → hand-off offer (`AGENTS.md` §4a). Rules module exists; Ask AI page / index not wired yet (by design this wave).
---

## Invariants (must hold)

- Org and user from session only; RLS via `getScopedClient()`.
- Unconnected → `connected: false` + Connect; never fabricate.
- Release pool clients before SSE/LLM.
- Send / pay / refund / delete / sign / autonomy / DSR → plan or approval.
- Allowlist + core + connected only; role-capability denials apply; pick never widens.
- Crew runtime cap **8** vs docs **3** — see Growth spec.

## Human-only blockers

| Blocker | Why |
|---|---|
| HubSpot OAuth client ID in Nango | Contacts (and any future deals) |
| Salesforce OAuth client ID | SF contact/lead tools |
| Zoho OAuth client ID | Zoho contact/lead tools |
| Apollo / LinkedIn Nango (or keys) | Enrichment — also blocked by allowlist until code fix |
| Google Calendar OAuth | Scheduling — also needs allowlist add |
| `NEXT_PUBLIC_NANGO_PUBLIC_KEY` | Connect button from chat |
| WhatsApp / Meta token | Channel send |

Do not fake CRM or enrichment results while blocked.
