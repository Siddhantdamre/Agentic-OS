# Emma (Customer Support) — employee capability spec

> Code-evidence only. Status is 🟡 (path exists, not live-verified) or 🔴 (missing / wrong / silent). Never 🟢 until a live Ask AI proof pass. Do not invent tools outside `tool-definitions.ts` / `tool-executor.ts` / `mcp-bridge.ts`.

**Roster seed:** name `Emma`, role `Customer Support`  
`apps/dashboard/lib/employee-provision.ts:134-138`

---

## Job

Front-line support: FAQs, inbox triage, scheduling. Persona explicitly **does not** claim refund processing — refunds, CRM/payments lookup, and Zendesk/Intercom tickets hand off to **Customer** (Customer Resolution). Emma keeps gmail / whatsapp / google-calendar (+ read-only `customer-ops`). Preferred Auto route for `ticket|faq|helpdesk|sop|escalate` (`route-employee.ts`).

---

## Capabilities

| Capability | Example chat message | Tool(s) | simple or plan | approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| Look up a customer across CRM, tickets, and payments | “Look up Jane in HubSpot, Stripe, and Zendesk” | None on Emma allowlist — locked turn returns `handoff` to Customer Resolution | simple (read) | n/a (hand-off) | 🟡 | Allowlist: gmail/whatsapp/calendar/customer-ops only (`employee-provision.ts:137`). Handoff rules: `lib/handoffs/customer.ts` CRM/payments → Customer Resolution. Ask AI attaches `handoff` on locked turns (`ask-ai/route.ts`). |
| Draft and send a reply (with approval) | “Reply on WhatsApp that we’re looking into her order” | `gmail_draft_email`, `gmail_send`, `whatsapp_send` | plan / complex for send | Yes for send | 🟡 | Tools on allowlist via `gmail`/`whatsapp`. |
| Refund (always approval) | “Process a refund for Jane’s last charge” | Not on Emma allowlist; hand-off to Customer | plan | Always if Customer executes | 🟡 | Persona no longer promises refunds (`employee-provision.ts:136`). Handoff: `lib/handoffs/customer.ts` refund patterns → Customer Resolution. Router still prefers Customer for refund keywords. |
| Open a ticket in Zendesk/Intercom | “File an Intercom conversation for this bug” | Not on Emma allowlist; hand-off to Customer | plan | n/a (hand-off) | 🟡 | Handoff ticket patterns → Customer Resolution (`lib/handoffs/customer.ts`). Customer owns zendesk/intercom. |
| Teach a knowledge gap to the Brain | “Save this FAQ answer to org knowledge” | `cognee_memory_remember` (core) | simple | No | 🟡 | Core tool + Emma role prompt prefers it (`system-prompt-builder.ts`). |
| Open loops | “List open loops I’m responsible for” | `customer_list_open_loops` | simple (read) | No | 🟡 | `customer-ops` on Emma allowlist (`employee-provision.ts:137`); `tools/customer-ops.ts`. |
| At-risk conversations | “Show at-risk support threads” | `customer_list_at_risk` | simple (read) | No | 🟡 | Same `customer-ops` module. |

---

## Tool allowlist

### Seeded allowlist (`employee-provision.ts:137`)

`gmail`, `whatsapp`, `google-calendar`, `customer-ops`

### Compared to `role-capability.ts`

- Role `Customer Support` / name Emma → persona `customer` (`role-capability.ts:27`).
- Denied tools (apollo/linkedin/ads) — not on allowlist (OK).
- **Refund action** allowed for customer persona but **stripe not granted** — allowlist deny fires first. Correct: Emma must hand off.

### Compared to provision persona vs tools

| Persona claim (`:136`) | Allowlist (`:137`) | Verdict |
|---|---|---|
| FAQs / triage / scheduling | gmail, whatsapp, calendar | Match |
| Open loops / at-risk (read) | customer-ops | Match |
| Refund processing | (hand-off, not claimed) | Match |
| CRM / tickets | (hand-off to Customer) | Match |

---

## Persona prompt

Unified scaffold + **Customer Support** role tools / hand-off lines (`system-prompt-builder.ts`): stay on channels; hand refunds/CRM/tickets to Customer Resolution; prefer `cognee_memory_remember` for durable FAQs.

---

## Memory scope

Identical customer-persona rules (token budget **1800**, entity filter). Both Customer and Emma share the `customer` budget.

---

## Hand-offs

| Request | Emma should… | Target | Evidence |
|---|---|---|---|
| Refund / return / chargeback | Hand off | **Customer** (Customer Resolution) | `lib/handoffs/customer.ts`; Ask AI `handoff` + “Hand to” control |
| Payment link / invoice collect | Hand off | **Finance** | Prompt + Customer rules (Emma FAQ path may still route Auto to Finance keywords) |
| CRM contact / payments lookup | Hand off | **Customer** | `lib/handoffs/customer.ts` |
| Zendesk/Intercom ticket | Hand off | **Customer** | `lib/handoffs/customer.ts` |
| Emergency | Never handle | dispatch / human | `route-employee.ts` |

**Finance must not own refunds** — refunds stay with Customer; Emma must not pull them either.

---

## Invariants checklist (flag violations)

| Invariant | Hold for Emma? |
|---|---|
| Session org + RLS | Yes on Ask AI path. |
| No fabrication / notConnected | Yes when connectors missing. |
| Pool release before SSE | Ask AI release before classify. |
| Outbound/refund approval | Send yes; refund via hand-off to Customer. |
| Allowlist not widened on pick | Locked path uses own allowlist. |
| Crew cap 3 | Product/docs say 3; verify shared-types separately. |

---

## Blocked (human-only)

- OAuth client IDs in Nango for HubSpot, Stripe, Zendesk, Intercom (Customer’s connectors — Emma does not need them on allowlist).
- `NEXT_PUBLIC_NANGO_PUBLIC_KEY` for Connect UI.

---

## Gap summary (this role)

1. ~~Persona/allowlist lie on refunds~~ — 🟡 persona rewritten; hand-off wired.
2. ~~Ticket tools on Emma~~ — intentionally not granted; 🟡 hand-off to Customer instead.
3. ~~No chat path for open loops / at-risk~~ — 🟡 `customer-ops`.
4. ~~Weak prompt / hand-off copy~~ — 🟡 role instructions + API `handoff`.
5. Org-union / crew cap — cross-cutting, other agents.
