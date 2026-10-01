# Workstream 10 — Analytics, observability, and evals

Insight today is templates. Langfuse ingestion works; persistence
can be flaky. Learning needs evals, cost per org, and playbook
promotion — not a new trace vendor.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/00-status-at-a-glance.md`,
`09-dashboard-pages.md`, `16-updates-2026-08-13.md`.

- `/analytics` real SQL aggregates. `/insight` rule templates.
- Langfuse ingestion schema fixed; dedicated `langfuse-redis`;
  ClickHouse still flaky.
- No Promptfoo, no pack goldens, no cost budget, no promotion.

---

## 2. Target

Sources: `docs/future-scope/13` Phase 7, `03` §7, `08` §10, `15` §7.

Semantic metrics + scheduled Insight cards that enqueue **named**
workflows. Langfuse KEEP. Promptfoo ADOPT. τ-bench shape for pack
goldens. LangSmith REJECT. Narrative over pre-aggregates only.

---

## 3. Gaps

**Audit 2026-08-14:** A2–A5 **done** as code. A1 Langfuse **partial**.

Analytics SQL **done**. Insight engine, eval-runner, cost budgets,
promotion **missing**. Langfuse **partial**.

---

## 4. Work items

### A1 — Stabilize Langfuse persistence

- **Where:** compose; `lib/langfuse-trace.ts`.
- **DoD:** Plan execute trace visible after 60s. Errors not
  swallowed.

### A2 — Eval-runner CI from Phase 6

- **Where:** `infra/evals/`; CI.
- **Depends on:** M6.
- **DoD:** Broken retrieve fails CI.

### A3 — Insight engine

- **Where:** `app/api/insight`; InsightActionWorkflow.
- **Depends on:** K4, O5.
- **DoD:** Card matches SQL. Button starts a named workflow. No
  LLM scan of raw messages.

### A4 — Cost per org + drift

- **DoD:** Owner sees weekly cost. High confirm-reject flagged.

### A5 — Promote plan → org skill

- **Depends on:** A2, R1, O6.
- **DoD:** Replay uses playbook matcher, not a new runtime.

---

## 5. End-to-end connections

Metrics from 05. Actions from 02. Traces from 01. Pack goldens
from 13. Billing (14) may reuse cost.

---

## 6. Non-goals

Replacing Langfuse. Insight before memory. Training on tenant PII.

---

## 7. Verification

Trace visible in UI. Eval CI red on a broken golden. Insight
action in Temporal UI. Numbers match SQL.

Related: [05-data-sources-and-knowledge.md](./05-data-sources-and-knowledge.md),
[14-billing-evals-and-learning.md](./14-billing-evals-and-learning.md).
