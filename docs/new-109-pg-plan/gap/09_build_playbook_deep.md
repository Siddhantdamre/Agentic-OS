# 09 — Build Playbook (Deep): Conventions, Skeletons, Exact Wiring

> **Supersedes the loose parts of `08`.** `08` sketched the phases; this file
> pins every new file to the patterns already in the repo so a new workflow looks
> like `OwnerBriefingWorkflow`, a new migration looks like `022`, and a new
> activity looks like the ones in `activities/index.ts`.
>
> **Corrections to `08` from reading the code:**
> - The repo does **not** use Temporal Schedules / cron. Daily loops are
>   `msUntilNextHourActivity` → `sleep` → `continueAsNew` (see `OwnerBriefingWorkflow`).
>   New periodic workflows follow that pattern.
> - FK target is **`orgs(id)`**, not `organizations(id)`. PK default is
>   **`uuid_generate_v4()`**.
> - HITL already exists: `resolveInboundHitlGate({userMessage})` + `approveWorkItemSignal`
>   + `condition(() => lastConfirm !== undefined)` in `WorkItemWorkflow`. The
>   autonomy engine extends this, it does not replace it.
> - Idempotency is universal: every activity takes a `businessKey`, uses
>   `withOrgClient`, and `readIdempotent`/`writeIdempotent` against `idempotency_keys`.

---

## A. Repo Conventions (copy these exactly)

### A.1 Migration file shape (from `022_entity_graph.sql`)

```sql
-------------------------------------------------------------------------------
-- Employee State Machines — Migration 023 (Autonomous Employee Layer)
--
-- Implements docs/new-109-pg-plan/gap/05 §4. Additive only: nothing existing
-- changes. Staged rollout — tables ship here; workflows write in "shadow" mode
-- and the dashboard ignores them until per-org flag `autonomy_enabled` is on.
--
-- Tenancy: every table gets RLS ENABLE + FORCE with USING + WITH CHECK in this
-- same migration. Grants to darex_app here.
--
-- File: infra/db/migrations/023_employee_state_machines.sql
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS operational_enquiries (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL,
  external_sender_id TEXT NOT NULL DEFAULT '',
  customer_name     TEXT NOT NULL DEFAULT '',
  company_name      TEXT NOT NULL DEFAULT '',
  intent_category   TEXT NOT NULL DEFAULT 'unknown',
  priority          TEXT NOT NULL DEFAULT 'medium',
  state             TEXT NOT NULL DEFAULT 'new',
  assigned_owner_id UUID,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  sla_expires_at    TIMESTAMPTZ,
  last_contacted_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oe_state_chk    CHECK (state IN ('new','assigned','contacted','in_progress','overdue','escalated','qualified','converted','closed')),
  CONSTRAINT oe_priority_chk CHECK (priority IN ('critical','high','medium','low'))
);

ALTER TABLE operational_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_enquiries FORCE  ROW LEVEL SECURITY;
CREATE POLICY oe_org_isolation ON operational_enquiries
  USING      (org_id = current_setting('app.current_org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON operational_enquiries TO darex_app;

CREATE INDEX oe_poll_idx ON operational_enquiries (org_id, state, sla_expires_at);
```

Repeat verbatim structure for: `agent_open_loops`, `operational_expectations`,
`agent_decision_ledger`, `employee_autonomy_rules`, `agent_pending_actions`,
`employee_roi_metrics` (DDL bodies in `05 §4`; apply this exact RLS/GRANT/index
block to each). Add one row to an `org_settings`/flags table:
`autonomy_enabled BOOLEAN NOT NULL DEFAULT FALSE`.

### A.2 Activity shape (from `activities/index.ts`)

```ts
export async function transitionEnquiryActivity(params: {
  orgId: string;
  enquiryId: string;
  toState: EnquiryState;
  reason?: string;
  businessKey: string;
}): Promise<{ enquiryId: string; state: EnquiryState }> {
  const key = sideEffectKey(params.orgId, 'transitionEnquiry', params.businessKey);
  const cached = await readIdempotent<{ enquiryId: string; state: EnquiryState }>(params.orgId, key);
  if (cached) return cached;

  const out = await withOrgClient(params.orgId, async (client) => {
    const cur = await client.query(
      `SELECT state FROM operational_enquiries WHERE id = $1 AND org_id = $2`,
      [params.enquiryId, params.orgId],
    );
    if (cur.rows.length === 0)
      throw ApplicationFailure.nonRetryable('enquiry not found', 'InvalidArgumentError');
    assertTransition('enquiry', cur.rows[0].state, params.toState); // throws on illegal move
    const res = await client.query(
      `UPDATE operational_enquiries
         SET state = $1, updated_at = NOW(),
             last_contacted_at = CASE WHEN $1 = 'contacted' THEN NOW() ELSE last_contacted_at END
       WHERE id = $2 AND org_id = $3
       RETURNING id, state`,
      [params.toState, params.enquiryId, params.orgId],
    );
    return { enquiryId: res.rows[0].id, state: res.rows[0].state };
  });

  await writeIdempotent(params.orgId, key, out);
  return out;
}
```

