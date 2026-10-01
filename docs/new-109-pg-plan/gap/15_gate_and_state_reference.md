# 15 — Gate & State Reference: The Canonical Implementations

> **Why this file exists.** `09 §B` sketched the autonomy gate and the state
> machines early, before `11` settled the design and before `12` fixed the
> schema. Three seams between those documents do not line up, and each one
> fails *silently* — the code runs, the tests pass, and the behaviour is wrong.
> This file is the reconciled, canonical version. Where it disagrees with
> `09 §B`, **this file wins.**
>
> Verified against the live repo, not assumed.

---

## 0. The Three Seams (read before writing `P1-GATE-*`)

### Seam 1 — the action taxonomy does not match the seed data

`09 §B.2`'s `classifyAction()` returns five coarse buckets:
`read | draft | write | external_send | high_risk`.

`12`'s seed inserts seventeen specific action types:
`read_*`, `create_task`, `refund_payment`, `send_external_email`, …

**These never join.** `checkAutonomy` queries
`WHERE action_type = 'high_risk'`, finds no row, and silently falls through to
`DEFAULTS`. The `employee_autonomy_rules` table — the org's entire configurable
policy — would be dead weight from day one, and nothing would report an error.
Every action would be governed by a hardcoded map, and an org that tightened
its rules in the UI would see no change in behaviour.

**Fix:** one taxonomy, resolved in two steps — specific action type first,
falling back to its bucket. §1 below.

### Seam 2 — the gate ignores `reversibility`, blast radius, and confidence

`09 §B.2` decides purely on tier. `11 §1` established that tier alone fails in
both directions, and `12` added the `reversibility` column to carry the
dominant term. The gate as sketched never reads it.

**Fix:** the escalation score in §2 below.

### Seam 3 — `withOrgClient` is not where `09` imports it from

`09 §B.2` has `import { withOrgClient } from './tools/shared.js'`. In the live
repo it is a **private, unexported** function inside
`services/workflows/src/activities/orchestration.ts:36`. The import fails at
build time — a loud failure, so harmless, but it costs whoever hits it an hour.

**Fix:** extract it once to a shared module (§4). Note that
`readIdempotent` / `writeIdempotent` sit right beside it in that same file and
already implement the `11 §4` layer-3 claim pattern against `idempotency_keys`.
Reuse them; do not write a second one.

---

## 1. The Canonical Action Taxonomy

Two levels. The **bucket** is derived from the tool call and always resolves;
the **action type** is specific and may or may not have an org rule.

```ts
// packages/shared-types/src/actions.ts

/** Coarse bucket — always derivable, never null. The fallback. */
export type ActionBucket =
  | 'read' | 'draft' | 'internal_write' | 'external_send' | 'irreversible';

/** Specific action type — what employee_autonomy_rules keys on. */
export type ActionType = string;   // e.g. 'refund_payment', 'create_task'

/** Every seeded action type maps to exactly one bucket. */
export const ACTION_BUCKETS: Record<ActionType, ActionBucket> = {
  'read_*': 'read',  'search_*': 'read',  'list_*': 'read',
  'draft_email': 'draft', 'prepare_brief': 'draft', 'recommend_merge': 'draft',
  'create_task': 'internal_write', 'assign_owner': 'internal_write',
  'update_field': 'internal_write', 'update_status': 'internal_write',
  'send_internal_reminder': 'internal_write', 'answer_faq': 'internal_write',
  'reschedule_appointment': 'external_send',
  'send_external_email': 'external_send',
  'send_external_message': 'external_send',
  'refund_payment': 'irreversible', 'delete_record': 'irreversible',
};

/** Bucket → the reversibility class from 11 §1. */
export const BUCKET_REVERSIBILITY: Record<ActionBucket, Reversibility> = {
  read: 'reversible', draft: 'reversible', internal_write: 'reversible',
  external_send: 'visible', irreversible: 'irreversible',
};
```

### Resolving a tool call to an action type

```ts
export function resolveActionType(tool: string, action: string): {
  actionType: ActionType; bucket: ActionBucket;
} {
  const a = `${tool}.${action}`.toLowerCase();

  // 1. exact specific matches first — most precise wins.
  if (/refund/.test(a))                  return t('refund_payment');
  if (/(delete|remove|purge|destroy)/.test(a)) return t('delete_record');
  if (/reschedul/.test(a))               return t('reschedule_appointment');
  if (/(draft|compose)/.test(a))         return t('draft_email');
  if (/(brief|digest|summar)/.test(a))   return t('prepare_brief');
  if (/merge/.test(a))                   return t('recommend_merge');

  // 2. then buckets by verb.
  if (/(search|list|get|fetch|read|lookup|report|metrics)/.test(a))
    return { actionType: 'read_*', bucket: 'read' };
  if (/(send|reply|post|email|message|whatsapp|sms)/.test(a))
    return { actionType: 'send_external_message', bucket: 'external_send' };
  if (/(create|update|assign|move|set|status)/.test(a))
    return { actionType: 'update_field', bucket: 'internal_write' };

  // 3. unknown. NOT internal_write — an unrecognised tool is the one most
  //    likely to do something unexpected, so it takes the cautious path.
  return { actionType: 'unknown', bucket: 'external_send' };

  function t(x: ActionType) { return { actionType: x, bucket: ACTION_BUCKETS[x] }; }
}
```

