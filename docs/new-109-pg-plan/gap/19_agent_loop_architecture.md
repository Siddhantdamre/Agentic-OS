# 19 — The Agent Loop: What Actually Runs Inside an Autonomous Employee

> **The gap this closes.** Every document so far treats the agent itself as a
> box. `16` says `handleDueLoopActivity` runs; nothing says what happens inside
> it. That box is the difference between an AI employee and a cron job with an
> LLM attached, and the repo's existing agent path — interactive
> plan-confirm-execute over SSE — **cannot be reused unchanged**, because it
> assumes a human is watching.
>
> This file specifies the autonomous loop: its shape, its stopping conditions,
> what it does when a tool fails halfway through, and the one Temporal
> constraint that will otherwise corrupt every workflow you write.

---

## 0. Why the Existing Agent Path Does Not Transfer

| | Interactive (shipped) | Autonomous (this plan) |
| :-- | :-- | :-- |
| Trigger | User prompt | Clock, webhook, state change |
| Goal | Stated by the user | Derived from state |
| Approval | User sees the plan | The gate decides (`15 §2`) |
| Failure | User sees the error, retries | Nobody is watching |
| Stopping | User stops asking | **Must stop itself** |
| Wrong output | User ignores it | It reaches a customer |
| Context | The conversation | Retrieved from memory (`20`) |

The last three rows are the whole problem. An interactive agent can be
open-ended because a human bounds it. An autonomous one that cannot decide it
is finished will loop, spend, and eventually act.

**So the autonomous loop is deliberately narrower than the interactive one.**
It is not a general agent given a goal — it is a bounded loop over a *specific
state discrepancy*, with a hard step budget and a verification step the
interactive path does not have.

---

## 1. The Loop

```text
   ┌─ TRIGGER ── a sweep found a due loop / a missed expectation
   │
   ▼
  1. FRAME      what is off, and what "resolved" concretely means
   │            ← from the state row. NOT from a model.
   ▼
  2. RETRIEVE   the facts needed to act (20 §2). bounded, cited.
   │
   ▼
  3. ASSESS     is it already resolved? has the world moved on?
   │            ← the cheapest possible exit, and the most common one
   ▼
  4. PLAN       ≤ 5 steps, each a known tool. typed, not prose.
   │
   ▼
  5. GATE       15 §2 per step, before any of it runs
   │            ├── approval_required → park, exit, done
   ▼            └── execute → continue
  6. ACT        one step at a time, each idempotent (11 §4)
   │
   ▼
  7. VERIFY     read back. did the world actually change?
   │            ← the step that separates this from hope
   ▼
  8. SETTLE     transition state, ledger the outcome, record ROI
   │
   └─ on any failure → §4
```

Steps 1, 3, 5, 7 and 8 are **code**. Only 2, 4 and parts of 6 involve a model.
That ratio is the design: the model chooses *how*, the state machine decides
*whether* and *when*, and code confirms *what actually happened*.

### Step 1 — Frame from state, never from a model

```ts
// the goal is READ, not generated. a generated goal is an unbounded goal.
const frame = {
  what:    loop.promise_summary,          // "send the revised quote"
  who:     loop.customer_identifier,
  by:      loop.target_check_at,
  basis:   loop.due_basis,                // drives tone (13 §4)
  resolved: resolutionPredicate(loop),    // a FUNCTION, evaluated in step 3/7
};
```

`resolutionPredicate` is the important part and the easiest to skip: a
checkable condition, not a description. "The quote document exists and was sent
after `created_at`" is verifiable. "The customer is happy" is not, and a loop
whose resolution cannot be evaluated can never close.

### Step 3 — Assess first, and expect to exit here

The most common correct outcome of an autonomous loop is **"nothing to do."**
A colleague sent the quote manually. The customer already replied. The order
shipped.

Check before acting, always. This is one query, it is cheaper than everything
downstream, and skipping it produces the most embarrassing failure this product
has: chasing something that was already handled — which reads, to the customer,
as an organisation that does not talk to itself.

