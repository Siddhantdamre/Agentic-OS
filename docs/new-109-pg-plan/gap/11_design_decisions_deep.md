# 11 — Design Decisions: The Nine Hard Problems

> **Why this file exists.** `08`, `09`, and `10` say *what* to build and in what
> order. They do not say *why each hard thing is built the way it is*, and that
> reasoning is the expensive part to recover six months from now. Everything
> below is a problem where the obvious implementation is wrong in a way that is
> not visible until the product is in front of a customer.
>
> Each section: **the problem**, **why the obvious answer fails**, **the
> decision**, **the rejected alternatives**, and **how we know it works**.
>
> Read this before writing code for `P2-EXT-*`, `P1-GATE-*`, `P2-CONF-1`,
> `P3-EVA-*`, or `P4-PREF-1`. Those five ticket families are where a plausible
> implementation quietly destroys the product.

---

## 1. What Counts as a Decision Worth a Human?

### The problem

The blueprint's central promise is "escalate decisions, not chats." That is a
good slogan and an unimplementable spec. Every action is a decision at some
level of zoom. The gate needs a rule that a machine can evaluate on an action it
has never seen before.

### Why the obvious answer fails

The obvious answer is a static allowlist: enumerate the risky actions, ask about
those, execute the rest. This is what `employee_autonomy_rules` looks like at
first glance, and it is why the seed table in `08 §1.1` is necessary but not
sufficient.

Static lists fail in both directions, and both failures are fatal:

- **Under-asking.** `send_external_email` is tier 2, so it asks. But
  `update_field` is tier 3 auto-execute — and `update_field(deal.stage,
  'closed_lost')` on a €200k opportunity is far more destructive than a routine
  email. The action type carries no information about the blast radius of *this
  instance*.
- **Over-asking.** Once the owner has approved "reschedule this appointment"
  forty times without ever declining, the forty-first prompt is not safety, it
  is a tax. Products in this category die of notification fatigue far more often
  than they die of an autonomous mistake — the owner stops reading, approves
  everything reflexively, and the gate becomes decorative while still appearing
  to work in the metrics.

### The decision

Escalate on a computed **escalation score**, with the static tier as one input
rather than the whole answer. Three factors, each independently sufficient to
force escalation:

```text
  escalate  ⟸   reversibility  ×  blast_radius  ×  (1 − confidence)   >  θ_org
                      │                │                   │
                      │                │                   └─ §3
                      │                └─ magnitude of THIS instance:
                      │                   money, record count, external
                      │                   parties reached, customer tier
                      └─ can the employee itself undo this in one step,
                         with no human and no third party?
```

**Reversibility is the dominant term, and it is binary in practice.** Sort every
action into one of three buckets, decided once at the tool-catalog level:

| Bucket | Definition | Policy |
| :-- | :-- | :-- |
| **Reversible** | The employee can undo it alone: internal field writes, task creation, status changes, internal reminders | Execute. Log. Never ask. |
| **Visible** | A third party perceives it and cannot un-perceive it: external email, WhatsApp message, calendar invite to a customer | Confidence gate (§3) + org policy. Ask when confidence is low or the recipient is high-value. |
| **Irreversible** | Money moves, data is destroyed, or a contractual state changes: refunds, deletions, signed-document sends | Always ask. No confidence score exempts these. No "the owner approved 40 of these" exempts these. |

Blast radius then modulates only the middle bucket. An external message to a
routine lead at high confidence goes; the same message to the org's largest
account asks, because the cost of being wrong scales with the account and the
cost of asking does not.

The critical structural consequence: **a decision card must always carry at
least two real options.** This is not a UI nicety — it is the definition test.
If the employee can only construct one course of action, it has not found a
decision; it has found a task it was too timid to do. `P2-CARD-2`'s acceptance
check enforces this deliberately. When you see single-option cards in testing,
the bug is in the gate, not the card renderer.

### Rejected alternatives

- **Pure LLM judgment ("ask the model whether to ask").** Non-deterministic on
  the exact axis where determinism is the product. The same action would
  escalate on Tuesday and not on Wednesday, and the owner would correctly
  conclude the system is arbitrary.
- **Always ask, tighten later.** This is the intuitive safe start and it is a
  trap: it trains the owner to bulk-approve during the exact period when the
  employee is least accurate, so the habit forms while the errors are worst.
