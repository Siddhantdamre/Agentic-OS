# 22 — Onboarding & Cold Start: The First Two Weeks Decide Everything

> **The gap this closes.** Every document in this set describes a steady-state
> employee: memory populated, precedent accumulated, expectations flowing,
> playbooks promoted. **A new org has none of that**, and by our own design it
> gets the weakest possible version of the product:
>
> - `13 §5`: precedent = 0, so confidence caps at **0.75**
> - `15 §2`: below the 0.85 threshold, visible actions **all escalate**
> - `20 §2`: empty memory, so grounding is low, so confidence drops further
> - `11 §5`: no expectations exist, so the Operations Employee flags nothing
>
> Net effect on day one: **an employee that asks about everything and notices
> nothing.** That is a correct implementation of the safety design and a
> disastrous first impression, and nothing in `00`–`21` addresses it.
>
> This is a product-survival problem, not a polish problem. The cold-start
> weeks are when churn is decided.

---

## 1. The Cold-Start Paradox

```text
   trust needs precedent  ──►  precedent needs autonomous actions
          ▲                                      │
          │                                      ▼
   autonomy needs confidence  ◄──  confidence needs trust
```

The loop has to be broken from outside. Three ways in, and we use all three:

1. **Import precedent** instead of waiting for it (§3)
2. **Earn trust on the cheapest surface first** — noticing, not acting (§4)
3. **Make the diffidence legible** so it reads as care rather than
   incompetence (§5)

---

## 2. What "Day One" Actually Looks Like

Honest baseline for a brand-new org with connectors freshly linked:

| Capability | Day 1 | Why |
| :-- | :-- | :-- |
| Answer questions about connected data | ✅ Works | Retrieval over live connectors, no history needed |
| Extract obligations from new messages | ✅ Works | The extractor needs no org history |
| Notice a missed promise | ⏳ 48h+ | Nothing has come due yet |
| Expected-vs-actual on operations | ❌ Weeks | No baseline (`11 §5` generator 3) |
| Act autonomously on customer messages | ⚠️ Escalates | Precedent = 0 |
| Propose growth opportunities | ❌ Needs an ICP | No won-deal history loaded |

**Only one of these is a real blocker** — the last two are *by design*, and
the third and fourth are honest physics. The trap is letting the org
experience all six as "it does not work yet."

---

## 3. Import Precedent Instead of Waiting For It

The single highest-leverage onboarding activity: **backfill.** Most orgs
arrive with years of history in the systems they just connected.

| Backfill | Source | Unlocks | Cost |
| :-- | :-- | :-- | :-- |
| **Closed-won accounts** → `entity_memory` | CRM | The ICP (`P4-ICP-1`) on day one | Low |
| **Historical resolution times** → baselines | Ticketing/CRM timestamps | Expected-vs-actual generator 3 (`11 §5`) | Low — pure SQL over imported rows |
| **Recent open conversations** → obligations | Last ~30 days of messages | Real open loops immediately | Medium (extraction cost) |
| **Existing SOPs/policy docs** → `org_memory` | Drive, Notion | Grounding, so confidence rises | Low, already built (`knowledge_sources`) |
| **Past human decisions** → precedent | Resolved tickets with outcomes | Precedent term ≠ 0 | Medium, highest value |

Three rules that make backfill safe:

- **Backfill is read-only and produces no actions.** An obligation extracted
  from a 3-week-old conversation must **never** trigger a chase. Import it as
  `status: 'closed'` with a `backfilled: true` marker unless it is genuinely
  live. Otherwise the org's first experience of the product is a burst of
  messages to customers about things everyone has long forgotten — the single
  worst possible launch, and it is the default behaviour if nobody thinks
  about it.
- **Bound the window.** 30 days of conversations, not everything. Cost scales
  with the window and value does not.
- **Backfilled precedent is marked and weighted lower.** A human decision the
  employee merely observed is weaker evidence than one it participated in.

**`P0-BACKFILL-1` belongs in Phase 1**, not Phase 5. Every later phase is
measurably better with it, and it is mostly SQL over data the connectors
already sync.

---

## 4. Earn Trust on the Cheapest Surface First

The order in which capabilities are revealed matters more than the order they
are built. Noticing is cheap, safe, and — surprisingly — the thing that
convinces people.

```text
  week 1   NOTICE           "3 enquiries from Tuesday have had no reply."
           zero actions. zero risk. immediately impressive, because
           it is already true and nobody had seen it.

  week 2   DRAFT            "I've drafted replies to these 3. Review?"
           still zero autonomous sends. the owner reads drafts and
           corrects them — and every correction is the highest-value
           learning signal in the system (20 §6).

  week 3   ACT (internal)   assign, schedule, update, remind.
           reversible only. builds precedent with no external exposure.

  week 4+  ACT (external)   gated per 15 §2, thresholds now meetable
           because precedent is real.
```

This maps exactly onto `14 §5`'s rollout stages — the point here is that
those stages are **also the onboarding experience**, not just an internal
safety ramp. Present them that way to the customer: "week one it watches, week
two it drafts" is a credible, reassuring plan. "It is in shadow mode" is not.

**Week 1 is the most underrated week.** An employee that simply says *"these
four things are overdue and nobody has looked at them"* is delivering real
value with zero risk, and it requires only the state layer — no autonomy, no
gate, no external sends. It is also the fastest possible demonstration that
the product sees things the org does not.

