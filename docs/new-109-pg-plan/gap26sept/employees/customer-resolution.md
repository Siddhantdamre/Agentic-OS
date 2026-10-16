# Customer (Customer Resolution) — employee capability spec

> Code-evidence only. Status is 🟡 (path exists, not live-verified) or 🔴 (missing / wrong / silent). Never 🟢 until a live Ask AI proof pass. Do not invent tools outside `tool-definitions.ts` / `tool-executor.ts` / `mcp-bridge.ts`.

**Roster seed:** name `Customer`, role `Customer Resolution`  
`apps/dashboard/lib/employee-provision.ts:106-110`

---

## Job

Owns end-to-end customer resolution: order and account lookups across CRM/payments, policy-grounded refunds, outbound replies on mail/WhatsApp, calendar follow-ups, and escalation of at-risk threads. Not a FAQ-only bot — persona text says “resolves customer needs end-to-end, not just replies” (`employee-provision.ts:108`). Refunds stay on this employee (router prefer `/\bcustomer\b/`), not Finance. Prefer `cognee_memory_remember` to teach durable policy facts to the Brain.

---

## Capabilities

| Capability | Example chat message | Tool(s) | simple or plan | approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| Look up a customer across CRM, tickets, and payments | “Pull the HubSpot + Stripe + recent ticket history for jane@acme.com” | `hubspot_search_contacts`, `stripe_get_customer`, `zendesk_fetch_tickets` / `intercom_fetch_conversations`, `database_query` | simple (read) / plan if multi-system write follows | No for reads | 🟡 | Search catalog: `tool-definitions.ts` + `mcp-bridge.ts` (`hubspot_search_contacts`). Stripe get: `tool-definitions.ts` `stripe_get_customer`. Tickets on allowlist: `employee-provision.ts:109` (`zendesk`, `intercom`). |
| Draft and send a reply (with approval) | “Draft a reply to the angry email from Jane, then send it after I approve” | `gmail_draft_email`, `gmail_send`, `whatsapp_send` | plan / complex (classify COMPLEX_HINTS for send/reply) | Yes for send (`confirmForRisk('send')`, autonomy `send_external_*`) | 🟡 | Tools: `tool-definitions.ts`. Risk / autonomy unchanged. Router: refund/follow-up → Customer (`route-employee.ts`). |
| Refund (always approval) | “Refund charge ch_123 for order 88 under policy” | `stripe_create_refund` → executor `create_refund` | plan (irreversible) | Always (`refund_payment` requires human approval) | 🟡 | Executor: `tools/stripe.ts` `create_refund`. Catalog: `tool-definitions.ts` / `mcp-bridge.ts` `stripe_create_refund` (confirm/risk pay). Autonomy parks refund (`autonomy.ts`). Allowlist has `stripe` (`employee-provision.ts:109`). |
| Open a ticket in Zendesk/Intercom | “Open a Zendesk ticket for Jane’s shipping delay” | `zendesk_create_ticket` / `intercom_create_conversation` | plan | Create = draft/send class; update may need approval by autonomy tier | 🟡 | Tools: `tool-definitions.ts` / `mcp-bridge.ts`. Allowlist: `employee-provision.ts:109` + migration `110_customer_employee_tools.sql`. |
| Teach a knowledge gap to the Brain | “Remember: our return window is 14 days under $100” | Chat: `cognee_memory_remember` (core). UI teach path: Customer page → `TeachKnowledgeGapModal` → `POST /api/brain` | simple | No for memory write (not irreversible pay/send) | 🟡 | Core tool: `tool-definitions.ts` `cognee_memory_remember`. Persona + role prompt prefer it (`employee-provision.ts:108`, `system-prompt-builder.ts` Customer Resolution block). |
| Open loops | “What open promises did we make to Jane this week?” | `customer_list_open_loops` (`customer-ops`) | simple (read) | No | 🟡 | Tool: `tools/customer-ops.ts` `list_open_loops`; defs/MCP appended; allowlist `customer-ops` (`employee-provision.ts:109`). Honest empty when table missing. |
| At-risk conversations | “Which conversations are at risk right now?” | `customer_list_at_risk` (`customer-ops`) | simple (read) | No | 🟡 | Tool: `tools/customer-ops.ts` `list_at_risk_conversations`; same allowlist. Honest empty when schema missing. |

---

## Tool allowlist

### Seeded allowlist (`employee-provision.ts:109`)

`gmail`, `whatsapp`, `google-calendar`, `stripe`, `hubspot`, `zendesk`, `intercom`, `customer-ops`, `database_query`

### Compared to `role-capability.ts`

- Persona after normalize: role/name contain `customer` → `EmployeePersona = 'customer'` (`role-capability.ts:23-28`).
- Customer persona **denies** tools: `apollo`, `linkedin`, `google-ads`, `meta-ads` (`:3-6`) — none of those are on this allowlist (OK).
- Customer persona **denies** actions: `delete`, `create_deal`, `update_deal`, `create_crm`, `cold` (`:9-12`).
- Refunds: non-customer personas denied; customer allowed (`:73-74`). Finance is a separate roster key with stripe — refund routing must stay on Customer (`route-employee.ts`).