**The default for unknown is `external_send`, not `internal_write`.** `09 §B.2`
defaulted unknowns to `write` (auto-execute). A tool nobody classified is
precisely the tool most likely to surprise you; it should ask. This one line is
the difference between a new connector shipping safely and a new connector
shipping with silent autonomy.

---

## 2. The Gate, Corrected

```ts
// services/workflows/src/autonomy.ts

export interface AutonomyVerdict {
  mode: 'execute' | 'approval_required';
  actionType: ActionType;
  bucket: ActionBucket;
  reversibility: Reversibility;
  escalationScore: number;
  reasonCode: string;          // goes straight onto the ledger row
  ruleSource: 'db_specific' | 'db_bucket' | 'default';
}

export async function checkAutonomy(input: {
  orgId: string; employeeRole: string; tool: string; action: string;
  confidence: number;          // from 13 §5. NOT the model's self-report.
  blastRadius?: BlastRadius;   // { amount?, recordCount?, externalParties?, customerTier? }
}): Promise<AutonomyVerdict> {

  const { actionType, bucket } = resolveActionType(input.tool, input.action);

  // two-step lookup — this is the fix for seam 1.
  const rule = await loadRule(input.orgId, actionType, input.employeeRole)
            ?? await loadRule(input.orgId, bucketRuleKey(bucket), input.employeeRole)
            ?? DEFAULT_RULES[bucket];

  const reversibility = rule.reversibility ?? BUCKET_REVERSIBILITY[bucket];

  // --- 11 §1, in order of precedence -------------------------------------

  // 1. irreversible ALWAYS asks. no confidence, no history, no org setting.
  //    checked before anything else so no later branch can override it.
  if (reversibility === 'irreversible')
    return verdict('approval_required', 'irreversible_action');

  // 2. an explicit org rule to ask is honoured.
  if (rule.requires_human_approval)
    return verdict('approval_required', 'org_rule_requires_approval');

  // 3. reversible internal work just runs. this is the common path and it
  //    must stay cheap — most actions land here.
  if (reversibility === 'reversible')
    return verdict('execute', 'reversible_within_policy');

  // 4. visible (customer-perceivable) work: score it.
  const radius = normalizeBlastRadius(input.blastRadius);   // 0..1
  const score  = radius * (1 - input.confidence);

  if (input.confidence < (rule.confidence_threshold ?? 0.85))
    return verdict('approval_required', 'confidence_below_threshold');

  if (score > (rule.escalation_threshold ?? 0.15))
    return verdict('approval_required', 'blast_radius_high');

  return verdict('execute', 'visible_within_policy');
}
```

Three properties worth preserving against future edits:

- **The irreversible check is first and unconditional.** Not last, not
  `&&`-ed with anything. Order is the enforcement.
- **`reasonCode` comes out of the gate, not out of the caller.** It is the enum
  `11 §6` needs and `14`'s metrics aggregate on. A caller inventing its own
  string breaks both.
- **`confidence` is the composite from `13 §5`.** Passing the model's
  self-report here reintroduces exactly the failure `11 §3` exists to prevent,
  and it will look like it works.

### Blast radius normalisation

```ts
function normalizeBlastRadius(b?: BlastRadius): number {
  if (!b) return 0.3;                       // unknown ≠ zero.
  return Math.max(
    b.amount        ? clamp01(b.amount / 50_000)      : 0,
    b.recordCount   ? clamp01(b.recordCount / 100)    : 0,
    b.customerTier === 'strategic' ? 0.9 : b.customerTier === 'key' ? 0.6 : 0,
    b.externalParties ? clamp01(b.externalParties / 10) : 0,
  );
}
```

`max`, not sum or average. A single extreme dimension — one €200k deal — must
dominate. Averaging lets four low scores dilute one catastrophic one, which is
the arithmetic version of the mistake `11 §1` describes.

**Unknown radius is 0.3, not 0.** Absent information is not evidence of safety.

---

## 3. The Complete State Machines

`09 §B.1` gave `ENQUIRY_TRANSITIONS` in full and left the other two as prose.
Here they are, matching `12`'s CHECK constraints exactly — if these two lists
ever diverge, you get an application-layer error and a constraint violation
describing the same bug in two different vocabularies.

