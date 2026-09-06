# 09 — Gaps and What To Add

Honest, ranked by leverage. Each item states the gap, why it matters, what
already exists to build on, and what "done" looks like.

**Corrections to earlier assumptions**, because getting this list wrong wastes
quarters: tool risk tiers (`tools/risk.ts`), idempotency keys
(`idempotency_keys`), a relation graph (`memory_edges`), hybrid lexical+semantic
retrieval, SSO routes, Instagram and SMS webhooks, and the "always do this"
table (`org_playbook_promotions`) **already exist**. The gaps below are what is
genuinely missing on top of them.

---

## Tier 1 — Without these, Darex is an assistant, not a brain

### 1.1 Entity graph and typed fact extraction

**Gap.** Memory stores prose. `entity_memory` keys chunks by
`(entity_type, entity_id)` but the content is text, not typed attributes with
confidence and validity.

**Why it matters.** Every proactive, analytical and autonomous feature needs
joins, not similarity. Without it, "what's the status of X?" is a plausible
paragraph rather than a retrieved truth, and there is nothing to watch, rank, or
correct.

**Exists to build on.** `entity_memory` (scope keys, provenance, TTL, hybrid
indexes), `memory_edges` (typed relations with weights), `audit_events.prompt_hash`
(the pattern for attributing extraction to a prompt version), `work_items` (the
escalation queue contradictions should land in).

**Done.** Fact rows with `subject`, `predicate`, typed `object`, `confidence`,
`valid_from`/`valid_to`, `source`, `extracted_by`, `status`,
`corrected_by_user_id`. An async extraction pipeline (redact → gate → extract →
resolve → reconcile → write → edge). Entity resolution across channels with a
review threshold. Contradiction records. `/brain` entity pages with a
correct-this-fact control that outranks extraction permanently.

**Effort.** 6–10 weeks. Everything else in Tier 1 depends on it.

---

### 1.2 Commitments and obligations

**Gap.** A promise made in a thread ("I'll send the quote Friday") and a
contractual date (rent due, renewal, compliance deadline) are not first-class
objects.

**Why it matters.** This is the value a customer *feels* in week one — nothing
gets dropped, without anyone remembering to chase. It is also the most
demonstrable ROI claim the product can make.

**Exists to build on.** `pm_charges` and `pm_leases` prove the obligation shape
for one vertical. `StaleChaseWorkflow` proves the chase mechanic.
`work_items.due_at` and `priority` are already there.

**Done.** Commitments extracted from threads and obligations from documents and
records, both with owner, due date, status and evidence. Automatic chase inside
quiet hours. A breach view. Commitments visible on the entity page.

---

### 1.3 Procedure authoring by the customer

**Gap.** `org_playbook_promotions` stores a promoted plan's **concrete** steps —
"email priya@example.com about unit 402" — not a parameterised procedure.

**Why it matters.** We cannot scale verticals or accounts while every procedure
needs an engineer. This is the line between a service and a product.

**Exists to build on.** The table with its `org.%` namespace, unique constraint,
and `ON DELETE RESTRICT` authorship. The planner already maps intent to
`{tool, action, payload}`. Guardrail primitives all exist: allowlists, quiet
hours, meter limits, work-item escalation.

**Done.** (a) *Record:* generalise a promoted plan by diffing payloads against
in-scope entities, replacing matched literals with parameter references, and
asking the human to confirm each substitution. (b) *Describe:* compile a
plain-language SOP into steps with confirmation on ambiguous tool mappings.
Both produce a versioned procedure with typed parameters, guardrails, success
criteria and auto-generated goldens.

---

### 1.4 Baselines, watchers and a ranked morning brief

**Gap.** The product waits to be asked. `OwnerBriefingWorkflow` and
`StaleChaseWorkflow` run on schedules with fixed heuristics; nothing defines
"unusual" and nothing ranks across signals.

**Why it matters.** Daily-open behaviour instead of occasional use. It is the
primary retention mechanism, and it is what makes turning Darex off disruptive.

**Exists to build on.** The two workflows, `InsightActionWorkflow` (cards name
an executable workflow), per-pack `kpis.yaml`, and the fan-out caps that show
we already think in budgets.

**Done.** Rolling per-org per-metric baselines with seasonality. A watcher
registry evaluated on schedule against the entity graph (commitment breach,
obligation window, silence, metric anomaly, spend anomaly, connector health,
pipeline stall). Ranking by `impact × urgency × confidence`, deduplicated across
watchers. A **silence budget** capping unsolicited output per user per day.
Role-specific briefs where every item is one-click approvable — including from
WhatsApp, which already works.

---

## Tier 2 — Trust and scale

### 2.1 Prompt-injection defence
**Gap.** Ingested content is untrusted but not treated as hostile.
**Exists.** Authorisation is a database array not prompt text (the strongest
defence); the confirm gate is risk-based; the sandbox has no network.
**Done.** Adversarial framing of retrieved content at every call site;
first-time outbound recipients require confirmation; injection attempts logged
as `audit_events` and surfaced to the org; a red-team golden suite (Garak probes
are a ready source) running on every prompt change.
**Gate.** Must land before autonomy above L2.

