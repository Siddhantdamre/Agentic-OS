# 10 — AI Employees: Spec vs Code, Missing Capabilities, and New Roles (2026-10-09)

> Scope: every employee in the default roster
> (`apps/dashboard/lib/employee-provision.ts:63-158`) plus org-created custom
> employees. For each: job, tool card, persona and system prompt, role
> capability rules, routing, memory scope, hand-offs, periodic sweeps,
> metrics, and chat capabilities, comparing the specs
> (`gap26sept/employees/*.md`, `plan/01-03`, `3-employee.md`) with the code
> on `main` at `c8ad0ab1`. Code wins. The second half proposes new employees.
>
> Companion document: `09-agent-runtime-and-memory-gaps.md` (runtime, memory,
> autonomy). IDs from that document (R-1, M-1, A-6, …) are referenced here
> instead of repeated.
>
> Status legend: **Works** (wired, code-verified, not necessarily proved live
> from `/ask-ai`), **Broken** (wired but wrong), **Missing**. Priority P0–P2,
> effort S/M/L/XL as in document 09.

---

## 0. Executive summary

Nine employees are seeded for every org: Customer, Operations, Growth, Sarah
(Sales & Lead Gen), Emma (Customer Support), Marcus (Marketing & Analytics),
Research, Executive and Finance. Each has a real tool card, a persona text, an
additive role block in the system prompt, a persona family that drives tool
and action denials, a router entry and hand-off rules for locked Ask AI turns.
That foundation is solid and well tested (`employee-capabilities.test.ts`,
`route-employee.test.ts`, `role-capability.test.ts`).

The gaps are of four kinds:

1. **Background work runs as the wrong employee.** Every Growth sweep
   activity calls the gate with `employeeRole: 'marketing'`
   (`services/workflows/src/activities/growth.ts:157,597,638,714,747,762,791,841,916`).
   The gate resolves that to Marcus, whose card has no `apollo`, `hubspot`,
   `google-calendar` or `slack`. The Apollo lookalike search (GE-01), Market
   Scout CRM insert (GE-02), meeting dossier calendar read and Slack post
   (GE-07) and the hot-lead Slack alert (GE-09) are denied
   `not_in_allowlist` on every pass, and the activities swallow the denial
   (`.catch(() => null)`, `searched: false`). `3-employee.md` marks all four
   "✅ Done". This is the single largest employee-level defect. **P0, S.**
   Operations' meeting-prep sweep likewise runs as Executive
   (`activities/meeting-prep.ts:48,97,117,138`).
2. **Six of nine employees have no background work at all.** Only Growth,
   Customer and Operations own sweeps. Sarah, Emma, Marcus, Research,
   Executive and Finance act only when asked in chat. "Works 24/7" is true for
   three employees.
3. **Per-employee memory is empty** (`employee_memory` has no writer,
   09 §M-1), and the system prompt tells Customer and Emma to use
   `cognee_memory_remember`, which neither card grants (09 §M-6).
4. **Several jobs in the persona text have no tool**: Finance "invoices" has no
   invoice-create tool, Customer "order corrections" has no Shopify tool on its
   card, Marcus has no write or campaign tool at all, Sarah has no quote or
   proposal tool, and nobody can send an e-signature envelope although
   DocuSign and Leegality tools exist.

Top fixes:

| # | Fix | Priority | Effort |
|---|-----|----------|--------|
| 1 | Run Growth sweeps as Growth (`employeeRole: 'growth'` or the Growth employee id) and stop swallowing gate denials in sweep activities | P0 | S |
| 2 | Pass employee id end to end (09 R-1) so two employees with the same role, and custom hires, are gated by their own card | P0 | S |
| 3 | Run Operations meeting prep as Operations; add `google-calendar` already on its card | P1 | S |
| 4 | Give each roster employee at least one owned sweep or scheduled task (§3) | P1 | L |
| 5 | Close the persona/card mismatches listed per employee | P1 | M |
| 6 | Agent-to-agent hand-off inside a turn and on inbound channels, not only an Ask AI button | P1 | M |
| 7 | Per-employee scorecard from one metric source (§4) | P1 | M |

---

## 1. Roster as built

| Name | Role string | Persona family (`role-capability.ts:29-41`) | Router key (`route-employee.ts:15-23`) | Card (`employee-provision.ts`) |
|---|---|---|---|---|
| Customer | Customer Resolution | `customer` | `support` (prefers `/customer/`) | gmail, whatsapp, google-calendar, stripe, hubspot, zendesk, intercom, customer-ops, database_query (`:68`) |
| Operations | Operations | `operations` | `ops` | hubspot, database_query, google-calendar, google-sheets, slack, gmail, operations, re (`:75`) |
| Growth | Growth | `growth` | `sales` (prefers `/growth/`) | hubspot, web_search, web_extract, apollo, gmail, slack, growth (`:82`) |
| Sarah | Sales & Lead Gen | `sales` | `sales` (prefers `/sarah|sales/`) | gmail, whatsapp, hubspot, salesforce, zoho-crm, apollo, linkedin, google-calendar, re (`:89`) |
| Emma | Customer Support | `customer` | `support` (prefers `/emma|customer support/`) | gmail, whatsapp, google-calendar, customer-ops (`:96`) |
| Marcus | Marketing & Analytics | `marketing` | `ops` (prefers `/marcus|marketing/`) | meta-ads, google-ads, gmail, google-analytics, google-search-console, google-business-profile (`:103-110`) |
| Research | Research | none (null) | `research` | web_search, web_extract, google-drive, notion (`:121`) |
| Executive | Executive | none (null) | `executive` | web_search, database_query, cognee, daily_brief, gmail, google-calendar, google-drive, google-docs, google-sheets, google-slides, slack (`:132-146`, migration `210_executive_workspace_tools.sql`) |
| Finance | Finance | `finance` | `finance` | stripe, razorpay, quickbooks, billing_usage (`:155`) |

Always available to every card as core reads (`tool-gate.ts:20-28`):
web_search, web_extract, database_query, metrics, connectors status. Never
implicit (`tool-gate.ts:31-34`): sandbox/code execution, file_ops,
cognee remember, maps.

Observations that apply to the whole roster:

- **Two router keys are shared.** Growth and Sarah both map to `sales`;
  Marcus and Operations both map to `ops`. The tie is broken by `prefer`
  regexes. `RosterKey` has no `marketing` or `growth` value
  (`route-employee.ts:15-23`). Add them so analytics and routing stop
  conflating roles. P2, S.
- **Two persona families are shared.** Customer and Emma are both
  `customer`; they get the same token budget and filters. The gate's
  role-only lookup (`pickEmployeeForRole`, `tool-executor.ts:207-222`) picks
  whichever was created first when a sweep asks for `'customer'`. Fixed by
  09 R-1.
- **Research and Executive have no persona family** (`normalizeEmployeePersona`
  returns null), so no denials and the default 3 000-token memory budget apply.
  Executive's persona says "Never send, pay, or run ads", but its card now
  carries `gmail` and `slack` and nothing denies send actions; sends still park
  for approval as confirm class. Decide which is right (§2.8).
- **Persona substring matching is fragile.** `'isa'` maps to operations and
  `'lead'` to sales (`role-capability.ts:37-39`), so a custom "Lead
  Researcher" becomes `sales` and "Data Analytics Lead" becomes `marketing`.
  Use `rosterKey` from the
  persona JSON first, substring match only as a fallback. P2, S.
- **Persona text is stored two ways**: plain strings for the first six,
  JSON with `text`, `rosterKey`, `confirmClasses` for the last three. Only the
  JSON form carries a `rosterKey`, which the gate prefers
  (`tool-executor.ts:189-200`). Backfill JSON personas for all nine. P2, S.

---

