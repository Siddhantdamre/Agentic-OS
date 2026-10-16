# 16 — Workflows Corrected: Seams in `09 §C–E`

> **Companion to `15`.** That file reconciled the gate and the state machines;
> this one does the same for the workflow layer. `09 §C–E` was written before
> `12` fixed the schema, and it assumes columns and tables that do not exist in
> this repo. Where this file disagrees with `09 §C–E`, **this file wins.**
>
> Every claim below was checked against the live schema and source, not
> inferred from the earlier docs.

---

## 0. The Seams, Ranked by How Quietly They Fail

| # | `09 §C–E` assumes | Reality | Fails |
| :-: | :-- | :-- | :-- |
| 1 | `work_items.payload` | **No such column.** `work_items` has `metadata JSONB`. `payload` is on `work_events`. | Loudly (SQL error) — but it invalidates the whole card design in `08 §2.3` |
| 2 | One `OpenLoopMonitorWorkflow` per loop | `10 P2-WF-1` specifies a periodic org-wide sweep | Silently — you get two designs, and whichever ships second is dead code |
| 3 | `recordRoiActivity('customer_recovered')` | Not in `12`'s `metric_type` CHECK | Loudly, at runtime, inside an activity retry loop |
| 4 | No autonomy gate on `sendCustomerUpdateActivity` | `11 §1` requires every external send to pass the gate | **Silently — the employee sends unapproved customer messages** |
| 5 | No outbound budget check | `12`'s `agent_outbound_budget` exists but nothing decrements it | Silently — cross-employee spam |
| 6 | No entity lease | `12`'s `agent_entity_leases` exists but nothing takes one | Silently — two employees act on one customer |

**Seam 4 is the serious one.** Everything in `11` and `15` about gating
external sends is bypassed if the workflow calls the send activity directly.
The gate is not a place code passes through by default — it is a call each
send site has to make, and `09 §C.2` does not make it.

---

## 1. Cards Live in `metadata`, Not `payload`

The real `work_items` shape (`012_work_items.sql`):

```
id, org_id, type, status, assignee_employee_id, conversation_id, channel,
entity_refs, priority, due_at, temporal_workflow_id, metadata, created_at, updated_at
```

No `payload`, and no CHECK on `type` or `status` — both are free text, so the
card discriminator needs no migration.

```ts
// the card is metadata.card. one namespaced key, so nothing already
// writing metadata collides with it.
type WorkItemMetadata = {
  card?: DecisionCardPayload | OpportunityCardPayload;
  [k: string]: unknown;
};

await client.query(
  `UPDATE work_items
      SET metadata = metadata || $1::jsonb, updated_at = NOW()
    WHERE id = $2 AND org_id = $3`,
  [JSON.stringify({ card }), workItemId, orgId],
);
```

`metadata || $1::jsonb` merges rather than replaces. `09 §C.3`'s
`SET payload = $1` would have clobbered sibling keys even if the column had
existed — worth fixing the habit, not just the column name.

**Card lifecycle events go to `work_events`**, which does have `payload` and
an `idempotency_key`:

```ts
// kind: 'card_shown' | 'card_approved' | 'card_rejected' | 'card_expired'
// payload for a rejection carries the one-tap reason — this is the
// storage 11 §7 and 17 §3 need. no new table.
INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
VALUES ($1, $2, 'card_rejected', $3, $4, $5)
ON CONFLICT DO NOTHING;
```

---

## 2. One Sweep, Not One Workflow Per Loop

`09 §C.2` starts a workflow per open loop. `10 P2-WF-1` specifies a periodic
org-wide monitor. Both work; they must not both be built.

**Decision: the periodic sweep.** Reasons, in order of weight:

1. **Workflow count.** A busy org accumulates thousands of open loops. Per-loop
   workflows means thousands of live executions per org, and Temporal history
   growth becomes an operational problem well before the product is interesting.
2. **The sweep already has to exist.** `12`'s `idx_agent_open_loops_due` index
   is built for exactly this query, and `MorningCheckWorkflow` and
   `StuckWorkDetectorWorkflow` are the same shape. One pattern, three uses.
3. **Restart semantics.** A singleton sweep per org (`09 §A.4`) is trivially
   idempotent on worker restart. Thousands of per-loop workflows are not
   trivially anything.