- **Learn the threshold from approvals only.** Approvals are heavily biased —
  owners approve to clear the queue. Rejections carry the signal (§8).

### How we know it works

Instrument the ratio, not the count. **Approval rate above ~90% means the gate
is over-asking** — those approvals are rubber stamps and the escalations should
have been executions. Below ~60% means it is escalating garbage. Both readings
are bugs in the gate; log them from day one and review weekly, because neither
shows up in error rates or test suites.

---

## 2. Obligation Extraction (`P2-EXT-*`) — The Hardest Ticket

### The problem

The Customer Employee's entire value rests on noticing that something was
promised and remains undone. Everything downstream — open loops, timers,
recovery, decision cards — is mechanical once an obligation exists as a row.
Creating that row from natural language is where the product is won or lost.

### Why the obvious answer fails

The obvious answer is one LLM call per inbound message: "extract any promises."
Three ways this breaks in production:

1. **Cost and latency at volume.** Most inbound messages contain no obligation.
   Paying full extraction on every "thanks!" is wasteful and, on a busy org,
   slow enough to matter.
2. **False positives are much worse than false negatives — and the naive prompt
   produces false positives.** A missed obligation costs one unnoticed
   follow-up, which is the status quo the customer already lives with. A
   hallucinated obligation causes the employee to chase a customer about
   something nobody promised. That is an actively embarrassing, trust-ending
   event, and it happens in front of the customer's customer.
3. **Whose obligation?** "I'll send the documents tomorrow" from the *customer*
   creates a loop the employee must *watch*. The same sentence from the *org*
   creates a loop the employee must *fulfil*. Same words, opposite behaviour.
   A prompt that does not force this distinction will conflate them.

### The decision

**Two-stage extraction with an asymmetric bar, and an explicit obligor field.**

Stage 1 — a cheap, fast classifier gate. Does this message plausibly contain a
commitment at all? Optimise for recall; let false positives through, they cost
one stage-2 call. Roughly 80–90% of traffic terminates here.

Stage 2 — structured extraction on survivors only, emitting a typed object and
refusing to guess:

```ts
type Obligation = {
  obligor: 'us' | 'them';        // who owes it. never inferred loosely.
  action: string;                // what was promised, verbatim-grounded
  due: { at: Date; basis: 'explicit' | 'relative' | 'default' };
  quote: string;                 // the source span. required.
  confidence: number;
};
```

Two non-negotiable constraints on stage 2:

- **`quote` is required and must appear in the source message.** Reject any
  extraction whose quote is not a substring of the input. This single check
  eliminates the majority of hallucinated obligations at near-zero cost, and it
  is the cheapest reliability win anywhere in this plan.
- **Below the confidence threshold, drop it silently and ledger the drop.** Do
  not create a low-confidence loop "just in case." Per the asymmetry above, the
  silent miss is the cheap error.

**Due-time inference**, in strict precedence order — and the ordering matters
because the basis determines how aggressively the employee later chases:

1. **Explicit** ("by Friday", "before the 15th") — parse it, high trust, chase
   firmly on expiry.
2. **Relative** ("tomorrow", "next week", "shortly") — resolve against the
   message timestamp *in the org's timezone*, not the server's. "Tomorrow" sent
   at 11pm local is a real off-by-one-day bug that will reach customers.
3. **Default** — no time given at all. Use the org default (48h is a sane
   start). Chase *gently*: nobody promised this deadline, the system invented
   it, and the follow-up language must reflect that.

**Idempotency (`P2-EXT-3`)** by content hash, not message ID:
`sha256(org_id || conversation_id || normalized_action || obligor)`. Message IDs
differ across redelivery, edits, and channel bridges; the same promise arriving
twice must not produce two loops. Unique index on the hash.

### Rejected alternatives

- **Regex / keyword triggers ("I'll", "we will", "by Friday").** Catches
  boilerplate signatures and marketing copy; misses everything phrased
  indirectly. Tested first because it is cheap — it is not good enough alone,
  but it is a reasonable stage-1 pre-filter *before* the classifier.
- **Extract at conversation close instead of per message.** Loses the timer: by
  the time a conversation is "closed", the deadline has often passed.
- **One-shot extraction with no quote grounding.** This is the default anyone
  writes first. It hallucinates, and the hallucinations are confident,
  plausible, and customer-visible.

### How we know it works