## 2. Cross-cutting gaps that affect every employee

### 2.1 Identity and permissions

- **E-X1 (P0, S): gate identity by role name.** See 09 R-1 and B-0. Until
  employee id is passed, a chat turn "as Emma" can be gated against Customer's
  card (same persona family) and a custom hire whose role equals a roster role
  borrows the roster card.
- **E-X2 (P1, S): sweeps attribute work to the wrong employee.** Growth →
  Marcus (all Growth sweeps), Operations → Executive (meeting prep). Ledger,
  metrics and approvals are filed under the wrong name. Fix: every sweep
  resolves its owning employee id once per pass (`pickEmployeeForRole` with
  the correct role, or better a `rosterKey` lookup), passes `employeeId`, and
  ends the pass with a `suppressed: owner_inactive` ledger row when that
  employee is paused or archived.
- **E-X3 (P1, S): sweep activities hide denials.** `executeAutonomousToolAction(...).catch(() => null)`
  turns a policy denial into "nothing found". Fix: log the gate result's
  `reason` to the decision ledger and surface "Growth could not search Apollo:
  not on its card" on the employee profile.

### 2.2 Hand-offs

What exists: rule catalogs per family in `apps/dashboard/lib/handoffs/`
(`customer.ts`, `operations.ts`, `growth-sales.ts`, `marketing-finance.ts`,
`research-executive.ts`, `custom.ts`), evaluated only for **locked** Ask AI
turns (`ask-ai/route.ts:60,645,886-932`), producing a "Hand to <Name>" button.

Missing:

| ID | Gap | Priority | Effort | Fix |
|---|---|---|---|---|
| H-1 | No in-turn delegation. An employee cannot ask another employee to do a sub-task and use the result (for example Customer asking Finance for a payment link mid-conversation). The only multi-employee path is a crew started up front. | P1 | M | Add a `handoff_to_employee` tool (internal, draft risk) that starts a child `AutonomousAgentWorkflow` as the named employee with its own card, waits up to N seconds, and returns the child's reply. Cap depth 1, count against the crew cap. |
| H-2 | No hand-off on inbound channels. `WorkItemWorkflow` routes once at the start; if Customer cannot do the request (payment link), the customer gets "I can't" instead of Finance doing it. | P1 | M | Reuse the same rules in the worker; on a match, reassign the work item to the target employee and run its turn. |
| H-3 | Hand-off rules live in the dashboard (`apps/dashboard/lib/handoffs`), router rules in the worker (`route-employee.ts`), and prompt hand-off text in `system-prompt-builder.ts`. Three sources for one concept. | P2 | M | Move the rule catalog to `services/workflows/src/handoffs/` and generate the prompt lines from it. |
| H-4 | Auto mode does not offer hand-offs; only locked turns do. | P2 | S | Offer when the router's confidence is under 0.5 and a rule names a better owner. |

### 2.3 Memory scope

Per-persona budgets and tier filters exist (`memory/retrieve.ts:27-34,683-728`).
But (09 §6.3): `employee_memory` is never written, `facts` is never written,
`entityId` is never passed. For each employee below, "memory scope" therefore
means "org + entity + conversation tiers with the listed budget and filter".
The fixes are in 09 M-1..M-6 and are not repeated per employee.

### 2.4 Periodic work

| Owner | Sweeps (`periodic-registry.ts:35-54`) | Event workflows |
|---|---|---|
| Growth | GrowthWatcher (signals, 4 h), MarketScout (daily), MeetingDossier (30 min), ReplySorter (20 min), DormantLeadRevival | NurtureWorkflow, StaleChaseWorkflow, InsightActionWorkflow |
| Customer | OpenLoopMonitor, ConversationalInsight | CustomerRecoveryWorkflow, WorkItemWorkflow (inbound) |
| Operations | MorningCheck (09:00 local), StuckWorkDetector (hourly), RepFollowUpSla (hourly), WorkloadBalancer (15 min), MeetingPrep, SystemReconciliation | RentReminderWorkflow, ShowingReminder/ScheduleWorkflow |
| Platform | GovernanceSweep (15 min) | DSR, billing, DLQ, embed, ingest |
| Sarah, Emma, Marcus, Research, Executive, Finance | **none** | none |

All 14 sweeps start for every active org regardless of which employees exist
(09 T-2).

### 2.5 Metrics

Per-employee metrics exist in two unconnected places:
- Work-item counts, completion rate and average resolution per
  `assignee_employee_id` (`apps/dashboard/lib/employee-performance.ts`,
  `/api/employees/[id]/metrics`).
- Health bands per role in `org_employee_metrics_daily`
  (`apps/dashboard/lib/employee-metrics-query.ts:320`), with
  `employee_role`, not employee id.

The worker's `recordEmployeeMetrics` persists nothing
(`services/workflows/src/employee-metrics.ts:100-112`). Decision cards carry
no employee id (09 A-5). Fix in §4.

### 2.6 Prompts

- One shared scaffold plus additive role blocks
  (`prompts/system-prompt-builder.ts:108-157`). Role blocks are matched by
  substrings of role and name, so a custom "Customer Success" hire gets the
  Customer Resolution block (`:29`) including its refund guidance.
- The shared "Executive Quality Standard" and "End-to-End Ownership: do not
  stall with 'Would you like me to proceed?'" lines (`:137-140`) apply to
  every employee, including Customer on WhatsApp, where a confirming question
  is often correct. Move them into the Executive block.
- No prompt versioning. `employeeDecisionLogFields` has a `prompt_version`
  field (`employee-metrics.ts:82`) that nothing fills. Add a version constant
  per role block and record it on the trace. P2, S.

### 2.7 Employee settings that do not exist yet

| Setting | Use | Priority | Effort |
|---|---|---|---|
| Working hours / on-call per employee | Emma answers 24/7, Sarah only in business hours, outbound respects them | P2 | M |
| Model profile per employee | 09 R-M4 | P2 | M |
| Channel ownership (which WhatsApp number / inbox an employee answers) | Today routing decides per message; no "Emma owns support@" | P1 | M |
| Escalation contact per employee (human manager) | Decision cards go to the org's Slack channel; no per-employee approver | P1 | M |
| Per-employee autonomy rules | Rules are org-wide with optional `employee_role`; no UI per employee, no employee id | P1 | M |
| Per-employee spend cap | 09 C-4 | P2 | M |

### 2.8 Decisions the product owner needs to make

1. Executive: coordinator with send tools (current card) or read-and-brief
   only (persona text and `executive.md`)? Recommendation: keep drafts
   (`gmail_draft_email`, docs, sheets, slides), drop `gmail` send and Slack
   post from the card; sends go through the owning specialist.
2. Who owns the morning brief: Operations (blueprint OE-01/OE-02, sweep
   `MorningCheckWorkflow`) or Executive (router `DAILY_BRIEF_RE`, `daily_brief`
   tool)? Today the sweep is Operations, the chat tool is Executive. Recommend
   Operations produces, Executive presents.
3. Growth vs Sarah boundary for Apollo and CRM writes. Both cards have
   `apollo` and `hubspot`. Recommend Growth finds and scores, Sarah writes
   CRM and talks to people.

---

## 3. Per-employee audit

Each section: spec summary, card and prompt check, capabilities table
(works / broken / missing), sweeps, memory, hand-offs, metrics, and a numbered
list of missing capabilities with fix steps.

### 3.1 Customer (Customer Resolution)

**Spec.** End-to-end resolution: lookup across CRM, tickets and payments,
policy-grounded refunds, replies on mail and WhatsApp, rescheduling, open
loops, churn risk, knowledge gaps (`gap26sept/employees/customer-resolution.md`,
`plan/02_customer_employee.md` 12-step engine, `3-employee.md` CE-01..CE-10).

