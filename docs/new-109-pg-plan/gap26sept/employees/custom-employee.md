# Custom employee — org-created path capability spec

> Code-evidence only. Status is 🟡 (path exists, not live-verified) or 🔴 (missing / wrong / silent). Never 🟢 until a live Ask AI proof pass. Re-verified against current code; `gap26sept/employees.md` prose may lag its Live Resolution Tracker.

**Definition target:** An org-created employee should be defined **only** by its card `tool_allowlist` + `persona` (plus name/role/status) — nothing hardcoded per custom role in shared infra (`route-employee.ts` comment). This file documents how close that is today.

---

## Job

Any employee an operator hires via **Hire AI Employee** (`POST /api/employees`) or `provisionCustomEmployee`. Not in `DEFAULT_EMPLOYEE_ROSTER`. Routed by name lock (`@Name` / “Ask X to…”) or by keyword/heuristic match on name/role/persona/tools like any other active row. Owns whatever tools and persona text the operator saved on the card.

---

## How creation works

| Step | Behavior | Evidence |
|---|---|---|
| Auth | Session via `getScopedClient()`; RBAC `canDisableEmployee` | `app/api/employees/route.ts` |
| Validate name/role | Required non-empty strings | same |
| Validate allowlist | `validateToolAllowlist` against `VALID_TOOLS` + extras; 400 on invalid | `lib/tool-allowlist.ts` |
| Persona | Stored as jsonb; **fenced** at prompt build time | `system-prompt-builder.ts` `fencedPersona` / `fenceUntrusted` |
| Insert | `provisionCustomEmployee` in one txn | `employee-provision.ts` |
| Autonomy | Calls **same** `seedDefaultAutonomyRules(client, orgId)` as org provisioning | `employee-provision.ts` `provisionCustomEmployee`; also `db.ts` on org create. Org-wide matrix (`employee_role` NULL) — no new permission tables / RBAC redesign. |
| Cold-start | `ensureEmployeeColdStart` | `employee-provision.ts` |
| UI | Hire modal posts `name`, `role`, `persona`, `tool_allowlist: selectedTools` | `employees/page.tsx` |

---

## Capabilities

| Capability | Example chat message | Tool(s) | simple or plan | approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| Route by @mention / Ask-to | “@Maya draft a Slack update” | Card allowlist + core + channels on card | simple or plan | Per tool risk | 🟡 | Name lock: `route-employee.ts`. Mentions: `employee-mentions.ts`. |
| Route by Auto keyword | Message matching Maya’s role/tools if scores beat peers | Card tools | simple or plan | Per tool | 🟡 | `inferRosterKey` may return `'other'` for custom names — often need @mention. |
| Call only card tools (product intent) | “Use only Maya’s tools” | Card ∪ core ∪ channels **on card** | — | — | 🟡 | Locked + Auto-selected: `allowlistForLockedEmployeeTurn` (`ask-employee.ts`); ask-ai `single` / `auto` with employee. Unit test: empty allowlist excludes stripe/gmail. |
| Empty allowlist hire | Hire with no tools checked | Core tools only | simple | — | 🟡 | `channelsOnEmployeeCard` returns `[]` when card empty → `mergeRuntimeAllowlist` = core only. Test: `ask-employee-locked-allowlist.test.ts`. |
| Persona defines behaviour | Custom system instructions on the card | Injected **fenced** | — | — | 🟡 | `system-prompt-builder.ts` wraps persona in `<<<UNTRUSTED_USER_CONTENT>>>`; escapes fence tokens inside persona. Does not strip persona text. |
| Per-employee autonomy tiers | Custom hire with stricter send rules | Org-wide `employee_autonomy_rules` seed | — | — | 🟡 | Same helper as default path; no new RBAC / permission tables (intentionally unchanged). |
| Pick in Ask AI mode selector | Pick one → custom employee | Locked allowlist | n/a | n/a | 🟡 | Mode selector + locked allowlist path exist; live proof pending. |

---

## Tool allowlist