Build a labelled fixture set of ~50 real messages before writing the extractor:
obligations by us, by them, ambiguous, and none. Track precision and recall
separately and hold **precision above recall** as the explicit target. A run at
95% precision / 60% recall ships. A run at 75% precision / 95% recall does not,
however good the aggregate F-score looks.

---

## 3. Where Confidence Actually Comes From (`P2-CONF-1`)

### The problem

`08` and `09` both gate on confidence and neither says how the number is
produced. Every remaining safety mechanism in this plan multiplies by this
value, so if it is noise, the safety is theatre.

### Why the obvious answer fails

Asking the model "how confident are you, 0–1?" produces a number that is
smoothly distributed, intuitively reasonable, and poorly correlated with
correctness. Self-reported confidence clusters high, moves for stylistic reasons
rather than epistemic ones, and — most dangerously — is *highest* on fluent,
plausible fabrications. The failure mode is precisely inverted from what safety
requires.

### The decision

**A composite score, where self-report is one term of four and never the
majority.** Compute per action:

| Term | Weight | What it measures | Why it is trustworthy |
| :-- | :-: | :-- | :-- |
| **Grounding** | 0.35 | Fraction of claims in the output traceable to a retrieved record or a source quote | Mechanical. Checkable without a model. |
| **State completeness** | 0.25 | Are the fields this action depends on actually populated, or is it acting on a stub? | Mechanical. A query. |
| **Precedent** | 0.25 | How many times has a near-identical action been taken and *not* reverted or complained about? | Empirical. Comes from the ledger. |
| **Self-report** | 0.15 | The model's own estimate | Weak but non-zero; useful for catching genuine ambiguity the other terms miss |

Three properties this buys that self-report alone cannot:

- **A cold start is correctly diffident.** With no precedent history, the
  ceiling is 0.75 — new orgs and novel actions ask more, which is right.
- **It degrades on stub data.** Acting on a half-populated record scores low
  even when the model is sure, which is exactly the case where the model is
  sure and wrong.
- **It is auditable.** When the employee declines, `P3-EXPLAIN-1` can say
  *"grounding 0.4 — I could not find a source for the delivery date"* rather
  than *"confidence was low."* The first is actionable by the owner; the second
  is a shrug.

**Calibration is a standing obligation, not a launch task.** Every quarter,
backtest ledger rows: bucket actions by confidence decile and measure what
fraction were later reverted, complained about, or corrected. If the 0.9 bucket
is not right ~90% of the time, the weights are wrong. Do not tune the threshold
to fix a calibration problem — that moves the symptom.

### Rejected alternatives

- **Model self-report alone.** See above. This is the industry default and it
  is the reason so many agent products feel randomly reckless.
- **Ensemble / self-consistency voting.** Real signal, but 3–5× the cost on
  every action, and it measures *stability* rather than *correctness*. A model
  can be stably wrong.
- **A single global threshold.** Different action classes deserve different
  bars. The threshold belongs per bucket from §1, not per system.

---

## 4. Exactly-Once Effects on a Retrying Runtime

### The problem

Temporal guarantees activities run **at least once**. Every activity in this
plan that touches a connector therefore *will* execute twice at some point:
worker restart, timeout with the work already done, network partition on the
ack. The blueprint promises an employee that does not double-message customers.
Those two facts are in direct conflict and the conflict must be resolved in
code, not in hope.

### Why the obvious answer fails

The obvious answer is "make activities idempotent," which everyone writes into
the DoD (`10 §6.2`) and few implement. Internal database writes are easy —
`ON CONFLICT DO NOTHING` and the problem disappears. **External sends are the
real case, and they have no such clause.** An email API called twice sends two
emails and returns 200 both times.

### The decision

Three layers, applied in order, because none is sufficient alone:

**Layer 1 — a deterministic idempotency key, derived not generated.**

```ts
key = sha256(workflow_id || activity_name || attempt_input_hash)
```

Derived from workflow identity and input, so a retry of the same logical work
computes the same key. Never `uuid()` and never a timestamp — both produce a
fresh key on retry, which is the bug this layer exists to prevent.

**Layer 2 — pass the key to the provider when it supports one.** Stripe, and
most payment and messaging APIs, deduplicate server-side on an idempotency
header. Where this exists it is the strongest guarantee available; use it and
prefer providers that offer it.

