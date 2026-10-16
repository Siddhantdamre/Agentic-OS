# DareXAI One — Master Gap Analysis & Current State Audit

> **Scope:** Comprehensive audit of current codebase capabilities (`apps/dashboard`, `services/workflows`, `services/connectors`, `infra/`) against the **DareXAI One 106-Page Blueprint** (`docs/new-109-pg-plan/plan/`).  
> **Status Taxonomy:**  
> - 🟢 **GREEN (Implemented / Working):** Fully built in code, verified with live execution or tests.  
> - 🟡 **YELLOW (Partial / In-Progress):** Scaffolding, schemas, or executors exist, but missing end-to-end wiring, autonomous triggers, or production hardening.  
> - 🔴 **RED (Missing / Gaps):** Specified in the blueprint but currently absent from the codebase.

---

## Executive Scorecard: Blueprint vs. Current Reality

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         DAREXAI ONE READINESS MATRIX                        │
 ├────────────────────────────────┬─────────┬──────────┬─────────┬─────────────┤
 │ Domain                         │ 🟢 Live │ 🟡 Partial│ 🔴 Gap  │ Readiness   │
 ├────────────────────────────────┼─────────┼──────────┼─────────┼─────────────┤
 │ 1. Growth Employee             │    3    │    4     │    7    │    21%      │
 │ 2. Customer Employee           │    4    │    5     │    6    │    27%      │
 │ 3. Operations Employee         │    2    │    4     │    9    │    13%      │
 │ 4. Shared Integrations         │    6    │    6     │    4    │    38%      │
 │ 5. Core Platform & Runtime     │    7    │    5     │    6    │    39%      │
 ├────────────────────────────────┼─────────┼──────────┼─────────┼─────────────┤
 │ TOTALS                         │   22    │   24     │   32    │    28%      │
 └────────────────────────────────┴─────────┴──────────┴─────────┴─────────────┘
