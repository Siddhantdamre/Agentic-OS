# 22 — Design Spec: Proactivity Engine

> Status: **specification, not built.** Depends on `21` (entity graph).
> This is `09` Tier 1.4 — the feature that turns weekly usage into daily.

---

## 1. Problem statement

Darex waits to be asked. `OwnerBriefingWorkflow` runs daily and
`StaleChaseWorkflow` runs on a schedule, but both use fixed heuristics, nothing
defines "unusual", and nothing ranks signals against each other.

A brain that only answers questions is opened a few times a day when someone
remembers it exists. A brain that tells you something you did not know is the
first tab open in the morning. That difference is the retention mechanism, and
it is also the difference between "useful tool" and "turning it off would be
disruptive" — the acceptance test in `04` §11.

---

## 2. The four pieces

```
   facts / entities (21)
        │
        ▼
   ┌──────────┐    baselines: what is normal for THIS org
   │ BASELINE │    rolling stats per (org, metric), seasonality-aware
   └────┬─────┘
        ▼
   ┌──────────┐    watchers: standing conditions evaluated on schedule
   │ WATCHER  │    → candidate signals with evidence
   └────┬─────┘
        ▼
   ┌──────────┐    ranking: impact × urgency × confidence, deduplicated
   │  RANK    │    → at most N items, respecting the silence budget
   └────┬─────┘
        ▼
   ┌──────────┐    brief: role-specific, cited, each item one-click actionable
   │  BRIEF   │    → dashboard, email, WhatsApp
   └──────────┘
```

Each stage is separately testable, and each can ship without the next: baselines
are useful in analytics alone, watchers are useful as a work-item feed before
ranking exists.

---

## 3. Baselines

### Why fixed thresholds fail

"Alert when inquiries go unworked for 2 hours" (the current
`core.inquiries_unworked` KPI) is right for a busy Mumbai brokerage and absurd
for a two-person firm that works in batches. Every fixed threshold is wrong for
most customers, and a wrong threshold trains people to ignore the product.

### Schema

```sql
CREATE TABLE IF NOT EXISTS metric_baselines (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  metric_key    TEXT NOT NULL,             -- from the pack kpis.yaml registry
  dimension     TEXT NOT NULL DEFAULT '',  -- optional slice: channel, employee
  window        TEXT NOT NULL,             -- hour_of_week | day | week
  n_samples     INTEGER NOT NULL DEFAULT 0,
  mean          NUMERIC,
  stddev        NUMERIC,
  p50           NUMERIC,
  p90           NUMERIC,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT metric_baselines_unique UNIQUE (org_id, metric_key, dimension, window)
);
```

`window = 'hour_of_week'` is the one that matters. Sunday evening is quiet for
every brokerage; a baseline that does not know that fires an anomaly alert every
Sunday and is muted by Tuesday.

### Computation

A scheduled `BaselineWorkflow`, nightly, per org. Aggregation runs off the
request path (`12` §7) and reads the same metrics registry analytics and insight
cards read, so the three surfaces cannot disagree.

**Cold start:** below `n_samples` (say 14 observations for a window), the
baseline is `NULL` and watchers that depend on it **do not fire**. A new org
gets no anomaly alerts for two weeks. That is correct — a confident anomaly
claim from four data points is noise, and the first two weeks are exactly when
trust is being established.

Fall back to pack-provided defaults during cold start only for watchers whose
condition is absolute rather than relative (an overdue commitment is overdue
regardless of history).

---

## 4. Watchers

### Definition

```sql
CREATE TABLE IF NOT EXISTS watchers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  watcher_key     TEXT NOT NULL,       -- pack.* or org.*
  enabled         BOOLEAN NOT NULL DEFAULT true,
  schedule        TEXT NOT NULL,       -- cron
  params          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT watchers_unique UNIQUE (org_id, watcher_key)
);
```

Watcher **definitions** ship in packs (like KPIs and workflow bindings);
`watchers` rows are the per-org enablement and parameters. Customers can turn
one off — which they will, and being able to is what stops them muting all of
them.