---

## 5. Make the Diffidence Legible

A new employee asks about everything. Framed badly it reads as broken; framed
honestly it reads as conscientious.

**Bad:** a stream of approval requests with no context.

**Good:**

```text
  I'm still learning how you like things handled, so I'll check with
  you more often for the first couple of weeks.

  You've approved 12 of my last 14 suggestions. Once we're consistent
  on a type of decision, I'll start handling it myself.

  Handling on my own now: rescheduling, internal reminders, status updates.
  Still asking: anything a customer sees, refunds, deletions.
```

Three requirements:

- **Show the trajectory.** "12 of 14" tells the owner this is a phase with an
  end. Diffidence with no visible arc reads as a permanent limitation.
- **Name what has graduated.** Every promotion from asking to acting is a
  visible win and the clearest evidence the thing is learning.
- **Name what will never graduate.** "Refunds always ask" is reassurance, not
  a limitation — and it is enforced in the schema (`12`), so it is a promise
  that cannot be accidentally broken.

---

## 6. Time-to-First-Value Targets

| Milestone | Target | Blocked by |
| :-- | :-- | :-- |
| First real observation ("3 unanswered") | **< 1 hour** from connect | Connector sync + state layer |
| First correct obligation extracted | < 24 hours | Inbound volume |
| First useful morning brief | Day 2 | Backfill (§3) |
| First autonomous internal action | Week 1 | Nothing — reversible actions need no precedent |
| First autonomous external action | Week 3–4 | Precedent accumulation |
| First playbook promoted | Month 2 | Repetition |

**The one-hour target is the important one.** An org that connects its tools
and sees nothing for a day has already begun to disengage. It is also
achievable: the first observation needs a connector sync and one query — no
model, no memory, no precedent.

---

## 7. The Onboarding Checklist

| Step | Why |
| :-- | :-- |
| 1. Connect Tier-1 connectors | Nothing works without data |
| 2. Kick off backfill (§3) | Runs in the background, read-only |
| 3. **Show the first observation within the hour** | The moment that earns the second week |
| 4. Set org timezone + business hours | `13 §4` correctness, `17 §7` notification timing |
| 5. Confirm the autonomy defaults | `12`'s seed; show what is locked and why |
| 6. Nominate the decision recipient | An unassigned queue is an unread queue (`14` metric 3) |
| 7. Import SOPs/policy docs | Directly raises grounding, therefore confidence |
| 8. Set expectations for weeks 1–4 (§4) | Frames diffidence as a plan |

Step 4 is skipped constantly and it is a correctness setting, not a
preference: without the org timezone, "tomorrow" resolves against the server
clock (`13 §4`) and the employee chases people at the wrong time on the wrong
day.

---

## 8. Cold-Start Failure Modes

| Failure | Looks like | Guard |
| :-- | :-- | :-- |
| **Backfill chase storm** | Employee messages customers about 6-month-old threads | Backfill imports as closed; never triggers actions (§3) |
| **Silent first week** | Org connects, sees nothing, disengages | The one-hour observation target (§6) |
| **Approval flood** | 40 requests day one; owner stops reading | Stage the rollout (§4); internal actions need no approval |
| **Empty-brief despair** | "Nothing to report" every day for a week | Usually a backfill or connector gap, not a quiet org — check `14` metric 6 |
| **Fabrication on empty memory** | No SOPs, so the employee invents policy | Grounding term floors confidence (`13 §5`); low confidence escalates |
| **Wrong-timezone chasing** | Follow-ups at 3am, deadlines off by a day | Step 4 of the checklist |

The first is the one that loses an account in week one, and it is entirely
preventable by a single flag on the backfill importer. Write that flag before
the importer.

---

## 9. Existing Orgs Are Also a Cold Start

Every current DareXAI customer is a cold start for the *employee* layer, and
they are a harder case: they already have expectations of the product.

- Run the same staged rollout. Existing usage does not transfer trust to
  autonomous behaviour.
- Backfill applies identically, and existing customers have more history — so
  it is worth more.
- **Announce the change before autonomy begins.** An employee that silently
  starts acting on a customer's behalf is a support incident even when every
  action is correct.
- Give them the kill switch (`14 §5`) explicitly and up front. Offering the
  off switch is what makes the on switch acceptable.

---

## 10. Tickets

| ID | Ticket | Size | Phase |
| :-- | :-- | :-: | :-- |
| `P0-BACKFILL-1` | Backfill importer, read-only, `backfilled` flag, 30-day window | M | **1** |
| `P0-BACKFILL-2` | Closed-won → `entity_memory` for ICP seeding | S | 1 |
| `P0-BACKFILL-3` | Historical durations → expectation baselines (p80, `11 §5`) | M | 3 |
| `P0-ONBOARD-1` | First-observation path, < 1 hour, no model required | M | 1 |
| `P0-ONBOARD-2` | Trajectory messaging — "12 of 14", graduated list (§5) | S | 2 |
| `P0-ONBOARD-3` | Org timezone + business hours in the connect flow | S | 1 |
| `P0-ONBOARD-4` | Staged-rollout presentation as an onboarding plan (§4) | S | 2 |

`P0-BACKFILL-1` and `P0-ONBOARD-1` are Phase 1. They are the difference
between a demo that impresses and a product that is still impressive in week
two.