**Layer 3 — claim-before-send for providers with no such support.** Insert the
key into a `sent_effects` table *inside the same transaction that marks intent*,
before calling out. On retry the insert conflicts and the activity returns the
prior result instead of sending. This narrows the duplicate window to a crash
between the commit and the provider ack — small, and where the residual risk is
knowingly parked.

For that residual window, choose the direction of failure explicitly per action
class rather than leaving it to chance:

- **Reversible / internal** — prefer at-least-once. A duplicate field write is
  harmless; a lost one is a state divergence that costs far more to find.
- **Visible / irreversible** — prefer at-most-once. Park it and reconcile with
  a read (`did this message actually go out?`) rather than risk a second refund
  or a second message to a customer.

Write the choice into the activity as a `ponytail:`-style comment naming the
window. The next person to read it must not have to re-derive which way it
fails.

### Rejected alternatives

- **Rely on Temporal's workflow determinism.** It protects workflow *state*
  replay. It does nothing about a side effect that already left the building.
- **A global distributed lock per effect.** Correct, and a throughput ceiling
  plus a new failure mode (lock holder dies). The claim-table pattern gets
  ~95% of the benefit with none of the liveness risk.

---

## 5. Where Expectations Come From (`P3-EVA-*`)

### The problem

Expected-vs-Actual is the Operations Employee's engine. `08 §3.4` and `09 §D`
describe comparing them and flagging the delta. Neither says what *creates* an
expectation — and an empty expectations table makes the entire comparator a
no-op that passes all its tests.

### Why the obvious answer fails