**Card and prompt.**

| Check | Result | Evidence |
|---|---|---|
| Card matches persona | Mostly. Persona promises calendar scheduling, refunds, CRM/ticket lookup, follow-ups; all on card. | `employee-provision.ts:67-68` |
| Persona tells it to use `cognee_memory_remember` | **Card lacks `cognee`**; tool is never-core, so every call is `not_in_allowlist` | `employee-provision.ts:67`; `tool-gate.ts:33` |
| Address correction (CE-06) | **No Shopify on card**; no `shopify_update_order_address` chat tool exists (only `shopify_fetch_products`, `shopify_fetch_orders`) | `tool-definitions.ts`; `3-employee.md` CE-06 |
| Persona denials | Denies apollo, linkedin, ads tools; denies `delete`, `create_deal`, `update_deal`, `create_crm`, `cold` actions | `role-capability.ts:5,14` |
| Prompt block | Customer Resolution block | `system-prompt-builder.ts:29-34` |

**Capabilities.**

| Capability | Tool(s) | State | Notes |
|---|---|---|---|
| Inbound fast-ACK and async reply (CE-01) | webhooks → `WorkItemWorkflow` | Works | Inbound always solo |
| Account profile (CE-02) | `customer/account-profile.ts` | Works, but calls providers raw | `account-profile.ts:139-157` uses `executeProvider` (no gate, no audit). Reads only; route through the gate for audit (P2, S). |
| Policy RAG + refund eligibility (CE-03) | `retrieveForEmployee` | Works | Requires `customerIdentifier`; Ask AI path has none, so chat refund questions get no eligibility citation |
| Reschedule (CE-04) | `calendar_update_event` | Works with approval | Not "100% automatic": update is gated; see 09 A-6 |
| Refund (CE-05) | `stripe_create_refund` | Works, always approval | Policy re-derived from Stripe |
| Address correction (CE-06) | — | **Missing in chat** | Executor action exists in `tools/shopify.ts`; no tool definition; card lacks shopify |
| Open loops (CE-07) | `OpenLoopMonitor`, `customer_list_open_loops` | Works | Sends via `guardedSend` as role `customer` (ambiguous with Emma) |
| Decision cards + Slack push (CE-08) | gate park | Works | |
| Churn radar (CE-09) | `CustomerRecoveryWorkflow`, `customer_list_at_risk` | Works | Slack alert via raw `executeProvider` (`activities/customer.ts:119`), intentional operator-internal |
| Knowledge gaps (CE-10) | `knowledge-gap-clusters.ts` | Works (surfacing) | No loop that re-tests after an answer is added (09 §12.3) |
| Tickets | `zendesk_*`, `intercom_*` | Works | |
| Outlook / Slack / Instagram replies | via connected channels merge | Partial | Not on card; only present when the channel is connected and merged (`mergeRuntimeAllowlist`). Locked turns use channels on the card only (`ask-employee.ts:62-96`). |
| Subscription changes (pause, downgrade, cancel) | — | **Missing** | Plan scenario B (`plan/02…md` §5) needs Stripe subscription update |
| Credit / coupon | — | **Missing** | |
| Order status lookup | `shopify_fetch_orders` | Not on card | |
| Return label / RMA | — | **Missing** | |
| CSAT survey after resolution | — | **Missing** | |

**Memory.** Budget 1 800, graph tier excluded, conversation tier limited to the
current thread in SQL (`memory/retrieve.ts:27,392-395,690-700`). Entity filter
inactive (no `entityId`, 09 M-3).

**Hand-offs.** Payment links → Finance; reconcile → Operations; prospecting →
Growth/Sales (`lib/handoffs/customer.ts`). Locked Ask AI only (H-1, H-2).

**Metrics today.** Work-item completion and resolution time per employee id;
approval stats only by role.

**Missing capabilities and fixes.**
1. *Shopify order tools.* Add `shopify_update_order_address`,
   `shopify_get_order` definitions (executor exists for the address change),
   add `shopify` to the card via migration (additive, like `110_*`), mark
   address change as `draft`→ approval. P1, S.
2. *Subscription management.* Add `stripe_update_subscription`
   (pause/resume/cancel at period end) and `stripe_list_subscriptions`;
   risk `pay` for cancel/downgrade so it parks. P1, M.
3. *Coupons and credits.* `stripe_create_credit_note` / balance transaction,
   capped by policy like refunds. P2, M.
4. *Remember via proposals.* Grant `cognee` once remember becomes a
   proposal (09 M-6), or remove the instruction from the persona. P1, S.
5. *Entity resolution at turn start* for inbound (09 M-3) so it only cites
   this customer. P1, S.
6. *CSAT.* After a work item closes, send a one-question survey on the same
   channel (approval tier configurable), store score on the work item; feed the
   scorecard. P2, M.
7. *Hand-off in-turn to Finance* for payment links (H-1). P1, M.
8. *Gate the account profile reads* for audit (above). P2, S.

### 3.2 Emma (Customer Support)