### 2.2 Idempotency threaded into every write tool
**Gap.** `idempotency_keys` exists and is passed at the workflow boundary, but
not derived and checked inside every mutating executor.
**Done.** Every write tool derives a key from `(org, plan/step, payload digest)`
and checks it before calling the provider.
**Effort.** Days. Highest value-per-hour item on this list.

### 2.3 Compensation and rollback
**Gap.** `completed_with_errors` reports partial failure honestly but offers no
undo for steps that already succeeded.
**Done.** Per-step compensation definitions for reversible steps; a partial
state that is visible and actionable in the plan UI; compensation itself under
the confirm gate.

### 2.4 Spend budgets at execution
**Gap.** Fan-out is capped by count (3 / 3 / 10) but not by cost. One expensive
step can exceed any reasonable budget.
**Exists.** `billing_meters.soft_limit` and `hard_limit`; Langfuse per-org cost.
**Done.** Per-org and per-employee token, cost and API budgets enforced in the
tool executor and the workflow layer, with alerts before hard stops.

### 2.5 Autonomy ladder
**Gap.** Autonomy is effectively binary. Risk classes govern the *action*; there
is no *procedure*-level level.
**Done.** L0–L4 per procedure per employee, evidence-based promotion, automatic
demotion on incident with a work item, `pay`/`sign` never above L2 without
explicit per-procedure owner opt-in, a global kill switch, and every level
change as an audit event.

### 2.6 Approval matrix, delegation and role-scoped brain
**Gap.** No model of who approves what, up to what amount, or what each role may
see.
**Exists.** `human_roles`, `audit_events.approver_user_id`.
**Done.** Approval routing by role and amount; out-of-office delegation so a
plan never waits forever on an absent approver; memory visibility scoped per
role **inside the query**, not post-filtered.

### 2.7 Scope-drift detection
**Gap.** A token minted before a scope was added 403s at execution time — the
exact `draft_email` bug.
**Exists.** `connector_defs.scopes` declares what is required.
**Done.** Compare required against granted at connect time and on a schedule;
surface `scope_insufficient` with a reconnect prompt; add a golden for it.

### 2.8 Connector health as an org-facing signal
**Gap.** A 401 surfaces to the user as a task failure.
**Exists.** `alerting-connector-401s.js`.
**Done.** Proactive health checks writing an org-facing "reconnect Gmail"
prompt, plus the existing ops alert.

### 2.9 Multi-replica SSE
**Gap.** SSE state is per process; two dashboard replicas do not both receive
`needs_attention`.
**Exists.** `check-two-replica-sse.js` is written and waiting.
**Done.** Redis pub/sub behind the stream; the check passes.

---

## Tier 3 — Reach and revenue

### 3.1 Missing senses
Voice and IVR (the highest-signal SMB channel — the caller is worth more than
the form-filler) · Microsoft Teams · calendar events as first-class signals ·
document drop-and-understand · ERP and accounting event streams.

### 3.2 Mobile and notification surfaces
Owner-WhatsApp approval proves the pattern. Extend it: push notification,
approve-from-notification, and a mobile morning brief.

### 3.3 Packs
`real-estate-pm` (RFC written) → commercial brokerage → professional services.
Full ranked list in `05` §6.

### 3.4 Marketplace and MCP distribution
Publish the Darex MCP server; open the pack format; publish the honesty eval
suite. Detail in `20` §10.

### 3.5 Billing depth
`billing_meters` has `soft_limit`, `hard_limit` and `truncated`. What is missing
is per-employee and per-procedure attribution reaching the customer's cost page
and invoice — plus the cost page shipping **before** usage-based billing does.

### 3.6 Employee lifecycle surfaces
Weekly per-employee scorecard: tasks completed, approval rate, edit rate,
escalations, cost. This is what makes the "AI employee" claim credible to a
buyer comparing against a salary.

---

## Tier 4 — Enterprise readiness

SOC 2 · SCIM (SSO routes already exist) · data residency · per-org encryption
keys · published DPA and sub-processor list · admin console · sandbox and
staging orgs · full export · uptime SLA and status page.

---

## Tier 5 — Engineering hygiene, named

- Dedicated Redis for Langfuse (shared Redis at ~100 clients causes BullMQ
  socket timeouts and flaky trace persistence).
- Rate limits on public and authenticated endpoints.
- Terraform/OpenTofu starter: VPC, RDS, Redis, secrets, HTTPS.
- PITR backups behind `restore-drill.sh`, with the drill actually run and timed.
- Complete the ops-blocked OAuth client registrations (`06` §11).
- OpenTelemetry propagation across dashboard → worker → tools into Langfuse.
- Replace the five hand-rolled `alerting-*.js` scripts with Prometheus +
  Alertmanager.
- Temporal versioning strategy before multi-week procedures are customer-authored.
- Wire goldens into CI as a merge gate — they exist but block nothing.
- Per-procedure goldens, cost regression tracking, and latency budgets as
  assertions (`18` §5).

---

## The one-line summary

Darex has an unusually strong **substrate** — tenancy, durability, risk
classification, honesty enforcement, hybrid memory — and an unusually thin
**state model**. Tier 1.1 is the hinge: build the entity graph, and Tiers 1.2
through 1.4 become weeks of work each instead of quarters.
