# 10 — Roadmap

Sequenced by dependency, not appetite. Every phase has testable exit criteria.
Do not start a phase without reading `BUILD_STATE.md` and `09`.

The live execution tracker is `docs/plan/README.md`; this is the product-level
narrative behind it.

---

## Now — Stabilise and unblock (0–4 weeks)

Nothing here is new capability. All of it removes drag from everything after.

| Work | Detail |
|---|---|
| Ops-blocked OAuth registrations | Slack, HubSpot, Stripe, Notion, Shopify, Zendesk, Intercom, Zoho, QuickBooks client IDs in Nango; Leegality BYOK |
| Dedicated Redis for Langfuse | Shared Redis at ~100 clients causes BullMQ socket timeouts and flaky trace persistence |
| Redis pub/sub for SSE | `check-two-replica-sse.js` is written and waiting |
| Rate limits | Public and authenticated endpoints |
| Backups | pgBackRest PITR behind `restore-drill.sh`; run the drill and record the wall-clock time |
| Idempotency threaded into write tools | Table and plumbing exist; executors do not all check |
| Scope-drift detection | Compare `connector_defs.scopes` against granted scopes at connect and on schedule |
| Connector health as an org signal | "Reconnect Gmail" in-product, not only an ops alert |
| Goldens as a CI merge gate | Six suites exist and block nothing |

**Exit:** `./start.sh --checks` green on a clean machine · traces persist for 24h
under load · two replicas both receive `needs_attention` · a restore drill is
documented with a real timing · a retried send provably does not duplicate ·
goldens block a merge.

---

## Phase A — The entity graph (4–10 weeks)

The hinge. Everything after is weeks instead of quarters once this lands.

| Work | Detail |
|---|---|
| Fact schema | `subject`, `predicate`, typed `object`, `confidence`, `valid_from`/`valid_to`, `source`, `extracted_by` (model + prompt hash), `status`, `corrected_by_user_id`. RLS in the same migration. |
| Extraction pipeline | Async: redact → gate → extract → resolve → reconcile → write → edge. Never on a request thread. Idempotent on `content_hash`. Honours `blockedDataClasses`. |
| Entity resolution | Deterministic (phone, email, provider id) first; probabilistic second with a **review threshold**; below threshold → merge-review work item, never an auto-merge |
| Contradictions | Recorded, resolved by a stated recency/trust rule, or escalated to `work_items` |
| Retrieval upgrade | Structured-first; RRF fusion of `fts_rank` and `vec_sim`; cross-encoder rerank; validity weighting; one-hop `memory_edges` expansion |
| `/brain` entity pages | Facts, confidence, provenance, contradictions, correct-this-fact |

**Exit:** "what's the status of X?" answers from a join with citations · a
planted contradiction surfaces rather than averaging · a human correction
permanently outranks extraction · the two-org RLS test passes on facts and
vectors · RAGAS retrieval metrics are recorded as a baseline.

---

## Phase B — Commitments and proactivity (10–18 weeks)

| Work | Detail |
|---|---|
| Commitments | Extracted from threads: owner, due date, status, evidence |
| Obligations | From documents and records; `pm_charges`/`pm_leases` project into the same abstraction |
| Chase | Automatic, inside quiet hours, capped, with typed cancel reasons |
| Baselines | Rolling per-org per-metric statistics with seasonality (statsforecast) |
| Watchers | Commitment breach · obligation window · silence · metric anomaly · spend anomaly · connector health · pipeline stall |
| Ranking | `impact × urgency × confidence`, deduplicated across watchers |
| Silence budget | A hard cap on unsolicited output per user per day |
| Morning brief | Role-specific, five items, each one-click approvable — including from WhatsApp |

**Exit:** a commitment made in a WhatsApp thread is chased with no configuration
· the owner opens the brief before their inbox for two consecutive weeks ·
unsolicited output stays inside the silence budget · a planted anomaly fires and
a normal seasonal dip does not.

---

## Phase C — Procedures and autonomy (18–28 weeks)

