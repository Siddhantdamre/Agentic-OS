# Operations employee — Ask AI capability spec

> Spec only. Status is never 🟢 here (no live browser pass in this pass).
> 🟡 = code path exists, not live-verified from `/ask-ai`.
> 🔴 = missing chat tool, wrong allowlist behaviour, silent failure, or missing hand-off.

**Roster verified (2026-09-27):**
- `DEFAULT_EMPLOYEE_ROSTER` name `Operations`, role `Operations`, allowlist
  `hubspot`, `database_query`, `google-calendar`, `google-sheets`, `slack`, `gmail`,
  `operations`, `re`
  — `apps/dashboard/lib/employee-provision.ts:113-117`
- Persona key `operations` in `EmployeePersona` —
  `services/workflows/src/tools/role-capability.ts:1,6,12,28`
- Memory budget `operations: 1200`, facts-first, excludes `conversation` tier —
  `services/workflows/src/memory/retrieve.ts:26-29,601-603,630-631`
- Migration backfill: `infra/db/migrations/111_operations_employee_tools.sql`

---

## Job

Operations is the org’s cross-system triage and integrity employee: reconcile sheets/CRM/DB records, dedup contacts, fix calendar deadlocks, prepare meeting briefs, and keep work-item / expectation state honest. It must not own refunds, ads, payment links, or cold outreach — those hand off to Customer, Marcus/Marketing, Finance, or Growth/Sales.

---

## Capabilities (chat coverage)

| Capability | Example chat message | Tool(s) | simple / plan | Approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| Sheets + reconciliation | “Reconcile this sheet against HubSpot contacts and flag mismatches.” | Chat: `sheets_read` / `sheets_append_row` + `hubspot_*` + `database_query` + `ops_reconcile_audit` → `auditCrossSystemReconciliation`. | simple (read) / plan (write rows or CRM mutate) | Sheets append / CRM write: autonomy-gated; outbound send: yes | 🟡 | MCP: `ops_reconcile_audit` in `tool-definitions.ts` / `mcp-bridge.ts`; executor `tools/operations.ts` `reconcile_audit`; engine `operations/reconciliation.ts:50+`. Sheets unchanged. |
| Dedup CRM contacts | “Find duplicate HubSpot contacts for Acme and merge safely.” | Chat: `ops_dedup_contacts` (scan or named check via `pickDedup`). Reports only — does not merge HubSpot. Post-create hook still runs. | simple (scan) | Merge CRM still needs human/plan; chat tool never auto-merges HubSpot | 🟡 | MCP: `ops_dedup_contacts`; `tools/operations.ts` `dedup_contacts`; engine `operations/dedup-engine.ts`; hook `tool-executor.ts` hubspot-create path. |
| Calendar deadlocks (Meet links, double-booking, unconfirmed guests) | “Audit tomorrow’s calendar for missing Meet links, overlaps, and unconfirmed guests.” | Chat: `ops_calendar_deadlocks` (+ optional `injectMeetLinks`) and `calendar_update_event` → google-calendar `update_event`. Pure detect reused. No auto email/Slack from chat path. | simple (audit) / plan (inject) | Meet inject via Calendar API; guest email/Slack still need explicit ask + approval | 🟡 | MCP: `ops_calendar_deadlocks`, `calendar_update_event`; `tools/operations.ts` `calendar_deadlocks`; pure detect `meeting-prep.ts:90-131`; provider `tools/google-calendar.ts` `update_event`. |
| Meeting prep briefs | “Prep briefs for all meetings tomorrow.” | Chat: `ops_meeting_prep` → `compileMeetingBrief` (named meeting or calendar list). | simple | N/A for brief compile; outbound push separate | 🟡 | MCP: `ops_meeting_prep`; `tools/operations.ts` `meeting_prep`; `operations/meeting-prep.ts:138+`. |
| Work items — create | “Create a high-priority work item for the stuck deal and assign Operations.” | Chat: `work_item_create`. REST still exists. | simple | Internal write; no email/Slack side effect | 🟡 | MCP: `work_item_create`; `tools/operations.ts` `work_item_create`. |
| Work items — reassign | “Reassign work item X to Emma.” | Chat: `work_item_reassign`. HubSpot owner reassign remains `hubspot` `reassign_owner`. | simple (internal) / plan for CRM | Internal only — no email/Slack | 🟡 | MCP: `work_item_reassign`; `tools/operations.ts` `work_item_reassign`. HubSpot: `tools/hubspot.ts`. |
| Work items — priority | “Bump that task to urgent.” | Chat: `work_item_set_priority`. | simple | Internal only | 🟡 | MCP: `work_item_set_priority`; `tools/operations.ts` `work_item_set_priority`. |
| Expected-vs-actual discrepancies | “Show open operational discrepancies / overdue expectations.” | Chat: `ops_list_discrepancies` → `scanOpenExpectations`. | simple | Background sweeps still run | 🟡 | MCP: `ops_list_discrepancies`; `tools/operations.ts` `list_discrepancies`; engine `expected-vs-actual-engine.ts`. |
| Rent reminders | “Draft rent reminders for leases due this week.” | Chat: `rent_reminders_list` drafts from `pm_charges` (no send). Playbook/Temporal still for send path. | simple (draft) / plan (send) | Outbound send: always approve | 🟡 | MCP: `rent_reminders_list`; `tools/operations.ts` `rent_reminders_list`. Never invents charges. |
| Showings | “Book a showing for listing L at Friday 3pm.” | `re_showing_book` (`tool: 're'`). Now also on Operations roster allowlist (+ core). | simple / plan (if draft+send) | Calendar book honest `connected:false`; send gated | 🟡 | `tool-definitions.ts` `re_showing_book`; provision allowlist includes `re`; migration `111_operations_employee_tools.sql`. |