What per-loop workflows buy — a customer reply short-circuiting the wait — is
kept without them: the webhook simply sets the loop's `target_check_at` to now,
or closes it. The next sweep pass picks it up. Latency goes from instant to
one sweep interval, which for a follow-up measured in hours is not a real cost.

```ts
export async function OpenLoopMonitorWorkflow(input: { orgId: string }): Promise<void> {
  const SWEEP = '15 minutes';
  for (let i = 0; i < 96; i++) {                    // ~24h, then continueAsNew
    const due = await dueLoopsActivity({ orgId: input.orgId, before: new Date().toISOString() });

    for (const loop of due) {
      // 11 §8 — advisory lease. contested: customer > operations > growth.
      const lease = await acquireLeaseActivity({
        orgId: input.orgId, entityKey: loop.customer_identifier,
        employeeRole: 'customer', ttlSeconds: 300,
      });
      if (!lease.acquired) continue;                // defer; next pass retries

      try {
        await handleDueLoopActivity({
          orgId: input.orgId, loopId: loop.id,
          businessKey: `loop:${loop.id}:${loop.target_check_at}`,   // idempotency
        });
      } finally {
        await releaseLeaseActivity({ orgId: input.orgId, entityKey: loop.customer_identifier });
      }
    }
    await sleep(SWEEP);
  }
  await continueAsNew<typeof OpenLoopMonitorWorkflow>(input);
}
```

The `businessKey` includes `target_check_at`, not just the loop id. A loop
re-armed for a later time is legitimately new work; keying on the id alone
would make the second pass a silent no-op.

---

## 3. Every External Send Goes Through the Gate

This is seam 4, and it is the correction that matters most. The pattern below
belongs in **one** activity that all three employees call — not copied into
each send site, because a copy is a place someone later forgets a check.

```ts
// services/workflows/src/activities/guarded-send.ts

export async function guardedSendActivity(input: {
  orgId: string; employeeRole: EmployeeRole;
  customerKey: string; channel: string; body: string;
  tool: string; action: string;
  confidence: number;              // composite, from 13 §5
  blastRadius?: BlastRadius;
  workflowId: string; businessKey: string;
}): Promise<{ sent: boolean; reason: string }> {

  // 1. idempotency claim BEFORE the send (11 §4 layer 3). reuses the
  //    existing readIdempotent/writeIdempotent against idempotency_keys.
  const prior = await readIdempotent<{ sent: boolean; reason: string }>(
    input.orgId, input.businessKey);
  if (prior) return prior;

  // 2. quiet hours (11 §10 Q6) — external sends only; internal work ignores it.
  if (await inQuietHours(input.orgId)) return done(false, 'quiet_hours');

  // 3. org-wide outbound budget (11 §8). counted across ALL employees.
  const budget = await consumeOutboundBudget(input.orgId, input.customerKey);
  if (!budget.allowed) return done(false, 'outbound_budget_exhausted');

  // 4. the autonomy gate (15 §2).
  const verdict = await checkAutonomy({
    orgId: input.orgId, employeeRole: input.employeeRole,
    tool: input.tool, action: input.action,
    confidence: input.confidence, blastRadius: input.blastRadius,
  });

  await logDecision({
    orgId: input.orgId, employeeRole: input.employeeRole,
    actionConsidered: verdict.actionType,
    decision: verdict.mode === 'execute' ? 'executed' : 'escalated',
    reasonCode: verdict.reasonCode,          // from the gate, never invented here
    confidence: input.confidence,
  });

  if (verdict.mode === 'approval_required') {
    await parkPendingAction({ ...input, verdict });   // agent_pending_actions
    return done(false, verdict.reasonCode);
  }

  await sendChannelMessageActivity({ /* … */ });
  return done(true, 'sent');

  async function done(sent: boolean, reason: string) {
    const r = { sent, reason };
    await writeIdempotent(input.orgId, input.businessKey, r);
    return r;
  }
}
```

Order is deliberate and each step is cheaper than the one after it. Quiet hours
and the budget are single indexed reads; the gate is a read plus a computation;
the send is a network call. Failing fast on the cheap checks also means a
budget-exhausted send never burns an LLM call or a connector quota.

