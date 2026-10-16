# 17 — UI & Interaction Spec: The Human Contract

> **The gap this closes.** `P2-CARD-3`, `P3-BRIEF-1`, `P4-PREF-1` and
> `P3-EXPLAIN-1` all terminate in a screen, and no document specifies any of
> them. This matters more than it sounds: the escalation mechanism *is* a UI
> contract. A perfectly reasoned decision card that reads as one more
> notification produces the same outcome as no gate at all (`11 §9` failure 1).
>
> **The governing principle:** the owner's attention is the scarcest resource
> in the system. Every screen below is designed to *spend less of it*, not to
> demonstrate how much the employee did.

---

## 1. What the Owner Should Experience

The product succeeds when the owner's day looks like this:

```text
  morning:  one brief. 3 exceptions, not 40 updates.
            "Two things need you. Everything else is handled."

  midday:   silence. the employee is working. no notifications
            for things it handled — those are in the log, not the phone.

  when it   ONE card. situation, two real options, a recommendation,
  needs you: and what each option costs. resolvable in one tap.

  anytime:  "why didn't you chase the Henderson quote?"
            → a straight answer from the ledger, in one sentence.
```

Anything that does not serve one of those four moments is out of scope for the
first version. In particular: no activity feed, no agent-thinking stream, no
per-action toast. Those make the employee feel busy and make the owner feel
supervised, which is the opposite of the value proposition.

---

## 2. The Decision Card

The single most important surface. It has one job: **let a competent person
make a correct call in under fifteen seconds without opening anything else.**

### Anatomy

```text
┌──────────────────────────────────────────────────────────────┐
│ ⚠  Refund request — Sarah Chen, Acme Ltd        2h ago       │  ← who, when
├──────────────────────────────────────────────────────────────┤
│ Order #4837 arrived 6 days late. She's asked for a full       │  ← SITUATION
│ refund (€1,240). She's ordered 14 times, never complained.    │    incl. the
│                                                               │    context that
│                                                               │    changes the call
├──────────────────────────────────────────────────────────────┤
│ ▸ Full refund €1,240        — she stays, margin gone this qtr │  ← OPTIONS, each
│ ▸ Refund shipping + 20% off — ~€380, offered this twice before│    with its COST
│ ▸ Explain the delay, no refund — risk: 14-order customer      │
├──────────────────────────────────────────────────────────────┤
│ ✓ Recommended: refund shipping + 20%                          │  ← RECOMMENDATION
│   Matches what you approved for Kellerman (Aug) and Voss (Jun)│    with its BASIS
├──────────────────────────────────────────────────────────────┤
│ [ Do this ]  [ Full refund ]  [ No refund ]  [ Not now ]      │  ← one tap each
└──────────────────────────────────────────────────────────────┘
```

### Rules

1. **At least two real options, always.** `10 P2-CARD-2` makes this an
   acceptance check. One option means the gate found a task, not a decision —
   fix the gate, not the card.
2. **Every option states its cost.** An option list without consequences is a
   quiz. The cost is what makes this a fifteen-second decision instead of a
   research task.
3. **The recommendation cites its basis.** "Matches Kellerman (Aug)" is the
   `precedent` term from `13 §5` made visible. It is also the thing that builds
   trust fastest — the owner recognises their own past judgement.
4. **No confidence percentage on the card.** Internally essential; on screen it
   invites the owner to arbitrate a number they cannot calibrate. Surface it in
   the detail view for the curious, never in the decision path.
5. **One tap resolves.** Every button is terminal. A card that opens a form has
   failed.
6. **"Not now" is a first-class button.** Without it, a busy owner rejects
   things to clear the queue, and `11 §7` then learns a preference that was
   never expressed. This button is the single cheapest defence against
   poisoning the preference model.

### Wiring

Reuse what exists — no new plumbing (`09 §C.3`, corrected by `16 §1`):

```
work_items.metadata.card       ← the payload
work_items.temporal_workflow_id ← the workflow to signal
approveWorkItemSignal           ← exists at WorkItemWorkflow.ts:75
POST /api/work-items/[id]/decision
work_events (kind='card_*')     ← the audit trail and the rejection reason
```

---

## 3. The One-Tap Rejection Reason

`11 §7` depends entirely on this and it is four buttons:

```text
  Not this one — why?
  [ Wrong fit ]  [ Wrong timing ]  [ Wrong channel ]  [ Just not now ]
```

- Appears **after** the rejection, never as a blocking step. The rejection is
  already recorded; this only refines it.