---

## Tool allowlist — exact match

| Source | Value |
|---|---|
| Roster (`employee-provision.ts:116`) | `hubspot`, `database_query`, `google-calendar`, `google-sheets`, `slack`, `gmail`, `operations`, `re` |
| `role-capability.ts` | Does **not** define a positive allowlist. Denies tools: `apollo`, `linkedin`, `google-ads`, `meta-ads`, `stripe` (`:6`). Denies actions: `delete`, `refund`, `send_email`, `send_channel`, `send_external`, `draft_email` (`:12`). |
| Migration `111_operations_employee_tools.sql` | Additive backfill of `operations` + `re` for `role = 'Operations'`. Does not delete org-added tools. |

**Match:** Roster keys align with MCP providers (`hubspot`, `google-calendar`→`calendar_*`, `google-sheets`→`sheets_*`, `slack`, `gmail`, `database_query`, `operations`→`ops_*` / `work_item_*` / `rent_reminders_list`, `re`→`re_*`).

**Quoted mismatches / contradictions (still open):**

1. **Selected-employee tools widen to org-union** on some Auto paths — `ask-employee.ts` / mentions. Locked single/team mode does not widen (`allowlistForLockedEmployeeTurn`, unit tested). 🟡 Auto unions by design.
2. **`gmail` + `slack` on roster vs persona action denials** soft when tool granted — `role-capability.ts:68-79`. Autonomy still parks `external_send`. **🔴** soft-denial gap.

Crew cap is aligned at `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts:6`, `crew-contract.ts:11`).

---

## Persona prompt (`system-prompt-builder.ts`)

Operations block is additive when role/name includes `operation` / `ops`:
- Preferred tools listed (ops_*, calendar_update_event, sheets, work_item_*, rent_reminders_list, re_showing_book, hubspot, database_query, calendar, slack, gmail).
- Hand-offs: refunds → Customer; payment links/invoices/charges → Finance; ads → Marketing; prospecting/deals → Sales/Growth; web research → Research.
- Evidence: `services/workflows/src/prompts/system-prompt-builder.ts` Operations branch. Status: 🟡

Roster persona text (`employee-provision.ts:115`) unchanged.

---

## Memory scope (`memory/retrieve.ts`)

| Rule | Value | Line |
|---|---|---|
| Token budget | `operations: 1200` | `:28` |
| Facts-first | `retrieveFactsFirst` when persona is `operations` or `growth` | `:630-631`, `:555` |
| Tier filter | Drops `conversation` prose — “needs state, not narrative” | `:601-603` |
| Empty index | Honest `no stored memory`; never invent | `:47-48`, `:615-616` |