**Spec.** Front-line FAQs, inbox triage, scheduling; hands refunds, CRM,
payments and tickets to Customer (`gap26sept/employees/customer-support.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs persona | Match: gmail, whatsapp, calendar, customer-ops | `employee-provision.ts:95-96` |
| Persona tells it to use `cognee_memory_remember` | **Card lacks `cognee`** | `:95` |
| Inbox triage routing | Router claims inbox-triage phrasing only (2026-10-05 fix) | `BUILD_STATE.md`; `route-employee.ts` |
| Same persona family as Customer | Yes (`customer`); same filters | `role-capability.ts:38` |

**Capabilities.**

| Capability | State | Notes |
|---|---|---|
| FAQ answers from Brain | Works | Grounded by retrieval; low-RAG gate on inbound |
| Gmail read/search/reply/draft | Works | reply parks |
| WhatsApp list/send | Works | send parks |
| Calendar booking | Works | |
| Open loops / at-risk (read) | Works | |
| Outlook, Slack, Instagram inboxes | **Not on card** | Only when the channel is connected and merged; locked turns strip channels not on the card |
| Triage sweep (label, prioritise, draft replies overnight) | **Missing** | Emma has no sweep |
| FAQ suggestions from repeated questions | **Missing** | Knowledge-gap clusters are attributed to Customer |
| Ticket creation | Hand-off only | By design |

**Missing capabilities and fixes.**
1. *Inbox triage sweep* (`SupportTriageWorkflow`, every 15 min in business
   hours): fetch unread Gmail/Outlook, classify (FAQ, refund, sales, spam),
   draft replies for FAQ (draft risk, no send), create work items assigned to
   Customer/Sarah for others, never send. Register in `PERIODIC_SWEEPS` with
   owner `support`. P1, M.
2. *Multi-inbox card.* Add `microsoft-outlook`, `instagram` and `slack` (read
   + reply) to Emma's card by migration so locked turns can answer there.
   P1, S.
3. *FAQ drafting from gaps.* When a knowledge-gap cluster reaches N, draft a
   proposed FAQ answer into `memory_proposals` (09 M-6) for admin approval.
   P2, M.
4. *Grant `cognee`* (search) and remember-as-proposal. P1, S.
5. *Separate identity from Customer* in sweeps and approvals (E-X1). P0, S.
6. *Auto-acknowledge with SLA promise* (draft risk) on new inbound when no
   answer is possible within N minutes; creates an open loop. P2, S.

### 3.3 Operations

**Spec.** Expected-vs-actual engine, 09:00 brief, SLA enforcement, dedup,
data hygiene, calendar integrity, stuck work, load balancing, outage buffer
(`plan/03_operations_employee.md` nine workflows, `3-employee.md` OE-01..OE-10,
`gap26sept/employees/operations.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs persona | Match | `employee-provision.ts:74-75` |
| Persona denies sends | `send_email`, `send_channel`, `send_external`, `draft_email` denied, **but soft when gmail/slack on card** | `role-capability.ts:15,78-97` (09 G-4) |
| Meeting prep sweep identity | Runs as **Executive** | `activities/meeting-prep.ts:48,97,117,138` |
| Rep SLA, workload balancer identity | Operations | `activities/rep-followup-sla.ts:64,112`; `activities/workload-balancer.ts:88` |

**Capabilities.**

| Capability | State | Notes |
|---|---|---|
| Morning check and brief (OE-01/02) | Works | Brief delivered to Slack/WhatsApp; once-per-day claim |
| Expected vs actual (OE-03) | Works | Declarative rule registry |
| Rep follow-up SLA (OE-04) | Works | Ledgered |
| Workload balancer (OE-05) | Works | HubSpot `reassign_owner` |
| Dedup on contact create (OE-06) | Works (report and redirect); chat tool is report-only | No HubSpot merge API call |
| Field backfill (OE-07) | Works through the gate as creator | |
| Calendar deadlocks (OE-08) | Works, wrong identity | Runs as Executive |
| Stuck work (OE-09) | Works | |
| Outage buffer (OE-10) | Works | |
| Reconciliation, sheets, work items, discrepancies, rent reminders, showings | Works (chat tools) | `tools/operations.ts` |
| SOP drift sync (plan workflow 7) | **Missing** | Stale knowledge flag is visual only (`brain.md` broken 11) |
| Incident buffering visible in brief | Partial | |
| "Why did / didn't you" explanations (plan §4) | **Partial** | Ledger rows exist; no chat tool reads them |
| Vendor / inventory / order ops (non-CRM businesses) | **Missing** | |

**Missing capabilities and fixes.**
1. *Correct identity for meeting prep.* Change `employeeRole: 'executive'`
   to the Operations employee id. P1, S.
2. *Hard send denial.* Operations drafts and hands off; make `send_*` denials
   hard (09 G-4). P1, S.
3. *Explain tool.* `ops_explain_decision` reads `agent_decision_ledger` for an
   entity or action and answers "why did/didn't you" with reason codes and
   confidence; read risk. P1, S.
4. *CRM merge.* Add HubSpot merge (`/crm/v3/objects/contacts/merge`) as an
   approval-gated action for ≥ 0.95 matches. P2, M.
5. *SOP drift sweep.* Weekly: for each `knowledge_sources` row with an
   external source, compare hash with the source; re-sync or create a work
   item when changed. P2, M.
6. *Generic "expected" rules from chat.* `ops_add_expectation` (draft) so a
   user can say "every new lead must get a reply within 1 hour" and it becomes
   a rule in `OPERATIONAL_EXPECTATION_RULES` storage. P2, M.
7. *Outage status in chat.* `ops_outage_status` read tool over the buffer.
   P2, S.

### 3.4 Growth

**Spec.** ICP from closed-won, lookalikes, buying signals, visitor intent,
dormant revival, why-now, dossiers, drafts, reply sorting, preference learning
(`plan/01_growth_employee.md` eight sub-skills, `3-employee.md` GE-01..GE-10,
`gap26sept/employees/growth.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs persona | Match for chat | `employee-provision.ts:81-82` |
| **Sweep identity** | **All Growth sweeps run as `marketing` (Marcus)** | `activities/growth.ts:157,597,638,714,747,762,791,841,916` |
| Persona denials | Denies stripe, shopify, zendesk, intercom, razorpay; actions delete, refund | `role-capability.ts:4,13` |
| Memory | Budget 1 600; conversation and graph tiers excluded; facts-first (empty, 09 M-2) | `memory/retrieve.ts:29,717-718,744-746` |

**Effect of the identity bug per feature** (gate resolves `marketing` →
Marcus; Marcus card: meta-ads, google-ads, gmail, GA, GSC, GBP):

| Feature | Tool called | Allowed for Marcus? | Result |
|---|---|---|---|
| GE-01 lookalike Apollo search | `apollo.search_people` (`:153,593`) | No | Denied every pass; candidates empty |
| GE-02 Market Scout CRM insert | `hubspot.create_crm_contact` (`:634`) | No | Denied; falls back to opportunity card only |
| GE-07 dossier calendar read | `google-calendar.list_events` (`:710`) | No | Denied; no dossiers |
| GE-07 dossier web research | `web_search`, `web_extract` (`:743,758`) | Yes (core) | Runs, but unused without events |
| GE-07 dossier Slack post | `slack` (`:787`) | No | Denied |
| GE-09 reply sorter Gmail fetch | `gmail` (`:837`) | Yes | Works |
| GE-09 hot-lead Slack alert | `slack` (`:910`) | No | Denied |
| GE-03 signals | Jina (direct fetch) | n/a | Works |
| GE-05 dormant revival, GE-06 why-now, GE-10 preferences | DB + LiteLLM | n/a | Works |

**Capabilities in chat.**

| Capability | Tool | State |
|---|---|---|
| Lookalike / people search | `apollo_search_people`, `apollo_enrich_company` | Works when Apollo connected |
| Dormant leads | `growth_list_dormant_leads` | Works |
| Pipeline attribution, ROI | `growth_list_pipeline_attribution`, `growth_pipeline_roi` | Works |
| Outreach drafts | `gmail_draft_email` | Works (draft) |
| ICP build / refresh | — | **Missing in chat** (Temporal only, `loadOrBuildIcpActivity`) |
| Signals for an account | — | **Missing in chat** (`lead_intent_signals` not exposed) |
| Sequences (multi-step outreach) | — | **Missing**; Nurture/StaleChase are internal workflows, not user-defined sequences |
| LinkedIn outreach | — | By design Sales-owned |

**Missing capabilities and fixes.**
1. *Fix sweep identity* (P0, S): replace `employeeRole: 'marketing'` with
   `'growth'` (or the Growth employee id) in all nine calls; add a unit test
   that every sweep's tool is on its owner's seeded card.
2. *Surface denials* (E-X3). P1, S.
3. *ICP chat tools* (P1, S): `growth_build_icp` (internal write, runs
   `loadOrBuildIcpActivity`) and `growth_get_icp` (read).
4. *Signals chat tool* (P1, S): `growth_list_signals(account?)` over
   `lead_intent_signals`.
5. *User-defined sequences* (P2, L): `growth_sequence_create` storing steps
   (day offsets, channel, template); each step's send parks unless an owner
   pre-approves the template (09 A-6).
6. *Visitor intent (GE-04) attribution to Growth* — the widget path creates
   growth opportunity cards in the dashboard (`lib/visitor-enrich.ts`); confirm
   the card's assignee is the Growth employee id (A-5). P2, S.
7. *Cross-employee negative constraints* (blueprint §6 "SOC2 loop"): when
   Customer logs a churn reason, write an `org_preferences` suppression that
   Growth's scoring reads. P2, M.

### 3.5 Sarah (Sales & Lead Gen)

**Spec.** Qualify inbound leads, demos and pricing, CRM upkeep, deals,
scheduling, approved outreach (`gap26sept/employees/sales-lead-gen.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs persona | Match; broad CRM (HubSpot, Salesforce, Zoho), Apollo, LinkedIn, calendar, `re` | `employee-provision.ts:88-89` |
| Persona family | `sales` (fixed from `customer`) | `role-capability.ts:37` |
| Denials | ads tools; delete, refund | `role-capability.ts:7,16` |
| Memory | Budget 1 600; keeps conversation tier | `memory/retrieve.ts:30,705-712` |

**Capabilities.**

| Capability | State | Notes |
|---|---|---|
| CRM contacts, leads, deals in three CRMs | Works | Writes are draft/internal risk; deal tools on all three |
| Apollo/LinkedIn enrichment | Works when connected | |
| Scheduling demos | Works | |
| Inquiry → listing match | Works (cards, no send) | |
| Outreach send | Works, always approval | |
| Lead qualification scoring (BANT/MEDDIC) stored on the lead | **Missing** | Dialogue only; nothing persists a score |
| Quotes / proposals | **Missing** | No quote tool; Docs/Slides are on Executive's card, not Sarah's |
| E-signature | **Missing on card** | `docusign_*`, `leegality_*` tools exist; on no card |
| Meeting notes → CRM | **Missing** | No transcript ingestion |
| Inbound lead speed-to-lead | **Missing** as Sarah's own sweep | Rep SLA is Operations nudging humans, not Sarah replying |
| Pipeline review | Partial | `hubspot_list_deals`; no stage-aging summary tool |

**Missing capabilities and fixes.**
1. *Speed-to-lead sweep* (P1, M): on new inbound lead (form, widget, CRM
   create), Sarah drafts a first reply within minutes; send parks unless the
   org pre-approves the template; open loop created.
2. *Qualification record* (P1, S): `sales_qualify_lead` writes a structured
   score (budget, authority, need, timeline, notes) to the CRM contact and
   `entity_memory`.
3. *Quote and proposal* (P1, M): add `google-docs` and `google-slides` to the
   card; add `sales_create_quote` that fills a template doc from deal data;
   link it on the deal.
4. *E-signature* (P1, S): add `docusign` or `leegality` to the card (org's
   choice); send envelope is `sign` risk → approval.
5. *Pipeline aging* (P2, S): `sales_pipeline_review` read tool: deals by stage
   and days in stage, with next step.
6. *Meeting notes* (P2, M): ingest Google Meet transcripts (Meet tool exists)
   after calls, summarise to the deal, create follow-up tasks.

### 3.6 Marcus (Marketing & Analytics)

**Spec.** Campaign performance, ad conversions, feedback signals, market
trends (`gap26sept/employees/marketing-analytics.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs persona | Read-only analytics + Gmail | `employee-provision.ts:100-110` |
| Persona family | `marketing` | `role-capability.ts:33` |
| Denials | pay tools; delete, refund, charge, payout | `role-capability.ts:8,17` |
| Unintended load | Receives every Growth sweep call (§3.4) | `activities/growth.ts` |
| Google Ads | notConnected until `GOOGLE_ADS_DEVELOPER_TOKEN` (human) | `tools/google-ads.ts` |

**Capabilities.**

| Capability | State |
|---|---|
| Google Ads / Meta Ads metrics | Works when connected (read) |
| GA4 report, Search Console, Business Profile | Works when connected (read) |
| Gmail | Works |
| Campaign changes (pause, budget, bids) | **Missing** |
| Content creation (posts, newsletters, landing copy) | **Missing tools**; only Gmail drafts |
| Social publishing (Instagram, LinkedIn, Facebook) | **Missing**; Instagram DM tools exist, not publishing |
| Review management (Business Profile replies) | **Missing** |
| Weekly marketing report | **Missing** (no sweep) |
| Attribution across ads → CRM → revenue | **Missing** |

**Missing capabilities and fixes.**
1. *Stop being the Growth sweep identity* (§3.4). P0, S.
2. *Weekly performance digest sweep* (P1, M): Monday 09:00 local, pulls ads,
   GA4 and GSC deltas, posts a summary to Slack/email (send parks, or
   pre-approved internal channel).
3. *Campaign controls* (P1, M): `google_ads_pause_campaign`,
   `meta_ads_pause_adset`, `*_update_budget`; `publish` risk → approval; hard
   cap on budget change percentage in `payloadDenial`.
4. *Content drafts* (P1, S): add `google-docs` to the card; prompt block for
   brand voice from `employee_memory`.
5. *Review replies* (P2, S): Business Profile `reviews.list` and
   `reviews.reply` (publish risk).
6. *Anomaly alerts* (P2, M): daily check of spend/CPA vs 7-day baseline;
   alert on > 30% change.
7. *Funnel attribution* (P2, L): join ad click ids (UTM) → widget/CRM contact
   → Stripe revenue; extend `growth_pipeline_attribution`.
8. *Social publishing* is better as a separate employee (§5.4).

### 3.7 Research

**Spec.** Read-heavy, cited web and Drive/Notion research; never invent
(`gap26sept/employees/research.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs persona | Match | `employee-provision.ts:113-122` |
| Persona family | none (no denials) | `role-capability.ts:29-41` |
| Prompt block | Research rules | `system-prompt-builder.ts:88-96,149-151` |
| Persona/prompt mention Brain remember | Prompt says use cognee tools; card lacks `cognee` | `system-prompt-builder.ts:139` |

**Capabilities.**

| Capability | State |
|---|---|
| Web search + extract with citations | Works |
| Drive / Notion search and read | Works when connected |
| Founder/company Auto route | Works (`GENERAL_RE` < 0.5) |
| Save findings to Brain | **Broken** (no `cognee` on card) |
| Long reports to a document | **Missing** (no Docs on card) |
| Scheduled monitoring (competitor watch) | **Missing** |
| Source quality ranking, dedupe, citation format | Partial (`reply-from-tools.ts`) |
| Deep multi-source research with sub-agents | Partial: dynamic sub-agents exist, but they lose the Research prompt (09 R-4) |

**Missing capabilities and fixes.**
1. *Brain access*: add `cognee` (search) and remember-as-proposal. P1, S.
2. *Report output*: add `google-docs`; `research_write_report` creates a Doc
   with a sources section. P1, S.
3. *Watch topics* (P2, M): a recurring task (09 §12.1) per topic that searches
   weekly and reports only new sources.
4. *Sub-agent prompt inheritance* (09 R-4). P1, S.
5. *Citation verifier* (P2, M): before the final answer, check that each
   quoted fact appears in a fetched page text; drop or flag unsupported
   sentences.

### 3.8 Executive

**Spec.** Cross-domain coordinator, daily brief, status, delegation
(`gap26sept/employees/executive.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs spec | Spec says narrow, no send; card now has gmail, calendar, Drive, Docs, Sheets, Slides, Slack (migration 210) | `employee-provision.ts:124-146` |
| Persona says "Never send, pay, or run ads" | Nothing denies send for a null persona family | `role-capability.ts:29-41` |
| Default identity | Ask AI with no employee uses "DareX Executive" name but role `Primary Business Assistant`, which does not resolve to the Executive row in the gate (09 R-1) | `ask-ai/route.ts:1308-1309` |
| Meeting-prep sweep runs as Executive | Yes (should be Operations) | `activities/meeting-prep.ts` |

**Capabilities.**

| Capability | State |
|---|---|
| Daily brief from real work items | Works (`daily_brief`) |
| Cross-domain status | Partial (SQL + brief) |
| Delegation to specialists | Hand-off button only; no in-turn delegation (H-1) |
| Board/investor updates (Docs/Slides) | Tools on card; no template |
| Weekly executive summary sweep | **Missing** |
| KPI goals and tracking | **Missing** (no goals table) |
| Decision inbox summary ("what needs me today") | Partial via brief |

**Missing capabilities and fixes.**
1. *Resolve the identity of the unselected chat* (09 R-1): bind to the
   Executive row. P0, S.
2. *Decide send policy* (§2.8): add `executive` persona family with denials
   for send/publish/pay, or update the persona text. P1, S.
3. *Delegate tool* (H-1) — Executive is the natural caller. P1, M.
4. *Goals* (P2, M): `org_goals (metric, target, period, owner_employee)`;
   `exec_set_goal`, `exec_goal_status`; brief reports progress.
5. *Weekly summary* (P2, S): Friday digest from all employees' ledgers and
   work items.

### 3.9 Finance

**Spec.** Invoices and payment links, always confirm before pay, refunds go
to Customer (`gap26sept/employees/finance.md`).

| Check | Result | Evidence |
|---|---|---|
| Card vs persona | Persona says "Invoices"; card has QuickBooks with list customers, create customer, list invoices only — **no invoice create**; no Stripe invoice tool | `tool-definitions.ts` (`quickbooks_*`); `employee-provision.ts:148-155` |
| `confirmClasses: ['pay']` | Wired into `checkAutonomy` | `autonomy.ts:299-315` |
| Refund denial | Hard deny | `role-capability.ts:18,84-86` |
| Memory | Budget 1 400, no tier filter | `memory/retrieve.ts:33,722-723` |

**Capabilities.**

| Capability | State |
|---|---|
| Stripe / Razorpay payment links | Works, approval |
| Stripe charge | Works, always approval |
| Stripe customers | Works |
| QuickBooks list invoices/customers, create customer | Works when connected |
| Darex billing usage | Works |
| Create / send invoice | **Missing** |
| Accounts receivable chase (overdue invoices) | **Missing** (no sweep) |
| Payment reconciliation (Stripe payouts ↔ bank ↔ books) | **Missing** |
| Expense capture, bills, AP | **Missing** |
| Cash-flow summary | **Missing** |
| Xero, Zoho Books, Tally (India) | **Missing** connectors |

**Missing capabilities and fixes.**
1. *Invoices* (P1, M): `quickbooks_create_invoice`, `quickbooks_send_invoice`
   and `stripe_create_invoice` / `stripe_send_invoice`; send is `pay`-class
   (parks); amounts must come from the user or a deal record
   (`payloadDenial` already blocks missing amounts).
2. *AR chase sweep* (P1, M): daily, list overdue invoices, draft polite
   reminders on the customer's channel (send parks or uses a pre-approved
   template), escalate at 30 days to Executive.
3. *Reconciliation* (P2, L): match Stripe/Razorpay payouts to QuickBooks
   deposits; discrepancies become Operations expectations.
4. *Cash summary* (P2, S): `finance_cash_summary` read: revenue collected,
   outstanding AR, refunds this period.
5. AP and bookkeeping are a separate employee (§5.5).

### 3.10 Custom employees (org-created)

**Spec.** Defined only by card + persona; validated tools; fenced persona;
autonomy seeded; locked turns never widen
(`gap26sept/employees/custom-employee.md`).

| Check | Result | Evidence |
|---|---|---|
| Tool validation | Works | `lib/tool-allowlist.ts` |
| Persona fenced | Works | `system-prompt-builder.ts:20-25` |
| Locked allowlist = card + core + channels on card | Works | `ask-employee.ts:157-170` |
| Gate enforces **this** employee's card | **Broken** when its role equals another row's role, or when its role maps by substring to a roster family (09 R-1, `tool-executor.ts:207-222`) | |
| Persona family by substring | Fragile (§1) | `role-capability.ts:29-41` |
| Auto routing | Weak for `rosterKey: 'other'`; usually needs `@Name` | `route-employee.ts` |
| Sweeps / background work | **None possible** without code | |
| Prompt role blocks | May inherit a roster block by substring (`system-prompt-builder.ts:27-48`) | |
| Hire quota | None (any number of rows) | `employees.md` broken 12 |

**Missing capabilities and fixes.**
1. *Identity by id* (09 R-1). P0, S.
2. *`rosterKey` and `family` chosen in the hire form* (P1, S): the operator
   picks "behaves like: Support / Sales / Ops / Finance / Marketing /
   Research / none"; stored in persona JSON; the substring matcher is only a
   fallback.
3. *Routing keywords on the card* (P1, S): optional `routing.keywords[]`
   scored by the router like built-in specialties.
4. *Custom recurring tasks* (P1, L): the `agent_tasks` design (09 §12.1)
   gives custom employees scheduled work without code.
5. *Templates* (P2, M): hire from a template (the new roles in §5) that
   pre-fills card, persona, autonomy and tasks.
6. *Hire limit per plan* (P2, S): enforce plan seat/employee caps on POST.

---

## 4. Per-employee metrics (target design)

One scorecard per employee id, computed daily by a worker job into
`employee_scorecard_daily (org_id, employee_id, date, …)`, shown on
`/employees/[id]` and in the Executive brief.

| Metric | Definition | Source today | Gap |
|---|---|---|---|
| Work items handled | assigned and closed per day | `work_items.assignee_employee_id` | Works |
| Resolution time p50 | open → done | `work_items` | Works |
| Approval rate | approved / decided pending actions | `agent_pending_actions` | No employee id column (09 A-5) |
| Edit rate | approved with `modified_payload` / approved | `agent_pending_actions` | Same |
| Escalation rate | parked / gated calls | `agent_decision_ledger` (employee id since 205) | Works with id |
| Denial rate by reason | not_in_allowlist, persona_denied, … | `tool_invocations` / ledger | Needs employee id on `tool_invocations` |
| Tool success rate | executed / attempted | `tool_invocations` | Same |
| Grounding rejections | low-RAG holds | ledger `low_rag_no_tool` | Works for Customer |
| Cost | model spend | `org_model_spend` | Org-level only (09 C-4) |
| Customer outcome | CSAT, reopen rate | — | Missing (§3.1 item 6) |
| Revenue outcome | pipeline and closed-won attributed | `growth_pipeline_attribution` | Growth only |
| Health bands | `EMPLOYEE_METRIC_BANDS` | dashboard query by role | Move to employee id; drop the worker no-op (`employee-metrics.ts:100-112`) |

Steps: add `employee_id` to `agent_pending_actions` and `tool_invocations`
(migration); fill it from the gate; write the daily job; replace
`org_employee_metrics_daily` role rows with employee rows (keep role rollup
as a view). P1, M.

---

## 5. New employees worth adding

Selection criteria: the role is common in the target customers (SMBs,
real-estate brokerages, B2B SaaS, e-commerce, Indian SMBs given Razorpay,
Leegality and RERA support), most tools already exist or are one connector
away, and the role produces measurable outcomes. Each spec follows the same
shape as the roster: job, card, persona family and denials, autonomy, owned
sweeps, memory scope, hand-offs, chat examples, metrics, build steps.

All new employees should be shipped as **templates** (hire from template,
§3.10 item 5) rather than added to the default roster, so existing orgs are
not changed and small orgs do not pay for sweeps they do not need.

### 5.1 Riya — HR & Recruiting

**Job.** Run hiring end to end up to the offer: job posts, applicant intake,
screening against the role scorecard, interview scheduling, candidate
communication, reference checks; plus light people-ops (onboarding checklists,
leave questions from the handbook).

| Field | Spec |
|---|---|
| Card (existing) | gmail, google-calendar, google-drive, google-docs, google-forms, slack, web_extract |
| Card (new connectors) | ATS: Greenhouse, Lever, Workable, Zoho Recruit; job boards via ATS; HRIS later (BambooHR, Keka, Zoho People, greytHR) |
| Persona family | new `hr`; denies pay tools, CRM writes, ads; denies sending offers (`offer` action → always approval) |
| Autonomy | Screening notes and scheduling: internal/reversible. Candidate emails: send → approval, or pre-approved templates (09 A-6). Rejections and offers: always approval. |
| Owned sweeps | New-applicant intake (hourly): parse resumes, score vs scorecard, create work items; Interview reminders (daily); Stale candidate nudge (candidates idle > 5 days) |
| Memory scope | employee tier: role scorecards, interview guides, handbook; entity tier: candidates (contact type `candidate`); never cites customer conversations (`hr` filter excludes `conversation` and `graph`) |
| Privacy | Candidate data is personal data: subject-scoped DSR (09 F-1) is a prerequisite; retention default 12 months; no protected-attribute inference (persona rule + output guard) |
| Hand-offs | Contracts → Legal (§5.2); payroll questions → Finance/Bookkeeper; equipment → Operations |
| Chat examples | "Post the Senior AE role on our ATS", "Who are the top 5 applicants for SDR this week and why?", "Schedule panel interviews with Priya next Tue–Thu", "Draft a rejection for candidates scored below 2" |
| Metrics | time-to-first-response to applicants, time-to-schedule, pipeline per stage, offer acceptance rate, approval edit rate |
| Build steps | 1. ATS connector module (`tools/greenhouse.ts` etc.) with list jobs/applications, add note, move stage, schedule interview. 2. `hr_score_candidate` (LLM structured output vs scorecard in employee memory, stored on the application). 3. Persona family `hr` in `role-capability.ts`, budget in `PERSONA_TOKEN_BUDGET`, filter in `filterCitationsForPersona`. 4. Router entries (`hire|candidate|resume|interview|job post`). 5. Sweeps registered with owner `hr`. 6. Template in hire UI. |
| Priority / effort | P2 / L |

### 5.2 Leo — Legal & Contracts

**Job.** Contract intake, first-pass review against the org's playbook,
redline suggestions, NDA generation from template, e-signature dispatch,
obligation and renewal tracking.

| Field | Spec |
|---|---|
| Card (existing) | google-drive, google-docs, docusign, leegality, gmail (drafts), notion |
| Card (new) | Contract repository (Drive folder convention first; Ironclad/Juro later) |
| Persona family | new `legal`; denies pay, ads, CRM writes; `sign` and `send_envelope` always approval |
| Autonomy | Review notes: internal. Generating an NDA from an approved template: draft. Sending for signature: approval always. Never "accepts" terms on the org's behalf. |
| Owned sweeps | Renewal radar (daily): contracts with renewal/notice dates in the next 60 days → work items to the owner; Signature chase (daily): envelopes pending > 3 days → reminder draft |
| Memory scope | employee tier: clause playbook (acceptable positions, fallbacks, never-accept list), templates; entity tier: contract records with typed facts (`facts`: counterparty, effective date, term, renewal, notice period, liability cap) — depends on 09 M-2 |
| Guardrails | Persona states it is not a lawyer and flags high-risk clauses for human counsel; every review lists clauses not covered by the playbook; outputs cite clause text from the document |
| Hand-offs | Sales (deal context), Finance (payment terms), Customer (customer-facing contract questions) |
| Chat examples | "Review this MSA against our playbook and list deviations", "Generate an NDA for Acme from our template and send via Leegality after I approve", "Which contracts renew next month?" |
| Metrics | review turnaround, % clauses within playbook, renewal misses (target 0), signature cycle time |
| Build steps | 1. `legal_extract_terms` (structured extraction to `facts` + `entity_memory` for a Drive file). 2. `legal_review_against_playbook` (clause-by-clause comparison, output table). 3. `legal_generate_from_template` (Docs copy + fill). 4. Wire existing DocuSign/Leegality tools. 5. Renewal sweep over `facts` (`predicate='renewal_date'`). |
| Priority / effort | P2 / L (needs 09 M-2 typed facts first) |

### 5.3 Pia — Procurement & Vendor Management

**Job.** Purchase requests, vendor quotes comparison, PO drafting, vendor
onboarding documents, spend tracking against budget, renewal of SaaS
subscriptions.

| Field | Spec |
|---|---|
| Card (existing) | gmail, google-sheets, google-drive, quickbooks (read), slack, web_search/web_extract |
| Card (new) | QuickBooks bills/vendors write; Zoho Books; card-spend exports (Ramp/Brex later) |
| Persona family | new `procurement`; denies refunds, CRM, ads; PO creation and vendor payment are `pay`-class |
| Autonomy | Comparing quotes and drafting POs: draft. Sending a PO to a vendor: send → approval. Paying a vendor: never (hand to Finance). |
| Owned sweeps | SaaS renewal watch (weekly) from email receipts and QuickBooks bills; Budget variance (monthly) |
| Memory scope | employee tier: preferred vendors, approval thresholds; entity tier: vendors (`entity_type='vendor'`) with facts (contract value, renewal date, owner) |
| Hand-offs | Finance (payment), Legal (vendor contracts), Operations (delivery tracking) |
| Chat examples | "Compare these three quotes for laptops", "Draft a PO to Dell for 5 units at the quoted price", "Which SaaS tools renew this quarter and who owns them?" |
| Metrics | cycle time request → PO, savings vs first quote, renewals caught before auto-renew |
| Build steps | 1. Vendor entity type and facts. 2. `procurement_compare_quotes` (structured comparison from Drive/email attachments). 3. `procurement_create_po` (Docs/Sheets template; QuickBooks PO when connected). 4. Receipt parser over Gmail for SaaS spend. 5. Sweeps. |
| Priority / effort | P2 / L |

### 5.4 Sana — Social Media Manager

**Job.** Plan, draft, schedule and publish social posts; reply to comments and
DMs within policy; report engagement. Splits publishing work off Marcus, who
stays on paid and analytics.

| Field | Spec |
|---|---|
| Card (existing) | instagram (DMs today), google-business-profile, google-drive (assets), google-docs, web_search |
| Card (new) | Instagram Graph publishing (`/media`, `/media_publish`), Facebook Pages, LinkedIn Pages (Community Management API), X (paid API); Canva connector for assets |
| Persona family | new `social`; denies pay, CRM writes, refunds; `publish` risk always approval unless the org pre-approves a content calendar |
| Autonomy | Drafts and calendar: draft. Publishing: approval per post, or batch approval of a week's calendar (one card, many posts). Replies to comments: pre-approved templates for FAQs; anything else approval. |
| Owned sweeps | Publish queue (every 15 min: post approved items at their slot); Mentions/comments triage (hourly); Weekly content plan draft (Monday) |
| Memory scope | employee tier: brand voice, banned topics, hashtag sets, past top posts; graph excluded; conversation tier excluded except DMs of the current thread |
| Guardrails | Critic check (`activities/critic-check.ts`) on every post; banned-topic list; no claims about pricing or guarantees unless in org memory |
| Hand-offs | Customer/Emma (support DMs), Sarah (sales inquiries in DMs), Marcus (paid boosts) |
| Chat examples | "Plan next week's 5 Instagram posts from our new listings", "Reply to today's comments that ask about price", "How did last week's posts perform?" |
| Metrics | posts published on schedule, engagement rate, response time to comments, approval edit rate |
| Build steps | 1. `social_posts` table (channel, content, media, scheduled_at, status, approval id). 2. Publishing tool modules per network with `publish` risk. 3. Batch approval card type (one decision, N items). 4. Sweeps. 5. Persona family, router (`post|instagram post|social|caption|content calendar`). |
| Priority / effort | P1 for real-estate and e-commerce orgs / L |

### 5.5 Bo — Bookkeeper

**Job.** Categorise transactions, reconcile bank and payment-processor
payouts, prepare month-end close checklists, chase missing receipts, GST/VAT
prep summaries. Distinct from Finance (collections and payment links).

| Field | Spec |
|---|---|
| Card (existing) | quickbooks (read), stripe (read), razorpay (read), gmail (receipts), google-sheets |
| Card (new) | QuickBooks write (categorise, attach, journal draft), Xero, Zoho Books, Tally export (India), bank feeds via accounting platform |
| Persona family | `finance` family with extra denials: no charges, no payment links, no payouts; journal posting is `pay`-class (approval) |
| Autonomy | Categorisation suggestions: draft; applying categories above confidence threshold for recurring vendors: internal write after an owner enables it; journals: approval always |
| Owned sweeps | Daily categorisation suggestions; Weekly receipt chase (draft emails to staff); Month-end close checklist (day 1 of month) |
| Memory scope | employee tier: chart of accounts mapping rules, vendor → category rules; facts for recurring vendors |
| Hand-offs | Finance (collections), Procurement (vendor questions), Operations (discrepancies) |
| Chat examples | "Categorise last week's uncategorised transactions", "Which Stripe payouts don't match a deposit?", "Prepare the GST summary for September" |
| Metrics | % transactions categorised within 48 h, reconciliation breaks open, close duration |
| Build steps | 1. Accounting write tools (QuickBooks first). 2. Rule store for vendor → category. 3. Payout ↔ deposit matcher (shared with Finance §3.9 item 3). 4. Tax summary report templates per region. |
| Priority / effort | P2 / L |

### 5.6 Sam — SEO & Content

**Job.** Keyword and content-gap research, on-page audits, content briefs and
drafts, internal linking, Search Console monitoring, Business Profile posts.

| Field | Spec |
|---|---|
| Card (existing) | google-search-console, google-analytics, google-business-profile, web_search, web_extract, google-docs |
| Card (new) | CMS publishing (WordPress, Webflow, Shopify blog), keyword volume API (optional, paid) |
| Persona family | `marketing` family (same denials as Marcus) |
| Autonomy | Audits and briefs: read/draft. Publishing to CMS: `publish` → approval. |
| Owned sweeps | Weekly Search Console movers (queries/pages up or down > 30%); Monthly content-gap report; Broken-link check (weekly, via web_extract on sitemap) |
| Memory scope | employee tier: target keywords, brand voice, product facts; org memory for product details; no conversation tier |
| Hand-offs | Marcus (paid), Sana (social distribution), Research (deep topic research) |
| Chat examples | "Which pages lost clicks this week and why?", "Write a brief for 'best CRM for real estate in India'", "Audit our pricing page for on-page SEO" |
| Metrics | clicks and impressions trend, pages published, ranking movement on target keywords |
| Build steps | 1. `seo_audit_page` (fetch + checks: title, meta, headings, schema, links). 2. `seo_content_brief` (SERP via web_search + gap). 3. CMS connector with draft-post and publish actions. 4. Sweeps. |
| Priority / effort | P2 / M |

### 5.7 Other candidates (shorter specs)

| Employee | Job | Main tools | Why | Priority |
|---|---|---|---|---|
| **Customer Success / Onboarding** | Onboard new customers after closed-won, run checklists, QBR prep, renewal and expansion signals | hubspot/salesforce, gmail, calendar, docs, product usage via database_query | Fills the gap between Sarah (closes) and Customer (support); blueprint "Growth deal → Operations onboarding" loop | P1, M |
| **Property Manager (real estate pack)** | Leases, rent reminders, maintenance requests, showings, owner reports | `re`, `rera`, rent reminders, whatsapp, calendar | Real-estate tools exist across Operations and Sarah; a dedicated role makes the pack coherent | P1, M |
| **IT & Internal Helpdesk** | Employee IT requests, account provisioning checklists, SaaS access reviews | google-cloud, github, slack, google-contacts | Common SMB need; tools partly exist | P2, M |
| **Data Analyst** | Ad-hoc SQL and metric questions, scheduled KPI reports, chart generation | database_query, metrics, sandbox (code_execution), sheets | Today the Executive and every employee half-do this; a dedicated read-only analyst with sandbox is safer | P2, S |
| **Collections Agent** (India SMB) | Overdue payment follow-ups on WhatsApp with Razorpay links | whatsapp, razorpay, quickbooks | High value for Indian SMBs; can be a Finance mode instead | P2, S |

### 5.8 Shared work needed before any new employee ships

1. Employee templates (persona JSON with `rosterKey`, `family`, card,
   autonomy overrides, task definitions) and a "hire from template" flow.
   P1, M.
2. Persona families and memory filters data-driven
   (`role-capability.ts` and `filterCitationsForPersona` read from the
   template instead of hard-coded unions). P1, M.
3. Router entries from the template's keywords (§3.10 item 3). P1, S.
4. Recurring tasks (09 §12.1) so templates can bring their sweeps without
   new Temporal code. P1, L.
5. Identity by employee id (09 R-1). P0, S.
6. Batch approval cards for high-volume, low-risk outputs (social posts,
   reminders). P1, M.

---

## 6. Consolidated tracker

| ID | Employee | Gap | Priority | Effort | Files |
|---|---|---|---|---|---|
| G-1 | Growth | All sweeps run as Marcus; Apollo, HubSpot, Calendar, Slack calls denied | P0 | S | `activities/growth.ts:157,597,638,714,747,762,791,841,916` |
| E-X1 | All | Gate identity by role (09 R-1, B-0) | P0 | S | `local-turn.ts`, `mcp-bridge.ts`, `tool-executor.ts` |
| X-1 | Executive | Unselected Ask AI role does not resolve to Executive | P0 | S | `ask-ai/route.ts:1308-1309` |
| E-X3 | All sweeps | Gate denials swallowed | P1 | S | sweep activities |
| O-1 | Operations | Meeting prep runs as Executive | P1 | S | `activities/meeting-prep.ts` |
| O-2 | Operations | Soft send denial | P1 | S | `role-capability.ts:78-97` |
| C-1 | Customer | Shopify tools missing / not on card | P1 | S | `tool-definitions.ts`, migration |
| C-2 | Customer | Subscription management missing | P1 | M | `tools/stripe.ts` |
| C-3, EM-4, R-1 | Customer, Emma, Research | Prompt says remember; card lacks `cognee` | P1 | S | roster, 09 M-6 |
| EM-1 | Emma | No triage sweep | P1 | M | new workflow |
| EM-2 | Emma | Outlook/Slack/Instagram not on card | P1 | S | migration |
| G-3, G-4 | Growth | ICP and signals not in chat | P1 | S | `tools/growth.ts` |
| S-1..S-4 | Sarah | Speed-to-lead, qualification record, quotes, e-sign | P1 | M | new tools, card |
| M-1..M-4 | Marcus | Weekly digest, campaign controls, content drafts | P1 | M | ads tools, card |
| R-2, R-4 | Research | Report output; sub-agent prompt | P1 | S | card, 09 R-4 |
| X-2, X-3 | Executive | Send policy decision; delegation tool | P1 | S–M | `role-capability.ts`, new tool |
| F-1, F-2 | Finance | Invoice create/send; AR chase | P1 | M | `tools/quickbooks.ts`, `tools/stripe.ts` |
| CU-1..CU-3 | Custom | Identity, family choice, routing keywords | P0–P1 | S | hire form, router |
| H-1, H-2 | All | In-turn and inbound hand-off | P1 | M | new tool, `WorkItemWorkflow.ts` |
| §4 | All | Scorecard by employee id | P1 | M | migrations, worker job |
| §2.4 | Sarah, Emma, Marcus, Research, Executive, Finance | No owned background work | P1 | L | sweeps / tasks |
| H-3, H-4 | All | Hand-off rule sources; Auto offers | P2 | S–M | handoffs |
| §1 | All | Shared router keys, substring persona, mixed persona formats | P2 | S | `route-employee.ts`, `role-capability.ts`, provision |
| §2.6 | All | Shared prompt lines; no prompt version | P2 | S | `system-prompt-builder.ts` |
| §2.7 | All | Hours, model profile, channel ownership, approver, per-employee autonomy | P1–P2 | M | schema, UI |
| §5 | New | HR, Legal, Procurement, Social, Bookkeeper, SEO, CS, Property Manager | P1–P2 | M–L | templates first (§5.8) |