The obvious answer is to have humans define expectations up front ("invoices are
paid in 30 days"). Nobody does this. Configuration that must be filled in before
any value appears is configuration that stays empty, and the feature ships dead.

### The decision

**Three generators, in increasing order of sophistication. Ship 1 and 2
together; 3 is the one that makes the product feel alive.**

1. **Promise-derived.** Every obligation from §2 is an expectation. Free — the
   Customer Employee's extractor already populates the Operations Employee's
   input. This is the single highest-leverage coupling in the architecture and
   it is easy to miss when the two employees are built by different people in
   different phases.

2. **Workflow-declared.** When a workflow starts a step with a known duration,
   it *declares* the expectation as part of starting: "this showing is
   scheduled for 14:00, expect a confirmation by 13:00." The step that creates
   the work also creates the expectation. Cheap, exact, and it means every
   workflow you write from here on contributes to operational visibility for
   free.

3. **Statistically inferred.** Observe historical durations per work type and
   set the expectation at roughly the 80th percentile of completions. "Enquiries
   of this type are usually answered within 4 hours; this one is at 11." Two
   traps worth naming in advance:
   - **Do not use the mean.** Operational duration distributions have long right
     tails; the mean sits above most real completions and the detector goes
     quiet exactly when work is drifting.
   - **Do not learn from a period the employee itself changed.** Once the
     employee starts fixing things, the baseline shifts and the detector slowly
     stops detecting. Freeze the baseline window, or recompute it against
     human-handled work only.

**Every expectation carries its `basis`** — `promise | declared | inferred` —
because the owner's response to a violation depends entirely on it. A broken
explicit promise is a customer-facing problem; a violated statistical inference
is a *possible* problem and must be worded that way. Presenting an inferred
expectation with the certainty of a promise is how the brief loses credibility
in week two.

### How we know it works

The comparator's real test is not that it flags discrepancies — it is that on a
quiet day it flags **nothing**. `P3-BRIEF-1`'s acceptance check exists for this
reason. A detector that always finds something is a detector nobody reads.

---

## 6. The Ledger: Answering "Why Didn't You Do That?"

### The problem

`P3-EXPLAIN-1` is the trust mechanism of the entire product, and it is the one
capability that cannot be retrofitted. Answering "why didn't you?" requires
having written down a thing that *did not happen*, at the moment it did not
happen. There is no way to reconstruct it later.

### Why the obvious answer fails

Standard audit logs record actions taken. That answers "what did you do?" — a
question nobody with trust concerns is actually asking. The owner's question is
always about the gap: the lead that went cold, the message that never went out,
the refund nobody processed. All of those are *absences*, invisible to an
action log.

### The decision

**Log the counterfactual, and log it at the point of decision.** Every gate
evaluation writes a row whether or not it acted:

```ts
logDecision({
  orgId, employeeRole,
  actionConsidered: 'send_followup_email',
  decision: 'declined',
  reasonCode: 'confidence_below_threshold',   // enum — queryable
  reasonSummary: 'No source found for the quoted delivery date',
  confidence: 0.41,
  confidenceBreakdown: { grounding: 0.4, state: 0.9, precedent: 0.2, self: 0.8 },
  contextPayload: { /* the inputs, for replay */ },
});
```

Three design points that are easy to get wrong:

- **`reasonCode` is an enum, not prose.** Prose reasons cannot be aggregated,
  and the aggregate is where the value is: "37% of declines this month were
  `missing_connector_scope`" is a product roadmap. A pile of sentences is not.
- **`confidenceBreakdown` is stored, not just the scalar.** Without the terms,
  §3's quarterly calibration is impossible and the explanation degrades to
  "confidence was low."
- **Volume is a real constraint.** Negative decisions vastly outnumber positive
  ones. Retain full rows for ~90 days, then roll up to daily
  `(reasonCode, actionType, count)` aggregates. Never sample the recent window
  — the one decision the owner asks about is always the one that got dropped.

The explain endpoint then answers from rows rather than from a model: match on
entity and window, return the decision, its reason, its confidence terms, and
the rule that governed it. **The model may phrase the answer; it must never
supply the facts.** An explanation endpoint that invents a plausible reason is
worse than having no endpoint, because it is confidently wrong about the one
thing the owner is checking.

---

## 7. Learning From Rejections Without Overfitting (`P4-PREF-1`)

### The problem

`10`'s acceptance check says: reject two cards of a class, suppress the third.
That rule is a reasonable starting heuristic and it is also, taken literally, a
way to make the Growth Employee go permanently silent.

### Why the obvious answer fails

- **"Class" is undefined and the definition is the whole problem.** Too narrow
  (exact company) and nothing generalises. Too broad (all outbound) and two
  rejections mute an entire capability. The owner who dismisses two cards on a
  busy Monday has not stated a preference — but a naive classifier records one.
- **Rejection is ambiguous.** "Not this company", "not this timing", "not this
  channel", and "not right now, I'm busy" are four different signals arriving
  through one identical UI event.
- **Preferences decay.** A rejection from eight months ago should not silence a
  card today. Markets change and so do priorities.

### The decision

- **Ask one question on reject.** A single-tap reason — *wrong fit / wrong
  timing / wrong channel / not now* — converts an ambiguous event into a usable
  one. This is a small UI change with more learning value than any amount of
  inference over unlabelled dismissals, and it should be built with the card,
  not after.
- **Suppress along the stated dimension only.** "Wrong timing" suppresses the
  *timing pattern*, not the account. "Not now" suppresses nothing permanently —
  it is a snooze.
- **Decay every suppression** with a half-life of roughly 90 days, and let a
  strong new signal override a decayed one.
- **Keep a visible escape hatch.** Suppressions appear in settings and are
  removable. A silent, unremovable filter is indistinguishable from a broken
  product, and the owner cannot debug what they cannot see.
- **Floor the suppression rate.** Never let learned preferences silence more
  than ~70% of candidate cards. Hitting the floor means the model of the
  owner's preferences is wrong, not that the owner wants silence — surface it
  as a warning rather than obeying it.

---

## 8. Multi-Employee Coordination

### The problem

Three employees share one org, one connector set, and one customer. Nothing in
`08`–`10` says what happens when two of them act on the same entity within the
same minute — and they will, because their triggers are independent.

### Why the obvious answer fails

Assuming it is rare. It is not: a customer with an unresolved complaint (Customer
Employee) is exactly the customer who looks dormant to a re-engagement sweep
(Growth Employee). The natural correlation between "needs attention" and "looks
idle" means the collision case is the *common* case, not the edge.

### The decision

- **Advisory entity leases.** Before acting on an entity, an employee takes a
  short lease (minutes, not hours). A second employee seeing a live lease defers
  rather than blocks — it reschedules its own check. Advisory, because a stuck
  lease must never freeze the entity permanently.
- **A fixed precedence order when a lease is contested:**
  `Customer > Operations > Growth`. Rationale: reacting to a live customer
  always outranks internal hygiene, which outranks speculative outreach. Encode
  it once as a constant; do not re-litigate it per workflow.
- **One outbound budget per customer per day, org-wide** — not per employee.
  Three employees each politely sending one message is three messages from one
  company in one day, and the customer experiences that as spam regardless of
  how well-reasoned each message was individually. This is the single most
  likely way the product embarrasses its user, and per-employee limits do not
  catch it.

---

## 9. Failure Modes That Kill This Product Class

Ranked by how often they are what actually goes wrong, not by severity. The
first two are near-certain without deliberate countermeasures.

| # | Failure | Looks like | Countermeasure | Ticket |
| :-: | :-- | :-- | :-- | :-- |
| 1 | **Notification fatigue collapse** | Approval rate climbs past 95%; owner bulk-approves without reading. Every dashboard metric looks *good*. | Monitor approval rate as a health metric with an upper bound; escalation score (§1) | `P1-GATE-1` |
| 2 | **Confident fabrication** | Employee chases a customer about a promise nobody made | Quote grounding (§2), composite confidence (§3) | `P2-EXT-1` |
| 3 | **Silent state divergence** | DB says the enquiry is resolved; the customer is still waiting | `assertTransition` everywhere; reconcile from the source of truth on a schedule | `P1-TYPE-1` |
| 4 | **The dead detector** | Expectations table is empty or the baseline drifted; nothing is ever flagged; everyone assumes things are fine | Generators (§5); alert on *zero* discrepancies over a long window | `P3-EVA-1` |
| 5 | **Duplicate outreach** | Customer receives the same message twice from a retry | Idempotency layers (§4) | all activities |
| 6 | **Learned silence** | Growth Employee stops proposing anything and nobody notices for weeks | Suppression floor, decay, visible escape hatch (§7) | `P4-PREF-1` |
| 7 | **Cross-employee spam** | Three coordinated-looking messages in one day from one company | Org-wide outbound budget (§8) | `P5-RATE-1` |
| 8 | **Unexplainable decline** | Owner asks "why didn't you?" and gets a generated guess | Ledger is the only source of explanation facts (§6) | `P3-EXPLAIN-1` |

**Failures 1 and 4 share a property that makes them uniquely dangerous: the
system reports success while delivering nothing.** Neither raises an error,
fails a test, or shows up in an error budget. Both need a metric whose *healthy*
range is bounded on both sides. Build those two metrics in Phase 1, before the
features they measure exist — they are the only instruments that can detect
these classes at all.

---

## 10. Open Questions — Product Calls, Not Engineering Calls

These need a human decision before the phase that depends on them starts. Each
is written with a recommended default so nothing blocks on an unanswered
question; the default is what ships if no one decides.

| # | Question | Blocks | Recommended default |
| :-: | :-- | :-- | :-- |
| 1 | Does an obligation with no stated deadline get chased at all? | `P2-EXT-2` | Yes, at 48h, with visibly softer language |
| 2 | Can the employee message a customer with no human ever in the loop, at any confidence? | `P2-CONF-1` | Yes above 0.85 for reversible/visible; never for irreversible |
| 3 | Per-employee autonomy thresholds, or one org-wide setting? | `P1-DB-5` | Org-wide at launch; per-employee is a settings-surface problem, not a policy one |
| 4 | Is the decision ledger visible to the customer's end customers? | `P3-EXPLAIN-1` | No. Internal only. Revisit only under an explicit compliance requirement |
| 5 | Who owns an escalated decision that nobody answers for 7 days? | `P1-HITL-2` | Expire, ledger the expiry, notify once. Never silently execute on timeout |
| 6 | Does the employee act outside the org's business hours? | `P2-WF-1` | Internal actions yes; external sends respect existing `quiet-hours.ts` |

Question 5 deserves the most care: **timeout must never mean approve.** An
approval that happens because nobody was looking is exactly the failure the gate
exists to prevent, and it is the version of the bug that is hardest to see in
retrospect.

---

## 11. Reading Order

| You are about to build | Read first |
| :-- | :-- |
| `P1-GATE-*` | §1, §6 |
| `P2-EXT-*` | §2, §3 |
| `P2-CONF-1`, `P2-CARD-*` | §1, §3 |
| Any Temporal activity touching a connector | §4 |
| `P3-EVA-*`, `P3-BRIEF-1` | §5, §9 |
| `P3-EXPLAIN-1` | §6 |
| `P4-PREF-1` | §7 |
| `P5-RATE-1`, anything multi-employee | §8 |
| Anything at all, once | §9 |
