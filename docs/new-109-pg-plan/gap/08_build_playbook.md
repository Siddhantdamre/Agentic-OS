# 08 — Build Playbook: How We Make the Full Plan Real

> **Purpose:** The engineering "how". `00_state_of_build.md` says what is missing;
> this file says exactly how to build it — file by file, migration by migration,
> workflow by workflow — grounded in the code that exists today.
> **Ground truth (2026-09-08):** migrations at `022`; `tool-executor.ts` has
> `resolveOrgToolAllowlist(orgId)` (no role arg); `AutonomousAgentWorkflow` uses
> `proxyActivities` + `defineQuery`/`setHandler`; activities live in
> `services/workflows/src/activities/`; worker loads `./workflows/index.js`.

---

## 0. Operating Principles (do not skip)

1. **State first, behaviour second.** No workflow ships before its table exists with RLS. A workflow with nowhere durable to write is a demo, not a feature.
2. **One migration per phase**, additive only. Never alter `001`–`022`. New tables get `ENABLE` + `FORCE ROW LEVEL SECURITY`, an `org_id` policy identical to existing tables, and `GRANT SELECT, INSERT, UPDATE, DELETE ... TO darex_app`.
3. **Every autonomous write goes through the autonomy gate.** After Phase 1, no code path calls a connector write tool without passing `checkAutonomy(orgId, employeeRole, actionType)`.
4. **Every non-trivial decision writes one `agent_decision_ledger` row** — including "decided not to". This is cheap at write time and impossible to reconstruct later.
5. **Temporal owns all time.** No `setTimeout`, no cron library, no `pg_cron`. Delays are `workflow.sleep`; schedules are Temporal Schedules registered at worker boot.
6. **Each phase ends with a runnable check** (a `test_*.ts` or a scripted demo path) that fails if the phase regressed.

---

## 1. Phase 1 — State Layer + Autonomy Engine (Weeks 1–2)

**Goal:** persistent multi-tenant state for everything the blueprint needs, plus a
gate that decides autonomous-vs-approval per action.

### 1.1 Migration `023_employee_state_machines.sql`