**The idempotency claim is written on every path, including refusals.** A retry
after a quiet-hours refusal must not send once the window opens — the retry is
the *same* logical action, and the decision was already made. New work needs a
new `businessKey`.

---

## 4. ROI Metric Types Must Match the CHECK

`09 §C.4` writes `'customer_recovered'`. `12`'s constraint allows:

```
pipeline_influenced | revenue_recovered | ticket_resolved_autonomously
hours_saved | escalation_avoided | churn_prevented
```

Use `churn_prevented` for the recovery case. **Do not widen the CHECK to fit
the call site** — the constraint is what keeps the ROI view from silently
growing a long tail of near-synonym metric types that nobody can sum. If a
genuinely new outcome type is needed, add it in a migration, deliberately, and
say what it means in the `COMMENT`.

The same applies to `reason_code` in `13`/`15`: a fixed vocabulary is the only
reason `14`'s aggregates mean anything.

---

## 5. Periodic Workflow Registry

All four sweeps are the same shape. Register them in one place so
`P3-BOOT-1` is written once (`09 §A.5`):

| Workflow | Interval | Singleton ID | Employee | Reads |
| :-- | :-- | :-- | :-- | :-- |
| `OpenLoopMonitorWorkflow` | 15 min | `open-loops:<orgId>` | customer | `idx_agent_open_loops_due` |
| `MorningCheckWorkflow` | daily, org-local 07:00 | `morning-check:<orgId>` | operations | expectations + enquiries |
| `StuckWorkDetectorWorkflow` | hourly | `stuck-work:<orgId>` | operations | `idx_operational_expectations_open` |
| `GrowthWatcherWorkflow` | 4 h | `growth-watch:<orgId>` | growth | signals + ICP |

```ts
const PERIODIC = [
  { wf: OpenLoopMonitorWorkflow,     id: (o:string) => `open-loops:${o}` },
  { wf: MorningCheckWorkflow,        id: (o:string) => `morning-check:${o}` },
  { wf: StuckWorkDetectorWorkflow,   id: (o:string) => `stuck-work:${o}` },
  { wf: GrowthWatcherWorkflow,       id: (o:string) => `growth-watch:${o}` },
];

for (const org of await activeOrgs()) {
  for (const p of PERIODIC) {
    await client.workflow.start(p.wf, {
      workflowId: p.id(org.id), taskQueue: TASK_QUEUE, args: [{ orgId: org.id }],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
    }).catch(e => { if (!isAlreadyStarted(e)) throw e; });
  }
}
```

`ALLOW_DUPLICATE_FAILED_ONLY` plus swallowing `WorkflowExecutionAlreadyStarted`
is what makes boot idempotent. Without it, `P3-BOOT-1`'s acceptance check
(restart twice, still one instance each) fails — and it fails by *duplicating
every sweep*, which doubles every outbound action.

**A new org needs its sweeps started at provisioning too**, not only at worker
boot. Otherwise an org created at 10am has no employees until the next deploy —
a bug that looks exactly like "the product does not work for new customers".

---

## 6. Corrections Summary

| `09 §C–E` | Correct | Where |
| :-- | :-- | :-- |
| `work_items.payload` | `work_items.metadata.card`, merged with `\|\|` | §1 |
| `SET payload = $1` | `SET metadata = metadata \|\| $1::jsonb` | §1 |
| Per-loop `OpenLoopMonitorWorkflow` | Periodic org-wide sweep | §2 |
| `businessKey: loop:<id>:check` | Include `target_check_at` | §2 |
| Direct `sendCustomerUpdateActivity` | `guardedSendActivity` | §3 |
| No budget / lease / quiet-hours check | All three, in `guardedSendActivity` | §3 |
| `recordRoiActivity('customer_recovered')` | `'churn_prevented'` | §4 |
| Boot not specified for new orgs | Start sweeps at provisioning too | §5 |

Unchanged and still correct in `09`: the `continueAsNew` cron shape (`§A.3`),
singleton IDs (`§A.4`), the idempotent-activity `businessKey` convention
(`§A.2`), reuse of `approveWorkItemSignal` (verified — it exists at
`workflows/WorkItemWorkflow.ts:75`), and the `pg_trgm` dedup approach (`§D.2`).
