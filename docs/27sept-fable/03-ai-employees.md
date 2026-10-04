# 03 · AI employees, routing, crews, governance

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 4 | 8.0% |
> | 🟡 **Pending / In Progress** | 3 | 6.0% |
> | 🔴 **Not Done (Open)** | 43 | 86.0% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **50** | **100.0%** |

Audit date 2026-09-27, read-only. Scope: `services/workflows/src/{route-employee,tool-executor,autonomy,employee-gate,employee-metrics,cold-start,crew-*,periodic-registry,quiet-hours,untrusted}.ts`, `activities/{critic-check,guarded-send,growth,meeting-prep,rep-followup-sla,workload-balancer,open-loop-sweep,index}.ts`, `workflows/*`, `prompts/system-prompt-builder.ts`, `tools/role-capability.ts`, `apps/dashboard/lib/{ask-employee,ask-mode,employee-mentions,employee-provision,employee-rollout,employee-observability,employee-metrics-query,role-scoped-tools,tool-allowlist,crew-planner,crew-abort,onboarding-cold-start}.ts`, `lib/handoffs/*`, `app/api/{employees,agent/crew,ask-ai,org/kill-switch,webhooks/whatsapp}/**`, `(dashboard)/employees/**`, migrations `001/023/025/026/038/039/109–116`, `gap26sept/employees*.md`, `3-employee.md`.

**Headline.** Ten roster employees have real personas, allowlists, hand-off rules and (for Growth/Customer/Operations) background loops. But the governance that makes them safe to run 24/7 is mostly unwired: the **kill switch stops only open-loop sends**; six activities call the raw `executeProvider` with no allowlist, autonomy, critic, quiet hours or ledger (MeetingPrep emails customers, MarketScout creates HubSpot contacts, WorkloadBalancer reassigns CRM owners at rollout stage 0); `employee-gate.ts` / `employee-metrics.ts` / `cold-start.ts` have no importers except their tests; an "emergency" regex on words like *fire* and *drive* drops chat into an **org-union allowlist with no persona**; and `DormantLeadRevivalWorkflow` (GE-05, marked ✅ in `3-employee.md`) is never started.

---

## 1. Per-employee reality

