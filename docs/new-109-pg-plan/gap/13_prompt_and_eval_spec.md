# 13 — Prompt & Evaluation Spec: The Model Layer

> **The gap this closes.** `11 §2` and `§3` establish *that* extraction must be
> two-stage and grounded, and *that* confidence is composite. Neither says what
> the prompts are or how you know they work. Every LLM-touching ticket
> (`P2-EXT-*`, `P2-CARD-2`, `P4-ICP-1`, `P4-SIG-1`, `P3-BRIEF-1`) needs this.
>
> **The governing rule for the whole file:** the model produces *candidates*;
> code produces *decisions*. Anywhere a model output flows directly into an
> external side effect without a deterministic check in between, that is a bug
> regardless of how good the prompt is.

---

## 1. Ground Rules for Every Prompt in This System

1. **Structured output, always.** JSON schema-constrained. Never parse prose.
   A schema violation is a hard failure that retries once and then escalates —
   not something to repair with a regex.
2. **Refusal must be cheap and first-class.** Every schema has a "nothing here"
   shape, and the prompt states plainly that returning it is a correct,
   expected answer. Models over-produce when the empty answer feels like
   failure, and over-production is exactly the failure mode `11 §2` warns about.
3. **Grounding is a field, not a hope.** Anything asserted about the world
   carries a `quote` or a record id, and code verifies it before the value is
   used. Verification is a substring check — cheap enough to run on every
   extraction.
4. **No unbounded context.** Pass the specific records the task needs. "Here is
   the whole conversation, figure it out" produces confident synthesis across
   unrelated threads.
5. **Temperature 0 for extraction and classification.** Non-zero only for
   drafting customer-facing prose, and never for anything that decides.
6. **The model never sees the autonomy policy.** It cannot be prompted into
   approving its own action. The gate is code, reading the database.

---

## 2. Stage 1 — The Obligation Classifier (`P2-EXT-1`)

**Job:** cheaply discard the ~85% of messages containing no commitment.
**Optimise for recall.** A false positive costs one stage-2 call; a false
negative loses the obligation permanently.

```
Does this message contain a commitment — something one party says they
will do, send, check, or decide?

Return {"has_commitment": true} if there is any chance one exists.
Return {"has_commitment": false} only for messages that are clearly
acknowledgements, greetings, or pure questions with no promise attached.

When uncertain, return true.

Message:
{{message_text}}
```

Cheapest model that clears the recall bar. Measure against the fixture set
(§6); the target is **recall ≥ 0.98**, precision irrelevant at this stage.