```

---

## Detailed Gap Analysis Modules

| Document | Scope & Focus | Status Breakdown |
| :--- | :--- | :--- |
| [**`00_state_of_build.md`**](./00_state_of_build.md) | **START HERE.** Deduplicated consolidation of all files below: what we did (verified live), what is half-done, what we must build, and the build order. | 28% Live \| 31% Partial \| 41% Gap |
| [**`01_growth_employee_gap.md`**](./01_growth_employee_gap.md) | **Growth Employee Audit**: Scout, Lookalike engine, Signal detection, Website visitor intent, Dormant lead reviver, Decision cards, and Outcome metrics. | 🟢 3 \| 🟡 4 \| 🔴 7 |
| [**`02_customer_employee_gap.md`**](./02_customer_employee_gap.md) | **Customer Employee Audit**: 12-step resolution loop, Open Loops state tracking, Escalation of decisions (not chats), Churn risk, and Proactive recovery. | 🟢 4 \| 🟡 5 \| 🔴 6 |
| [**`03_operations_employee_gap.md`**](./03_operations_employee_gap.md) | **Operations Employee Audit**: Expected vs. Actual state machine, 9 operational workflows, Stuck Work detector, Morning Brief, Outage buffering. | 🟢 2 \| 🟡 4 \| 🔴 9 |
| [**`04_shared_integrations_gap.md`**](./04_shared_integrations_gap.md) | **DareXAI Connect & Integration Stack**: Tier 1 Core 10 vs Tier 2, single-connection shared context, role-based tool allowlists, token lifecycle. | 🟢 6 \| 🟡 6 \| 🔴 4 |
| [**`05_core_platform_and_runtime_gap.md`**](./05_core_platform_and_runtime_gap.md) | **Runtime, Data Models & Architecture**: Temporal durable timers, PostgreSQL RLS, Webhook ingress 3s latency, Decision Trace Ledger, State machines. | 🟢 7 \| 🟡 5 \| 🔴 6 |
| [**`07_completion_percentages_and_next_build.md`**](./07_completion_percentages_and_next_build.md) | **Percentage Breakdown & What We Are Going to Build**: Quantitative % scorecard by domain + sequenced build priority. | 28.2% Done \| 41.0% Gap |
| [**`06_master_implementation_roadmap.md`**](./06_master_implementation_roadmap.md) | **Phase-by-Phase Remediation Roadmap**: Engineering milestones to convert all 🔴 Red and 🟡 Yellow gaps into 🟢 Green production features. | Action Plan |
| [**`08_build_playbook.md`**](./08_build_playbook.md) | **The "how": file-by-file build guide** — migration DDL, workflow skeletons, activity lists, autonomy-gate wiring, per-phase runnable checks, and the end-to-end demo acceptance script. | Engineering Spec |
| [**`09_build_playbook_deep.md`**](./09_build_playbook_deep.md) | **Deep version of `08`** — matched to the repo's real conventions (migration shape from `022`, `continueAsNew` cron from `OwnerBriefingWorkflow`, idempotent-activity pattern, existing `approveWorkItemSignal` HITL). Real code excerpts for every new file, a test matrix, and corrections to `08`. | Engineering Spec |
| [**`10_execution_backlog.md`**](./10_execution_backlog.md) | **The work queue.** `08`/`09` decomposed into ticket-level units with IDs, dependencies, sizes, files touched, and a written acceptance check per ticket. Plus a 7-point definition of done and the sequencing rules. | Build Backlog |
| [**`11_design_decisions_deep.md`**](./11_design_decisions_deep.md) | **The reasoning layer — read before coding the hard tickets.** Nine problems where the obvious implementation quietly breaks the product: what counts as an escalation-worthy decision, obligation extraction, where confidence actually comes from, exactly-once effects on a retrying runtime, where expectations originate, counterfactual logging, rejection learning, multi-employee collision, and the eight failure modes that kill this product class. | Design Rationale |
| [**`12_migrations_ready_to_run.md`**](./12_migrations_ready_to_run.md) | **Copy-paste DDL for `023` + `024`, corrected against the live schema.** Supersedes the draft in `05 §4` (which referenced a non-existent `organizations` table). Ten tables with RLS, indexes, seed rules, a verification script, and rollback. | Ready to Apply |
| [**`13_prompt_and_eval_spec.md`**](./13_prompt_and_eval_spec.md) | **The model layer.** Both extraction prompts, the deterministic checks that must run after every model call, due-time resolution in code, the confidence composite implemented, four fixture sets, and the quality gates that block a ship. | LLM Spec |
| [**`14_observability_and_rollout.md`**](./14_observability_and_rollout.md) | **Detecting the silent failures.** Ten metrics with bands bounded on *both* sides (five alert on zero), per-org alerting, the four-stage shadow-to-autonomous rollout with an exit test each, and an incident playbook. | Ops Spec |
| [**`15_gate_and_state_reference.md`**](./15_gate_and_state_reference.md) | **Canonical gate + state machines; supersedes `09 §B`.** Fixes three silent seams: an action taxonomy that never joins the seed rules, a gate that ignores reversibility and blast radius, and a bad import. Includes the complete transition maps and the revised Phase-1 order. | Corrected Spec |
| [**`16_workflows_corrected.md`**](./16_workflows_corrected.md) | **Canonical workflows; supersedes `09 §C–E`.** Six seams, including a card design that writes to a column that does not exist and — the serious one — external sends that bypass the autonomy gate entirely. Adds `guardedSendActivity` as the single send path. | Corrected Spec |
| [**`17_ui_and_interaction_spec.md`**](./17_ui_and_interaction_spec.md) | **The human contract.** Decision card anatomy, the four-button rejection reason `11 §7` depends on, the morning brief (whose healthy state is nearly empty), the explain surface, settings, and the notification policy that decides whether the gate survives contact with a busy owner. | UX Spec |
| [**`18_security_and_governance.md`**](./18_security_and_governance.md) | **What autonomy changes about the threat model.** Prompt injection as privilege escalation, blast-radius containment for fleet-wide mistakes, the ledger as a new PII store with DSR obligations, credential scoping, and the pre-launch checklist. | Security Spec |
| [**`19_agent_loop_architecture.md`**](./19_agent_loop_architecture.md) | **What runs inside an autonomous employee.** The eight-step loop (frame → retrieve → assess → plan → gate → act → verify → settle), why the shipped interactive agent path cannot be reused, the Temporal determinism boundary that silently corrupts workflows, step/replan/token budgets, and the partial-failure policy. | Agent Spec |
| [**`20_memory_and_learning.md`**](./20_memory_and_learning.md) | **How the employee knows things and improves.** Per-employee retrieval strategy over the four memory stores that already ship, write-back discipline (and the one rule that prevents self-citation drift), contradiction handling via `fact_conflicts`, and procedural learning through the existing playbook-promotion table. | Memory Spec |
| [**`21_cost_model_and_scaling.md`**](./21_cost_model_and_scaling.md) | **What 127 sweep passes per org per day actually cost.** The ~18× branch between a model-per-pass and an SQL-first idle path, cost ratios per operation, the optimisation order, and the sweep-share-of-spend leak detector. | Cost Model |
| [**`22_onboarding_and_cold_start.md`**](./22_onboarding_and_cold_start.md) | **The first two weeks, which decide churn.** Why a new org gets an employee that asks about everything and notices nothing, the backfill that breaks the paradox, the notice→draft→act ramp, and the chase-storm failure that loses an account in week one. | Onboarding |
| [**`23_demo_and_acceptance.md`**](./23_demo_and_acceptance.md) | **The acceptance test for the whole plan.** Nine runnable scenes proving the four mechanisms compose — including silence when healthy, a forced irreversibility bypass that must fail, and the definition of done for `00`–`22`. | Acceptance |

---

---

## Reading Order

> **Prior art:** [`../opensource.md`](../opensource.md) maps every subsystem
> below to the open-source projects that already solve it — with links, a
> verdict (adopt / study / skip), and an honest list of the five things that
> have no good open-source answer.


| You are | Read, in order |
| :-- | :-- |
| **Deciding what to fund** | `README` scorecard → `07` percentages → `00` verdict |
| **About to write code** | `10` (pick a ticket) → `11` (the section for that ticket) → `09` (the code shape) → `12` (if it touches the schema) |
| **Building the state layer** | `15 §6` (the order) → `12` (the SQL) → `15 §1`–`§3` (the code) |
| **Building anything LLM-touching** | `13` in full, then `11 §2`–`§3` |
| **Building a workflow** | `16` → `09 §A` (conventions) → `11 §4` (idempotency) |
| **Building any screen** | `17` in full |
| **Building the agent itself** | `19` → `20` → `13` (the prompts) |
| **Taking it to production** | `14` → `18 §6` → `21` (cost) → `22` (onboarding) |
| **Proving it is done** | `23` |

> **Note on `09`:** `§B` is superseded by **`15`** (gate, state machines) and
> `§C–E` by **`16`** (workflows). Those sketches predate `11` and `12`, and
> several of the mismatches fail *silently* rather than loudly. `§A` — the repo
> conventions — remains correct and is still the right place to start.
>
> **Note on `05 §4`:** its DDL was a first draft and is **superseded by `12`**
> — it referenced an `organizations` table that does not exist in this repo.
> Read `05` for the requirements; apply the SQL from `12`.

---

## Key Takeaway: Where DareXAI Stands Today

DareXAI has built a **world-class foundation**:
- SuperTokens multi-tenant auth with Postgres RLS (`app.current_org_id`).
- Temporal worker infrastructure (`services/workflows`) with atomic-agent and MCP bridge.
- LiteLLM routing with plan-confirm-execute streaming via SSE.
- 62 real connector tools with Nango OAuth management.
- Webhook ingress for WhatsApp and Chatwoot.
- Entity Graph & Fact Model schema (`022_entity_graph.sql`).

**The Missing Bridge:**  
The codebase currently functions primarily as an **interactive AI Assistant / Plan-Executor** (user prompts $	o$ AI drafts plan $	o$ user approves $	o$ tool runs).  
To become the **AI Employee Platform** defined in the 106-page blueprint, DareXAI must transition from **reactive prompting** to **proactive, state-driven, autonomous ownership**:
1. **State Engines:** Explicit state machines for *Enquiries*, *Tasks*, and *Customer Open Loops*.
2. **Durable Timers:** Temporal workflows that wake up after hours/days without user prompting.
3. **Operational Discrepancy Tracking:** Comparing *Expected vs. Actual* to surface *Stuck Work*.
4. **Self-Explanation Auditability:** Logging negative decisions to explain *“Why didn't you do that?”*