| Work | Detail |
|---|---|
| Record | Generalise a promoted plan: diff payloads against in-scope entities, parameterise matched literals, confirm each substitution with the human |
| Describe | Compile a plain-language SOP into steps mapped to real tools, confirming ambiguous mappings |
| Procedure object | Versioned; typed parameters; preconditions; guardrails (tools, spend cap, quiet hours, escalation); success criteria |
| Auto-goldens | Generated from successful procedure runs |
| Autonomy ladder | L0–L4 per procedure per employee; evidence-based promotion; automatic demotion on incident; `pay`/`sign` never above L2 without per-procedure owner opt-in; global kill switch |
| Compensation | Per-step undo for reversible steps; partial state visible and actionable |
| Spend budgets | Per-org and per-employee token/cost/API budgets enforced at execution |
| Temporal versioning | Patching strategy before multi-week customer-authored procedures |

**Exit:** a customer authors a working procedure with no engineering help ·
three procedures run at L3+ for thirty days with zero incidents · a forced
mid-plan failure leaves a defined, visible, compensable partial state · a budget
breach stops execution before the spend, not after.

---

## Phase D — Trust, roles and the enterprise floor (28–38 weeks)

| Work | Detail |
|---|---|
| Injection defence | Adversarial framing at every call site; first-time-recipient confirmation; detection as audit events; Garak-derived red-team goldens on every prompt change |
| Approval matrix | By role and amount; out-of-office delegation so a plan never waits on an absent approver |
| Role-scoped brain | Visibility filters applied **inside** the query |
| Audit coverage | Access, data, governance and security event classes; append-only; exportable; queryable by a non-engineer |
| Deletion cascade | Memory, edges, facts, traces, object storage — provably complete |
| Compliance | SOC 2 readiness programme; published DPA and sub-processor list; SCIM on the existing SSO routes |

**Exit:** the red-team suite passes · a ten-seat org can express its real
approval rules · a deletion request provably removes every trace · SOC 2
evidence collection is running.

---

## Phase E — Reach (38–52 weeks)

| Work | Detail |
|---|---|
| Voice and IVR | LiveKit Agents + faster-whisper; the highest-signal missing sense |
| Teams | The remaining major workplace channel |
| Documents | Docling + PaddleOCR → entities and obligations, honouring `blockedDataClasses` |
| Mobile | Push notification, approve-from-notification, mobile brief |
| Packs | `real-estate-pm` built from its RFC; commercial brokerage |
| Billing depth | Per-employee and per-procedure cost attribution to the customer's cost page **before** usage-based billing ships |
| Employee scorecard | Weekly: tasks, approval rate, edit rate, escalations, cost |

**Exit:** a customer runs an entire day's operations without opening a laptop ·
a new pack ships with zero platform code changes · a customer can see what each
AI employee cost and produced last week.

---

## Phase F — Platform and ecosystem (52–78 weeks)

| Work | Detail |
|---|---|
| Marketplace | Packs, procedures, connectors |
| MCP distribution | Publish the Darex MCP server as a first-class channel |
| Partner packs | With a certification and eval bar |
| Open source | The pack format and the honesty eval suite (`20` §10) |
| Enterprise | Admin console, sandbox/staging orgs, full export, residency, per-org keys |

**Exit:** a pack authored outside the company passes certification and installs
into a paying org.

---

## Standing rules across all phases

1. No phase ships without goldens for what it added.
2. No tenant table ships without its RLS policy in the same migration.
3. `BUILD_STATE.md` is updated in the change that alters behaviour.
4. Anything ops-blocked is labelled ops-blocked, never "done".
5. A vertical needing a platform code change means the platform is missing a
   primitive — build the primitive.
6. New decision logic goes in a pure isolate-safe module; new side effects go in
   an activity.
7. Injection defences land **before** the autonomy level they protect.
8. A cost page ships before usage-based billing.

---

## Sequencing rationale in one paragraph

The entity graph is first because commitments, watchers, ranking, procedures and
the fact-level trust surface are all queries against it — building any of them
first means building them twice. Proactivity is second because it is what turns
weekly usage into daily and is therefore the retention mechanism. Procedures are
third because they remove us from the loop and are what make verticals scale.
Autonomy is fourth because it converts saved clicks into saved headcount, which
is the actual sales claim — and it is gated on the injection defences because
autonomy without them is the one change that could end the company.