| Role (seed) | Can do today, end-to-end | Allowlist (`employee-provision.ts`) | Hand-offs | Periodic workflows | Metrics / gating | Blueprint ids missing or stubbed |
|---|---|---|---|---|---|---|
| **Growth** | Chat: Apollo/web/HubSpot reads, Gmail draft. Background: GrowthWatcher 4h, MarketScout 24h (Apollo → `growth_market_scout_leads` → HubSpot create), MeetingDossier 30m, ReplySorter 20m | `:120-124` hubspot, web_search, web_extract, apollo, gmail, slack, growth | `handoffs/growth-sales.ts:8-35` → Customer / Marketing / Finance / Sarah / Research | 4 in `periodic-registry.ts:27-30` ✅; **DormantLeadRevival registered (`workflows/index.ts:37`), never started** ❌ | Growth activities never call `checkAutonomy` / `logAutonomyDecision` (`activities/growth.ts` 0 hits) → no ledger, metrics blind | GE-05 dead; GE-01 ICP centroid Temporal-only, no chat tool; GE-08 draft→send not critic-gated |
| **Customer Resolution** | Chat: CRM/ticket/Stripe lookup, refund (approval), open loops, at-risk. Background: OpenLoopMonitor 15m, CustomerRecovery (child of `WorkItemWorkflow.ts:643`), ConversationalInsight 24h | `:109` gmail, whatsapp, google-calendar, stripe, hubspot, zendesk, intercom, customer-ops, database_query | `handoffs/customer.ts:36-58` → Finance / Operations / Growth | ✅ | Ledger rows tagged `customer` (`open-loop-sweep.ts:113,352`); `guardedSendActivity` used only here | **CE-06 Shopify address fix unreachable — `shopify` not on Customer card** (`ask-employee.ts:66-83`); CE-10 gap clusters exist, no SOP write-back |
| **Operations** | Chat: reconcile, dedup report, calendar deadlocks, meeting prep, work items, rent drafts, showings. Background: MorningCheck, StuckWork, RepFollowUpSla, WorkloadBalancer, MeetingPrep 24h, SystemReconciliation | `:116` hubspot, database_query, google-calendar, google-sheets, slack, gmail, operations, re | `handoffs/operations.ts:8-38` | All 6 in registry ✅; `kickPeriodicSweeps` (`employee-provision.ts:74-84`) omits RepFollowUpSla / WorkloadBalancer / ConversationalInsight → new orgs miss them until worker restart | RepFollowUp / WorkloadBalancer use `executeProvider` directly (`rep-followup-sla.ts:59,107`, `workload-balancer.ts:83`) — no gate, no ledger | **OE-06 merge writes local `entities` only (`dedup.ts:51-52`), never merges CRM; OE-10 `outage-buffer.ts` zero importers; OE-08 pings guests ungated** |
| **Executive** | `daily_brief`, database_query, cognee, web_search; coordinator by prompt only | `:173` | `handoffs/research-executive.ts:8-50` | OwnerBriefing **not in `PERIODIC_SWEEPS`**; started only by owner-whatsapp webhook (`:62`), InsightAction, packs | `normalizeEmployeePersona('Executive')` → null → no persona denials | Delegation is prose (`system-prompt-builder.ts:98-106`), no delegation tool |
| **Customer Support (Emma)** | FAQ / triage / scheduling over gmail, whatsapp, calendar; open loops read | `:137` | `handoffs/customer.ts:9-34` → Customer Resolution | none | Persona `customer` | Front-line only |
| **Sales & Lead Gen (Sarah)** | HubSpot / Salesforce / Zoho contacts+deals, Apollo / LinkedIn reads, calendar, RE inquiry match, draft outreach | `:130` | `handoffs/growth-sales.ts:38-70` | none | Persona `sales` | No Sales background loop; SF/Zoho OAuth 🔴 |
| **Marketing & Analytics (Marcus)** | GA4 / Search Console / GBP / Meta / Google Ads reads, gmail | `:144-151` | `handoffs/marketing-finance.ts:15-28` | none | Persona `marketing`; denies charge/payout | Ads token / Meta OAuth 🔴; no campaign workflow |
| **Research** | web_search / extract, Drive, Notion, cognee remember | `:162` | `handoffs/research-executive.ts:52-70` | none | Persona null → no denials | No citation persistence beyond Cognee |
| **Finance** | Stripe / Razorpay links, charges (always approval), QuickBooks reads, billing usage | `:185` | `handoffs/marketing-finance.ts:9-14` → Customer on refund | none | `confirmClasses:['pay']` enforced (`autonomy.ts:288-300`) ✅ | Keys 🔴; no invoice reconciliation loop |
| **Custom** | Only via `@Name` / Pick one | POST-validated (`tool-allowlist.ts:26-31`) | none (no rule file matches unknown role) | none | Org-wide autonomy rules (`provisionCustomEmployee` `:335`) | Unreachable in Auto (`inferRosterKey` → `'other'`, `route-employee.ts:243`) |

## 2. Bugs