Six tables. DDL is in `05_core_platform_and_runtime_gap.md §4` — copy it verbatim.
Add to each table, matching the pattern in `009_auth_tenancy.sql`:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>_org_isolation ON <t>
  USING (org_id = current_setting('app.current_org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON <t> TO darex_app;
```

Indexes that matter (workflows poll on these):
- `operational_enquiries (org_id, state, sla_expires_at)`
- `agent_open_loops (org_id, status, target_check_at)`
- `operational_expectations (org_id, is_discrepancy, expected_by_timestamp)`
- `agent_decision_ledger (org_id, created_at DESC)`

Seed `employee_autonomy_rules` with a default row set per org on org creation
(hook into the existing org-provisioning path). Defaults map straight from the
blueprint matrix (`plan/05 §4`):

| action_type | tier | requires_human_approval |
| :-- | :-: | :-: |
| `read_*` / `search_*` / `list_*` | 1 | false |
| `draft_email`, `recommend_merge`, `prepare_brief` | 2 | true |
| `reschedule_appointment`, `assign_owner`, `create_task`, `update_field` | 3 | false |
| `send_internal_reminder`, `answer_faq`, `update_status` | 4 | false |
| `refund_payment`, `delete_record`, `send_external_email` | 2 | true |

### 1.2 Shared types

`packages/shared-types/src/state-machines.ts`:
- enums: `EnquiryState`, `OpenLoopStatus`, `ExpectationStatus`, `DecisionOutcome`, `AutonomyTier`, `EmployeeRole`.
- `const ENQUIRY_TRANSITIONS: Record<EnquiryState, EnquiryState[]>` + `canTransition(from, to): boolean`.
- same for open loops and tasks. Mirror the diagrams in `plan/05`.
- `assertTransition()` throws on illegal move — call it in every state-write helper.

### 1.3 Data-access helpers

`apps/dashboard/lib/state/` (also importable by `services/workflows` via a shared package or a thin re-export):
- `enquiries.ts` — `createEnquiry`, `transitionEnquiry`, `listOverdue(orgId)`.
- `open-loops.ts` — `openLoop`, `transitionLoop`, `dueLoops(orgId, before)`.
- `expectations.ts` — `recordExpectation`, `settleExpectation`, `openDiscrepancies(orgId)`.
- `decision-ledger.ts` — `logDecision({orgId, employeeRole, actionConsidered, decision, confidence, reasonSummary, contextPayload})`, `explain(orgId, filter)`.

All use `getScopedClient(orgId)` — never the raw pool.

### 1.4 Autonomy gate

New file `services/workflows/src/autonomy.ts`:

```ts
export type AutonomyDecision =
  | { mode: 'execute' }
  | { mode: 'approval_required'; tier: AutonomyTier };

export async function checkAutonomy(
  orgId: string, employeeRole: EmployeeRole, actionType: string,
): Promise<AutonomyDecision>;
```

Logic: load `employee_autonomy_rules` for `(orgId, actionType)` (fallback to a
built-in default map when no row). Tier 1 & 4 and tier 3 with
`requires_human_approval=false` → `execute`. Otherwise → `approval_required`.

Wire it into `executeAutonomousToolAction()` in `tool-executor.ts` (line ~101):
resolve `actionType` from the tool name via `AUTONOMOUS_TOOL_CATALOG`, call
`checkAutonomy`, and on `approval_required` write an `agent_pending_actions` row +
return a sentinel instead of executing. Always `logDecision(...)` with the outcome.

### 1.5 Approval token + pause/resume

- Migration `023` also adds `agent_pending_actions (id, org_id, workflow_id, action_type, payload, token_hash, status, created_at, decided_at)`.
- Token = random 32 bytes; store SHA-256, hand the raw token to the dashboard.
- Generic `ApprovalGateWorkflow` helper or inline in `AutonomousAgentWorkflow`:
  ```ts
  const approved = defineSignal<[boolean]>('resolveApproval');
  setHandler(approved, v => { decisionValue = v; });
  await condition(() => decisionValue !== undefined, '7 days');
  ```
- `POST /api/agent/approvals/:id` in dashboard verifies token hash + caller org +
  role, then `client.workflow.getHandle(workflowId).signal('resolveApproval', ...)`.

### 1.6 Phase-1 check

`services/workflows/src/autonomy.test.ts`: assert tier-1 read → execute; refund →
approval_required; illegal enquiry transition throws; ledger row written on both
paths. Plus a manual: create pending action, hit the approve route, confirm the
workflow resumes.

---

## 2. Phase 2 — Customer Employee: Open Loops + Decision Cards (Weeks 3–4)

**Goal:** stop escalating raw chats; escalate decisions, track promises to closure,
recover customers 24h later.

### 2.1 Obligation extractor

`services/workflows/src/activities/obligation-extract.ts` — new activity
`extractObligationsActivity(turnText, context)`:
- LiteLLM call (`litellm-client`, `reasoning:{enabled:false}`) with a strict Zod
  schema: `{ hasObligation: boolean, promiseSummary: string, targetCheckAt: string | null, dependsOn: 'customer'|'internal'|'third_party' }`.
- Called from the post-turn path of `AutonomousAgentWorkflow` (after
  `runAgentTurnActivity`). On `hasObligation` → `openLoop(...)` + start
  `OpenLoopMonitorWorkflow` as a child with `workflowId = loop:<loopId>`.

### 2.2 `OpenLoopMonitorWorkflow`

`services/workflows/src/workflows/OpenLoopMonitorWorkflow.ts`:

```ts
export async function OpenLoopMonitorWorkflow(input: { loopId: string; orgId: string; targetCheckAt: string }) {
  const wake = defineSignal<[]>('externalUpdate');
  let updated = false;
  setHandler(wake, () => { updated = true; });

  await condition(() => updated, msUntil(input.targetCheckAt));
  const state = await checkSystemStateActivity(input);   // order/warehouse/ticket status
  if (state.resolved) {
    await sendCustomerUpdateActivity(input, state);
    await transitionLoopActivity(input.loopId, 'closed');
  } else {
    await escalateActivity(input);                        // creates a work_item / decision card
    await transitionLoopActivity(input.loopId, 'escalated');
  }
}
```

Register in `workflows/index.ts`. New activities: `checkSystemStateActivity`,
`sendCustomerUpdateActivity`, `transitionLoopActivity`, `escalateActivity`.

### 2.3 Decision Card

- Agent, when it hits `approval_required` or low confidence, calls
  `buildDecisionCardActivity` → writes structured `work_items.payload`:
  ```ts
  interface DecisionCardPayload {
    customer: { name: string; identifier: string; sentiment: string };
    issue: string; orderRef?: string;
    policy: string; recommendedAction: { type: string; args: Record<string,unknown>; humanText: string };
    evidenceIds: string[];
  }
  ```
- `apps/dashboard/components/inbox/DecisionCard.tsx` renders it; buttons call
  `POST /api/work-items/:id/decision` with `{ action: 'approve'|'modify'|'reject', modifiedArgs? }`.
- Route signals the paused workflow (Phase 1.5 mechanism) → agent executes the
  tool → `sendCustomerUpdateActivity` closes the loop → `logDecision('executed', ...)`.

### 2.4 `CustomerRecoveryWorkflow`

Triggered from the `work_items` → `resolved` transition (add a hook in
`WorkItemWorkflow` or the patch route):

```ts
export async function CustomerRecoveryWorkflow(input: { orgId: string; conversationId: string; customerId: string }) {
  await sleep('24 hours');
  const health = await checkCustomerHealthActivity(input);   // any new inbound complaint since?
  if (!health.newComplaint) {
    await sendCheckInActivity(input);                         // "Hi Rahul, just checking your order arrived ok"
    await updateSentimentActivity(input, 'recovered');
  }
}
```

### 2.5 Persistent customer state

Add `customer_operational_state` to the existing `conversations` (or `entities`)
row via `023`: `'new'|'existing'|'waiting'|'unresolved'|'frustrated'|'vip'|'at_risk'`.
Write it from a deterministic rule in the post-turn path (sentiment score +
open-loop presence + escalation history), not from the LLM.

### 2.6 Confidence gate

In `runAgentTurnActivity`: before returning a customer-facing answer, if
`max(ragSimilarity) < 0.72` AND no tool returned a matching entity →
force the escalation branch (build decision card, tell customer a human will
follow up). Config threshold in env.

### 2.7 Phase-2 check

Scripted: send WhatsApp "check with warehouse at 4pm" → assert `agent_open_loops`
row + child workflow. Advance Temporal time 4h in a test env → assert customer
message sent or escalation created. Resolve a work item → assert
`CustomerRecoveryWorkflow` scheduled.

---

## 3. Phase 3 — Operations Employee: Expected-vs-Actual + Stuck Work (Weeks 5–6)

**Goal:** the 9:00 AM Morning Check and continuous stalled-work detection.

### 3.1 Temporal Schedules at worker boot

In `worker.ts` after the worker starts, an idempotent
`ensureSchedules(client)` that upserts:
- `daily-morning-check-<orgId>` → `DailyMorningCheckCron`, cron `0 9 * * *` in org TZ.
- `stuck-work-hourly-<orgId>` → `StuckWorkDetectorWorkflow`, every 1h.
- `meeting-prep-<orgId>` → `MeetingPrepWorkflow`, `0 18 * * *`.
- `nightly-insight-<orgId>` → `ConversationalInsightWorkflow`, `0 2 * * *`.

Org list comes from a `listActiveOrgs()` activity. Re-run `ensureSchedules` when
an org is created.

### 3.2 `DailyMorningCheckCron`

```ts
export async function DailyMorningCheckCron(input: { orgId: string }) {
  const raw = await sweepChannelsActivity(input, { sinceHours: 24 });     // webhook_inbox + Gmail threads
  const classified = await classifyEnquiriesActivity(raw);               // intent, priority, missing-info
  for (const e of classified) {
    const dup = await fuzzyMatchCrmActivity(input.orgId, e);             // pg_trgm
    if (dup.score >= 0.85) await updateExistingRecordActivity(dup, e);
    else if (dup.score >= 0.60) await quarantineActivity(input.orgId, e, dup);
    else await createEnquiryActivity(input.orgId, e);                    // operational_enquiries, state=new
  }
  const brief = await buildTriageBriefActivity(input.orgId);            // 3-tier: critical/high/medium
  await persistBriefActivity(input.orgId, brief);
  await notifyOwnerActivity(input.orgId, brief);                        // WhatsApp / Slack
}
```

### 3.3 Dedup engine

Migration `023` (or `023b`): `CREATE EXTENSION IF NOT EXISTS pg_trgm;` +
`ambiguous_duplicate_reviews (id, org_id, inbound_payload, candidate_crm_id, similarity, status, created_at)`.
`services/workflows/src/operations/dedup-engine.ts`:
`scoreSimilarity(a, b)` blends `similarity(name)`, exact domain match (+0.3),
exact phone match (+0.3), clamp 0–1. Bands: `≥0.85` merge, `0.60–0.85` quarantine,
`<0.60` new.

### 3.4 Expected-vs-Actual

- When an enquiry hits `assigned`, `recordExpectation({objectType:'enquiry', objectId, expectedState:'contacted', expectedBy: now + 2h})`.
- `StuckWorkDetectorWorkflow` hourly:
  ```ts
  const open = await openDiscrepanciesActivity(orgId);          // expected_by < now AND actual != expected
  for (const d of open) { await flagAndRouteActivity(d); }      // decision card or reminder per tier
  const stalled = await scanStalledActivity(orgId);             // CRM stage age >5d, quote pending >48h, tomorrow meeting w/o brief
  ...
  ```
- Verification pass: a cheap activity that reads the actual system (CRM last-contact
  timestamp, calendar, work_items) and calls `settleExpectation` when satisfied.

### 3.5 Triage brief — filtering

`buildTriageBriefActivity` returns **at most** the blueprint's shape
(`plan/05 §5`): Critical → immediate, High → morning brief, Medium → dashboard log,
Low → auto-handled/suppressed. Rank by `(severity, sla_overshoot, value)` and cap
High at ~5 items with "Everything else is up to date."

### 3.6 Self-explanation API

`GET /api/agent/explain?objectId=&actionType=` → `decision-ledger.explain()` →
returns the logged `reason_summary` + `confidence_score` + evidence. Dashboard:
small "Why?" affordance on every enquiry/task row.

### 3.7 Phase-3 check

Seed 5 fake overnight enquiries (1 clean, 1 exact dup, 1 fuzzy, 1 missing-info,
1 enterprise). Trigger the cron manually. Assert: 1 `operational_enquiries` new,
1 CRM update, 1 `ambiguous_duplicate_reviews`, brief has correct tiers.
Age an enquiry past SLA → assert discrepancy flagged next `StuckWork` run.

---

## 4. Phase 4 — Growth Employee: Lookalike + Signals + Opportunity Card (Weeks 7–8)

**Goal:** turn Growth from reactive chat into a continuous pipeline engine.

### 4.1 Lookalike profiler

`services/workflows/src/growth/lookalike-profiler.ts`:
- `buildIcp(orgId)` → query connected CRM for closed-won (HubSpot `dealstage`,
  Zoho equivalent), take top ~20 by value.
- Extract features per account: employee band, industry, geo, tech tags (from
  enrichment / Apollo). Compute the mode/centroid → `IcpProfile`.
- Persist to `023` `growth_icp_profiles (org_id, profile jsonb, sample_size, computed_at)`.
- `scoreCandidate(candidate, icp)` → 0–100 weighted match.

### 4.2 Signal watcher

- `023`: `lead_intent_signals (id, org_id, company_name, company_domain, signal_type, payload jsonb, detected_at, consumed_at)`.
- `GrowthContinuousWatcherWorkflow` (Schedule, every 4h):
  ```ts
  const icp = await loadIcpActivity(orgId);
  const signals = await pollSignalsActivity(orgId);        // Apollo alerts, Google News RSS, widget intent counters
  await persistSignalsActivity(orgId, signals);
  const candidates = await matchAndRankActivity(orgId, icp, signals);
  for (const c of candidates.filter(x => x.score >= THRESHOLD && x.hasActiveSignal)) {
    await createOpportunityActivity(orgId, c);             // writes work_item type='growth_opportunity'
  }
  ```
- Filter out zero-signal accounts (anti-fatigue, blueprint p.12).

### 4.3 Website visitor de-anon (widget upgrade)

- `apps/dashboard/app/api/widget/session/` — on session, call reverse-IP
  (Clearbit Reveal / Snitcher) activity → store `company_domain` on the session.
- Increment `pricing_page_visits` etc. per recognized company → emit
  `lead_intent_signals` rows of type `page_intent`.

### 4.4 Opportunity Card

- Zod `GrowthOpportunityPayload` (schema in `01_growth_employee_gap.md §7`).
- Watcher populates it: `whyThisCompany` from ICP score, `whyThisPerson` from
  Apollo decision-maker lookup, `whyNow` from the triggering signals,
  `draftedMessage` from a LiteLLM draft activity (tier-2 → `approval_required`).
- `apps/dashboard/components/growth/OpportunityCard.tsx` + list at
  `app/(dashboard)/employees/growth/page.tsx`. Buttons: `[Review]`, `[Edit]`,
  `[Approve & Send]` → same signal/approve mechanism as decision cards.

### 4.5 Negative preference learner

`agent_feedback` rows already exist and nothing reads them. New activity in a
nightly step: `synthesizePreferencesActivity(orgId)` → LiteLLM distills rejection
comments into `{ rule: string, filter: jsonb }` → `org_preferences` table (`023`).
Watcher's `matchAndRankActivity` applies these as hard filters before ranking.

### 4.6 Generalize `StaleChaseWorkflow`

Extract the real-estate specifics into a pack config; core becomes
`DormantLeadRevivalWorkflow`: CRM contacts with `last_activity > 180d`
cross-referenced against `lead_intent_signals` → revival opportunity card.

### 4.7 Phase-4 check

Seed 10 fake won deals → assert `growth_icp_profiles` row with sane bands.
Inject a `funding` signal for an ICP-matching company → run watcher → assert a
`growth_opportunity` work item with a populated 3-part rationale. Reject it with
"no companies under 50 staff" → assert `org_preferences` rule → assert next run
filters sub-50 companies.

---

## 5. Phase 5 — Connect Role-Scoping + ROI Ledger + Demo Hardening (Weeks 9–10)

### 5.1 Role-scoped tool allowlist

Change `resolveOrgToolAllowlist(orgId)` →
`resolveOrgToolAllowlist(orgId, employeeRole)` in `tool-executor.ts`.
Add `ROLE_CAPABILITY_MATRIX: Record<EmployeeRole, Record<string, string[]>>`
(connector → allowed tool suffixes), e.g.:

```ts
growth:    { hubspot: ['search_contacts','create_deal','update_stage','draft_note'] },
customer:  { hubspot: ['get_contact','list_tickets','create_ticket','update_note'] },
operations:{ hubspot: ['audit_fields','flag_duplicate','reassign_owner','update_status'] },
```

`mergeRuntimeAllowlist` intersects the connected-channel tools with the role
matrix instead of unioning. Update every caller to pass the role (it is already
on `AgentTaskInput` / plan context). Deny-by-default: a tool not in the matrix is
not exposed.

### 5.2 Rate limiter

`services/workflows/src/rate-limit.ts` — per-`(orgId, connector)` token bucket
(in-memory is fine for single worker; note the ceiling). Wrap connector HTTP in
`tool-executor`; on `429` respect `Retry-After`, exponential backoff, surface a
clean "system busy, retrying" rather than a tool error.

### 5.3 ROI ledger

Migration `024_business_outcomes.sql`: `employee_roi_metrics` (schema in
`05 §4.6`) + `growth_pipeline_attribution (opportunity_id, crm_deal_id, stage, estimated_value, org_id)`.
Write points:
- opportunity → CRM deal created: attribution row.
- work item resolved with no human touch: `ticket_resolved_autonomously`.
- each autonomous action that replaces a human step: `hours_saved` (fixed
  estimate per action type).
`GET /api/analytics/roi` + panel on `/dashboard/stats`. This replaces token-count
as the headline metric (`plan/00 §4`).

### 5.4 Interactive Slack

Slack Block Kit message for decision cards; `POST /api/slack/interactions`
verifies signing secret → same decision route as the dashboard button.

### 5.5 Outlook / MS365 + Teams

Finish Azure AD multi-tenant app registration, run live consent, flip the
scaffolded Graph client to live. Teams webhook → notification parity with Slack.

### 5.6 End-to-end demo run (acceptance for the whole plan)

Scripted, must pass start to finish:
1. Fresh org connects Gmail + WhatsApp + HubSpot + Calendar once via Connect.
2. Overnight: 28 enquiries seeded across channels.
3. 9:00 AM cron: processes all 28, reports exactly 3 exceptions, "everything else up to date."
4. Operator: "take care of #1" → autonomous resolution, CRM + calendar + WhatsApp all updated, loop closed.
5. Customer sends "move my appointment to tomorrow 3pm" on WhatsApp → rescheduled, CRM updated, confirmed — no human.
6. Customer refund request → decision card (not a raw chat) → operator approves → refund tool runs → customer notified → 24h later recovery check-in fires.
7. Operator: "why didn't you merge Acme Technologies and Acme Tech Solutions?" → instant answer from `agent_decision_ledger`: "domain match uncertain, confidence 0.58 < 0.85."
8. `/dashboard/stats` shows pipeline $ influenced and hours saved, not tokens.

---

## 6. Cross-Phase Workstreams (run continuously)

| Stream | What |
| :-- | :-- |
| **Prompt hardening** | per-employee system prompts with explicit negative constraints ("never promise delivery without order-system confirmation"); untrusted-content isolation wrapper around all RAG/tool output before it re-enters the model. |
| **Observability** | every workflow emits Langfuse spans; every `agent_decision_ledger` row links its trace id. Dashboard "activity" view reads both. |
| **Fact ingestion** | `FactExtractWorkflow` (uses live `022` schema) runs post-conversation to populate `entities`/`facts`; agent reads structured facts before falling back to raw transcript. Unblocks "the employee already knows Rahul's history." |
| **Pack config** | move real-estate specifics (ShowingSchedule, RentReminder, StaleChase) behind pack configs so the core workflows are industry-neutral. |
| **Tests** | each new workflow gets a time-skipping Temporal test; each new table gets an RLS test (cross-org read returns zero rows). |

---

## 7. Dependency Order (the one picture)

```text
        ┌─────────────────────────────────────────────┐
        │ Phase 1: 023 tables + autonomy gate + tokens │  ← everything depends on this
        └───────┬───────────────────────┬─────────────┘
                │                       │
     ┌──────────▼─────────┐   ┌─────────▼──────────┐
     │ Phase 2: Customer  │   │ Phase 3: Ops       │
     │ open loops, cards, │   │ morning check,     │
     │ recovery           │   │ expected-vs-actual │
     └──────────┬─────────┘   └─────────┬──────────┘
                │                       │
                │             ┌─────────▼──────────┐
                │             │ Phase 4: Growth    │
                │             │ (needs decision-   │
                │             │  card + schedule   │
                │             │  infra from 2 & 3) │
                │             └─────────┬──────────┘
                └───────────┬───────────┘
                  ┌─────────▼───────────┐
                  │ Phase 5: role-scope,│
                  │ ROI, Slack, demo    │
                  └─────────────────────┘
```

Ship Phase 1 clean or nothing after it stands up. Phases 2 and 3 can run in
parallel by two people. Phase 4 reuses the card + schedule plumbing from 2/3.
Phase 5 is integration + polish + the demo that proves 100% blueprint parity.