Every state-mutating activity: `sideEffectKey` → `readIdempotent` → `withOrgClient`
→ `writeIdempotent`. Non-retryable errors use `ApplicationFailure.nonRetryable(msg, 'InvalidArgumentError')`.

### A.3 Periodic workflow shape (from `OwnerBriefingWorkflow`)

```ts
const { ...acts } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '6 minutes',
  retry: { initialInterval: '2s', maximumAttempts: 3, backoffCoefficient: 2,
           nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'] },
});

export async function StuckWorkDetectorWorkflow(input: {
  orgId: string; intervalMinutes?: number; repeat?: boolean;
}): Promise<StuckWorkResult> {
  const orgId = requireOrgId(input.orgId);
  const every = input.intervalMinutes ?? 60;

  const discrepancies = await scanExpectationsActivity({ orgId, businessKey: `stuckwork:${orgId}:${slot()}` });
  for (const d of discrepancies) {
    await routeDiscrepancyActivity({ orgId, discrepancy: d, businessKey: `stuckwork:${orgId}:${d.id}` });
  }
  const stalled = await scanStalledWorkActivity({ orgId, businessKey: `stuckwork:${orgId}:stalled:${slot()}` });
  // ... route stalled ...

  if (input.repeat !== false) {
    await sleep(every * 60_000);
    await continueAsNew<typeof StuckWorkDetectorWorkflow>({ orgId, intervalMinutes: every, repeat: true });
  }
  return { orgId, discrepancies: discrepancies.length, stalled: stalled.length };
}
```

`slot()` = a coarse time bucket string (e.g. `YYYYMMDDHH`) so retries inside one
tick dedupe but the next tick gets a fresh key. Deterministic-safe: derive it from
`workflowInfo().startTime` inside the workflow, or pass it from an activity.

### A.4 Singleton workflow IDs (from `quiet-hours.js`)

Add helpers next to `ownerBriefingWorkflowId`:

```ts
export const stuckWorkWorkflowId       = (orgId: string) => `stuck-work-${orgId}`;
export const morningCheckWorkflowId    = (orgId: string) => `morning-check-${orgId}`;
export const growthWatcherWorkflowId   = (orgId: string) => `growth-watcher-${orgId}`;
export const openLoopWorkflowId        = (loopId: string) => `open-loop-${loopId}`;
export const customerRecoveryWorkflowId = (workItemId: string) => `recovery-${workItemId}`;
```

Start with `{ workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY' }` and swallow
`WorkflowExecutionAlreadyStartedError` — that is how the repo keeps one live
instance per org.

### A.5 Bootstrapping the periodic workflows

There is no scheduler service. Two triggers, matching how `OwnerBriefingWorkflow`
is already kicked off:
1. **On org provisioning / connector connect** — the dashboard route that marks an
   org active also calls `ensurePeriodicWorkflows(orgId)` in
   `services/workflows/src/workflow-client.ts`, which `client.workflow.start`s each
   singleton (id from A.4, dedupe by reuse policy).
2. **On worker boot** — `worker.ts` after `worker.run()` calls a one-shot
   `reconcilePeriodicWorkflows()` that lists orgs with `autonomy_enabled = true`
   and ensures each singleton is running. Idempotent, cheap, covers restarts.

---

## B. Phase 1 — State + Autonomy (exact wiring)

### B.1 `assertTransition` — `packages/shared-types/src/state-machines.ts`

