# Executive — employee capability spec

> Code-evidence only. Status is 🟡 (path exists, not live-verified) or 🔴 (missing / wrong / silent). Never 🟢 until a live Ask AI proof pass.

**Roster seed:** name `Executive`, role `Executive`, `rosterKey: 'executive'`  
`apps/dashboard/lib/employee-provision.ts` (`DEFAULT_EMPLOYEE_ROSTER`)  
Allowlist (narrow — no stripe / ads / send): `web_search`, `database_query`, `cognee`, `daily_brief`  
Backfill: `infra/db/migrations/114_research_executive_employee.sql` — idempotent INSERT per org lacking `role = 'Executive'`.

---

## Job

Cross-domain coordinator: daily brief from real work items, org status, and hand-off of specialist work. Pick-able and `@`-mentionable. Auto prefers this employee when the router would otherwise fall through to human / “DareX Executive” (except founder/company questions, which go to Research).

---

## How routing works

| Step | Behavior | Evidence |
|---|---|---|
| Keyword route | Specialty matches score employees | `route-employee.ts` |
| Daily / executive brief | `DAILY_BRIEF_RE` → Executive | `route-employee.ts`; test `route-employee.test.ts` |
| Founder / company | `GENERAL_RE` + score &lt; 0.5 → **Research** (not Executive) | `route-employee.ts`; test founder → Research |
| Human fallback | Prefer active Executive row via `preferExecutiveOrHuman` | `route-employee.ts` |
| Name lock / Pick | `lockToEmployee` / `@Name` still wins | test `@Executive` lock |
| Identity strings | Ask AI / prompt still default to DareX Executive when no employee | `system-prompt-builder.ts`; ask-ai route |

**Daily brief chat tool:** `daily_brief` reads real `work_items` (or honest empty) — `services/workflows/src/tools/daily-brief.ts`; defs in `tool-definitions.ts` / `mcp-bridge.ts`. Does not invent a brief. Ops Temporal `MorningCheckWorkflow` / `deliverBriefActivity` remain for Slack/WA delivery.

---

## Capabilities

| Capability | Example chat message | Tool(s) | simple or plan | approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| Daily / morning brief in Ask AI | “Give me today’s executive brief” | `daily_brief` | simple | No (read) | 🟡 | Tool: `tools/daily-brief.ts`. Router: `DAILY_BRIEF_RE`. Allowlist on Executive card. |
| Cross-domain status | “What’s the status across sales, support, and ops?” | `daily_brief`, `database_query`, web (narrow card) | simple or plan | Depends | 🟡 | Narrow allowlist; hand-offs for specialists. |
| Insights / unstructured analysis | “What should I focus on this week?” | LLM + `database_query` / web / cognee | simple | No for read | 🟡 | Prompt Executive block: `system-prompt-builder.ts`. |
| Founder / company questions | “Tell me about the founders of darexai” | Research tools | simple | No | 🟡 | Routes to **Research**, not Executive (`route-employee.ts`). |
| Hand work to a specialist | “Have Finance create a payment link” | Hand-off rules + router / `@Name` / crew | plan or crew | Cap rules | 🟡 | `handoffs/research-executive.ts` `export const rules`. |
| Pick Executive in Ask AI mode selector | Pick one → Executive | n/a | n/a | n/a | 🟡 | Roster row + backfill exist (`employee-provision.ts`; migration `114_…`). Live Pick UI proof still needed. |

---

## Tool allowlist

Seeded: `web_search`, `database_query`, `cognee`, `daily_brief`.  
No stripe, ads, or send. Locked turns use card + core + channels on card only (`ask-employee.ts`).

---

## Persona

DB persona JSON with `rosterKey: 'executive'`. Prompt defaults still say DareX Executive when no employee is selected. Additive Executive block in `system-prompt-builder.ts`. Persona fenced via `fenceUntrusted`.

`RosterKey` includes `'executive'` (`route-employee.ts`).

---

## Memory scope

| Rule | Value | Evidence |
|---|---|---|
| Persona token budget | Default **3000** | `memory/retrieve.ts` |
| Brain | Existing cognee on allowlist + core | No second store |

---

## Hand-offs / crew

| Request | Pass to | Why | Evidence |
|---|---|---|---|
| Refunds / tickets | Customer | rules | `handoffs/research-executive.ts` |
| Sheets / calendar / work items | Operations | rules | same |
| Pipeline / lookalikes | Growth | rules | same |
| Deals / meetings | Sales | rules | same |
| Ads | Marketing | rules | same |
| Payment links / invoices (not refunds) | Finance | rules | same |
| Sources / founder / web | Research | rules + router | same + `route-employee.ts` |

Crew cap: 🟡 re-verified 2026-09-30 — code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending.

---

## Invariants checklist

| Invariant | Hold? |
|---|---|
| Org/user from session + RLS | Yes for Ask AI. |
| Never fabricate | `daily_brief` returns real rows or empty; prompt forbids inventing. |
| Irreversible → approval | Narrow card has no send/pay. |
| Selection never widens | Locked / Auto-selected use `allowlistForLockedEmployeeTurn`. |
| Pick one locks employee | 🟡 Roster row exists; live Pick proof pending. |
| Crew cap 3 | 🟡 code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending. |

---

## Blocked (human-only)

- None unique to Executive identity. Connector blockers are those of tools on other employees’ cards.

---

## Gap summary (this role)

1. 🟡 **Seeded Executive roster + backfill** — `employee-provision.ts`; migration `114_research_executive_employee.sql`.
2. 🟡 **Daily brief chat tool** — `tools/daily-brief.ts` (honest empty).
3. 🟡 **Hand-off rules** — `handoffs/research-executive.ts`.
4. 🟡 **Auto prefers Executive** when human fallback; founder → Research.
5. 🟡 **Crew cap 3** — code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending.
6. 🟡 **Pick one** — seedable; live UI proof not done.