### The catalogue

| Watcher | Condition | Needs |
|---|---|---|
| `commitment.breach` | A commitment is past due, or inside its warning window | `21` facts |
| `obligation.window` | Rent, renewal, or compliance date enters notice period | `21` facts, `pm_charges` |
| `thread.silence` | No reply for longer than this relationship's own norm | baselines |
| `metric.anomaly` | A KPI outside its baseline band | baselines |
| `spend.anomaly` | Token or tool cost deviates from the org's pattern | `billing_meters`, Langfuse |
| `connector.unhealthy` | A connector is 401ing | already detected in ops; not surfaced to the org |
| `pipeline.stall` | An entity has not changed state within its expected cycle time | `21` facts + baselines |
| `plan.awaiting_approval` | A plan has been waiting on a human too long | `agent_plans` |
| `workitem.aging` | A work item is past `due_at` | `work_items` |

The last two need **no** new infrastructure and should ship first. A plan
waiting three days for approval is a real, common, currently invisible failure,
and it is a one-query watcher.

### Output

```sql
CREATE TABLE IF NOT EXISTS signals (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  watcher_key   TEXT NOT NULL,
  subject_id    UUID REFERENCES entities(id) ON DELETE CASCADE,
  dedupe_key    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info',
  impact        REAL NOT NULL DEFAULT 0.0,
  urgency       REAL NOT NULL DEFAULT 0.0,
  confidence    REAL NOT NULL DEFAULT 0.0,
  score         REAL NOT NULL DEFAULT 0.0,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- fact ids, memory ids
  proposed_action JSONB,                             -- a named procedure + params
  status        TEXT NOT NULL DEFAULT 'open',
                -- open | delivered | actioned | dismissed | expired | suppressed
  work_item_id  UUID REFERENCES work_items(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_signals_dedupe
  ON signals (org_id, dedupe_key) WHERE status IN ('open','delivered');
```

**`dedupe_key` with a partial unique index is the whole deduplication design.**
A watcher that fires hourly on the same overdue commitment updates
`last_seen_at` on one row instead of creating 24 rows a day. Without this, the
brief becomes a firehose within a week and the feature dies.

**`evidence JSONB`** carries fact and memory ids, so every brief item is cited —
`12` §8 applies to proactive claims exactly as it does to answers. An
uncited "this deal looks stalled" is unverifiable and therefore unactionable.

**`proposed_action`** names a procedure with parameters, following the existing
`InsightActionWorkflow` rule: a card names a specific executable workflow, not
advice.

---

## 5. Ranking

```
score = impact × urgency × confidence
```

| Term | Range | Meaning |
|---|---|---|
| `impact` | 0–1 | Money or relationship at stake, normalised per org so a ₹5 crore firm and a ₹50 lakh firm both get a usable spread |
| `urgency` | 0–1 | How fast the window is closing; a deadline in 2 hours beats one in 2 weeks |
| `confidence` | 0–1 | The **minimum confidence of the facts in `evidence`** — an item built on a shaky fact cannot outrank one built on a tool read |

Confidence propagating from the underlying facts is what stops the entity graph's
uncertainty from being laundered into a confident alert. A brief item is never
more certain than its weakest evidence.

Multiplication, not a weighted sum: a zero on any term should zero the item. A
high-impact, zero-confidence signal is a guess, and guesses do not go in the
brief.

---

## 6. The silence budget

The most important constraint in this document.

```
per user per day:   ≤ 5 brief items
per user per day:   ≤ 2 unsolicited pushes (WhatsApp/email), outside quiet hours
per watcher per org: ≤ 3 items in one brief   (no single watcher floods it)
suppression:        a dismissed signal's dedupe_key is suppressed for 7 days
```

Same instinct, same file family as `MAX_NURTURE_FANOUT = 3` and
`MAX_STALE_CHASE = 10` — a pure, isolate-safe module with constants and tests.

**Rules:**
- Items that do not fit the budget are **not delivered**, not queued for
  tomorrow. Yesterday's sixth-most-important item is rarely today's most
  important.