```ts
export type EnquiryState =
  | 'new' | 'assigned' | 'contacted' | 'in_progress'
  | 'overdue' | 'escalated' | 'qualified' | 'converted' | 'closed';

export const ENQUIRY_TRANSITIONS: Record<EnquiryState, EnquiryState[]> = {
  new:        ['assigned', 'closed'],
  assigned:   ['contacted', 'overdue', 'closed'],
  contacted:  ['in_progress', 'qualified', 'overdue', 'closed'],
  overdue:    ['contacted', 'escalated', 'closed'],
  escalated:  ['contacted', 'in_progress', 'closed'],
  in_progress:['qualified', 'converted', 'closed'],
  qualified:  ['converted', 'closed'],
  converted:  ['closed'],
  closed:     [],
};

export function assertTransition(
  machine: 'enquiry' | 'open_loop' | 'task',
  from: string, to: string,
): void {
  const table = { enquiry: ENQUIRY_TRANSITIONS, open_loop: OPEN_LOOP_TRANSITIONS, task: TASK_TRANSITIONS }[machine];
  if (from === to) return;
  if (!table[from]?.includes(to as any))
    throw new Error(`illegal ${machine} transition: ${from} -> ${to}`);
}
```

`OPEN_LOOP_TRANSITIONS` and `TASK_TRANSITIONS` mirror the diagrams in
`plan/05 §2–3` exactly. Open loop: `waiting↔scheduled↔monitoring → escalated → closed`,
`* → closed`.

### B.2 Autonomy gate — `services/workflows/src/autonomy.ts`

```ts
import { withOrgClient } from './tools/shared.js';

export type AutonomyMode = 'execute' | 'approval_required';
export interface AutonomyVerdict {
  mode: AutonomyMode; tier: 1|2|3|4; actionType: string; ruleSource: 'db' | 'default';
}

// action_type derived from tool+action, NOT the raw tool name.
export function classifyAction(tool: string, action: string): string {
  const a = `${tool}.${action}`.toLowerCase();
  if (/(search|list|get|fetch|read|lookup|report|metrics)/.test(a)) return 'read';
  if (/(draft|prepare|recommend|suggest)/.test(a))                   return 'draft';
  if (/(refund|delete|remove|purge)/.test(a))                        return 'high_risk';
  if (/(send|reply|post|email|message|whatsapp)/.test(a))            return 'external_send';
  if (/(create|update|assign|reschedule|move|set)/.test(a))          return 'write';
  return 'write';
}

const DEFAULTS: Record<string, { tier: 1|2|3|4; approval: boolean }> = {
  read:          { tier: 1, approval: false },
  draft:         { tier: 2, approval: true  },
  write:         { tier: 3, approval: false },
  external_send: { tier: 2, approval: true  },
  high_risk:     { tier: 2, approval: true  },
};

export async function checkAutonomy(
  orgId: string, employeeRole: string, tool: string, action: string,
): Promise<AutonomyVerdict> {
  const actionType = classifyAction(tool, action);
  const row = await withOrgClient(orgId, async (c) => {
    const r = await c.query(
      `SELECT autonomy_tier, requires_human_approval
         FROM employee_autonomy_rules
        WHERE org_id = $1 AND action_type = $2
        LIMIT 1`, [orgId, actionType]);
    return r.rows[0];
  }).catch(() => undefined);

  const spec = row
    ? { tier: row.autonomy_tier as 1|2|3|4, approval: row.requires_human_approval as boolean }
    : DEFAULTS[actionType];

  const mode: AutonomyMode =
    (spec.tier === 1 || spec.tier === 4 || (spec.tier === 3 && !spec.approval))
      ? 'execute' : 'approval_required';

  return { mode, tier: spec.tier, actionType, ruleSource: row ? 'db' : 'default' };
}
```

### B.3 Wire into `tool-executor.ts`

In `executeAutonomousToolAction`, after the allowlist check (line ~128), before
`executeProvider` (line ~131):

```ts
// autonomy gate — only when the caller declares an employee role and the org opted in
if (params.employeeRole && await isAutonomyEnabled(params.orgId)) {
  const verdict = await checkAutonomy(params.orgId, params.employeeRole, baseTool, actionName);
  await logDecision({
    orgId: params.orgId, employeeRole: params.employeeRole,
    actionConsidered: verdict.actionType, decision: verdict.mode === 'execute' ? 'executed' : 'deferred',
    confidence: params.confidence ?? 1, reasonSummary:
      verdict.mode === 'execute'
        ? `tier ${verdict.tier} (${verdict.ruleSource}) — auto`
        : `tier ${verdict.tier} (${verdict.ruleSource}) — needs approval`,
    contextPayload: { tool: params.tool, action: actionName, payload: params.payload },
  });
  if (verdict.mode === 'approval_required') {
    const pending = await createPendingAction({
      orgId: params.orgId, workflowId: params.workflowId,
      actionType: verdict.actionType, payload: { tool: params.tool, action: actionName, payload: params.payload },
    });
    return {
      tool: params.tool, action: actionName, status: 'pending_approval',
      message: `Queued for human approval (${verdict.actionType}).`,
      data: { pendingActionId: pending.id, tier: verdict.tier }, timestamp,
    };
  }
}
```

