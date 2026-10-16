# 14 — Observability & Rollout: Detecting the Silent Failures

> **The gap this closes.** `11 §9` names eight failure modes and says two of
> them — notification fatigue collapse and the dead detector — report success
> while delivering nothing. Neither raises an error, fails a test, or burns an
> error budget. This file specifies the instruments that can see them, and the
> rollout sequence that keeps a mistake small.
>
> **Build the metrics in Phase 1, before the features they measure.** They are
> the only things that can detect these failure classes at all, and adding them
> later means the first weeks of production data — the most informative weeks —
> are unobserved.

---

## 1. Why Ordinary Monitoring Does Not Work Here

Standard service monitoring answers "is it up and is it fast." Both can be
perfectly green while this product is failing completely:

| Scenario | Error rate | Latency | Reality |
| :-- | :-: | :-: | :-- |
| Owner bulk-approves everything unread | 0% | fine | The gate is decorative |
| Expectations table is empty | 0% | fine | The detector is dead |
| Preference learning silenced Growth | 0% | fine | The employee stopped working |
| Extractor returns `[]` for everything | 0% | fine | No obligations exist |

Every one of these looks like a *healthy, quiet* system. So the metrics below
have a **healthy band with bounds on both sides**. Zero is an alert. So is a
number that is too good.

---

## 2. The Ten Metrics That Matter

| # | Metric | Healthy band | Alert on | Detects |
| :-: | :-- | :-- | :-- | :-- |
| 1 | **Approval rate** — approved ÷ escalated | 60–90% | `> 90%` or `< 60%` | Fatigue collapse (high); garbage escalations (low) |
| 2 | **Escalation rate** — escalated ÷ total actions | 5–25% | `> 25%` or `< 2%` | Over-asking; a gate that stopped gating |
| 3 | **Time-to-decision** on pending actions | p50 < 4h | p50 > 24h, or expiry rate > 10% | Nobody is reading the queue |
| 4 | **Obligations extracted per 100 messages** | 8–25 | `= 0` or `> 40` | Extractor died; extractor hallucinating |
| 5 | **Grounding rejection rate** | 1–15% | `= 0` or `> 30%` | Check not running; prompt regressed |
| 6 | **Open discrepancies per day** | ≥ 1 on a working day | `= 0` for 3 days | The dead detector |
| 7 | **Autonomous action share** — executed ÷ total | rising over time | Flat for 30 days | The employee never earned trust |
| 8 | **Suppression rate** — cards hidden ÷ generated | < 70% | `> 70%` | Learned silence |
| 9 | **Outbound per customer per day** | ≤ org cap | any breach | Cross-employee spam |
| 10 | **Confidence calibration drift** | \|predicted − actual\| < 0.1 | > 0.15 | Confidence has become noise |

Metrics 1, 4, 5, 6 and 8 all alert on **zero**. That is the point — the
failure signature of this product is silence, not errors.

### Where they come from

Nine of the ten are queries over `agent_decision_ledger`, which is why `11 §6`
insists on logging the negatives and on `reason_code` being an enum. A ledger
of positives only cannot compute a single row of this table.

```sql
-- metric 1, per org, last 7 days
SELECT org_id,
       COUNT(*) FILTER (WHERE decision = 'executed')::numeric
         / NULLIF(COUNT(*) FILTER (WHERE decision = 'escalated'), 0) AS approval_rate
FROM agent_decision_ledger
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY org_id;

-- metric 6: the dead detector. an org with zero for three days is the alert.
SELECT org_id, COUNT(*) AS discrepancies
FROM operational_expectations
WHERE is_discrepancy AND created_at > NOW() - INTERVAL '3 days'
GROUP BY org_id;
```

Metric 10 comes from the §7 backtest in `13`.

---

## 3. Per-Org, Not Just Aggregate

**Aggregate metrics hide exactly the failures worth catching.** A hundred
healthy orgs and one where the employee has gone completely silent averages to
"healthy." Alert per org, and rank orgs by distance from the healthy band —
that ranking *is* the customer-success queue.

