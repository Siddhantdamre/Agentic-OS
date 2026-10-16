# Research — employee capability spec

> Code-evidence only. Status is 🟡 (path exists, not live-verified) or 🔴 (missing / wrong / silent). Never 🟢 until a live Ask AI proof pass. Do not invent tools outside `tool-definitions.ts` / `tool-executor.ts` / `mcp-bridge.ts`.

**Roster seed:** name `Research`, role `Research`, `rosterKey: 'research'`  
`apps/dashboard/lib/employee-provision.ts` (Research row in `DEFAULT_EMPLOYEE_ROSTER`)  
Persona JSON: `{ text: 'Read-heavy researcher. Cite web and Drive/Notion docs. Never invent sources or listings. Hand pay, refund, or reconcile asks to Finance, Customer, or Operations.', rosterKey: 'research', confirmClasses: [] }`  
Allowlist: `web_search`, `web_extract`, `google-drive`, `notion`

---

## Job

Read-heavy researcher for public facts and internal docs. Searches the live web, extracts pages, cites Drive/Notion sources, and writes answers from those sources only — never invents listings or citations. Routed when the message matches research keywords (`cite`, `research`, `web search`, `notion`, `drive`, …) via `route-employee.ts` keyword weights, and when Auto mode sees founder/company `GENERAL_RE` with low specialty score (`route-employee.ts` founder → Research).

---

## Capabilities

| Capability | Example chat message | Tool(s) | simple or plan | approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| Web search with citations | “Search the web for DareX AI competitors and cite sources” | `web_search`, then `web_extract` on best URLs | simple (read) | No | 🟡 | Tools: `tool-definitions.ts`. Router weight 0.8: `route-employee.ts` research keywords. Persona forbids inventing sources: `employee-provision.ts`. Reply-from-tools cites pages or says nobody is named: `reply-from-tools.ts`. |
| Deep extract after search | “Open the top result and summarize the founding year” | `web_extract` | simple | No | 🟡 | Def: `tool-definitions.ts`. System prompt Research block: `system-prompt-builder.ts` `researchBlock()`. |
| Company / founder questions (Auto) | “who founded Acme Corp?” / “tell me about the founders of darexai” | `web_search`, `web_extract` | simple | No | 🟡 | Auto: `GENERAL_RE` + score &lt; 0.5 → Research when active (`route-employee.ts`); test `route-employee.test.ts` founder → Research. Name lock still wins (`@Executive` test). Daily brief stays Executive, not Research. |
| Search Drive / Notion and cite | “Find our Q3 strategy doc in Drive and Notion and quote it” | `google-drive_*`, `notion_search` / page tools | simple (read) / plan if write-back | No for read; write to Notion may need approval by autonomy | 🟡 | Allowlist: `employee-provision.ts`. Notion/Drive defs in `tool-definitions.ts`. Unconnected → honest `notConnected` + Connect path (invariant). |
| Summarize findings into the Brain | “Remember this competitive summary in org memory” | `cognee_memory_remember` (core) | simple | No (not pay/send/delete) | 🟡 | Core cognee keys: `tool-executor.ts` `ALWAYS_ALLOWED_CORE_TOOLS`; defs: `tool-definitions.ts`. Prompt: `system-prompt-builder.ts` Research block — existing cognee only, no second memory store. |
| Comps / citation-heavy brief for another employee | “Research comps for this deal then hand to Sarah” | web + Drive/Notion; hand-off rules | simple or crew | No for research reads | 🟡 | Hand-off rules: `apps/dashboard/lib/handoffs/research-executive.ts` (`export const rules`). Research → Finance/Customer/Operations when asked to pay, refund, or reconcile. No first-class hand-off tool; persona + rules + router. |

---

## Tool allowlist

### Seeded allowlist (`employee-provision.ts`)

`web_search`, `web_extract`, `google-drive`, `notion`

### Compared to `role-capability.ts`

- `normalizeEmployeePersona('Research')` → `null` — **no** growth/customer/operations deny list applies.
- Runtime filter returns allowlist unchanged when persona is null.
- Card tools are not stripped by Research-specific denials (none exist).