Add `employeeRole?`, `workflowId?`, `confidence?` to `ToolExecutionParams` in
shared-types. `ToolExecutionResult.status` gains `'pending_approval'`.

### B.4 Pause / resume in the workflow

The turn activity returns `status: 'pending_approval'` inside `executedSteps`.
`AutonomousAgentWorkflow` (or a new `AutonomousActionWorkflow` wrapper) checks for
it and blocks — reuse the exact `WorkItemWorkflow` pattern:

```ts
const resolveApproval = defineSignal<[boolean, Record<string,unknown>?]>('resolveApproval');
let approval: { ok: boolean; modifiedArgs?: Record<string,unknown> } | undefined;
setHandler(resolveApproval, (ok, modifiedArgs) => { approval = { ok, modifiedArgs }; });

if (turn.pendingActionId) {
  await condition(() => approval !== undefined, '7 days');
  if (!approval?.ok) { await markRejectedActivity(...); return failResult('approval_rejected'); }
  await executePendingActionActivity({ pendingActionId: turn.pendingActionId, modifiedArgs: approval.modifiedArgs, businessKey });
}
```

### B.5 Approve route — `apps/dashboard/app/api/agent/approvals/[id]/route.ts`

```
POST { decision: 'approve'|'reject'|'modify', modifiedArgs?, token }
 1. load agent_pending_actions row via getScopedClient(orgId from session)
 2. sha256(token) === row.token_hash  else 403
 3. row.status === 'pending' else 409
 4. RBAC: session user's role may approve row.action_type (reuse 019_human_roles)
 5. client.workflow.getHandle(row.workflow_id).signal('resolveApproval', decision==='approve', modifiedArgs)
 6. UPDATE agent_pending_actions SET status=$decision, decided_at=NOW(), decided_by=$userId
 7. logDecision(decision='executed'|'rejected', reason='human approval')
```

Token: `crypto.randomBytes(32).toString('base64url')`; store
`crypto.createHash('sha256').update(token).digest('hex')`.

---

## C. Phase 2 — Customer (exact wiring)

### C.1 Where the obligation extractor hooks in

`AutonomousAgentWorkflow` post-turn, after the `saveMessageActivity` block
(line ~95), only for channel turns (`input.channelId` present):

```ts
if (input.conversationId && resultToSave.replyMessage && input.employeeRole === 'customer') {
  const ob = await extractObligationActivity({
    orgId: input.orgId, conversationId: input.conversationId,
    assistantText: resultToSave.replyMessage, nowIso: <deterministic current time activity>,
    businessKey: `${input.idempotencyKey}:obligation`,
  });
  if (ob.hasObligation) {
    await openLoopActivity({
      orgId: input.orgId, conversationId: input.conversationId,
      customerIdentifier: input.customerIdentifier ?? '',
      promiseSummary: ob.promiseSummary, targetCheckAt: ob.targetCheckAt,
      assignedEmployeeRole: 'customer',
      businessKey: `${input.idempotencyKey}:openloop`,
    });
    await startChild(OpenLoopMonitorWorkflow, {
      workflowId: openLoopWorkflowId(ob.loopId),
      args: [{ loopId: ob.loopId, orgId: input.orgId, targetCheckAt: ob.targetCheckAt }],
      parentClosePolicy: ParentClosePolicy.ABANDON,
    });
  }
}
```

`extractObligationActivity` — LiteLLM call via `litellm-client`, `reasoning:{enabled:false}`,
strict JSON, temperature 0:

```
system: "Extract any commitment the assistant made to do something later or get back
to the customer. Return JSON only."
schema: { hasObligation: bool, promiseSummary: string,
          targetCheckAt: ISO8601 | null,   // resolve 'at 4 PM', 'tomorrow', '3 days'
          dependsOn: 'customer'|'internal'|'third_party' }
```
If `targetCheckAt` null but `hasObligation` true → default `now + 4h`.

### C.2 `OpenLoopMonitorWorkflow`