---

## Hand-offs — what Operations must refuse and pass

| Request class | Must | Pass to | Enforcement today |
|---|---|---|---|
| Refunds / returns | Refuse to execute | Customer | Router + persona deny refund/stripe. Prompt hand-off + `apps/dashboard/lib/handoffs/operations.ts` rules. 🟡 |
| Ads / campaigns / ROAS | Refuse | Marcus / Marketing | Router + ads tools denied. Prompt + handoffs rules. 🟡 |
| Payment links / payouts / Stripe charge | Refuse | Finance | Router finance + stripe denied. Prompt + handoffs rules. 🟡 |
| Cold outreach / Apollo / lookalikes / deals | Refuse | Growth / Sales | Router + apollo/linkedin denied. Prompt + handoffs rules. 🟡 |
| Web research / company/founder questions | Refuse | Research | Prompt + handoffs rules. 🟡 |
| Draft/send customer email as Ops | Prefer hand-off or plan+approve | Customer / human | Action denials soft when `gmail` granted. Autonomy parks `external_send`. 🔴 soft denial |

Index wiring / Ask AI “Hand to” UI is owned by G1 (`handoffs/index.ts`, `ask-ai/page.tsx`) — not edited here.

---

## Ask AI routing (Operations)

- Auto route: `routeAskEmployee` → `route()` — `ask-employee.ts`, ops keywords `route-employee.ts`.
- Classify simple vs complex: `classify.ts`; irreversible outbound should become plan/approval.
- Crew: ops domain hint in `crew-planner.ts`; product cap 3.
- `@Operations` mention: locks persona; allowlist must not widen beyond own+core+connected.

---

## Invariants (ops-relevant)

1. Org/user from session only; RLS via `getScopedClient()` / `withOrgScopedClient`.
2. Never fabricate connector data — `connected:false` + Connect URL.
3. Release pool clients before SSE/LLM.
4. Irreversible / outbound (send, pay, refund, delete, …) → plan or approval.
5. Selected employee tools: own allowlist + core + connected — Auto org-union still a known gap.
6. Work-item reassign/priority: internal DB only; no email/Slack side effect from the tool.
7. Calendar Meet inject goes through google-calendar executor only (no Zoom).

---

## Human-only blockers (OAuth)

| Connector | Why Ops needs it | Blocker |
|---|---|---|
| Google Sheets | Reconciliation / sheets CRUD | Org must complete Google OAuth; public Nango key / client IDs as per connectors audit |
| Google Calendar | Deadlocks, showings, meeting prep | Same Google OAuth |
| HubSpot | Dedup / CRM reconcile / reassign_owner | HubSpot OAuth client ID in Nango UI (often listed as human-blocked) |
| Gmail | Guest pings / rent reminder drafts | Google OAuth |
| Slack | Conflict notify / briefs / decision cards | Slack OAuth |
| Stripe / Razorpay | **Not** Ops tools — Finance/Customer only | N/A for Ops allowlist; payment links must hand off |

---

## Gap list (file:line)

1. ~~No MCP tools for ops engines~~ → 🟡 chat tools in `tool-definitions.ts` / `mcp-bridge.ts` / `tools/operations.ts`.
2. ~~Calendar update / Meet inject MCP gap~~ → 🟡 `calendar_update_event` + `ops_calendar_deadlocks`.
3. ~~Dedup not chat-invocable~~ → 🟡 `ops_dedup_contacts` (report-only).
4. **Allowlist widening on Auto** — still 🔴 if org-union remains for unlocked turns.
5. **Persona send denials soft** when gmail/slack granted — 🔴 `role-capability.ts:68-79`.
6. ~~No Operations hand-off text~~ → 🟡 `system-prompt-builder.ts` + `handoffs/operations.ts`.
7. ~~Crew cap product vs code~~ → aligned at 3 (`shared-types/crew.ts:6`, `crew-contract.ts:11`).
8. ~~Showings only via core `re`~~ → 🟡 also on Operations roster + migration `111`.
