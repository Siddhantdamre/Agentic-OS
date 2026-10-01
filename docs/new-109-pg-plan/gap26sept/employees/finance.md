# Finance — Finance

> Per-employee chat capability spec. Status legend: 🟡 code exists, not proved live · 🔴 missing / wrong / silent. No 🟢 until a live `/ask-ai` pass.

## Job

Finance owns invoices and payment links. Always confirm before pay. Never create a charge or payout without owner confirmation. Seeded allowlist: Stripe, Razorpay, QuickBooks, billing_usage. `rosterKey: finance`. **Refunds are Customer’s job** — Finance hard-denies refunds at the persona layer and hands off via `handoffs/marketing-finance.ts`.

| Field | Value | Evidence |
|---|---|---|
| Name | Finance | `apps/dashboard/lib/employee-provision.ts` |
| Role | Finance | `employee-provision.ts` |
| Persona JSON | `text` + `rosterKey: finance` + `confirmClasses: ['pay']` | `employee-provision.ts` |
| Seed allowlist | `stripe`, `razorpay`, `quickbooks`, `billing_usage` | provision + migration `113_marketing_finance_employee_tools.sql` |
| Roster key | `finance` | `route-employee.ts` |
| Router | invoice / payment link / razorpay / stripe / payout → finance | `route-employee.ts` |

## Role-capability / EmployeePersona

`EmployeePersona` includes **`finance`**. `normalizeEmployeePersona('Finance')` → `'finance'`. Finance denies actions containing `refund` even when Stripe is on the allowlist (`roleCapabilityDenial`).

| Effect | Behaviour |
|---|---|
| `filterAllowlistForPersona` | Drops ads/prospecting tools |
| `roleCapabilityDenial` | Hard-denies refund |
| Memory | Finance budget 1400; no conversation-tier strip |

## confirmClasses

`confirmClasses: ['pay']` is read from `ai_employees.persona` inside `checkAutonomy` (`autonomy.ts`). Pay / charge / payout tools force `approval_required` through the **existing** autonomy gate (no second gate). `create_charge` / `create_payment` also map to irreversible action types in `packages/shared-types/src/actions.ts`.

## Persona in system prompt

Additive Finance block in `system-prompt-builder.ts`. Hand-off: Finance refund → Customer (`handoffs/marketing-finance.ts`).

## Allowlist vs provision

| Layer | What Finance gets |
|---|---|
| Seed | stripe, razorpay, quickbooks, billing_usage |
| Connect catalog | QuickBooks in `CONNECTOR_SIGN_IN_IDS` + integrations catalog (Intuit OAuth / not-configured honesty) |
| Role denial | Refunds denied; ads tools filtered |

## Capabilities

| Capability | Example chat message | Tool(s) | Approval? | Status | Evidence |
|---|---|---|---|---|---|
| Stripe payment link | "Create a Stripe payment link for $50" | `stripe_create_payment_link` | **yes** (pay + confirmClasses) | 🟡 | stripe tool + autonomy |
| Razorpay payment link | "Create a Razorpay payment link" | `razorpay_create_payment_link` | **yes** | 🟡 | razorpay tool |
| Create charge | "Charge this card $100" | `stripe_create_charge` | **yes always** — never auto-charge | 🟡 | `stripe.ts` + `actions.ts` + autonomy |
| Billing usage | "What's our billing usage / plan?" | `billing_usage` | no (read) | 🟡 | `tools/billing.ts` — real meters or honest missing-table error |
| QuickBooks invoices | "List QuickBooks invoices" | `quickbooks_list_invoices` | no (read) | 🟡 | on allowlist + Connect catalog; never invents rows |
| Refund this | "Refund order 88" | hand-off to Customer | **yes** | 🟡 | persona deny + handoff rules |

## Human-only blockers

| Blocker | Affects |
|---|---|
| Stripe OAuth client ID in Nango | Stripe payment links / charges / customers |
| Razorpay per-org keys (or approved env fallback) | Razorpay payment links |
| QuickBooks / Intuit OAuth client in Nango | Invoices / QB customers |

## Live Resolution Tracker

| # | Gap | Priority | Status | Evidence |
|---|---|---|---|---|
| 1 | Finance in `EmployeePersona` + hard refund deny | P0 | 🟡 | `role-capability.ts` + unit test |
| 2 | `confirmClasses: ['pay']` wired into autonomy gate | P1 | 🟡 | `autonomy.ts` `loadConfirmClasses` |
| 3 | Stripe `create_charge` tool (approval always) | P0 | 🟡 | defs + mcp + stripe.ts |
| 4 | QuickBooks on allowlist + Connect catalog | P1 | 🟡 | provision, connector-signin, integrations-catalog |
| 5 | Billing usage chat tool | P1 | 🟡 | `tools/billing.ts` |
| 6 | `create_refund` not in MCP defs | P1 | 🟡 | intentional — Customer path; Finance persona denies |
| 7 | Classify COMPLEX_HINTS omit pay/invoice/refund | P1 | 🟡 | tool-level confirm + autonomy still gate |
| 8 | Stripe / Razorpay / QuickBooks OAuth or keys | P0 | 🔴 Blocked (human) | catalog operatorHints |
| 9 | No live `/ask-ai` proof | P0 | 🔴 | — |
| 10 | Crew cap 3 | P1 | 🟡 | code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending |
| 11 | Hand-off rules file (Finance → Customer on refund) | P1 | 🟡 | `handoffs/marketing-finance.ts` |
