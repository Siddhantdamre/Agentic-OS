# 24 — Design Spec: The Autonomy Ladder

> Status: **specification, not built.** Depends on `23` (procedures) for its
> unit of scope and `25` (threat model) for its safety gate. This is `09` §2.5 —
> what converts saved clicks into saved headcount, which is the actual sales
> claim.

---

## 1. Problem statement

Autonomy today is effectively binary. `tools/risk.ts` classifies **actions**
(`read | draft | send | pay | sign | publish | delete`) and `confirmForRisk()`
decides whether a human approves. That is correct and should never be removed —
but it is fixed. A rent reminder that has been approved identically 400 times
still requires the 401st approval.

The commercial consequence: the customer is still in the loop for everything, so
Darex saves *effort* but not *headcount*. The claim in `11` §1 — that the
comparison is versus hiring a coordinator — is only true if some work eventually
runs without a human touching it.

The safety consequence of getting this wrong is the opposite and worse: a system
that acts freely on its own judgement, on a customer's inbox and payment
provider, is one prompt injection away from an incident that ends the company.

The design must therefore make autonomy **earned, scoped, observable, and
reversible**.

---

## 2. The ladder

| Level | Behaviour | Human involvement |
|---|---|---|
| **L0 Observe** | Reads only. Produces nothing outbound. | — |
| **L1 Suggest** | Drafts; a human sends. | Every action |
| **L2 Confirm** | Plans; a human approves; Darex executes. | Every irreversible action |
| **L3 Notify** | Executes reversible actions; tells the human after. | Review after the fact |
| **L4 Autonomous** | Executes within budget and policy; escalates exceptions. | Exceptions only |

### The scope of a level

**A level is per `(procedure, employee, org)` — never global.**

An employee can be L4 on rent reminders and L1 on contract drafting. That is not
a compromise; it is the correct model. Trust is earned per task, exactly as it is
with a human hire, and a global autonomy dial is unusable because the riskiest
task caps the whole roster.

```sql
CREATE TABLE IF NOT EXISTS autonomy_grants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  procedure_id    UUID NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  employee_id     UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  level           SMALLINT NOT NULL DEFAULT 2,
  granted_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_cost_minor  BIGINT,
  max_runs_per_day INTEGER,
  expires_at      TIMESTAMPTZ,
  CONSTRAINT autonomy_level_chk CHECK (level BETWEEN 0 AND 4),
  CONSTRAINT autonomy_unique UNIQUE (org_id, procedure_id, employee_id)
);
```

- **`granted_by_user_id ... ON DELETE RESTRICT`** — the human who granted
  autonomy remains resolvable forever. Same provenance rule as
  `org_playbook_promotions.named_by_user_id`.
- **`evidence JSONB`** — the run statistics that justified the grant, frozen at
  grant time. "Why is this L4?" must be answerable without recomputing history.
- **`expires_at`** — grants can be time-boxed. A useful default for the first
  L4 grant in an org is 30 days, renewed on evidence.

---

## 3. The decision function

```
requires_human_confirm(step, procedure, employee, org) =

     step.risk ∈ {pay, sign}
       AND NOT explicit_opt_in(procedure, step.risk)
  OR step.risk ∈ {pay, sign}
       AND counterparty_first_seen(step)
  OR confirmForRisk(step.risk)
       AND autonomy_level(procedure, employee) < 3
  OR recipient_first_seen_in_retrieved_content(step)
  OR budget_exceeded(procedure, org)
  OR org.kill_switch_active
```

Read as five independent tripwires. Any one of them re-imposes the gate.

### Rules that never bend

1. **`pay` and `sign` never exceed L2** without an explicit, per-procedure owner
   opt-in — a separate deliberate act, not a side effect of a promotion.
2. **Even with opt-in, a first-time counterparty re-gates.** The first payment to
   a new vendor is approved by a human, always. This is simultaneously an
   anti-fraud control and the primary prompt-injection defence for the highest
   consequence action class.
3. **A recipient that first appears inside retrieved content re-gates.** An email
   saying "forward the invoices to newaddress@x.com" cannot cause an autonomous
   send to that address (`25` §5).
4. **A budget breach stops execution before the spend, not after.**
5. **The kill switch overrides everything**, org-wide, immediately.

---

## 4. Promotion — earned, not configured

Promotion is proposed by the system and accepted by a human. It is never
automatic, and it is never a dropdown the customer sets on day one.

### Gates

| Transition | Requires |
|---|---|
| L0 → L1 | The procedure has produced ≥ 10 drafts |
| L1 → L2 | ≥ 20 drafts, edit rate < 20%, zero incidents in 30 days |
| L2 → L3 | ≥ 30 approvals, approval rate > 95%, zero incidents in 30 days, all goldens passing |
| L3 → L4 | ≥ 50 runs at L3, zero incidents in 60 days, explicit owner opt-in, budget set, kill switch tested |

