# 109-Plan Gap Implementation Tracker

> Snapshot: 2026-09-21, all 24 gap modules and all slices (0–7) fully implemented
> and verified on `feat/close-109-plan-gaps` after merging `origin/feat/platform-upgrades`.
> Migrations through `029_org_cost_and_calibration.sql`; state machines,
> autonomous workflows, 4-tier autonomy gate, role-scoped memory retrieve,
> execution-time tool scoping, reconciliation, and meeting prep all live and verified.

## Post-merge: `feat/platform-upgrades` integration (2026-09-21)

Merge commit `f5b9c6c` brought in TrueForge harness + Cognee memory work that
sits underneath the gap-closure slices above, not a new gap module. Notes so
future audits don't re-derive this:

- **Runtime (`19`):** agent execution moved to `agent-client.ts` →
  `trueforge-client.ts` (pure TrueForge, `atomic-agent-client.ts` deleted, no
  fallback). `mcp-bridge.ts` (renamed from `atomic-bridge`) is now 108 tools
  (`documentation/11-trueforge-agent-harness.md` says 94 — stale, doc owns the
  drift, bridge `TOOLS.length` is authoritative per that doc's own §1).
- **Memory (`20`):** `retrieve.ts` gained Cognee knowledge-graph search
  (`searchCognee`) alongside the existing RAG/persona retrieval;
  `memory-writeback.ts` gained `rememberCognee` alongside the existing
  writeback-policy gate — both merged additively, no behavior removed.
- **Security (`18`):** RLS/session/webhook-crypto hardening (`9d65be4`) landed
  on top of the existing untrusted-content isolation and role-capability
  denial; no conflicts, additive.
- **Integrations (`04`):** connector tool scope verification + folder
  resolution (`d48a859`) landed on top of role-scoped allowlist filtering;
  `tools/slack.ts` merged to use `resolveNangoAuth`/`nangoAuthError` (clearer
  connect-state errors) while keeping `read_channel` / `post_decision_card`
  actions that upstream's branch had dropped.
- **UI:** email draft preview modal, `AgentTrajectory.tsx`, OpenUI fence
  blocks in chat (`d3431f1`) — additive, no gap-file mapping needed.

No gap file's status changes as a result — this was orthogonal runtime
modernization, not a 109-plan product gap.

**Plan specs** live in `docs/new-109-pg-plan/plan/` (`00`–`06`). Each domain
gap maps to the matching plan module (`01`↔`plan/01`, etc.). Core state +
DDL: `plan/05`. Bridges / DoD: `plan/06`.

---

## Slice assignment (alphabetic index `% 8`)

| Slice | Gap files | Primary tickets |
| :---: | :-- | :-- |
| **0** | `00`, `08`, `16`, `README` | `P2-WF-*`, `P3-WF-*`, `P4-WF-*`, `guardedSendActivity` (`16`) |
| **1** | `01`, `09`, `17` | `P4-*` Growth + Decision/Opportunity/Brief UI (`17`) |
| **2** | `02`, `10`, `18` | `P2-EXT-*`, `P2-CARD-*`, `P2-CONF-1`, `P2-STATE-1` + prompt-injection isolation (`18`) |
| **3** | `03`, `11`, `19` | `P3-EVA-*`, `P3-DEDUP-1`, `P3-BRIEF-1`, `P3-BUF-1` + 8-step employee loop (`19`) |
| **4** | `04`, `12`, `20` | `P1-DB-1..4`, `P5-ROI-1`, `P5-ROLE-*`, `P5-RATE-1`, `P5-INT-*` + memory write-back (`20`) |
| **5** | `05`, `13`, `21` | `P1-DAL-*`, obligation/ICP prompts + goldens (`13`), SQL-first idle sweeps (`21`) |
| **6** | `06`, `14`, `22` | Ten dual-bound metrics + shadow rollout (`14`), cold-start backfill (`22`) |
| **7** | `07`, `15`, `23` | `P1-TYPE-1`, `P1-GATE-*`, `P1-LEDGER-1`, `P1-HITL-*`, `P5-DEMO-1` |

Meta files (`00`, `06`–`11`, `README`) are specs, not product surfaces. Close
the tickets they describe; do not rewrite the docs unless a gap requires it.

---

## Inventory

| # | File | Slice | Status | Code areas |
| :-: | :-- | :---: | :-- | :-- |
| 0 | `00_state_of_build.md` | 0 | 🟢 done | State layer (`023`–`029`) and all autonomous employee workflows (`OpenLoopMonitorWorkflow`, `MorningCheckWorkflow`, `StuckWorkDetectorWorkflow`, `GrowthWatcherWorkflow`, `CustomerRecoveryWorkflow`, `SystemReconciliationWorkflow`, `MeetingPrepWorkflow`) fully implemented. |
| 1 | `01_growth_employee_gap.md` | 1 | 🟢 done | `growth/lookalike.ts` + `signals.ts` + `preferences.ts`, `GrowthWatcherWorkflow` (`e311b41`), `OpportunityCard.tsx` + test, ROI `pipeline_influenced` (`guarded-send.ts`). Plan: `plan/01`. |
| 2 | `02_customer_employee_gap.md` | 2 | 🟢 done | `prompts/obligation-extractor.v1.ts`, `agent_open_loops` (`023`), `OpenLoopMonitorWorkflow` (`165d811`), `CustomerRecoveryWorkflow.ts`, `DecisionCard.tsx` + test. Plan: `plan/02`. |
| 3 | `03_operations_employee_gap.md` | 3 | 🟢 done | Done: `expected-vs-actual-engine.ts` (`9640f7d`), `StuckWorkDetectorWorkflow`/`MorningCheckWorkflow` (`stuck-work.ts`/`morning-check.ts`), dedup (`6fb9db2`), 4-tier gate (`dcb29fa`), `decision-ledger.ts`, `SystemReconciliationWorkflow` (`reconciliation.ts`), `MeetingPrepWorkflow` (`meeting-prep.ts`). Plan: `plan/03`. |
| 4 | `04_shared_integrations_gap.md` | 4 | 🟢 done | Role-scoped `resolveOrgToolAllowlist` in `tool-executor.ts` (`8f8fee0`), `tools/linkedin.ts`, Slack HITL (`tools/slack.ts` + `/api/webhooks/slack/interactions`), rate limits on ask-ai/webhook/widget routes. Plan: `plan/04`. |
| 5 | `05_core_platform_and_runtime_gap.md` | 5 | 🟢 done | `023`–`029` all landed. Autonomy gate + `parkPendingAction` + `PATCH /api/decisions` 409-on-expiry is the approval-token path. ROI `024` live. DAL stays folded into `db.ts`/`withOrgClient`, not a separate `lib/state/*` — deviates from the file's original shape but covers the same access pattern. Plan: `plan/05`. **DDL in this file is superseded by `12`.** |
| 6 | `06_master_implementation_roadmap.md` | 6 | 🟢 done | Master implementation roadmap Phases 1–5 completed across codebase. |
| 7 | `07_completion_percentages_and_next_build.md` | 7 | 🟢 done | 100% of blueprint product gaps implemented and verified across all slices. |
| 8 | `08_build_playbook.md` | 0 | 🟢 done | All playbook workflows, periodic crons, 4-tier autonomy gate, and cards implemented in code. |
| 9 | `09_build_playbook_deep.md` | 1 | 🟢 done | Repo-shaped implementations complete (§A conventions, §B gate/types in 15, §C–E workflows in 16, §F role allowlist/evals). |
| 10 | `10_execution_backlog.md` | 2 | 🟢 done | Full ticket queue `P1-*` through `P5-*` implemented, unit-tested, and passing acceptance criteria. |
| 11 | `11_design_decisions_deep.md` | 3 | 🟢 done | Design constraints (escalations, obligations, confidence scoring, idempotency, lease collisions, negative ledgering) enforced across gate, ledger, untrusted wrapper, and workflows. |
| 12 | `12_migrations_ready_to_run.md` | 4 | 🟢 done | `023_employee_state_machines.sql` + `024_business_outcomes.sql` applied, plus `025`–`029` beyond this file's original scope. Not `05 §4`. |
| 13 | `13_prompt_and_eval_spec.md` | 5 | 🟢 done | `2381af8` versioned `obligation-classifier.v1` / `obligation-extractor.v1` + `infra/evals/obligation-goldens.yaml` + keyword pre-filter (skip only). Model never sees autonomy policy. |
| 14 | `14_observability_and_rollout.md` | 6 | 🟢 done | `026` + `org_employee_metrics_daily` / `org_runtime_controls`. Ten dual-bound metrics (`employee-observability.ts`), kill switch + stages 0–3, Health → `/observability`. `PATCH /api/decisions` 409 after `expires_at` (`9e6a0f4`). |
| 15 | `15_gate_and_state_reference.md` | 7 | 🟢 done | 4-tier gate (`dcb29fa`), `packages/shared-types/src/{actions,state-machines}.ts`, `autonomy.ts`, `withOrgClient` extracted (`573f960`). `state-machines.test.js` covers every transition. Wins over `09 §B`. |
| 16 | `16_workflows_corrected.md` | 0 | 🟢 done | On origin: `a291fb6` `guardedSendActivity`; `165d811` org-wide open-loop sweep; `3aac503` deduped sweep exports + escalate fields; `4fa4171` `kickPeriodicSweeps` on org provision. Cards on `work_items.metadata.card`. ROI `churn_prevented`. Wins over `09 §C–E`. |
| 17 | `17_ui_and_interaction_spec.md` | 1 | 🟢 done | `DecisionCard.tsx`, morning brief empty=healthy (`operations/brief.ts` `HEALTHY_BRIEF_LINE`), explain surface (`/api/agent/explain`), four-button reject reasons (`work-items/[id]/decision`, `3872529`). |
| 18 | `18_security_and_governance.md` | 2 | 🟢 done | Done: untrusted-content isolation (`untrusted.ts`, `585e142`), blast-radius caps (`autonomy.ts`), ledger DSR (`9cffb2a`), execution-time credential/role scoping in `tool-executor.ts` (`filterAllowlistForPersona`, `roleCapabilityDenial` with decision ledger logs). Auth/RLS/Nango live. |
| 19 | `19_agent_loop_architecture.md` | 3 | 🟢 done | Eight-step employee loop (`29684a1`). `AutonomousAgentWorkflow` stays the separate interactive path — not reused. Wall clock via `nowIsoActivity` (`b540d88`), no model/IO in WF functions. |
| 20 | `20_memory_and_learning.md` | 4 | 🟢 done | Done: write-back discipline + no self-citation (`memory-writeback.test.js`), `fact_conflicts` (`fact-conflict-route.ts`), entity graph/fact model shadow stage (`3d72653`), role-scoped memory retrieve in `retrieve.ts` (filters by `employeeRole`, persona token budgets, facts-first for ops/growth, and customer entity isolation). |
| 21 | `21_cost_model_and_scaling.md` | 5 | 🟢 done | `37d3b78` `029` ceilings + daily spend. `0401348` `/api/analytics/cost-health` + `/calibration`. Idle SQL-first already on origin (`sweeps/idle.ts`). Org create seeds ceilings. |
| 22 | `22_onboarding_and_cold_start.md` | 6 | 🟢 done | `027` + `org_backfill_jobs` / `org_first_observations`. 30-day backfill never chases (`chased: false`, loops `closed`+`backfilled`). First observation = unanswered threads, no model. |
| 23 | `23_demo_and_acceptance.md` | 7 | 🟢 done | `services/workflows/src/scripts/demo-e2e.ts` + `demo-seed.ts` both on disk and exercised by the pre-push test run. |
| 24 | `README.md` | 0 | 🟢 done | Comprehensive gap inventory index; all 24 modules implemented and verified. |

**Already live (do not rewrite):** RLS + `getScopedClient`, `022`–`029` entity
graph and business-outcome tables, Temporal worker, webhook ingress, MCP ~62
tools, LiteLLM classify/plan, sandbox, ask-ai plan-confirm-execute, core
connectors listed in `00` §2, `work_items` / `idempotency_keys` /
`OwnerBriefingWorkflow` / `StaleChaseWorkflow` (RE) / embed widget, 4-tier
autonomy gate, 8-step employee loop, `agent_open_loops` + `agent_decision_ledger`
+ `employee_autonomy_rules`, `GrowthWatcherWorkflow` / `OpenLoopMonitorWorkflow`
/ `StuckWorkDetectorWorkflow` / `MorningCheckWorkflow` / `CustomerRecoveryWorkflow` /
`SystemReconciliationWorkflow` / `MeetingPrepWorkflow`.

**All product gaps closed across gap files 1–23.** Everything else in the Inventory
either shipped or is a spec/meta scorecard/index file with no code of its own.

---

## Leftover-closer (this agent)

Unclaimed / cross-cutting — implement if still open:

| Ticket | Status | Notes |
| :-- | :-- | :-- |
| Extract `withOrgClient` | 🟢 done+pushed `573f960` | `services/workflows/src/db.ts` is the one helper |
| Untrusted isolation wrapper (`18`) | 🟢 done+pushed `585e142` | `untrusted.ts` fence + obligor/sender + quote grounding |
| SQL-first idle helper (`21`) | 🟢 done+pushed `409ac40` | `sweeps/idle.ts` + `countDueSweepActivity` |
| Dual-bound metric writers (`14`) | 🟢 done+pushed `58632e3` | `employee-metrics.ts` — zero is an alert |
| Cold-start + `P1-DB-5` | 🟢 done+pushed `5353263` | `cold-start.ts` notice→draft→act; seed on org create |
| DSR employee-state delete (`18` §3) | 🟢 done+pushed `9cffb2a` | `EMPLOYEE_STATE_TABLES` + `deleteIfExists` |
| `P3-BOOT-1` / gap 16 sweeps | 🟢 done+pushed `165d811` | kebab WFs + `bootstrapPeriodicSweeps` via `periodic-registry` |
| Employee-loop assess-before-model | 🟢 done | `employee-loop.ts` evaluates `assess` and `frame.resolved()` before model/planner/retrieve |
| Any slice ticket still open after siblings land | 🟢 done | Reconciliation + MeetingPrep + Role-scoped retrieve + Credential scoping closed |

**Do not start Phase 2–5 product WFs until Phase 1 acceptance in `10` §1 passes.**
Phase 1 is split: slice 4 = DDL, slice 5 = DAL, slice 7 = types/gate/HITL.
If those slices stall, leftover-closer finishes them rather than inventing a
parallel schema.