```ts
export async function OpenLoopMonitorWorkflow(input: {
  loopId: string; orgId: string; targetCheckAt: string;
}): Promise<{ loopId: string; outcome: 'resolved'|'escalated'|'cancelled' }> {
  const externalUpdate = defineSignal<[]>('externalUpdate');
  let woke = false;
  setHandler(externalUpdate, () => { woke = true; });

  const waitMs = await msUntilActivity({ iso: input.targetCheckAt });   // deterministic
  if (waitMs > 0) await condition(() => woke, waitMs);

  const loop = await loadOpenLoopActivity({ orgId: input.orgId, loopId: input.loopId,
    businessKey: `loop:${input.loopId}:load` });
  if (loop.status === 'closed') return { loopId: input.loopId, outcome: 'cancelled' };

  const state = await checkSystemStateActivity({ orgId: input.orgId, loop,
    businessKey: `loop:${input.loopId}:check` });   // reads order/ticket/CRM per loop.metadata

  if (state.resolved) {
    await sendCustomerUpdateActivity({ orgId: input.orgId, loop, state,
      businessKey: `loop:${input.loopId}:notify` });
    await transitionLoopActivity({ orgId: input.orgId, loopId: input.loopId, toStatus: 'closed',
      businessKey: `loop:${input.loopId}:close` });
    return { loopId: input.loopId, outcome: 'resolved' };
  }

  await escalateLoopActivity({ orgId: input.orgId, loop,   // builds a decision-card work_item
    businessKey: `loop:${input.loopId}:escalate` });
  await transitionLoopActivity({ orgId: input.orgId, loopId: input.loopId, toStatus: 'escalated',
    businessKey: `loop:${input.loopId}:esc-state` });
  return { loopId: input.loopId, outcome: 'escalated' };
}
```

Signal path: a later inbound message on the same conversation (webhook) calls
`getHandle(openLoopWorkflowId(loopId)).signal('externalUpdate')` so a customer
reply short-circuits the wait.

### C.3 Decision card — reuse `work_items`, don't add a table

`escalateLoopActivity` / the low-confidence branch writes:

```ts
await upsertWorkItemActivity({
  orgId, conversationId, channel, type: 'conversation',
  status: 'needs_attention',
  // payload is the card:
});
// then a dedicated column update:
UPDATE work_items SET payload = $1 WHERE id = $2 AND org_id = $3
```
`payload` = `DecisionCardPayload` (in `08 §2.3`). The dashboard already lists
`work_items`; add `components/inbox/DecisionCard.tsx` that renders `payload` when
`payload.recommendedAction` is present, and `POST /api/work-items/[id]/decision`:

```
1. load work_item (getScopedClient), find its temporalWorkflowId
2. getHandle(temporalWorkflowId).signal(approveWorkItemSignal, decision==='reject' ? 'rejected' : 'approved')
   -- reuse the EXISTING signal; no new plumbing
3. if 'modify': stash modifiedArgs on payload first, workflow reads them
4. updateWorkItemStatusActivity(... 'in_progress' | 'cancelled')
```

### C.4 `CustomerRecoveryWorkflow` trigger

In `updateWorkItemStatusActivity` (or the patch route) when status → `done` and
`work_items.type = 'conversation'` and the item had an escalation:

```ts
await startChild(CustomerRecoveryWorkflow, {
  workflowId: customerRecoveryWorkflowId(workItemId),
  args: [{ orgId, conversationId, customerIdentifier, workItemId }],
  parentClosePolicy: ParentClosePolicy.ABANDON,
});
```
Body: `sleep('24 hours')` → `checkCustomerHealthActivity` (any inbound since
resolve with negative sentiment?) → if clean, `sendChannelMessageActivity` a
check-in → `recordRoiActivity('ticket_resolved_autonomously' or 'customer_recovered')`.

### C.5 Confidence gate

`retrieveMemory` already returns `citations`. In `runAutonomousAgentDirect` (or a
thin wrapper), before returning a customer-facing reply:

```ts
const topSim = Math.max(0, ...retrievedMemory.citations.map(c => c.score ?? 0));
const toolHit = executedSteps.some(s => s.result && /found|match|record/i.test(String(s.result)));
if (input.employeeRole === 'customer' && topSim < 0.72 && !toolHit) {
  // do not send the drafted answer; escalate instead
  return { ...result, replyMessage: ESCALATION_HOLDING_REPLY, forceEscalate: true };
}
```
`forceEscalate` makes `WorkItemWorkflow` build a decision card instead of sending.

---