### Compared to catalog / executor / MCP

| Expectation | Seeded? | In definitions / MCP? | Mismatch |
|---|---|---|---|
| Gmail / WhatsApp / Calendar | Yes | Yes | None |
| Stripe get customer / payment link | Yes (`stripe`) | Yes | OK |
| Stripe **refund** | Yes (`stripe`) | Yes (`stripe_create_refund`) | Closed (path exists; live pass pending) |
| HubSpot lookup | Yes | Yes (`hubspot_search_contacts`) | Closed (path exists; live pass pending) |
| Zendesk / Intercom | Yes | Yes | Closed (path exists; live pass pending) |
| Open loops / at-risk | Yes (`customer-ops`) | Yes | Closed (path exists; live pass pending) |
| `database_query` | Yes | Yes | Redundant but OK |

### Runtime widening (invariant violation)

Product invariant: selected employee uses own allowlist ∪ core ∪ connected channels — never widened by peers.  
Ask AI turn builder historically merged org-union (`ask-employee.ts`). Locked single/team paths use `allowlistForLockedEmployeeTurn` — verify live; do not treat org-union as intended for Pick one.

---

## Persona prompt

`buildUnifiedSystemPrompt` injects the shared scaffold plus **Customer Resolution** role tools / hand-off lines (`system-prompt-builder.ts` `roleSpecificInstructions`).

Preferred tools: gmail/whatsapp, stripe (incl. refund), hubspot search, zendesk/intercom, calendar, `customer_list_*`, `cognee_memory_remember`.

Hand-offs in prompt: payment links/invoices → Finance; sheets/reconcile → Operations; prospecting → Growth/Sales.

---

## Memory scope

| Rule | Value | Evidence |
|---|---|---|
| Persona token budget | **1800** for `customer` | `memory/retrieve.ts:26-30` |
| Applied when | `employeeRole` normalizes to customer | `:626-627` |
| Citation filter | Drop other customers’ **entity** memory when `entityId` is set and `sourceRef` ≠ that id | `:593-600` |
| Facts-first path | Not used for customer (ops/growth only) | `:630-632` |
| Empty index | Honest “no stored memory”; never invent | `:47-48,615-616` |

---

## Hand-offs

| Request | Pass to | Why | Evidence |
|---|---|---|---|
| Payment link / invoice / Razorpay collect | **Finance** | Locked-turn rule + prompt | `lib/handoffs/customer.ts`; `system-prompt-builder.ts` |
| Refund / return / order status | **Stay on Customer** (not Finance) | Explicit support weights | `route-employee.ts`; handoff rules do not move refunds off Customer |
| FAQ / ticket / helpdesk / SOP (no refund) | **Emma** (Customer Support) when keywords match (Auto) | Prefer Emma for ticket/faq | `route-employee.ts` |
| Pipeline / deal / prospecting | **Growth / Sales** | Locked-turn rule | `lib/handoffs/customer.ts` |
| Spreadsheet reconcile / dedup | **Operations** | Locked-turn rule | `lib/handoffs/customer.ts` |
| Emergency PM keywords | **dispatch / human** | Never ISA | `route-employee.ts` |

Locked Pick one / Team turns attach `handoff: { toRole, reason }` when a rule matches (`ask-ai/route.ts` + `lib/handoffs/`). UI: “Hand to \<Name\>” on Ask AI page.

---

## Invariants checklist (flag violations)

| Invariant | Hold for this employee? |
|---|---|
| Org/user from session + RLS `getScopedClient` | Yes on Ask AI / customer APIs (session-scoped routes). |
| Never fabricate; `connected:false` | Prompt + stripe/hubspot `notConnected` paths. |
| Release pool before SSE/LLM | Ask AI `release()` before classify. |
| Irreversible/outbound → plan or approval | Autonomy parks refund/send; refund now agent-visible. |
| Selected employee allowlist not widened | Locked path uses per-employee allowlist; Auto still org-union — flag. |
| Crew cap UI = server = 3 | Product/docs say 3; verify shared-types cap separately (other agents). |

---

## Blocked (human-only)

- Nango OAuth client IDs for **HubSpot**, **Stripe**, **Zendesk**, **Intercom** (and related) — cannot be faked in code (`gap26sept/integrations-connectors.md`; AGENTS.md known manual items).
- `NEXT_PUBLIC_NANGO_PUBLIC_KEY` for browser connect popups.

---

## Gap summary (this role)

1. ~~Missing agent-visible refund tool~~ — 🟡 path exists (`stripe_create_refund`).
2. ~~Missing HubSpot search in catalog~~ — 🟡 path exists (`hubspot_search_contacts`).
3. ~~Zendesk/Intercom off allowlist~~ — 🟡 seeded + migration `110_customer_employee_tools.sql`.
4. ~~Open loops / at-risk~~ — 🟡 `customer-ops` tools.
5. ~~Weak persona / hand-off block~~ — 🟡 role instructions + `lib/handoffs/customer.ts`.
6. Org-union allowlist widening on Auto — still a cross-cutting concern.
7. Crew cap product vs code — other agents.
8. Crew-planner payment→Finance steals refund-adjacent crew plans — still a risk on Auto/Team heuristics.
