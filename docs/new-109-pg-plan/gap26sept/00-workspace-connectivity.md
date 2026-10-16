# Workspace End-to-End Connectivity Audit

Scope: this doc is the cross-tab wiring layer the 35 per-domain audit docs in this
directory deliberately did not cover. Each of those covers one tab's internals; this
one asks whether an action in tab A actually ripples into tab B, C, D — same DB rows,
same org scope, same event bus — or whether the UI merely *implies* a connection that
the backend never wired.

Sidebar tabs, `apps/dashboard/components/shell/AppShell.tsx:36-58` (22 items): Home
`/`, Ask AI `/ask-ai`, Conversations `/conversations`, Plans `/plans`, Work Items
`/work-items`, Brain `/brain`, Listings `/listings`, Inquiries `/inquiries`, Employees
`/employees`, Growth `/growth`, Customer `/employees/customer`, Brief `/brief`, Insight
`/insight`, Analytics `/analytics`, Health `/observability`, Audit `/audit`,
Integrations `/integrations`, Connectors `/connectors`, Packs `/packs`, Billing
`/billing`, Skills `/skills`, Autonomy `/settings/autonomy`. (`/settings` itself is
reached via the profile menu, not a top-level nav item.)

---

## Current data flow map (verified, file:line cited)

### 1. Conversations is the shared substrate — real, not implied

`conversations` + `messages` is the one table pair almost every other tab reads or
writes, and the wiring is genuinely real (same `org_id`-scoped rows, no separate
mirror table):

- **Webhooks → Conversations**: WhatsApp/Chatwoot inbound writes `messages` +
  `conversations` directly (`apps/dashboard/app/api/webhooks/whatsapp/route.ts:204-322`),
  publishes to `realtime-hub.ts`, and the same row is what `/conversations` renders
  (`apps/dashboard/app/api/conversations/route.ts:12-140`).