## D. Phase 3 — Operations (exact wiring)

### D.1 `MorningCheckWorkflow` (continueAsNew daily, like OwnerBriefing)

```ts
export async function MorningCheckWorkflow(input: {
  orgId: string; timeZone?: string; hour?: number; repeatDaily?: boolean;
}): Promise<MorningCheckResult> {
  const orgId = requireOrgId(input.orgId);
  const tz = input.timeZone || 'UTC';
  const hour = input.hour ?? 9;

  const bk = `morning:${orgId}:${await dayStampActivity({ tz })}`;   // one run per day
  const raw       = await sweepChannelsActivity({ orgId, sinceHours: 24, businessKey: `${bk}:sweep` });
  const enriched  = await classifyEnquiriesActivity({ orgId, items: raw, businessKey: `${bk}:classify` });

  for (const e of enriched) {
    const m = await fuzzyMatchCrmActivity({ orgId, enquiry: e, businessKey: `${bk}:match:${e.hash}` });
    if (m.score >= 0.85)      await updateExistingRecordActivity({ orgId, match: m, enquiry: e, businessKey: `${bk}:upd:${e.hash}` });
    else if (m.score >= 0.60) await quarantineActivity({ orgId, enquiry: e, candidate: m, businessKey: `${bk}:quar:${e.hash}` });
    else                      await createEnquiryActivity({ orgId, enquiry: e, businessKey: `${bk}:new:${e.hash}` });
    // expected-vs-actual seed:
    if (m.score < 0.60)
      await recordExpectationActivity({ orgId, objectType: 'enquiry', objectId: e.hash,
        expectedState: 'contacted', expectedByIso: <now + 2h>, businessKey: `${bk}:exp:${e.hash}` });
  }

  const brief = await buildTriageBriefActivity({ orgId, businessKey: `${bk}:brief` });
  await persistBriefingActivity({ orgId, ...brief, businessKey: `${bk}:persist` });   // reuse existing activity
  await notifyOwnerActivity({ orgId, brief, businessKey: `${bk}:notify` });

  if (input.repeatDaily !== false) {
    const waitMs = await msUntilNextHourActivity({ timeZone: tz, hour });
    if (waitMs > 0) await sleep(waitMs);
    await continueAsNew<typeof MorningCheckWorkflow>({ orgId, timeZone: tz, hour, repeatDaily: true });
  }
  return { orgId, processed: enriched.length, ...brief.counts };
}
```

### D.2 Fuzzy match activity — `pg_trgm`

Migration `023` adds `CREATE EXTENSION IF NOT EXISTS pg_trgm;` and
`ambiguous_duplicate_reviews`. Activity:

```ts
// score = 0.5*name_trgm + 0.3*exact_domain + 0.2*exact_phone, clamp 0..1
const r = await client.query(
  `SELECT id, name, domain, phone,
          similarity(lower(name), lower($1)) AS name_sim
     FROM crm_contacts_cache        -- or live CRM tool result cached per run
    WHERE org_id = $2
    ORDER BY name_sim DESC LIMIT 5`,
  [enquiry.companyName, orgId]);
```
No `crm_contacts_cache` table yet → the activity calls the HubSpot/Zoho search
tool once per run, caches rows in a short-lived temp structure keyed by `bk`.
Ponytail: skip the cache table until a run measurably hits rate limits.

### D.3 `StuckWorkDetectorWorkflow` — see A.3 skeleton. Activities:

- `scanExpectationsActivity` — `SELECT * FROM operational_expectations WHERE org_id=$1 AND is_discrepancy=false AND expected_by_timestamp < NOW() AND actual_state <> expected_state`.
- `verifyActualActivity` — reads the real system (CRM last-contacted, calendar, work_items) and `settleExpectation` when satisfied (flips `actual_state`, sets `discrepancy_resolved_at`).
- `routeDiscrepancyActivity` — tier from `employee_autonomy_rules`: tier ≤2 → decision card; tier 3–4 → `sendInternalReminderActivity`.
- `scanStalledWorkActivity` — three sub-queries: CRM deal stage age > 5d, `work_items` open > SLA, tomorrow's calendar events without a linked briefing doc.

### D.4 Self-explanation — `GET /api/agent/explain`