```ts
if (await frame.resolved()) {
  await transitionLoop(loop.id, 'closed');
  await logDecision({ decision: 'executed', reasonCode: 'already_resolved' });
  return;                                  // no model call, no cost, no risk
}
```

### Step 4 — Plans are typed and short

```ts
type PlanStep = {
  tool: string; action: string; args: Record<string, unknown>;
  why: string;                     // one clause, goes on the ledger
  expect: string;                  // what step 7 will verify
};
type Plan = { steps: PlanStep[] };   // MAX 5
```

Five steps is not a performance limit, it is a semantic one. A resolution
needing more than five known-tool steps is not a resolution the employee
understands well enough to attempt unsupervised — escalate it as a decision
card instead. **`expect` is mandatory:** a step that cannot say what success
looks like cannot be verified, and an unverifiable step is a step taken on
faith.

### Step 7 — Verify by reading the world back

```ts
const actual = await readBackActivity(step);      // fresh read, not the tool's return
if (!matches(actual, step.expect)) {
  await logDecision({ decision: 'declined', reasonCode: 'verification_failed' });
  return escalate('acted, but could not confirm the effect');
}
```

**Do not trust the tool's own success response.** A 200 means the request was
accepted, not that the intended state exists — the classic case being a CRM
that accepts a field write and silently drops it on a validation rule. Without
step 7 the employee reports success, closes the loop, and the work is gone. It
is the single most under-built step in agent systems and the reason they feel
unreliable even when every call succeeded.

---

## 2. The Temporal Determinism Boundary

**This will corrupt your workflows if you get it wrong, and the symptom is
bizarre.**

Temporal replays workflow code from history to rebuild state. Replay must be
deterministic. An LLM call is the least deterministic thing in the system.

```ts
// ✅ correct — the model call lives in an activity. its RESULT is in history,
//    so replay reuses the recorded answer instead of asking again.
const plan = await planActivity({ orgId, frame, memory });

// ❌ wrong — a direct model call in workflow code. on replay it returns
//    something different, the workflow takes a different branch than history
//    records, and Temporal throws a non-determinism error. often days later,
//    on an unrelated worker restart, with a stack trace pointing nowhere useful.
const plan = await llm.complete(prompt);
```

The same rule covers everything non-deterministic: `Date.now()`, `Math.random()`,
`uuid()`, direct database reads, `fetch`. In workflow code use
`workflow.now()`, `workflow.uuid4()`, and activities for all I/O.

Related, from `16 §2`: derive idempotency keys from **workflow id + input**,
never from a timestamp or a fresh uuid, or every retry generates a new key and
the idempotency layer becomes decorative.

---

## 3. Budgets — the loop must be able to stop

An autonomous loop with no ceiling is a billing incident that occasionally
also sends messages. Enforce four, and enforce them in code rather than by
prompting:

| Budget | Limit | On breach |
| :-- | :-- | :-- |
| Steps per plan | 5 | Escalate as a decision card |
| Replans per trigger | 2 | Escalate |
| Model calls per trigger | 8 | Abort, ledger `budget_exhausted` |
| Wall clock per trigger | 5 min | Abort, ledger, retry next sweep |
| Actions per sweep pass | 50 (`18 §2`) | Defer the remainder |

Every breach writes a ledger row. A rising `budget_exhausted` rate is an early
signal that the tools no longer fit the work — usually the first sign of an
integration that changed under you.

---

## 4. Failure Recovery — the part that is normally hand-waved

Failure at step 6 is normal, not exceptional. What matters is *which* failure.

```text
  step 3 of 4 fails
        │
        ├── transient (timeout, 429, 503)
        │     → Temporal retries the activity. nothing else to do.
        │       this is the majority.
        │
        ├── permanent, and nothing has changed yet
        │     → replan once with the error as context (budget §3),
        │       else escalate.
        │
        └── permanent, and steps 1-2 ALREADY CHANGED THE WORLD
              → the hard case. §4.1.
```

### 4.1 Partial completion

Three strategies. Pick per plan, at plan time, and record the choice:

1. **Compensate** — undo steps 1–2. Only possible when every completed step is
   reversible. Compensation is itself a plan and can also fail, so cap it at
   one attempt and escalate on failure.
2. **Roll forward** — retry the failed step until the budget is spent. Correct
   when the completed steps are harmless on their own.
3. **Freeze and escalate** — stop, leave the world where it is, and hand a
   human a card that says exactly what completed and what did not.

**Default to 3 whenever any completed step was externally visible.** Once a
customer has seen a message, undoing the database is not undoing anything; a
compensating action generates a *second* customer-visible event and the
situation gets worse, not better. This mirrors `11 §1`: reversibility is the
axis that decides.

The escalation card for a partial failure must be specific — "sent the
apology, could not apply the credit" — because a vague one makes the human
redo the diagnosis the employee already did.

### 4.2 Poison triggers

A trigger that fails identically every pass burns budget forever and buries
the real signal. After 3 consecutive identical failures, quarantine it: mark
the row, stop retrying, raise one card. Quarantined rows appear in settings
(`17 §6`) — a quarantine nobody can see is a silently dropped obligation.

---

## 5. Where the Existing Machinery Fits

Reuse, do not rebuild:

| Existing | Use for | Change |
| :-- | :-- | :-- |
| `atomic-agent-client.ts` | The model call inside `planActivity` | None — wrap in an activity |
| `mcp-bridge.ts` | Tool invocation | None |
| `tool-executor.ts` | Step 6 execution | Gate wired in at `P1-GATE-3` |
| `memory/retrieve.ts` | Step 2, with citations | Employee-scoped query (`20 §2`) |
| `crew-runner.ts`, `MAX_CREW_SPAWN = 3` | Sub-agents for genuinely parallel research | Cap already correct |
| `plan-steps.ts` | Plan representation | Add `expect` for step 7 |
| `WorkItemWorkflow` + `approveWorkItemSignal` | Approval pause/resume | None — verified present |

The autonomous loop is mostly **orchestration around parts that already
exist**. The genuinely new code is the frame (§1), the assess exit (§3), the
verify step (§7), the budgets (§3), and the partial-failure policy (§4.1).
That is a small surface — which is the point of having audited the repo first.

---

## 6. Sub-Agents: When, and When Not

`crew-runner.ts` caps spawning at 3. Keep that cap and add a rule for *when*
spawning is justified at all:

**Spawn only for genuinely parallel, read-only investigation** — three
independent lookups whose results get synthesised once. Everything else is
sequential work that a loop does better and cheaper.

Never spawn for: anything that writes, anything where step N depends on
step N−1, or "to be thorough." Each spawn re-derives context the parent
already has, and in an autonomous loop nobody is watching the cost.

The honest default: **most employee triggers need zero sub-agents.** A due
open loop is one retrieval, one plan, one or two tool calls, one verification.
If the design keeps reaching for crews, the trigger is too coarse — split the
trigger, not the agent.

---

## 7. Testability

The loop must be testable without a model or a network:

```ts
// inject the plan; assert the loop's control flow, not the model's judgement.
const result = await runEmployeeLoop({
  frame,
  planner: async () => ({ steps: [{ tool:'gmail', action:'send', args:{}, why:'x', expect:'sent' }] }),
  gate:    async () => ({ mode: 'execute', reasonCode: 'reversible_within_policy' }),
  execute: async () => ({ ok: true }),
  verify:  async () => false,           // ← force verification failure
});
assert.equal(result.outcome, 'escalated');
assert.equal(result.reasonCode, 'verification_failed');
```

Four tests carry most of the value, and none needs a model:

1. Already resolved → exits at step 3 with **zero** model calls.
2. Verification fails → escalates, does not close.
3. Partial failure with an external step → freezes, does not compensate.
4. Budget exhausted → aborts with a ledger row.

Model *quality* is tested by the fixture sets in `13 §6`. Loop *behaviour* is
tested here, deterministically. Conflating the two gives you a slow suite that
fails for reasons nobody can act on.