### Card is the declared allowlist

Whatever `POST` / `PATCH` persisted after `validateToolAllowlist`.

### Empty allowlist

| Layer | Result | Evidence |
|---|---|---|
| DB | `tool_allowlist = []` allowed | `employee-provision.ts` |
| Locked turn | Core only — **not** org connectors | `allowlistForLockedEmployeeTurn` + test |
| Core always | web_search, web_extract, database_query, file/sandbox, cognee, … | `tool-executor.ts` `ALWAYS_ALLOWED_CORE_TOOLS` |

### Role denials

Custom roles that don’t match growth/customer/operations get null persona → no deny list. A custom name containing `sarah` may still map wrongly via `role-capability` — residual risk.

---

## Persona

- Stored via `JSON.stringify` on POST.
- Parsed for routing with `personaPlain` (`ask-employee.ts`).
- Prompt build: fenced with existing untrusted delimiters (`system-prompt-builder.ts`); fence markers inside persona are escaped, content kept.

---

## Memory scope

| Rule | Value | Evidence |
|---|---|---|
| Token budget | Default **3000** unless role normalizes to growth/customer/operations | `memory/retrieve.ts` |
| Isolation | Org-scoped retrieval | `retrieve.ts` |

---

## Hand-offs

| Mechanism | Works for custom? | Evidence |
|---|---|---|
| `@Name` / Ask-to lock | Yes if name matches | `route-employee.ts` |
| Keyword `RosterKey` buckets | Only if name/role/tools infer known keys; else `'other'` | `inferRosterKey` |
| Crew inclusion | Yes if active and planner picks them | `crew-planner.ts` |
| Offer hand-off when out of scope | 🟡 Request-keyed offer when the card lacks the tool (`handoffs/custom.ts`, wired in `ask-ai/route.ts`); unit tested, live proof pending | AGENTS.md §4a |

---

## Gaps vs “card allowlist + persona is the whole definition”

| Expectation | Today | Status |
|---|---|---|
| Allowlist alone defines tools | Locked/Auto-selected: card + core + channels on card | 🟡 |
| Persona alone defines behaviour | Fenced concatenation; shared quality scaffold remains | 🟡 |
| No hardcoded role logic | Router has keyword→rosterKey map; custom `'other'` under-routed without @mention | 🟡 |
| Autonomy from card | Org matrix seeded via same helper; no per-employee rules / no auth redesign | 🟡 |
| Validated tools only | POST/PATCH validate catalog | 🟡 |
| Selection never widens | Locked path fixed; org-union only when no employee selected | 🟡 |
| Crew cap 3 | code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending | 🟡 |

---

## Invariants checklist

| Invariant | Hold for custom path? |
|---|---|
| Org/user from session + RLS | Yes (`getScopedClient` on POST). |
| Never fabricate / `connected:false` | Shared prompt + tool executors. |
| Release pool before SSE | Ask AI path yes; hire API releases in `finally`. |
| send/pay/refund/delete → approval | Org autonomy seed + risk helpers. |
| Allowlist + core + channels on card only | 🟡 Locked / Auto-selected. |
| Crew cap 3 | 🟡 Code caps at 3; live proof pending. |

---

## Blocked (human-only)

- Whatever connectors the operator puts on the card (Nango client IDs / public key) — same as roster employees.

---

## Gap summary (custom path)

1. 🟡 **Card allowlist exclusive on locked/selected turns** — `allowlistForLockedEmployeeTurn` + ask-ai auto/single.
2. 🟡 **Persona fenced** — `system-prompt-builder.ts` (not stripped).
3. 🟡 **Autonomy seed on custom hire** — same `seedDefaultAutonomyRules` helper (no auth model change).
4. 🟡 **Empty allowlist = core only** — unit tested.
5. 🟡 **Auto-route weak for `rosterKey: other`** — often need `@Name`.
6. 🟡 **Crew cap 3** — code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending.
7. 🟡 vs stale audit: allowlist validation + org autonomy seed on custom hire **are implemented**.