```
?objectId=&actionType=&since=
 → getScopedClient(orgId).query(
     `SELECT action_considered, decision, confidence_score, reason_summary, created_at
        FROM agent_decision_ledger
       WHERE org_id = $1
         AND ($2::text IS NULL OR context_payload->>'objectId' = $2)
         AND ($3::text IS NULL OR action_considered = $3)
       ORDER BY created_at DESC LIMIT 20`)
 → format: "Did not <action> — <reason_summary> (confidence <score>, <relativeTime>)."
```
Dashboard: a "Why?" link on each enquiry / task row → drawer showing the ledger
entries for that `objectId`.

---

## E. Phase 4 — Growth (exact wiring)

### E.1 `GrowthWatcherWorkflow` (continueAsNew every 4h)

```ts
const bk = `growth:${orgId}:${slot4h()}`;
const icp = await loadOrBuildIcpActivity({ orgId, maxAgeDays: 7, businessKey: `${bk}:icp` });
const signals = await pollSignalsActivity({ orgId, sinceHours: 4, businessKey: `${bk}:signals` });
await persistSignalsActivity({ orgId, signals, businessKey: `${bk}:persist-sig` });
const prefs = await loadPreferencesActivity({ orgId, businessKey: `${bk}:prefs` });
const ranked = await rankCandidatesActivity({ orgId, icp, signals, prefs, businessKey: `${bk}:rank` });
for (const c of ranked.filter(x => x.score >= 70 && x.activeSignals.length > 0)) {
  await createOpportunityActivity({ orgId, candidate: c, businessKey: `${bk}:opp:${c.domain}` });
}
```

### E.2 `loadOrBuildIcpActivity`

- Read cached `growth_icp_profiles` if `computed_at > now - 7d`, else rebuild.
- Rebuild: `hubspot_search_contacts`/deal search tool for `dealstage=closedwon`,
  top 20 by amount → for each, enrichment (Apollo person/company) → collect
  `{ employeeBand, industry, geo, techTags[] }` → centroid = mode per field,
  numeric range = p10–p90 of headcount.
- Persist `{ profile: {...}, sampleSize, computedAt }`.

### E.3 `rankCandidatesActivity` — scoring

```
fit  = 0.4*industryMatch + 0.3*sizeInBand + 0.2*geoMatch + 0.1*techOverlap   (0..1)
now  = min(1, 0.5*hasHiringSignal + 0.5*hasIntentSignal + 0.3*hasFundingSignal)
score = round(100 * (0.6*fit + 0.4*now))
```
Apply `prefs` as hard filters first (`headcount >= 50`, `geo in [...]`) — drop,
don't down-rank.

### E.4 Opportunity card = `work_items` again

`type='conversation'` is wrong here — add `work_items.type` value
`'growth_opportunity'` (it's a TEXT column, no migration needed, update the TS
union). `payload` = `GrowthOpportunityPayload` (`01 §7`). `draftedMessage` comes
from `draftOutreachActivity` (LiteLLM) → classified `external_send` → the send
button goes through the **same** `approveWorkItemSignal` path as C.3.

### E.5 Preference synthesizer

Nightly step (fold into `MorningCheckWorkflow` or its own tiny workflow):

```
rows = SELECT comment FROM agent_feedback WHERE org_id=$1 AND rating='down' AND synthesized_at IS NULL
llm: "Convert each rejection reason into a filter rule. JSON array of
      { field: 'headcount'|'industry'|'geo'|'title', op: 'gte'|'lte'|'in'|'not_in', value }"
UPSERT org_preferences (org_id, rules jsonb)
UPDATE agent_feedback SET synthesized_at = NOW() WHERE ...
```
`agent_feedback` needs a `synthesized_at` column — add in `023`.

---

## F. Phase 5 — Role Scoping, ROI, Demo

### F.1 `resolveOrgToolAllowlist(orgId, employeeRole?)`

Keep the current union as the **org-owns** set (what CAN be called at all). Add a
second filter layer keyed by role:

```ts
const ROLE_TOOL_SCOPES: Record<string, RegExp[]> = {
  growth: [
    /^(web_search|web_extract|apollo|database_query|metrics|file_ops|code_execution)$/,
    /^gmail\.(draft|send|search|read)/, /^google-calendar\./,
    /^hubspot\.(search|create_deal|update_stage|create_contact|update_contact|draft_note)/,
    /^zoho\.(search|create_lead|update_record)/, /^(meta-ads|google-ads)\./, /^slack\.send/,
  ],
  customer: [
    /^(web_search|web_extract|database_query|metrics|file_ops)$/,
    /^gmail\.(draft|send|search|read)/, /^google-calendar\./, /^google-drive\.(search|read)/,
    /^hubspot\.(search|get|list|create_ticket|update_contact|draft_note)/,
    /^(zendesk|intercom)\./, /^whatsapp\.send/, /^slack\.send/,
  ],
  operations: [
    /^(web_search|database_query|metrics|file_ops|code_execution)$/,
    /^gmail\.(search|read)/, /^google-calendar\./, /^google-sheets\./, /^google-drive\./,
    /^hubspot\.(search|get|list|update_contact|update_deal)/, /^slack\.send/, /^whatsapp\.send/,
    /^(jira|asana|clickup)\./,
  ],
};
```