### Compared to catalog / executor / MCP

| Expectation | Seeded? | In definitions / MCP? | Mismatch |
|---|---|---|---|
| `web_search` / `web_extract` | Yes | Yes | Also in `ALWAYS_ALLOWED_CORE_TOOLS` — redundant but OK |
| Google Drive | Yes (`google-drive`) | Yes | Needs Nango Drive connection |
| Notion search / pages | Yes | Yes | Needs Nango Notion connection |
| Brain remember/search | Via core only | Yes | Not on card allowlist; depends on `ALWAYS_ALLOWED_CORE_TOOLS` |

### Runtime widening

Product invariant: selected employee = own allowlist ∪ core ∪ connected channels on the card.  
Locked / Auto-selected Research turns use `allowlistForLockedEmployeeTurn` (`ask-employee.ts`) — no org-union. Empty card → core only.

---

## Persona prompt

Seeded persona text (`employee-provision.ts`): cite web and Drive/Notion; never invent sources; hand pay/refund/reconcile onward. `rosterKey: 'research'` in persona JSON.

`buildUnifiedSystemPrompt` (`system-prompt-builder.ts`) adds Research block; persona is wrapped in `fenceUntrusted` delimiters so card text cannot close the system prompt.

---

## Memory scope

| Rule | Value | Evidence |
|---|---|---|
| Persona token budget | **Default 3000** (Research is not `customer`/`operations`/`growth`) | `memory/retrieve.ts` |
| Brain write | Existing `cognee_memory_remember` only | Research prompt block; no second store |

Research should prefer citing **web + Drive/Notion tool results** over inventing Brain facts; persona text encodes that.

---

## Hand-offs

| Request | Pass to | Why | Evidence |
|---|---|---|---|
| Founder / company (Auto, low specialty) | **Research** | `GENERAL_RE` → Research | `route-employee.ts`; test founder → Research |
| Daily / executive brief | **Executive** | `DAILY_BRIEF_RE` | `route-employee.ts`; test daily brief → Executive |
| Payment link / Stripe charge | **Finance** | Finance keywords + hand-off rules | `route-employee.ts`; `handoffs/research-executive.ts` |
| Refund / order status | **Customer** | Support weights + rules | same |
| Spreadsheet reconcile | **Operations** | Ops keywords + rules | same |
| Pipeline / outreach | **Sarah / Growth** | Sales keywords | `route-employee.ts` |

`@Research` / “Ask Research to …” name-locks this employee without widening the card allowlist (`lockToEmployee` / locked turn allowlist).

---

## Invariants checklist (flag violations)

| Invariant | Hold for this employee? |
|---|---|
| Org/user from session + RLS | Yes on Ask AI path. |
| Never fabricate; `connected:false` | Persona + prompt; Drive/Notion must not invent when disconnected. |
| Release pool before SSE/LLM | Ask AI releases before classify/stream. |
| Irreversible/outbound → plan or approval | Research card has no send/pay tools; locked turns do not org-union. |
| Selected employee allowlist not widened | 🟡 Locked/Auto-selected path uses card + core + channels on card (`ask-employee.ts`). |
| Crew cap = 3 | Product lock; see crew docs — out of this role’s scope. |

---

## Blocked (human-only)

- Nango OAuth client IDs for **Notion**, **Google Drive** (and related) — cannot fake connectors.
- `NEXT_PUBLIC_NANGO_PUBLIC_KEY` for browser connect popups.

---

## Gap summary (this role)

1. 🟡 **Founder / company Auto route → Research** — implemented (`route-employee.ts` + test). Live Ask AI proof still needed.
2. 🟡 **Brain summary via existing cognee** — prompt + core tools; no second store.
3. 🟡 **Locked allowlist** — `allowlistForLockedEmployeeTurn` filters channels to the card.
4. 🟡 **Hand-off rules file** — `handoffs/research-executive.ts` (no ask-ai page / index edit).
5. 🟡 **Crew cap 3** — code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending.