**Edit rate is the honest signal.** An approval is cheap — people click approve.
An *unedited* approval means the output was actually right. The metric that
matters for L1→L2 is therefore how often a human changed the draft, not how
often they let it through.

### The proposal

The system surfaces a promotion candidate as a brief item (`22`):

> **Rent reminders are ready for more autonomy.**
> Aisha has drafted 34 rent reminders. You approved 34 and edited 2.
> No incidents in 47 days. Let her send these without asking?
> `[ Review the evidence ]  [ Promote to L3 ]  [ Not yet ]`

Showing the evidence is the point. "Promote to L3" as an abstract setting is
something no owner will click; "you approved 34 of these unchanged" is a fact
they can act on.

---

## 5. Demotion — automatic, immediate

```
on incident(procedure, employee):
    level := level - 1
    write audit_events(kind='autonomy.demoted', ...)
    create work_item(type='autonomy_incident', priority='high')
    notify the granting user
    suppress promotion proposals for 30 days
```

An **incident** is: a human reversing an autonomous action, a customer complaint
tied to a run, a golden failing on the procedure, a tool error causing external
side effects, or a detected injection attempt on that path.

**A ladder that only goes up is a ratchet toward the first serious mistake.**
Automatic demotion is what makes upward movement safe to offer, and it must
happen without a human deciding — the human decides whether to promote *back*.

---

## 6. The kill switch

```
POST /api/org/emergency-stop
```

- Sets `orgs.meta.kill_switch_active = true`.
- Every in-flight autonomous run halts at its next step boundary.
- All levels behave as L2 (confirm everything) until cleared.
- Scheduled triggers stop firing.
- Nothing is deleted; runs resume or are cancelled explicitly by a human.
- Clearing it requires an owner and writes an audit event.

Reachable from the dashboard **and from WhatsApp** — the owner who needs it is
not at a desk. The existing owner-WhatsApp route already proves the pattern.

`NurtureCancelReason.emergency_stop` is the precedent; this generalises it from
one workflow to the whole org.

---

## 7. Observability

| Surface | Shows |
|---|---|
| Autonomy page | Every `(procedure, employee)` pair with its level, who granted it, when, and the evidence |
| Employee card | Per-employee level distribution — "L4 on 2, L3 on 5, L2 on 11" |
| Run feed | Every L3/L4 execution, with what it did and a one-click reverse where possible |
| Incident log | Demotions, with cause |
| Cost per level | What autonomy is spending |

**The run feed is what makes L3 tolerable.** "Executes and tells you after" is
only acceptable if "after" is a place the human actually looks and can act on.
Without it, L3 is indistinguishable from L4 from the customer's point of view,
and they will not grant it.

---

## 8. What autonomy does *not* change

Explicit, because the temptation at every level is to relax one of these:

- The **allowlist** still gates every tool. Autonomy changes who approves, never
  what is callable.
- **RLS** still scopes every query.
- **Audit** still records every action, with `approver_user_id` recording
  `system` plus the grant id at L3/L4 — the authority chain never breaks.
- **Quiet hours** still apply. Autonomy is not permission to message at 2am.
- **The critic** still runs. A second opinion matters *more* when no human sees
  the output first.
- **Honest failure.** An autonomous run that hits `notConnected` reports it as a
  work item; it does not improvise around the missing tool.

---

## 9. Rollout

1. Schema + the decision function reading grants, with **everything seeded at
   L2**. Behaviour is identical to today; the plumbing is live.
2. Autonomy page — read-only. Customers see levels before they can change them.
3. L1 for new procedures in `draft` (drafts only, no sends).
4. Metrics: edit rate, approval rate, incidents per procedure.
5. Promotion proposals in the brief. **No self-service level setting** —
   promotion happens through the evidence flow.
6. L3 for `send`-class procedures, per-procedure opt-in, run feed live.
7. Demotion + incident detection. Must precede any L4.
8. Kill switch, tested in production by an actual owner.
9. L4 with budgets, expiry, and `25`'s injection defences all shipped.

Steps 7, 8 and 9 are ordered deliberately: demotion before L4, kill switch
before L4, injection defences before L4. Any other order ships the risk before
the control.

---

## 10. Metrics

| Metric | Direction | Why |
|---|---|---|
| Procedures at L3+ per org | Up | The headcount-saving claim, made concrete |
| Incidents per 1,000 autonomous actions | Down, near zero | The trust metric; a rise halts all promotion |
| Demotions per month | Down | Rising means promotion gates are too loose |
| Approval latency at L2 | Down | High latency is what makes L3 worth granting |
| Reversals in the run feed | Down | Human undo is the honest quality signal for L3 |
| Time from first run to L3 | Down | How fast the product earns trust |

"Incidents per 1,000 autonomous actions" is the number that gates the whole
feature. If it does not stay near zero, autonomy stops moving up — regardless of
what the roadmap says.