`isToolAllowed(baseTool, allowlist)` gets a companion
`isToolInRoleScope(tool, action, role)` called from `executeAutonomousToolAction`
right after the allowlist check. Deny → `status:'error'`, message
`"<tool>.<action> is outside the <role> employee's scope"`, and `logDecision`.

Callers already have the role: `WorkItemWorkflowInput.employeeRole`,
`AgentTaskInput.employeeRole`, plan context. Thread it into `ToolExecutionParams`.

### F.2 ROI ledger — migration `024_business_outcomes.sql`

`employee_roi_metrics` (05 §4.6) + `growth_pipeline_attribution`
`(id, org_id, opportunity_work_item_id, crm_deal_id, stage, estimated_value_cents, currency, created_at)`.
Same RLS/GRANT block as A.1.

`recordRoiActivity({ orgId, employeeRole, metricType, amountCents?, currency?, referenceId, businessKey })`
called at: opportunity→deal, work_item autonomous-resolve, each tier-3/4 auto
action (`hours_saved` fixed table: `send_reminder=0.1h`, `reschedule=0.25h`,
`dedup_merge=0.5h`, `resolve_ticket=0.75h`).

`GET /api/analytics/roi` aggregates last 30d; `/dashboard/stats` panel replaces
token cost as the headline (keep cost, demote it).

### F.3 Demo acceptance script — `services/workflows/scripts/demo-e2e.ts`

Deterministic, seeds one org, runs the 8 steps from `08 §5.6`, asserts on DB
state after each. This is the regression gate for "blueprint parity". Wire into
`package.json` as `demo:e2e`, run in CI nightly (not on every push — it needs live
connector sandboxes).

---

## G. Test Matrix (one runnable check per unit)

| Unit | Check | File |
| :-- | :-- | :-- |
| `assertTransition` | illegal move throws, legal passes, self is no-op | `packages/shared-types/state-machines.test.ts` |
| `classifyAction` / `checkAutonomy` | read→execute, refund→approval, db rule overrides default | `services/workflows/src/autonomy.test.ts` |
| RLS on all `023` tables | cross-org SELECT returns 0 rows | `infra/db/tests/023_rls.test.ts` |
| obligation extractor | "check warehouse at 4pm" → hasObligation + targetCheckAt≈16:00 | activity unit test w/ recorded LLM |
| `OpenLoopMonitorWorkflow` | time-skip to target → resolved path sends msg; unresolved → escalates; signal short-circuits wait | Temporal `TestWorkflowEnvironment` |
| fuzzy match | "Acme Tech Solutions" vs "Acme Technologies" → 0.6–0.85 band → quarantine | `dedup-engine.test.ts` |
| `MorningCheckWorkflow` | 5 seeded enquiries → 1 new / 1 update / 1 quarantine / correct brief tiers | Temporal env + seeded DB |
| role scope | customer role calling `hubspot.delete_contact` → denied + ledger row | `tool-executor.test.ts` |
| ROI rollup | seeded metrics → `/api/analytics/roi` returns correct sums | route test |
| demo E2E | all 8 steps green | `scripts/demo-e2e.ts` |

---

## H. Ship Order Recap

```
023 migration + assertTransition + autonomy.ts + approve route + pause/resume   [P1, blocks all]
  ├─ obligation extractor → OpenLoopMonitor → DecisionCard → CustomerRecovery    [P2]
  └─ MorningCheck + fuzzy dedup → expectations + StuckWork → /explain            [P3]
        └─ GrowthWatcher + ICP + signals + OpportunityCard + prefs               [P4, reuses P2/P3 card+cron]
              └─ role scoping + ROI ledger + Slack blocks + demo-e2e             [P5]
```

Two engineers: one takes P2, one takes P3, after P1 lands. P4 is one engineer
once the card + continueAsNew patterns exist. P5 is integration + the demo gate.