| ID | Sev | Location | What happens | Fix sketch | Status |
|---|---|---|---|---|---|
| EMP-B01 | **P0** | `route-employee.ts:73-82,352-358` + `ask-ai/route.ts:565-580` | `EMERGENCY_RE` matches `fire`, `smoke`, `sparks`, `leaking`, `flood(ing)` → destination `dispatch` → `routeAskEmployee` returns null → Auto falls to `allowlistForEmployeeTurn(orgTools, orgTools…)` = **org-union of every employee's tools, no persona**. "Fire off an email to Jane" runs with stripe/apollo/etc. | Gate emergency regex to inbound channels or ≥2 signals; when router returns non-employee in chat, fall back to Executive/core-only. | 🟢 (2026-09-28: `WorkItemWorkflow` already short-circuited dispatch/human before touching tools, but `routeEmployeeActivity` still returned a full caller-allowlist fallback attached to that result — a landmine for any future caller. New `mergeRoutedForCaller` only applies the caller-allowlist/identity fallback for a real `employee` destination; `route-employee.test.ts` covers both branches, workflows 330/330) |
| EMP-B02 | **P0** | `activities/index.ts:606-612` + `route-employee.ts:40` | `routeEmployeeActivity` substitutes `params.toolAllowlist` (webhook default employee's list) when the routed employee's list is empty → custom employee with empty card inherits Customer's stripe/hubspot. `preferredEmployeeId` declared, never read. | Fall back only when destination is human; honour `preferredEmployeeId`. | 🟢 2026-10-05: caller defaults only for the caller's own employee (`mergeRoutedForCaller`) |
| EMP-B03 | P1 | `route-employee.ts:243,292-294,413-419` | Custom roles always infer `'other'`; `pickByRoster` never returns them; org with only custom employees → `emptyRoute('human')` → org-union (B01 path). | Score custom employees by persona/tool overlap. | 🔴 |
| EMP-B04 | P1 | `route-employee.ts:92-98,133-140,166-177,394-402` | Keyword collisions: `returns?` beats "return on ad spend"; `sheets?` sends "balance sheet" to Ops; `drive` → Research ("drive revenue"); `lead` → Sarah ("lead time"). Ties broken by roster insertion order. | Phrase-level patterns, negative lookarounds, deterministic tie-break. | 🔴 |
| EMP-B05 | P1 | `tool-executor.ts:255-259` | Empty `params.toolAllowlist` ⇒ `resolveOrgToolAllowlist` (union of all employees + channels). Any caller passing an empty card widens permissions. 🟢 (2026-09-28: verified — `resolveOrgToolAllowlist` no longer exists in `services/workflows/src`; the `tool-gate.ts` refactor (side effect of the plan-step-actor work) computes `onCard = card.length > 0 && isAllowed(...)` at `tool-gate.ts:241-246` — an empty card now falls through to core-read-only, never an org-wide union) | Empty = core-only; `undefined` = org resolution. | 🟢 (2026-09-28: side effect of the `tool-gate.ts` refactor — `resolveOrgToolAllowlist`'s org-union fallback no longer exists anywhere; an empty employee card now falls through to core-read-only, never a union) |
| EMP-B06 | P1 | `tool-executor.ts:45-65` | `loadEmployeeAutonomyTier` selects `autonomy_tier` from *any* rule row (no `action_type` filter, `LIMIT 1`) → skill min-tier gate compares against an arbitrary rule. | Filter by action bucket or use `org_runtime_controls.autonomy_stage`. | 🔴 |
| EMP-B07 | P1 | `handoffs/research-executive.ts`, `handoffs/operations.ts:13-18` | Locked Executive + "brief me on today's meetings" → hand-off to Sales, no tools run. Research + "who is in charge at Acme" → Finance. Handoff fires before any tool call (`ask-ai/route.ts:590-608`). | Anchor patterns; exempt daily-brief phrases; hand off only when the locked employee lacks the tool. | 🔴 |
| EMP-B08 | P1 | `activities/meeting-prep.ts:37-60` + `workflows/meeting-prep.ts:44-49` | `auditCalendarDeadlocksActivity` has no idempotency key; workflow repeats every 24h → unconfirmed guests emailed **every day forever**. | Key per `(eventId, guestEmail)`; route through `guardedSendActivity`. | 🔴 |
| EMP-B09 | P1 | `role-capability.ts:29-41`, `system-prompt-builder.ts:50-70,72-86,143-148`, `route-employee.ts:236-240` | Persona inferred from substrings of role **and name**: "Customer Success Lead" → `sales`; custom "Marcus Lee / Legal" → Marketing prompt + `ops` roster key; "Sarah Connor / Analyst" → Sales prompt. | Explicit `rosterKey` in persona JSON (supported at `route-employee.ts:224`); stop name inference. | 🔴 |
| EMP-B10 | P1 | `apps/dashboard/lib/role-scoped-tools.ts:31-36` vs `wf/tools/role-capability.ts:56-63` | Same export `filterAllowlistForPersona`, opposite semantics (whitelist vs denylist). Dashboard version drops every core tool because `mergeCardAllowlist` normalises `_`→`-` (`ask-employee.ts:58-60,92`) but `CORE_ALWAYS` uses `_`. Masked only because `local-tool-select.ts:90` re-adds core. | Delete dashboard copy; import from workflows dist. | 🔴 |
| EMP-B11 | P1 | `employees/[id]/route.ts:55-136` | PATCH: no UUID check on `id`, no `archived_at IS NULL` (re-activates archived), `name`/`role` unvalidated, persona unbounded, `status` coerces anything to `active`. | Mirror GET validation; bound persona (8 KB). | 🔴 |
| EMP-B12 | P2 | `employees/stats/route.ts:10-16,31-32` | "automationRate" = active/total employees (fake KPI); counts archived. | Compute from `agent_decision_ledger`. | 🔴 |
| EMP-B13 | P2 | `crew-planner.ts:97-105,51-60,296-300` | `pickEmployeeForDomain` `roster.find(roleHints)` → "calendar" returns Customer not Operations; Auto crews double-assign the full message to each member. | Score roleHints against rosterKey; scoped `task` per specialist. | 🔴 |
| EMP-B14 | P2 | `CrewWorkflow.ts:88-108`, `crew-runner.ts:124-144`, `crew-budget.ts:49-56` | Spend check only when `specialists.length > 1`; solo-via-crew bypasses it; check **fails open**. | Check all crew starts; fail closed. | 🔴 |
| EMP-B15 | P2 | `CrewWorkflow.ts:155-182,196-233`; `crew-abort.ts:19-24` | Parent cancel does not cancel `runAgentTurnActivity`; children run to 20-min timeout after client abort. No per-crew cost accounting. | `CancellationScope`, heartbeats, `org_model_spend` per child. | 🔴 |
| EMP-B16 | P2 | `employee-provision.ts:69-102` vs `periodic-registry.ts:21-34` | Two sweep lists (9 vs 12). | `kickPeriodicSweeps` → `startSweepsForOrg`. | 🔴 |
| EMP-B17 | P2 | `agent/crew/route.ts:43-49`, `activities/index.ts:576-581` | Roster queries omit `archived_at IS NULL`. | Add everywhere roster is loaded. | 🔴 |

## 3. Security / governance holes

| ID | Sev | Evidence | Hole | Status |
|---|---|---|---|---|
| EMP-S01 | **P0** | `kill_switch` read only in `customer/outbound-budget.ts:15` (via `guarded-send.ts:101`). Zero hits in `tool-executor.ts`, `autonomy.ts`, `AutonomousAgentWorkflow.ts`, `CrewWorkflow.ts`, `ask-ai/route.ts`, `webhooks/whatsapp/route.ts`, all periodic workflows | **Kill switch stops only open-loop-sweep sends.** Chat, webhook turns, crews, MarketScout CRM writes, MeetingPrep emails, RepFollowUp Slack all run with kill switch ON. `/api/org/kill-switch` writes a flag nothing reads. | 🟢 (2026-09-28: `gateOrgRunnable` reads `kill_switch` off `org_runtime_controls` in the ordered tool gate; every call through `executeAutonomousToolAction` denies `kill_switch` before the provider runs — `executor-gate.test.ts`) |
| EMP-S02 | **P0** | `meeting-prep.ts:129-141`, `growth.ts:633,786,909`, `rep-followup-sla.ts:59,107`, `workload-balancer.ts:83`, `customer.ts:119`, `enrichment.ts:102`; `tools/index.ts:354-360` | `executeProvider` is the raw executor — no allowlist, no `checkAutonomy`, no critic, no quiet hours, no ledger. MeetingPrep sends **customer-facing email**; MarketScout **creates HubSpot contacts**; WorkloadBalancer **reassigns CRM owners** — autonomous at rollout stage 0. | 🔴 |
| EMP-S03 | **P0** | `outage-budget.ts:16` only reader of `autonomy_stage`; `employee-gate.ts:24-36` / `employee-rollout.ts:22-33` no callers | Rollout stage 0 "shadow" is not shadow: chat tool execution goes straight to `checkAutonomy` (`tool-executor.ts:345-350`), which knows nothing about stage. `canAdvanceStage` gates UI only (`org/rollout/route.ts:65`). | 🟢 (2026-09-28: `evaluateEmployeeGate` is now called from `tool-gate.ts` and enforced — `deny_role` blocks, `shadow` suppresses+logs and never invokes the provider, `escalate` parks — `executor-gate.test.ts`) |
| EMP-S04 | P1 | `critic-check.ts:217` called only from `WorkItemWorkflow.ts:438`; `guarded-send.ts:174-237` never calls it | Critic (fair-housing / legal-promise) covers inbound work-item replies only. Chat sends, open-loop chases, nurture, pack/showing reminders (`packs.ts:198-224`, `showing-reminders.ts:174-201`) bypass it. 🟡 (2026-09-28: verified partial — `guarded-send.ts`'s `sendChannelMessage` now calls the gated `executeAutonomousToolAction` instead of raw `executeProvider`, and `tool-gate.ts` runs `deps.critic()` for every `risk:'send'` action on both the approved-resume and live paths (`tool-gate.ts:308,332`) — so guarded sends (open-loop chases, nurture, showing reminders) are now critic-checked. Still open: `meeting-prep.ts`, `growth.ts`, `rep-followup-sla.ts`, `workload-balancer.ts` still call raw `executeProvider` directly and never reach this gate) | 🟡 (2026-09-28: `guarded-send.ts` now routes through the gated `executeAutonomousToolAction`, and `tool-gate.ts` runs the critic for every `risk:'send'` action — guarded sends are critic-checked; `meeting-prep.ts`/`growth.ts`/`rep-followup-sla.ts`/`workload-balancer.ts` still call raw `executeProvider` directly, so coverage is incomplete (see `EMP-S02`)) |
| EMP-S05 | P1 | `guarded-send.ts:119` `void customerKey`; `outbound-budget.ts:56-59` `void customerIdentifier`; `agent_outbound_budget` (023:388) unused | Per-customer daily cap not enforced — only org-wide count from ledger `LIKE '%send%'`. `outbound_per_customer_day` metric measures nothing real. | 🔴 |
| EMP-S06 | P1 | quiet-hours honoured in `guarded-send.ts:184`, `workload-balancer.ts:19`, `orchestration.ts:767` only | ReplySorter Slack, MeetingPrep guest emails, RepFollowUp nudges, chat sends ignore quiet hours. | 🔴 |
| EMP-S07 | P1 | `role-capability.ts:79-97` | Action denials soft when tool on card: Operations with `gmail` may `send_email` (`operations.md:93` 🔴). | 🔴 |
| EMP-S08 | P1 | `guarded-send.ts:157-172` | `sendChannelMessage` calls executor without `employeeRole` → skips `roleCapabilityDenial`; `toolAllowlist:[tool]` bypasses card. | 🔴 |
| EMP-S09 | P1 | `autonomy.ts:547` | `logAutonomyDecision` defaults empty role to `'operations'` → misattributed ledger corrupts per-role metrics. | 🔴 |
| EMP-S10 | P2 | `employee-mentions.ts:8,29-31` vs `ask-mode.ts:1-4` | `MENTION_ALLOWLIST_MODE='org-union'` still declared; contract drift. | 🔴 |
| EMP-S11 | P2 | `periodic-registry.ts:65` filters status at boot only | Suspended / soft-deleted orgs keep sweeping and sending until worker restart. | 🔴 |
| EMP-S12 | P2 | `employee-provision.ts:5-28`, `cold-start.ts:35-58`, `autonomy.ts:317-340`, `onboarding-cold-start.ts:9-14` | Four autonomy-default definitions; `seedDefaultAutonomyRules` has no caller. | 🔴 |

## 4. Functional gaps

| ID | Sev | Evidence | Enterprise target | Status |
|---|---|---|---|---|
| EMP-G01 | P0 | `employee-gate.ts`, `employee-metrics.ts`, `cold-start.ts` — only importers are tests | `evaluateEmployeeGate` in `tool-executor.ts` before `checkAutonomy`; `EMPLOYEE_METRIC_BANDS` per employee daily. | 🟢 (2026-09-29: `employee-gate.ts` wired into `tool-gate.ts`; `recordEmployeeMetrics` wired into `tool-gate` and `writeLedgerRow`; `DEFAULT_AUTONOMY_SEED` and `seedColdStart` imported in `employee-provision.ts` and onboarding completion) |
| EMP-G02 | P0 | DormantLeadRevival never started; `3-employee.md:22` says "Fully working in Temporal" | Add to `PERIODIC_SWEEPS` or trigger from GrowthWatcher. | 🔴 |
| EMP-G03 | P1 | `org_employee_metrics_daily.employee_role DEFAULT '*'` (026:203); ledger keyed `employee_role TEXT` (023:206) — no `employee_id` | Per-employee UUID keying for KPIs, SLA, cost, approvals. | 🔴 |
| EMP-G04 | P1 | Customer card lacks `shopify` | CE-06 reachable; migration backfill. | 🔴 |
| EMP-G05 | P1 | `outage-buffer.ts` 0 importers | OE-10 durable outbound buffer into `guardedSendActivity` failures. | 🔴 |
| EMP-G06 | P1 | `dedup.ts:49-60` | OE-06 real CRM merge (HubSpot merge API) behind approval. | 🔴 |
| EMP-G07 | P1 | No delegation tool; hand-off = text + event (`ask-ai/route.ts:834-903`) | Employee→employee delegation protocol (work item assigned to target, context carried, report back). | 🔴 |
| EMP-G08 | P1 | Webhook picks first-created active employee (`webhooks/whatsapp/route.ts:165-172`) | Channel→employee assignment config; sticky per contact. | 🔴 |
| EMP-G09 | P2 | `employees/page.tsx:61-74` 12 hardcoded tools | Tool picker from catalog filtered by connected channels + persona denials. | 🔴 |
| EMP-G10 | P2 | `crew-contract.ts:11` and `shared-types/crew.ts:6` both define `MAX_CREW_SPAWN`; four spec files say "code 8" | Single constant; fix docs (cap **is** 3). | 🔴 |

## 5. Enterprise readiness

| ID | Gap | Evidence | Status |
|---|---|---|---|
| EMP-E01 | Per-employee KPIs / SLA / scorecard | Only org-level `computeSilentMetrics`; `stats/route.ts` fake rate | 🔴 |
| EMP-E02 | Performance reviews / approval rate per employee | `canAdvanceStage` org-wide (`org/rollout/route.ts:65`) | 🔴 |
| EMP-E03 | Versioning / config history / prompt A/B | No `prompt_version`, no `employee_prompt_history` (proposed `employees.md:370-423`) | 🔴 |
| EMP-E04 | Per-employee cost budgets | `org_cost_ceilings` / `org_model_spend` org-level (029); `cost/track.ts` no employee field | 🔴 |
| EMP-E05 | Marketplace / templates | Only `DEFAULT_EMPLOYEE_ROSTER` (`employee-provision.ts:104-187`) | 🔴 |
| EMP-E06 | Custom employee builder (skills, memory scope, schedule, model) | POST accepts name/role/persona/tools only (`employees/route.ts:107-135`) | 🔴 |
| EMP-E07 | Escalation as *decisions* | ✅ `parkPendingAction` → `work_items(type='decision')` + Slack (`autonomy.ts:414-493`); unreachable from `executeProvider` paths (S02) | 🟡 |
| EMP-E08 | 24/7 scheduling / shifts | Quiet hours fixed 21→08 (`quiet-hours.ts:6-7`); no per-employee schedule | 🔴 |
| EMP-E09 | Multi-language | No locale on `ai_employees`; prompts English-only | 🔴 |
| EMP-E10 | Audit of roster changes | `employees/route.ts` / `[id]/route.ts` never `recordAuditEvent` | 🔴 |
| EMP-E11 | Per-employee autonomy rules UI | `employee_autonomy_rules.employee_role` supported (023:266) but seeds role-NULL; `loadRule` matches role string not id | 🔴 |

## 6. Dead / duplicate / drift

- **Dead:** `employee-gate.ts`, `employee-metrics.ts`, `cold-start.ts`, `autonomy.ts:seedDefaultAutonomyRules`, `operations/outage-buffer.ts`, `employee_authority_policies` (025:66), `ai_employees.graph_id` (written, never read), `WorkItemRouteInput.preferredEmployeeId`, `growth-sales.ts:matchHandoff`.
- **Duplicate:** `DEFAULT_AUTONOMY_SEED` ×2; `EmployeeGateInput/classifyActionSurface` ×2; `normalizeEmployeePersona`/`filterAllowlistForPersona` ×2 with opposite semantics; `MAX_CREW_SPAWN` ×2; `CORE_TOOLS` (`ask-employee.ts:14-24`) drifted from `ALWAYS_ALLOWED_CORE_TOOLS`; `parseToolAllowlist` ×2 with different fallbacks; `consumeOutboundBudget` ×2.
- **Roster vs migrations:** `114_research_executive_employee.sql` backfills **only Executive** (no Research row despite filename) and ignores `orgs.employees_seeded`. 110–113 backfill by `role =` string; renaming a seeded role (B11) detaches it from every backfill.
- **Docs vs code:** `3-employee.md:22` GE-05 ✅ vs never started; `employees.md:1-8` header stale; four spec files "crew cap code 8" — false; `agent-governance.md:236-241` "no live bug in wired modules" contradicted by S01/S02; `employees.md:47-51` custom hires bypass autonomy — fixed at `employee-provision.ts:335`.

## 7. Test coverage map

| Area | Present | Not covered |
|---|---|---|
| Router | `route-employee.test.ts` | emergency false positives (B01), custom-only roster (B03), collisions (B04), tie-break |
| Mentions / mode | `ask-mode.test.ts`, `ask-mode-selection.test.ts` | inactive mention in team mode; archived ids |
| Allowlist | `ask-employee-locked-allowlist`, `role-scoped-tools`, `employee-capabilities`, `local-tool-select` | core drop for persona roles (B10); executor empty-allowlist widening (B05) |
| Hand-offs | customer, growth-sales, operations, marketing-finance | **no research-executive test**; false positives (B07) |
| Crews | `crew-contract`, `crew-fixed-members`, `crew-planner`, `crew-concurrency-lease`, `workflows-corrected` | CrewWorkflow e2e, cancellation, spend fail-open |
| Governance | `autonomy`, `employee-gate`, `employee-metrics`, `cold-start`, `employee-rollout`, `untrusted`, `critic-check`, `inbound-hitl` | kill switch reach, stage enforcement in executor, `guardedSendActivity`, quiet-hours wrap, periodic-registry |
| Engines | growth/customer/operations pure-function tests, `state-machines` | activities using `executeProvider`; DormantLeadRevival scheduling |
| API / UI | `employee-metrics-query`, `employee-observability`, `onboarding-cold-start` | `/api/employees` CRUD, `[id]` validation, stats formula, employees page, CrewSpawnPanel |

## 8. Fix order for this domain

1. **EMP-S01** — one `assertOrgRunnable(orgId, employeeId)` (kill switch + org status + rollout stage) called in `tool-executor` before any execution, in `AutonomousAgentWorkflow`, `CrewWorkflow`, every periodic sweep, and the webhook entry.
2. **EMP-S02 / S08 / B08** — delete direct `executeProvider` use from activities; everything external goes through `tool-executor` → `checkAutonomy` → critic → quiet hours → ledger, with idempotency keys.
3. **EMP-B01 / B02 / B03 / B05** — router never returns org-union in chat; empty card = core-only; custom employees routable.
4. **EMP-S03 + EMP-G01** — wire `employee-gate` (stage) and `employee-metrics` (bands) into the executor and a daily per-employee snapshot.
5. **EMP-G02** — schedule DormantLeadRevival; single sweep list (B16); suspend terminates sweeps (S11).
6. **EMP-G03** — `employee_id UUID` on ledger, metrics, autonomy rules; migrate from role strings.
7. **EMP-S04 / S05 / S06** — critic + per-customer cap + quiet hours on every outbound path.
8. **EMP-B09 / B10 / B04 / B07** — explicit `rosterKey`, one persona module, phrase-level routing, anchored hand-offs; add eval set (ENT-06) with ≥30 prompts per employee.
9. **EMP-E03 / E04 / E06** — employee config versioning, per-employee budgets, builder UX (schedule, memory scope, model).
10. **EMP-G07** — delegation protocol as a first-class tool.