The one aggregate worth watching on its own: the *distribution* of approval
rate across orgs. A bimodal shape (a cluster at ~100% and a cluster at ~50%)
means the default policy fits neither group, which is a product decision, not
an ops issue.

---

## 4. What Every Log Line Carries

Structured, always these fields:

```ts
{ org_id, employee_role, workflow_id, run_id,
  action_type, decision, reason_code, confidence, prompt_version }
```

`workflow_id` + `run_id` make a Temporal execution joinable to its ledger rows —
without them, debugging an autonomous action means reading two systems and
guessing at the correspondence. `prompt_version` is what lets you attribute a
quality change to the prompt that caused it (`13 §9`).

**Never log message bodies or customer PII at info level.** Log the message id
and fetch under RLS when investigating. The ledger's `context_payload` holds
what is needed for replay and inherits the table's org isolation; application
logs do not.

---

## 5. Rollout: Four Stages, Each With an Exit Test

`022` already established the shadow-mode pattern for this repo. Follow it —
each stage limits the size of the mistake the next stage can make.

### Stage 0 — Shadow (2 weeks per employee)

Everything runs. Nothing acts. Every decision is ledgered with what it *would*
have done.

**Exit test:** an operator reads 50 shadow decisions and agrees with ≥ 90%.
This is a human reading rows, not a metric — and it is the highest-value two
hours anyone spends on this project. Every disagreement is a bug found before
a customer saw it.

### Stage 1 — Internal only

The employee acts, but only on reversible internal actions: field writes, task
creation, status changes, internal reminders. No external sends at all.

**Exit test:** two weeks with zero state divergences (metric 3 in `11 §9`) and
approval rate inside the band.

### Stage 2 — External, gated

External sends enabled, all requiring approval regardless of confidence.

**Exit test:** approval rate ≥ 80% over 100+ decisions. Below that, the drafts
are not good enough to trust unattended, and the fix is upstream in the prompt
or the confidence composite — not in lowering the bar.

### Stage 3 — Autonomous within policy

The gate decides per `11 §1`. Irreversible actions still always ask, forever.

**Exit test:** none. This is the steady state, and metrics 1–10 are the
standing check.

### The kill switch

A per-org flag that drops any employee back to Stage 0 in one write, with no
deploy. Test it before Stage 1, not after an incident. An untested kill switch
is a comment.

---

## 6. Incident Playbook

| Symptom | First check | Likely cause |
| :-- | :-- | :-- |
| Customer received a duplicate message | `idempotency_keys` for the derived key | Key generated instead of derived (`11 §4`) |
| Employee chased a promise nobody made | Ledger row's `source_quote` | Grounding check bypassed (`13 §3`) |
| Nothing has been flagged in days | `SELECT count(*) FROM operational_expectations WHERE settled_at IS NULL` | Empty table — generators not wired (`11 §5`) |
| Owner says "it asks about everything" | Metric 1 | Escalation score falling back to static tiers |
| Owner says "it did something I didn't approve" | Ledger by entity + `agent_pending_actions.status` | Expiry treated as approval — must never happen (`11 §10 Q5`) |
| Growth employee proposes nothing | Metric 8 | Learned silence — check suppression floor |

Every row starts with a query, not a hypothesis. The ledger exists so incidents
are answered from data.

---

## 7. What to Build in Phase 1

Concretely, alongside `P1-LEDGER-1`:

1. A `metrics` view or scheduled rollup producing the ten numbers per org daily.
2. Alerts on the **zero-side** bounds first — they are the silent killers, and
   they are also the easiest to implement.
3. The per-org kill-switch flag.
4. A one-page internal dashboard: ten numbers, one row per org, sorted by
   distance from the healthy band.

That dashboard is worth more than any amount of tracing infrastructure. Ten
numbers, read weekly, catch every failure in `11 §9`.
