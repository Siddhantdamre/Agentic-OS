# 21 — Cost Model & Scaling: What Three Employees Per Org Actually Cost

> **The gap this closes.** `16 §5` schedules four sweeps per org: open loops
> every 15 minutes, stuck work hourly, growth every 4 hours, morning check
> daily. That is **127 sweep passes per org per day**, running whether or not
> anything happened. Nobody has multiplied that out.
>
> This matters beyond the invoice. The cost model *dictates architecture*: it
> is the reason the assess step (`19 §1` step 3) must exit before any model
> call, and the reason sweeps must be SQL-first. Get it wrong and the product
> is technically excellent and commercially impossible.

---

## 1. The Arithmetic Nobody Has Done

Per org, per day, from `16 §5`:

| Sweep | Interval | Passes/day |
| :-- | :-- | :-: |
| `OpenLoopMonitorWorkflow` | 15 min | 96 |
| `StuckWorkDetectorWorkflow` | 1 h | 24 |
| `GrowthWatcherWorkflow` | 4 h | 6 |
| `MorningCheckWorkflow` | daily | 1 |
| | | **127** |

Now the branch that decides the business:

```text
  IF every sweep pass invokes a model:
     127 passes × ~3 calls × ~4k tokens   ≈  1.5M tokens/org/day
     × 1,000 orgs                          ≈  1.5B tokens/day
     → the product cannot be sold at any plausible seat price.

  IF a sweep pass with nothing due is pure SQL:
     ~120 of 127 passes cost one indexed query (~1ms, no model)
     ~7 passes do real work × ~3 calls × ~4k  ≈ 84k tokens/org/day
     → ~18× cheaper, and it scales with WORK, not with TIME.
```

**That factor is the whole cost model.** Everything below exists to keep the
system on the second branch, permanently.

---

## 2. The Governing Rule

> **A sweep pass with nothing due must cost one indexed query and zero model
> calls.**

This is why `12`'s partial indexes are written the way they are:

```sql
CREATE INDEX idx_agent_open_loops_due
  ON agent_open_loops (org_id, status, target_check_at)
  WHERE status NOT IN ('closed');
```

The `WHERE` clause keeps closed loops out of the index entirely, so an org
with 50,000 historical loops and 3 open ones scans 3 rows. Without the partial
predicate the index grows forever and the "cheap" sweep slowly becomes the
dominant cost — invisibly, over months.

**Corollaries that are easy to violate:**

- The sweep never asks a model "is there anything to do?" That is what the
  index is for.
- `19 §1` step 3 (assess) runs **before** retrieval and planning. An
  already-resolved loop must cost one query, not a retrieval plus a plan.
- No sweep enriches, summarises, or scores "while it is there." That is the
  instinct that turns a 1ms pass into a 4-second one, and it always arrives
  as a small, reasonable-looking pull request.

A useful review question, in the exact words: *does this pull request add a
model call to a path that runs when nothing happened?*

---

## 3. Cost Per Unit of Work

Rough per-token pricing moves; the **ratios** below are stable and are what
should drive design.

| Operation | Model calls | Rel. cost | Frequency driver |
| :-- | :-: | :-: | :-- |
| Sweep pass, nothing due | 0 | **0.001** | Time (127/day) |
| Stage-1 classifier (`13 §2`) | 1 cheap | **0.05** | Inbound messages |
| Stage-2 extraction (`13 §3`) | 1 | **1.0** | ~15% of messages |
| Retrieval (embedding + query) | 1 embed | **0.1** | Per action |
| Plan (`19 §4`) | 1 | **1.5** | Per action taken |
| Verify (`19 §7`) | 0 | **0.002** | Per action — it is a read |
| Decision card copy | 1 | **0.8** | Per escalation |
| Morning brief | 1 | **1.2** | 1/org/day |

Three consequences worth internalising:

1. **The stage-1 gate pays for itself immediately.** At 20× cheaper than
   extraction and filtering ~85% of traffic, it is not an optimisation, it is
   the reason the extractor is affordable at all.
2. **Verification is nearly free** — it is a database read, not a model call.
   Anyone proposing to drop step 7 "for cost" has misread the table by three
   orders of magnitude.
3. **Planning is the most expensive single operation**, which makes playbook
   promotion (`20 §5`) a *cost* feature as well as a trust feature: a matched
   playbook turns a 1.5 into a 0.01 lookup.

---

## 4. Cost Scales With Three Things, Not One

| Driver | Scales | Control |
| :-- | :-- | :-- |
| **Inbound message volume** | Linear, per org | Stage-1 gate, keyword pre-filter |
| **Open work volume** | Linear, per org | Nothing — this *is* the product doing its job |
| **Org count** | Linear | Sweep must stay SQL-only when idle (§2) |
| **Sweep frequency** | Linear, and **pays nothing when idle** | Only shorten intervals with evidence |