**Pre-filter before the classifier.** A keyword pass ("I'll", "we will", "by
", "send you", "get back", "let you know", "check") is not sufficient alone —
it misses indirect phrasing and fires on signatures — but as a cheap *pre*-gate
it removes obvious no-hope traffic before you pay for a model call. Never use
it as the only gate.

---

## 3. Stage 2 — The Obligation Extractor (`P2-EXT-1/2`)

```
Extract every explicit commitment from this message.

A commitment is a specific thing someone said they would do. It is NOT a
question, a hope, a suggestion, or a general statement of capability.

For each commitment, identify:
- obligor: "us" if {{org_name}} or its staff made the promise,
           "them" if the customer did.
- action: what was promised, in one clause.
- quote: the exact text from the message that contains the promise.
         This MUST appear verbatim in the message. Do not paraphrase.
- due_text: the deadline exactly as written ("by Friday", "tomorrow"),
            or null if none was stated.
- confidence: 0-1, how certain you are this is a real commitment.

Return {"obligations": []} if there are none. That is a normal, correct
answer — most messages contain no commitment.

Never infer a commitment from context outside this message.
Never invent a deadline that was not stated.

Sender: {{sender_role}}   Org: {{org_name}}
Message timestamp: {{iso_ts}}  Org timezone: {{tz}}
Message:
{{message_text}}
```

### The deterministic checks after the call (all in code, all mandatory)

```ts
// 1. grounding — the single highest-value check in this system.
if (!messageText.includes(o.quote)) reject('quote_not_grounded');

// 2. obligor must be explicit. the schema forbids null; a model that
//    cannot tell is telling you the extraction is unreliable.
if (o.obligor !== 'us' && o.obligor !== 'them') reject('obligor_unclear');

// 3. confidence floor. below it, drop SILENTLY and ledger the drop.
//    do not create a low-confidence loop "just in case" — 11 §2.
if (o.confidence < 0.7) { logDecision({decision:'suppressed', reasonCode:'extraction_low_confidence'}); return; }

// 4. due time resolved in code, never by the model.
const due = resolveDue(o.due_text, messageTs, orgTz);   // §4
```

Check 1 alone removes the majority of hallucinated obligations. It costs one
`String.includes`. Build it before you tune a single word of the prompt.

---

## 4. Due-Time Resolution — Code, Not Model

Models are unreliable at date arithmetic and have no access to the org's
timezone. Resolve deterministically:

```ts
function resolveDue(text: string | null, sentAt: Date, tz: string): Due {
  if (!text) return { at: addHours(sentAt, 48), basis: 'default' };

  const explicit = parseAbsolute(text, tz);          // "the 15th", "Friday"
  if (explicit) return { at: explicit, basis: 'explicit' };

  const relative = parseRelative(text, sentAt, tz);  // "tomorrow", "next week"
  if (relative) return { at: relative, basis: 'relative' };

  return { at: addHours(sentAt, 48), basis: 'default' };
}
```

**The timezone argument is not optional.** "Tomorrow" in a message sent at
23:40 local resolves to a different calendar day in UTC. This is a real
off-by-one-day bug that reaches customers as a follow-up chasing something not
yet due, and it is invisible in any test written in a single timezone. Fixture
set must include a late-evening message.

`basis` then drives tone downstream:

| basis | Chase language |
| :-- | :-- |
| `explicit` | "You mentioned Friday for the quote — checking in." |
| `relative` | "You'd said you'd get back this week; following up." |
| `default` | "Just checking whether this is still open — no rush." |

Chasing a `default` deadline with `explicit` firmness invents an obligation the
customer never made. Same bug class as a hallucinated extraction, arriving
through tone instead of content.

---

## 5. The Confidence Composite in Code (`P2-CONF-1`)

`11 §3` gives the weights. The implementation:

```ts
export function computeConfidence(i: ConfidenceInputs): Confidence {
  const grounding = i.claims.length === 0 ? 1
    : i.claims.filter(c => c.sourceId || c.quoteVerified).length / i.claims.length;

  const stateCompleteness =
    i.requiredFields.filter(f => i.record[f] != null).length / i.requiredFields.length;

  // precedent: near-identical actions taken before and not reverted.
  // cold start is deliberately diffident — no history, no credit.
  const precedent = i.priorSimilar === 0 ? 0
    : i.priorSimilarClean / i.priorSimilar;

  const selfReport = clamp01(i.modelConfidence ?? 0.5);

  const score = 0.35*grounding + 0.25*stateCompleteness
              + 0.25*precedent  + 0.15*selfReport;

  return { score, breakdown: { grounding, stateCompleteness, precedent, selfReport } };
}
```

Two properties to preserve when anyone "improves" this:

- **Cold start caps near 0.75** (precedent = 0). New orgs ask more. That is
  correct behaviour, not a bug to tune away — the first weeks are when the
  employee is least accurate and trust is most fragile.
- **Stub data scores low even at high model certainty.** This is the case where
  the model is confident *and wrong*, and it is the whole reason self-report is
  capped at 0.15.

**Store `breakdown` on every ledger row.** Without it, §7 calibration is
impossible and `P3-EXPLAIN-1` degrades from "grounding 0.4 — no source for the
delivery date" to "confidence was low", which tells the owner nothing they can
act on.

---

## 6. The Fixture Sets (build these before the code)

Each lives in `services/workflows/src/__fixtures__/`, as plain JSON with a
`expected` field. No framework.

| Set | Size | Contents | Gates |
| :-- | :-: | :-- | :-- |
| `obligations.json` | ~50 | promises by us / by them / ambiguous / none / multiple in one message / late-evening relative dates / a signature block containing "I'll" | `P2-EXT-1/2` |
| `escalation.json` | ~30 | actions across all three reversibility buckets, spanning blast radius and confidence | `P1-GATE-1` |
| `dedup.json` | ~20 | near-duplicate and genuinely-distinct entity pairs | `P3-DEDUP-1` |
| `ranking.json` | ~20 | historically won and lost accounts | `P4-RANK-1` |

**Write the fixtures from real messages before writing the extractor.**
Fixtures written afterwards encode whatever the implementation already does,
which makes the suite green and worthless.

### The gates that actually block a ship

| Check | Threshold | Rationale |
| :-- | :-- | :-- |
| Stage-1 recall | ≥ 0.98 | A miss here is unrecoverable downstream. |
| Stage-2 **precision** | ≥ 0.95 | The asymmetry. A chase about an invented promise is trust-ending. |
| Stage-2 recall | ≥ 0.60 | A miss is the status quo the customer already lives with. |
| Grounding violations | **0** | Any ungrounded quote reaching the DB is a hard failure. |
| Ranking | won > lost | If not, the ICP features are wrong — do not tune weights. |

**95/60 ships. 75/95 does not**, however much better the F-score looks. Anyone
proposing to optimise aggregate F-score on this task has not read `11 §2`.

---

## 7. Calibration — A Standing Quarterly Job

```sql
SELECT width_bucket(confidence_score, 0, 1, 10) AS decile,
       COUNT(*) AS n,
       AVG(CASE WHEN reverted OR complained THEN 0 ELSE 1 END) AS actual_ok
FROM agent_decision_ledger l
LEFT JOIN outcome_feedback f ON f.decision_id = l.id
WHERE l.decision = 'executed' AND l.created_at > NOW() - INTERVAL '90 days'
GROUP BY decile ORDER BY decile;
```

The 0.9 decile should be right ~90% of the time. If it is not:

- **Fix the weights, not the threshold.** Raising the threshold to compensate
  for bad calibration hides the problem and reduces autonomy at the same time —
  the worst of both.
- **Check `precedent` first.** It is the term most likely to be miscomputed,
  because "near-identical action" is a similarity judgement and similarity
  judgements drift.

Put a calendar reminder on this. It is the kind of task that is never urgent
and is the reason confidence numbers rot silently.

---

## 8. Cost Control

| Lever | Effect |
| :-- | :-- |
| Keyword pre-filter before stage 1 | Removes obvious no-hope traffic for free |
| Cheap model for stage 1 | ~85% of messages never reach the expensive call |
| Cache stage-1 by message hash | Redelivery costs nothing |
| Cap stage-2 context to the message plus a short thread window | Bounded and cheaper — and per §1.4, more accurate |

Track cost per obligation extracted, not cost per message. The first number
tells you whether the pipeline is efficient; the second only tells you how
chatty the customers are.

---

## 9. Prompt Change Control

Prompts are production code with no type checker, so the process substitutes
for one:

1. Prompts live in versioned files, never inline string literals.
2. Every change runs the fixture set. A change that moves precision below its
   gate does not merge, regardless of how much better it looks on examples.
3. The prompt version is recorded on ledger rows, so a behaviour change can be
   traced to the prompt that caused it.
4. One prompt change per commit. A prompt change bundled with a code change is
   unbisectable when quality moves.