- Quiet hours apply to pushes exactly as they do to nurture.
- Dismissal is a signal, not just a UI action: three dismissals of the same
  watcher key suggests disabling it, and the product should offer that rather
  than continuing.

Notification fatigue kills this feature faster than bad analysis. A brief with
five right items beats one with five right and twenty mediocre — the second gets
muted, and a muted brain is churned.

---

## 7. The brief

### Per role, not per org

`human_roles` decides what a person sees. The owner's five items are not the
junior agent's five items. Delivering the owner's cashflow signal to a junior
agent is both noise and a data-scope leak.

### Item shape

```
[severity]  <one-line claim>
            what changed, in the customer's own vocabulary
            evidence: "from Priya's WhatsApp, 3 Sep 14:22"  → opens the source
            [ Approve: send follow-up ]  [ Snooze ]  [ Dismiss ]
```

Approve triggers the `proposed_action` procedure through the normal confirm
path — the same gate, the same audit trail, the same risk classification. The
brief is a **surface** onto the existing execution machinery, not a parallel one
with its own rules.

### Delivery

| Channel | When |
|---|---|
| Dashboard | Always; the brief is the home surface |
| Email | Daily digest at a per-user time |
| WhatsApp | Only items above a severity threshold, only outside quiet hours |

WhatsApp delivery reuses the owner-approval route that already exists: the owner
receives the item and replies to approve. That path is proven (`16` §7), and it
is the single highest-leverage delivery surface because the buyer lives on their
phone (`01` §4).

---

## 8. Failure modes to design against

| Failure | Design response |
|---|---|
| Alert fatigue | Silence budget, dedupe key, 7-day suppression on dismissal, per-watcher cap |
| Crying wolf on bad facts | Confidence propagates from evidence; low-confidence items never rank |
| Same signal from three watchers | `dedupe_key` is computed from `(subject, concern)`, not from `(watcher, subject)` |
| Cold-start noise | Baselines `NULL` below `n_samples`; relative watchers stay silent for two weeks |
| Seasonal false positives | `hour_of_week` baselines |
| A watcher that is wrong for this business | Per-org `enabled` flag, and offer to disable after repeated dismissal |
| Brief becomes a to-do list nobody clears | Items expire; the brief shows today, not a backlog |
| Proactive spam to end customers | Watchers produce **internal** signals only. A watcher never messages a customer directly — only an approved procedure does. |

The last row is a hard boundary. Watchers observe and propose; they never act on
the outside world. That keeps the confirm gate meaningful and keeps a bad
watcher from becoming an outbound incident.

---

## 9. Build order

1. `plan.awaiting_approval` and `workitem.aging` — no new dependencies, real
   value, and they exercise the whole `signals` → rank → brief path end to end.
2. `signals` table, dedupe, silence budget, dashboard brief.
3. `metric_baselines` + `BaselineWorkflow`; `metric.anomaly` and
   `thread.silence`.
4. `connector.unhealthy` — the detection already exists in
   `alerting-connector-401s.js`; this just makes it org-facing.
5. After `21` lands: `commitment.breach`, `obligation.window`, `pipeline.stall`.
6. Email digest, then WhatsApp delivery.
7. Role-specific briefs once the approval matrix (`09` §2.6) exists.

Stage 1 is deliberately unglamorous. It proves the pipeline against signals
whose correctness is not in doubt, before anything depends on extracted facts.

---

## 10. Metrics for the feature itself

| Metric | Target direction | Meaning |
|---|---|---|
| Brief open rate | Up | The core retention signal |
| Items actioned / items delivered | Up | Are we surfacing the right things |
| Dismissal rate per watcher | Down | A watcher above ~40% is wrong and should be disabled |
| Time from signal to action | Down | Is the brief actually accelerating the business |
| Pushes per user per day | At or below budget | The guardrail; breaching it is a bug |
| Signals suppressed by budget | Watch | Consistently high means the ranking is too permissive |

Dismissal rate per watcher is the honest one. It is the metric that tells us to
delete our own feature, which is exactly why it must be on the dashboard.