```ts
// packages/shared-types/src/state-machines.ts

export type OpenLoopStatus =
  'waiting' | 'scheduled' | 'monitoring' | 'escalated' | 'closed';

export const OPEN_LOOP_TRANSITIONS: Record<OpenLoopStatus, OpenLoopStatus[]> = {
  waiting:    ['scheduled', 'monitoring', 'escalated', 'closed'],
  scheduled:  ['monitoring', 'waiting', 'escalated', 'closed'],
  monitoring: ['escalated', 'waiting', 'closed'],
  escalated:  ['monitoring', 'closed'],
  closed:     [],          // terminal. reopening creates a NEW loop.
};

export type ExpectationStatus = 'pending' | 'met' | 'missed' | 'cancelled';

export const EXPECTATION_TRANSITIONS: Record<ExpectationStatus, ExpectationStatus[]> = {
  pending:   ['met', 'missed', 'cancelled'],
  missed:    ['met', 'cancelled'],   // late completion still settles it
  met:       [],
  cancelled: [],
};

export function assertTransition(
  machine: 'enquiry' | 'open_loop' | 'expectation',
  from: string, to: string,
): void {
  const table = {
    enquiry: ENQUIRY_TRANSITIONS,
    open_loop: OPEN_LOOP_TRANSITIONS,
    expectation: EXPECTATION_TRANSITIONS,
  }[machine] as Record<string, string[]>;

  if (from === to) return;                       // idempotent replay is fine
  if (!table[from])        throw new Error(`unknown ${machine} state: ${from}`);
  if (!table[from].includes(to))
    throw new Error(`illegal ${machine} transition: ${from} -> ${to}`);
}
```

Three decisions embedded above:

- **`from === to` is allowed.** Temporal retries the same activity; a
  self-transition must be a no-op, not a crash. Without this line every
  workflow retry becomes an incident.
- **`closed` is terminal everywhere.** Reopening creates a new row, so history
  stays honest and "how long was this open" keeps one answer.
- **`missed → met` is legal.** Work completed late still settles the
  expectation. Modelling `missed` as terminal leaves permanently-open
  discrepancies that pollute every count in `14`'s metric 6.

### The transition-map test (`P1-TYPE-1`)

```ts
// one property test per machine, worth more than a dozen examples.
for (const [machine, table] of Object.entries(MACHINES)) {
  // 1. every named target state exists as a key
  for (const [from, tos] of Object.entries(table))
    for (const to of tos)
      assert(to in table, `${machine}: ${from} -> ${to} targets unknown state`);

  // 2. every state is reachable from the initial state (no orphans)
  assert(reachableFrom(table, INITIAL[machine]).size === Object.keys(table).length);

  // 3. exactly one terminal state, and it is 'closed'/'met'
  const terminals = Object.entries(table).filter(([, t]) => t.length === 0);
  assert(terminals.length >= 1);
}
```

Check 2 is the one that earns its keep: an unreachable state is a state some
workflow will try to write and always fail on, and it is invisible to
example-based tests.

---

## 4. Shared Plumbing to Extract First

Before any Phase-1 ticket, do this small refactor — it is ~30 minutes and every
subsequent ticket depends on it:

| Move | From | To |
| :-- | :-- | :-- |
| `withOrgClient` | `activities/orchestration.ts:36` (private) | `services/workflows/src/db.ts` (exported) |
| `readIdempotent` / `writeIdempotent` | same file (private) | same new module |

Both already exist and both are already correct — `withOrgClient` sets
`app.current_org_id` with `set_config(..., false)` and resets on release, and
the idempotency pair already implements `11 §4` layer 3 against
`idempotency_keys`. **Do not rewrite them.** Export what is there, update the
two or three call sites, commit that alone as a `refactor:` commit, then build
on top.

Writing a second org-scoped client is how a codebase ends up with one that
forgets `RESET` on the error path.

---

## 5. Corrections to `09 §B` — Summary

| `09 §B` says | Correct | Failure mode if uncorrected |
| :-- | :-- | :-- |
| `classifyAction` → 5 buckets | Two-step: action type, then bucket (§1) | `employee_autonomy_rules` never matches; org policy silently inert |
| Unknown action → `write` (executes) | Unknown → `external_send` (asks) | New connectors ship with silent autonomy |
| Gate decides on tier alone | Escalation score (§2) | Both over- and under-asking; `11 §1` in full |
| `import { withOrgClient } from './tools/shared.js'` | Extract from `activities/orchestration.ts` (§4) | Build error |
| `OPEN_LOOP_TRANSITIONS` described in prose | Defined (§3) | Two people write two different maps |
| No `expectation` machine | Defined (§3) | `P3-EVA-*` has no legality check |
| `assertTransition` on `'task'` | Machine is `'expectation'`; there is no task table | Import of a non-existent map |
| Ledger reason invented by caller | `reasonCode` returned by the gate | `14` metrics cannot aggregate |

---

## 6. Build Order for Phase 1, Revised

`10`'s ticket list stands; this is the order within it, given the above:

1. **`§4` plumbing extraction** — a `refactor:` commit, no behaviour change.
2. **`12`'s migration `023`** + the verification script (`12 §3`).
3. **`§1` action taxonomy** — pure data and one function, fully unit-testable
   with no database.
4. **`§3` state machines** + the property test.
5. **`P1-LEDGER-1`** — needed by the gate, and by `14`'s metrics from day one.
6. **`§2` gate** — depends on all four above.
7. **`P1-GATE-3` wiring** into `tool-executor.ts`, after the existing allowlist
   check at line ~118 and before the `try` block that executes.
8. **`P1-HITL-*`** approval token, signal, route.

Steps 3 and 4 need no database and no Temporal. If you want something running
on day one, start there.