- **Ask AI → Conversations**: `ask-ai/route.ts` persists thread history to the same
  `messages` table keyed by conversation (ask-ai.md #6, `route.ts:273-276`); a plan's
  `agent_plans` row is independent but the conversational turns it originates from are
  shared rows.
- **Conversations → Customer employee tab**: `employees/customer/route.ts:15-106`
  queries `conversations` directly for a 7-day window, feeding `at_risk`/`handled`
  counts, and `customer_operational_state` is inferred from the same message stream
  (customer.md). The `TeachKnowledgeGapModal`/decision cards deep-link back to
  `/conversations?id=...` (customer.md tracker #2) — a real, verified two-way link.
- **Conversations → Home**: `dashboard/stats/route.ts` aggregates the same
  `conversations`/`messages` tables for automation rate, needs-attention count, and
  latency (dashboard-home.md).
- **Conversations → Analytics**: `analytics/route.ts` re-aggregates the identical
  tables over a longer window (analytics.md) — real shared source, but see Silo #2
  below for the metric-definition drift this causes.
- **Conversations → Brief**: `brief/route.ts:32-115` reads `work_items` (not
  `conversations` directly), but those work items are themselves created from
  conversation-triggered escalations (customer.ts `attachDecisionCardActivity`) — an
  indirect but real chain: Conversations → Customer employee escalation logic →
  `work_items` → Brief.
- **Conversations → Inquiries (real estate)**: inbound WhatsApp/webhook messages
  trigger `re.inquiry_create` (`services/workflows/src/tools/realestate/index.ts:379-424`),
  which writes `re_inquiries` and links `conversation_id` — a real FK, not a guess.

### 2. Work Items is the second shared substrate (task/decision bus)

`work_items` + `work_events` is written by many producers and read by several tabs —
this actually works end-to-end for the write side, but the *read* side is fragmented:

- **Producers**: Temporal activity `upsertWorkItem` (work-items.md #6), inbound
  webhooks (`lib/inbound-agent.ts:336-365`), customer-employee obligation extraction
  (`attachDecisionCardActivity`, customer.md), growth opportunity scouting
  (`work_items WHERE type = 'growth_opportunity'`, growth.md), autonomy tier
  interception / `parkPendingAction` (decisions.md — writes `agent_pending_actions`,
  a **different** table, see Silo #4).
- **Readers that are real**: `/work-items` Kanban (work-items.md tracker #3),
  `/brief` (`brief/route.ts:32-115`, filters `status IN ('needs_attention',
  'waiting_approval')`), `/employees/customer` decision cards (customer.md #3),
  `/growth` console (growth.md, reads `type = 'growth_opportunity'` rows).
- **Verified real link**: Brief's inline triage (`api/brief/[id]/triage`) and Customer's
  decision approval (`api/work-items/[id]/decision`) both mutate the *same*
  `work_items` row — approving from Brief and approving from Customer converge on one
  row, one `work_events` audit trail. This is genuine shared-state wiring, not a UI
  coincidence.

### 3. Employees ↔ Autonomy ↔ Skills ↔ Tool execution (config chain, mostly real)

- `ai_employees.tool_allowlist` gates what `tool-executor.ts` will run for that
  employee (employees.md, skills.md tracker #4: `PATCH /api/skills/[id]` "rebuilds
  employee allowlists from assigned enabled skills" — this is a **real, shipped**
  bidirectional sync between `/skills` and `ai_employees`, not aspirational).
- `employee_autonomy_rules` (configured at `/settings/autonomy`, settings.md tracker
  #5, `PATCH /api/settings/autonomy`) is read by `tool-executor.ts`'s
  `assertSkillAutonomyGuard`-style check (skills.md tracker #5: "minAutonomyForTool +
  employee_autonomy_rules tier check before execute" — shipped) and by the autonomy
  interception logic that parks actions into `agent_pending_actions`
  (`services/workflows/src/autonomy.ts:120-185`).
- **Real chain**: `/settings/autonomy` PATCH → `employee_autonomy_rules` row → read by
  `tool-executor.ts` at execution time → gates whether an action executes immediately,
  gets parked to `/observability`'s pending-decisions queue, or is rejected. This is a
  live, working cross-tab pipeline (Autonomy tab config → Ask AI / webhook execution
  path → Observability/Decisions surface).
- **Employees → Growth/Customer/Brief**: an employee's `role` string is the join key
  used everywhere (`employee_role = '*'` in metrics, `assignee_employee_id` in
  `work_items`), but see Silo #7 — this is a soft string join, not a FK in the metrics
  path, and breaks per-employee attribution.

### 4. Brain (memory) ↔ Ask AI ↔ Brief/Insight (partially real)

- Ask AI's agent runtime reads `org_memory`/`employee_memory`/`entity_memory` via
  `services/workflows/src/memory/retrieve.ts:220-342` (pgvector cosine) — a real,
  verified read path from Brain's data into every Ask AI / webhook agent turn.
  Real-estate tools also write into `entity_memory` after listing/inquiry lookups
  (listings.md #5, inquiries.md #3) — a real write path from those domains back into
  Brain.
- **Silo**: the Brain *UI* (`/brain` search box) does **not** use the same hybrid
  vector search the agent runtime uses (brain.md #1: UI is keyword-only FTS vs.
  agent's real pgvector cosine) — same table, two divergent query paths, so what an
  operator sees searching Brain is not what the agent actually retrieves.
- Insight's KPI engine and Brief do not read Brain at all; there is no "why did the
  agent say X" citation link from a conversation back to the specific `org_memory` row
  that grounded it (brain.md "missing vs vision" #8) — a real gap, not yet built.

### 5. Billing ↔ everything else (config exists, enforcement mostly doesn't)

- `billing_meters`/`usageBlocked` is computed from real usage (`refreshOrgMeters`,
  billing.md) pulling from `conversations`, `users` (seats), and Langfuse cost — a real
  read-side connection to Conversations/Employees/Ask AI activity.
- **Critical silo**: `usageBlocked` is computed but a repo-wide grep confirms **zero**
  references in `tool-executor.ts`, `plan-generator.ts`, or any `ask-ai/*` route
  (billing.md #1). Billing's hard cap is a dashboard-only banner; Ask AI, webhooks, and
  Growth outbound all keep running past it. This is the single biggest "looks wired,
  isn't" gap in the whole workspace — billing computes the number, nothing downstream
  ever reads it at execution time.
- Seat count (`billing_meters` kind=`seats`) is not enforced when Settings adds a user
  (billing.md "what's missing": "no seat-enforcement at signup/employee-add time") —
  Settings tab and Billing tab both display seat data independently; only Settings'
  invite path checks `checkSeatAvailability` (settings.md tracker #3, shipped), but
  employee-add (as opposed to member-invite) is a separate code path not confirmed to
  share the same gate.

### 6. Realtime hub is the only true cross-tab push mechanism

- `realtime-hub.ts` publish calls originate from: WhatsApp/Chatwoot webhooks,
  conversation status updates, outbound messages, work-item decisions
  (`broadcastToOrg`), inquiries CRUD (inquiries.md tracker #9), growth domain locks.
  `/api/stream/events` is the single SSE endpoint multiple pages subscribe to
  (realtime-stream.md).
- **Real, verified subscribers**: `/conversations` (message/attention events),
  `/employees/customer` (customer.md tracker #6, subscribes and reloads on
  attention/conversation/work_item events).
- **Silo**: Home, Brief, Insight, Analytics, Observability, Growth, Inquiries, Listings
  all fetch once on mount with **no** SSE subscription (dashboard-home.md #7,
  brief.md #7, insight.md #12, analytics.md #12, observability.md #12) — an action
  approved in Brief does not make the same event ripple to a manager who has Home or
  Analytics open in another tab; they must manually refresh. The event bus exists and
  is real, but only 2 of 22 tabs actually listen to it.

### 7. Audit trail is fragmented, not centralized

- A single `audit_events`/`audit_logs` table exists and `/audit` (audit-log.md) can
  query it, but coverage is real only for AI agent tool executions and plan
  approvals. Settings mutations, employee roster changes, billing plan changes,
  connector connect/disconnect, and kill-switch toggles are **not** written to it
  consistently — some domains (billing.md "what's missing" #6, employees.md #10,
  settings.md #8) explicitly note zero `audit_log`/`auditLog` grep hits for their
  mutations. So `/audit` is a real, working tab, but it is blind to roughly half the
  security-relevant actions taken across the other 21 tabs.

---

## Silos found (file:line evidence of gaps)

1. **Billing enforcement silo (P0)** — 🟢 Resolved: hard cap enforced in `tool-executor.ts` (`usageBlock` gate), `ask-ai` + `ask-ai/execute` (402), and direct `agent/run|stream|crew` (402 `USAGE_CAP_REACHED`); gate fails closed. Historical finding follows:  `refreshOrgMeters()` (`apps/dashboard/app/api/billing/_lib.ts:915-1112`)
   computes `usageBlocked`, but grep confirms zero call sites in
   `services/workflows/src/tool-executor.ts`, `apps/dashboard/lib/plan-generator.ts`,
   or `apps/dashboard/app/api/ask-ai/*` (billing.md #1). Billing tab and every
   execution-surface tab (Ask AI, Conversations webhooks, Growth outbound) are
   visually connected (same banner logic references the same org) but functionally
   disconnected — the cap is cosmetic.

2. **Automation Rate taxonomy collision (P0)** — 🟢 Resolved: Home and Analytics both call `queryAutomationRate` (`apps/dashboard/lib/automation-rate.ts`); Home windows to 7 days (Analytics default) and labels the tile "(7d)".
   (`apps/dashboard/app/api/dashboard/stats/route.ts:49-61`, definition: conversations
   with ≥1 assistant message ÷ total) and Analytics
   (`apps/dashboard/app/api/analytics/route.ts:60-70`, definition: assistant messages
   with tool_calls ÷ total assistant messages) both label their number "Automation
   Rate" against the *same underlying tables* but compute genuinely different ratios
   (analytics.md #2). This is two tabs reading the same data and disagreeing — a
   taxonomy silo, not a data silo.

3. **Skills UI vs runtime enforcement silo (mostly closed, one gap remains)** —
   skills.md tracker shows the `/skills` ↔ `ai_employees.tool_allowlist` sync and
   `minAutonomyLevel` runtime check are now shipped. Remaining real gap: skill
   *revocation* does not invalidate already-running TrueForge sessions holding cached
   tool definitions in memory (skills.md #12) — Skills tab writes truth to Postgres,
   but a live agent turn in Ask AI can still be executing against the old, revoked
   tool_allowlist for the duration of that turn.

4. **Decisions vs Work Items vs Settings pending-actions triplication (P2, explicitly
   flagged)** — three separate routes read/write overlapping tables for "things a
   human must approve": `/api/decisions` → `agent_pending_actions`,
   `/api/work-items/[id]/decision` → `work_items`, `/api/settings/pending` → also
   `agent_pending_actions` with different error handling (decisions.md #4). An
   operator approving from `/observability`'s pending-decision card and one approving
   from `/work-items` are touching different tables for conceptually the same "human
   sign-off" action — the UI presents one mental model, the backend has two competing
   schemas.

5. **Brain UI vs Brain-as-used-by-agent silo (P0)** 🟢 Resolved: `/api/brain` GET uses `searchMemoryHybrid` with keyword fallback and a `searchMode` flag (brain.md #2). — `/brain` search
   (`apps/dashboard/app/api/brain/route.ts:124-185`) is keyword-FTS-only;
   `services/workflows/src/memory/retrieve.ts:220-342` (what Ask AI actually queries)
   is hybrid vector+FTS (brain.md #1). An operator editing/searching Brain sees a
   different, weaker retrieval surface than what the agent uses in production —
   looks like the same knowledge base, is actually two different query engines over
   the same table.

6. **Realtime push silo (P1)** — only Conversations and Customer-employee subscribe to
   `/api/stream/events`; Home, Brief, Insight, Analytics, Observability, Growth,
   Inquiries, Listings, Billing, Skills, Autonomy do not (dashboard-home.md #7,
   brief.md #7, insight.md #12, analytics.md #12, observability.md #12 — five
   independent audits flag the identical missing-SSE pattern). The event bus exists,
   is validated, and is real; it is simply wired to 2 of 22 consumer tabs.

7. **Per-employee attribution silo (P1)** — `org_employee_metrics_daily` and
   observability's telemetry hardcode `employee_role = '*'`
   (observability.md #4, employees.md #2 "Per-Employee Analytics"). Employees tab
   creates individually named employees; Observability, Analytics ROI, and Insight
   cannot filter by the specific employee id anywhere in the metrics pipeline — the
   join key that exists in `ai_employees` (a UUID `id`) is discarded in favor of the
   coarse `role` string by the time data reaches Health/Analytics, so "which employee
   is misbehaving" cannot be answered by clicking through from Employees to
   Observability.

8. **Growth ↔ Inquiries/Listings cross-vertical silo (P1, partially closed)** —
   growth.md tracker #4 shows `api/growth/listings/match/route.ts` now matches
   `re_listings` ↔ `re_inquiries` and creates `waiting_approval` work items (real,
   shipped). But the core B2B growth engine (ICP/Apollo/Jina scouting) and the
   real-estate saved-search matcher remain two independent code paths with no shared
   scoring/dedup logic — a lead scouted by Growth's B2B engine and an inquiry
   matched by the real-estate matcher both land in `work_items`, but nothing
   deduplicates across the two origins for the same contact.

9. **Multi-org/tenant switch silo (P2, mostly closed)** — org-tenancy.md tracker shows
   `organization_memberships` + `/api/org/switch` shipped, but no tab's UI has a
   workspace switcher component wired in yet (component exists in the audit's
   proposed code, not confirmed present in `AppShell.tsx`'s current 22-item nav) —
   worth a quick grep before the next work cycle to confirm whether the switcher
   landed in the shell.

10. **Audit trail coverage silo (P1)** — `/audit` is real and queryable, but Settings,
    Billing, Employees, and Connectors mutations are inconsistently emitted to
    `audit_events` (audit-log.md #3, settings.md #8, billing.md "what's missing" #6).
    A change made in any of those four tabs may be invisible to the one tab
    (`/audit`) whose entire purpose is to show cross-tab history.

---

## Full end-to-end architecture needed (concrete build order)

The goal: one action in one tab should deterministically ripple into every tab that
has a legitimate reason to reflect it, via a small number of shared primitives rather
than N² point-to-point wiring.

**Shared primitives to build/finish (in dependency order):**

1. **Usage-gate middleware, single call site.** Add one function
   (`assertUsageAllowed(orgId)`, already exists per ask-ai.md's tracker for the ask-ai
   route) and call it from the *one* choke point all execution paths already funnel
   through: `services/workflows/src/tool-executor.ts` before any tool runs. This one
   change wires Billing → Ask AI, Webhooks, Growth outbound, Crew workflows in a
   single PR instead of four.
2. **Canonical pending-approval table.** Collapse `agent_pending_actions` and the
   `work_items`-as-decision-card pattern into one schema (or make one a thin view over
   the other) so Decisions, Work Items, Brief, and Customer's decision cards are
   provably reading/writing the same rows, not three tables that happen to look
   similar in the UI.
3. **`employee_id` (UUID) as the join key everywhere metrics are recorded.** Add
   `employee_id` alongside the existing `employee_role = '*'` column in
   `org_employee_metrics_daily` and `observability_alerts` (observability.md already
   proposes this migration) so Employees → Observability → Analytics ROI can filter
   by the specific hired employee, not just role.
4. **Generic SSE consumer hook, adopted by every tab.** `useRealtimeStream` (proposed
   in realtime-stream.md and dashboard-home.md) should be extracted once and imported
   by Home, Brief, Insight, Analytics, Observability, Growth, Inquiries, Listings —
   not re-implemented per page. Each page registers which event `type`s it cares about
   (e.g. Brief listens for `work_item_updated`, Growth listens for
   `opportunity_decided`) against the *existing* `org:{orgId}` channel — no new
   infrastructure, just consumers.
5. **Single audit-emit helper, called from every mutation route.** A
   `recordAuditEvent(client, {orgId, actorUserId, action, targetType, targetId,
   metadata})` helper (several domains already sketch this inline) should be the one
   thing every `POST`/`PATCH`/`DELETE` route calls, so `/audit` becomes complete by
   construction instead of by each domain remembering to add it.
6. **Brain retrieval unification.** Point `/api/brain`'s search at the same
   `hybridSearchBrain`/`searchMemoryHybrid` function the agent runtime uses
   (`services/workflows/src/memory/retrieve.ts`), rather than maintaining a second,
   weaker keyword-only query — one retrieval function, two callers (UI search, agent
   turn).
7. **Cross-vertical lead dedup.** Before Growth's B2B engine or the real-estate
   listing matcher creates a new `work_items` row for a contact, both should check a
   shared `(org_id, contact_id/domain, created_at > now() - 7d)` guard — the inquiries
   domain already has this pattern (7-day dedup, inquiries.md #6); growth.md's
   `outbound_domain_locks` is the B2B analog — these two guards should share one
   function rather than being reimplemented per vertical.

**Build order:** (1) usage-gate is P0 and touches the most other domains' safety
guarantees — do it first. (4) SSE adoption is mechanical and low-risk — good second
target since it's copy-paste per page once the hook exists. (3) and (5) are schema
+ one shared helper each — do together since both are "add a column /
add a call site everywhere" shaped. (2) is the riskiest (schema consolidation across
three existing tables with live data) — do last, after the others reduce the blast
radius of getting it wrong.

---

## Fix priority

**P0**
- Wire `usageBlocked`/`assertUsageAllowed` into `tool-executor.ts` so Billing's hard
  cap actually stops Ask AI, webhook, and Growth execution — currently purely
  cosmetic (billing.md #1).
- Unify "Automation Rate" definition between Home and Analytics so the same org
  doesn't show two contradictory numbers under an identical label (analytics.md #2).
- Point `/brain`'s UI search at the same hybrid vector function the agent runtime
  uses, so what operators see searching Brain matches what actually grounds AI
  employee answers (brain.md #1).

**P1**
- 🟢 Resolved (open edges noted): shared `useRealtimeStream` now adopted by Conversations, Customer, Work Items and Plans (new `work_item_updated` / `plan_updated` events, polling fallback). Also adopted (quiet refetch via `useLiveRefresh`, debounced, polling fallback): Home, Brief, Insight, Analytics, Observability, Growth, Inquiries, Brain (brain delete/correct routes now publish `memory.updated`). Listings (new `listing_updated` event, published by the listings create/patch/withdraw/sync routes). Billing (new `billing_updated` event, published by `upsertSubscription` / `upsertInvoice`, so both webhooks and user actions refresh open tabs; usage meters are not event-driven). Skills (new `integration_updated` event from the integrations connect/disconnect/config, Razorpay and WhatsApp BYOK routes), Settings and Autonomy (new `settings_updated` event from settings, autonomy, suppressions and decision routes; Settings quiet refresh leaves form fields untouched). Open edges: WhatsApp embedded-signup, Nango OAuth callback and employee roster changes do not publish yet, so Skills refreshes on its polling fallback only for those. Original ask: adopt one shared SSE hook across Home/Brief/Insight/Analytics/Observability/
  Growth/Inquiries/Listings so a decision made in one tab is reflected live in every
  other open tab, not just Conversations and Customer (five independent audits flag
  this identical gap).
- Add `employee_id` (UUID) as a first-class column in `org_employee_metrics_daily`
  and `observability_alerts` so Employees → Observability/Analytics attribution
  works per-hire, not just per-role.
- Consolidate audit-event emission behind one shared helper so `/audit` stops being
  blind to Settings/Billing/Employees/Connector mutations.
- Share one dedup/domain-lock function between Growth's B2B scouting and the
  real-estate listing-matcher so the same contact doesn't get two independent
  outbound touches from two different verticals.

**P2**
- Collapse `agent_pending_actions` / `work_items`-as-decision / `/api/settings/pending`
  into one canonical approval schema so Decisions, Work Items, Brief, and Customer's
  decision cards are unambiguously the same underlying queue.
- Confirm (or build) a workspace-switcher UI component wired into `AppShell.tsx`
  now that `organization_memberships` and `/api/org/switch` exist server-side.
- Invalidate in-memory TrueForge tool-definition caches when a skill is revoked in
  `/skills`, so an in-flight Ask AI turn cannot keep executing against a
  just-revoked tool_allowlist.