The trap is the fourth row. "Make open loops sweep every 5 minutes so we are
more responsive" triples the pass count. On the SQL-first architecture that is
nearly free; on a model-per-pass architecture it triples the bill. Teams
usually discover which architecture they built at exactly this moment.

**A busy org should cost more than a quiet one.** If cost tracks org *count*
rather than org *activity*, the idle path is doing work it should not.

---

## 5. Per-Org Budget Ceilings

Cost control belongs in the same place as safety control (`18 §2`), because
the failure is identical — a runaway loop is both a spend incident and a
customer incident.

| Ceiling | Suggested | On breach |
| :-- | :-- | :-- |
| Model calls per trigger | 8 (`19 §3`) | Abort, ledger `budget_exhausted` |
| Actions per sweep pass | 50 (`18 §2`) | Defer remainder to next pass |
| Model spend per org per day | Plan-dependent | Degrade to escalate-only, notify |
| Platform spend per hour | Global | Alert, then throttle sweeps |

**"Degrade to escalate-only" is the right failure mode.** An org over budget
does not get a broken employee — it gets one that stops acting autonomously
and starts asking. Work still surfaces; only the autonomy pauses. That is
recoverable and explainable to a customer, which "we silently stopped
processing your queue" is not.

---

## 6. Where the Money Actually Goes

Expected steady-state distribution for a mid-size org:

```text
  extraction (stage 1 + 2)   ████████████████░░░░░░░░  ~40%
  planning                   ██████████░░░░░░░░░░░░░░  ~25%
  retrieval / embeddings     ██████░░░░░░░░░░░░░░░░░░  ~15%
  card + brief copy          ████░░░░░░░░░░░░░░░░░░░░  ~10%
  sweeps (SQL)               ██░░░░░░░░░░░░░░░░░░░░░░   ~5%
  verification               ░░░░░░░░░░░░░░░░░░░░░░░░   ~1%
```

If sweeps exceed ~10%, the idle path is making model calls — go find them.
That single ratio is the cheapest health check in this document, and it is
worth putting on the `14 §7` dashboard as an eleventh number.

**Optimise in this order**, highest leverage first:

1. **Stage-1 recall/precision.** Every percentage point of precision here
   removes an expensive stage-2 call. Biggest lever by a wide margin.
2. **Playbook hit rate** (`20 §5`). Replaces planning with a lookup.
3. **Retrieval token budget** (`20 §2`). Already a correctness control; the
   cost saving is a side effect of doing the right thing.
4. **Model routing.** Cheap model for classification, capable model for
   planning and customer-facing copy. LiteLLM already routes, so this is
   configuration rather than code.

Do **not** optimise by: skipping verification (§3), widening sweep intervals
(hurts responsiveness for ~5% of cost), or shrinking the plan budget below 5
steps (escalates more, and human attention is the expensive resource).

---

## 7. What to Instrument From Day One

Add to `14 §2`, and add them in Phase 1 — retrofitting cost attribution means
guessing at the past:

| Metric | Healthy | Detects |
| :-- | :-- | :-- |
| Model calls per sweep pass | **≈ 0** when nothing due | The idle path regressed |
| Cost per obligation extracted | Stable | Extractor efficiency (`13 §8`) |
| Cost per autonomous action | Falling as playbooks accumulate | Learning is working |
| Cost per org per day | Tracks activity, not headcount | Idle-path leak |
| Sweep share of total spend | < 10% | The single best leak detector |

**Track cost per obligation, not cost per message.** The first says whether the
pipeline is efficient; the second only says how chatty the customers are, and
it moves for reasons nobody controls.

---

## 8. Scaling Beyond One Worker

Cost is not the only thing that scales. At ~1,000 orgs:

- **127,000 sweep passes/day** across the fleet. Trivially handled by one
  Temporal worker fleet, *provided* the idle path stays SQL-only.
- **Sweep stampede.** Every org's 15-minute sweep firing on the same wall
  clock produces a spike every 15 minutes. Jitter the start time per org
  (`hash(orgId) % interval`) at bootstrap (`16 §5`). One line at start time;
  a painful retrofit later, because changing a running workflow's schedule
  means terminating and restarting every singleton.
- **Connection pool.** Each pass takes a pooled connection to set
  `app.current_org_id`. Sweeps must hold it for the query only, never across a
  model call — a model call inside `withOrgClient` is how a pool exhausts
  itself under load, and it looks like a database problem rather than an agent
  problem.
- **Partial indexes are the scaling story.** Every hot query in `12` has a
  `WHERE` predicate keeping closed and settled rows out. That is what keeps
  the sweep O(open work) rather than O(history).

---

## 9. The One-Paragraph Version

The sweep architecture is affordable **only** if an idle pass is pure SQL.
That single property is worth roughly 18× on the bill, and it is enforced by
three things already in the plan: partial indexes (`12`), the assess-first
step (`19 §1`), and the review reflex in §2. Cost then scales with work rather
than with time, a busy org costs more than a quiet one, and the largest
optimisation lever is stage-1 classifier precision — not model choice, not
sweep frequency, and never verification.