- **Dismissible.** A skipped reason means "unknown", suppresses nothing, and
  that is a correct outcome — a forced answer is a fabricated signal, which is
  worse than no signal.
- `Just not now` writes a snooze, never a suppression.
- Stored on the `work_events` row (`16 §1`), read by the synthesizer.

Four buttons is the entire mechanism that stops the Growth Employee learning
the wrong lesson. Build it with the card, not after.

---

## 4. The Morning Brief

**The healthy state is a nearly empty screen**, and the design must make that
feel like success rather than breakage.

```text
  Good morning. 2 things need you.

  ⚠  Henderson quote — promised Tuesday, not sent. 3 days over.
     [ Send draft ]  [ Reassign ]  [ Details ]

  ⚠  Refund request — Sarah Chen, €1,240.     [ Review ]

  ─────────────────────────────────────────────
  Handled overnight: 14 enquiries answered, 3 appointments
  rescheduled, 2 invoices chased.              [ See log ]
```

- **Exceptions above the fold; handled work collapsed below it.** The handled
  list exists to build trust, not to be read. Once trust is established the
  owner stops opening it, which is the intended trajectory.
- **On a clean day, say so in one line:** *"Nothing needs you. 22 things
  handled."* Do not pad with content to justify the notification. `14`'s
  metric 6 catches the opposite failure — a brief that is *always* empty means
  the detector is dead, and that is an ops alert, not a UI state.
- **One notification per day, maximum**, for the brief. Cards notify
  separately, and only above an urgency bar.
- Every exception carries its deviation numerically ("3 days over"), per
  `10 P3-EVA-2`.

---

## 5. The Explain Surface

`P3-EXPLAIN-1` needs an entry point, not just an endpoint. Two:

- **Ask AI** — a natural question routes to `/api/agent/explain`.
- **On any entity** — a "what has the employee done here?" view listing ledger
  rows for that entity, negatives included.

```text
  Q: why didn't you chase the Henderson quote?

  I drafted a follow-up on Tuesday but didn't send it — I couldn't
  find a source for the delivery date you'd quoted, so I wasn't
  confident enough to state it. It's waiting for you.
                                      [ See draft ]  [ Send it ]
```

Three hard rules:

1. **Facts come from ledger rows. Only the phrasing comes from a model.**
   An explanation that invents a plausible reason is worse than no explanation
   — the owner is checking trust at exactly that moment.
2. **If no ledger row exists, say so:** *"I have no record of considering
   that."* That is an honest and useful answer. It is also how you discover a
   missing `logDecision` call.
3. **End with the remedy.** Every explanation offers the action that resolves
   it. An explanation the owner cannot act on is trivia.

---

## 6. The Settings Surface

Three things must be visible and reversible, or the owner cannot trust the
system they cannot see:

| Surface | Shows | Why |
| :-- | :-- | :-- |
| **Autonomy** | Each action type, its current mode, last changed | The policy must be inspectable, not folklore |
| **Suppressions** | What the employee has stopped showing, and why | `11 §7` — a silent unremovable filter is indistinguishable from a broken product |
| **Pending** | Everything awaiting approval, with age | `14` metric 3 — a queue nobody sees is a queue nobody clears |

Irreversible actions render as locked with a one-line explanation ("refunds
always need you"). `12`'s CHECK constraint enforces this at the database; the
UI should explain it rather than appear to offer a toggle that will fail.

---

## 7. Notification Policy

The mechanism that decides `11 §9` failure 1, more than the gate does:

| Event | Notify? |
| :-- | :-- |
| Employee handled something | **No.** Log only. |
| Decision card, routine | Batched into the brief |
| Decision card, urgent (customer waiting, money at risk) | Immediate, one notification |
| Approval pending > 24h | One reminder. Then stop. |
| Approval expiring in 24h | One notification. **Expiry never approves** (`11 §10 Q5`) |
| Employee errored | No. It retries. Notify only after exhausting retries |

Never more than one immediate notification per hour per org, regardless of what
is happening. If three urgent things land at once, they become one notification
saying three things need attention. The alternative trains the owner to swipe
notifications away, and a swiped-away notification is indistinguishable from an
unbuilt feature.

---

## 8. Build Order

`P2-CARD-3` depends on the card; everything else can follow.

1. Decision card + one-tap resolve (§2) — unblocks all of Phase 2
2. Rejection reason (§3) — four buttons, ship with the card
3. Morning brief (§4) — Phase 3
4. Explain (§5) — Phase 3, needs the ledger populated
5. Settings (§6) — before the first external customer, not before the demo
6. Notification policy (§7) — enforce from the first card, retrofitting it
   means undoing a habit the owner has already formed
