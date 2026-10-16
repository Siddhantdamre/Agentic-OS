# 10 — Execution Backlog: Every Ticket to Ship the AI Employees

> **What this is.** `06` gives phases, `07` gives percentages, `08` gives the build
> guide, `09` gives the exact repo-shaped code. This file is the **work queue**:
> one row per shippable ticket, with dependencies, files touched, and a written
> acceptance test. Nothing here is new scope — it is `08`/`09` decomposed into
> units small enough to finish, review, and commit on their own.
>
> **How to use it.** Take the topmost ticket whose dependencies are all `DONE`.
> Do only that ticket. Its acceptance check must pass before you mark it done and
> commit. One ticket ≈ one commit, per `CLAUDE.md §2`.
>
> **Ticket ID format:** `P<phase>-<area>-<n>`.
> **Size:** S ≈ half a day, M ≈ 1–2 days, L ≈ 3–5 days.

---

## 0. The Spine (read once, then never re-derive)

Everything in this backlog exists to move the product across one line:

```text
  TODAY                                      TARGET
  ─────                                      ──────
  user prompts  ──►  AI drafts plan          clock/event fires  ──►  employee
       │                   │                        │                  notices
       ▼                   ▼                        ▼                    │
  user approves  ──►  tool executes          state machine says   ◄──────┘
                                             "this is off-track"
                                                    │
                                             autonomy gate decides
                                              ┌─────┴─────┐
                                          execute     escalate a
                                          silently    DECISION (not a chat)
                                                    │
                                             every branch, both ways,
                                             written to the decision ledger
```

Four mechanisms carry that whole transition. Every ticket below implements,
wires, or tests exactly one of them:

| # | Mechanism | Without it | Tickets |
| :-: | :-- | :-- | :-- |
| 1 | **Persistent state machines** — enquiries, open loops, expectations, tasks | The employee has no memory of what is unfinished, so it cannot own anything | `P1-DB-*`, `P1-TYPE-*`, `P1-DAL-*` |
| 2 | **Durable timers** — Temporal workflows that wake with no human present | Nothing is proactive; everything waits on a prompt | `P2-WF-*`, `P3-WF-*`, `P4-WF-*` |
| 3 | **Autonomy gate** — per-action tier policy, escalate only real decisions | Either it asks about everything (useless) or asks about nothing (unsafe) | `P1-GATE-*`, `P2-CARD-*`, `P5-ROLE-*` |
| 4 | **Decision ledger** — log the negatives too | Cannot answer "why didn't you do that?", so nobody trusts it | `P1-LEDGER-*`, `P3-EXPLAIN-*` |

If a proposed ticket does not serve one of those four, it is out of scope for
this plan. Say so and move on.

---

## 1. Phase 1 — State Layer + Autonomy Engine

**Exit condition for the whole phase:** a tool call routed through
`executeAutonomousToolAction()` is either executed or parked as a pending action
purely on policy, an illegal state transition is impossible to write, and both
outcomes appear in the decision ledger.

| ID | Ticket | Size | Depends on | Files |
| :-- | :-- | :-: | :-- | :-- |
| `P1-DB-1` | Migration `023_employee_state_machines.sql` — the six state tables | M | — | `infra/db/migrations/023_employee_state_machines.sql` |
| `P1-DB-2` | RLS + `FORCE ROW LEVEL SECURITY` + `darex_app` grants on all six | S | `P1-DB-1` | same file |
| `P1-DB-3` | Poll indexes (the four in `08 §1.1`) | S | `P1-DB-1` | same file |
| `P1-DB-4` | `agent_pending_actions` table + `token_hash` unique index | S | `P1-DB-1` | same file |
| `P1-DB-5` | Seed default `employee_autonomy_rules` on org provisioning | M | `P1-DB-1` | org-provisioning path + seed helper |
| `P1-TYPE-1` | State enums + transition maps + `assertTransition()` | M | — | `packages/shared-types/src/state-machines.ts` |
| `P1-DAL-1` | `enquiries.ts` — create / transition / listOverdue | M | `P1-DB-1`, `P1-TYPE-1` | `apps/dashboard/lib/state/enquiries.ts` |
| `P1-DAL-2` | `open-loops.ts` — open / transition / dueLoops | M | `P1-DB-1`, `P1-TYPE-1` | `apps/dashboard/lib/state/open-loops.ts` |
| `P1-DAL-3` | `expectations.ts` — record / settle / openDiscrepancies | M | `P1-DB-1`, `P1-TYPE-1` | `apps/dashboard/lib/state/expectations.ts` |
| `P1-LEDGER-1` | `decision-ledger.ts` — `logDecision()` + `explain()` | M | `P1-DB-1` | `apps/dashboard/lib/state/decision-ledger.ts` |
| `P1-GATE-1` | `checkAutonomy(orgId, role, actionType)` | M | `P1-DB-5`, `P1-TYPE-1` | `services/workflows/src/autonomy.ts` |
| `P1-GATE-2` | Map tool name → `actionType` via `AUTONOMOUS_TOOL_CATALOG` | S | `P1-GATE-1` | `services/workflows/src/autonomy.ts` |
| `P1-GATE-3` | Wire gate into `executeAutonomousToolAction()`; park + sentinel | M | `P1-GATE-2`, `P1-DB-4` | `services/workflows/src/tool-executor.ts` |
| `P1-GATE-4` | `logDecision()` on **both** branches of the gate | S | `P1-GATE-3`, `P1-LEDGER-1` | `tool-executor.ts` |
| `P1-HITL-1` | Approval token: 32 random bytes, store SHA-256 only | S | `P1-DB-4` | approvals lib |
| `P1-HITL-2` | Pause/resume in workflow via `resolveApproval` signal + 7-day `condition` | M | `P1-HITL-1` | `services/workflows/src/workflows/*` |
| `P1-HITL-3` | `POST /api/agent/approvals/[id]` — verify hash + org + role, then signal | M | `P1-HITL-2` | `apps/dashboard/app/api/agent/approvals/[id]/route.ts` |
| `P1-TEST-1` | `autonomy.test.ts` — the four assertions | S | `P1-GATE-4` | `services/workflows/src/autonomy.test.ts` |

### Acceptance checks

- `P1-DB-2` — connect as `darex_app` with `app.current_org_id` set to org A;
  `SELECT` on each table returns zero rows written under org B. Attempt an
  `INSERT` with a mismatched `org_id`: rejected by the `WITH CHECK` clause.
- `P1-TYPE-1` — `assertTransition('resolved', 'new')` throws; every state in
  each enum is reachable from the initial state (walk the map in the test).
- `P1-GATE-3` — a `read_*` tool executes with no pending row; `refund_payment`
  creates exactly one `agent_pending_actions` row and returns the sentinel
  without touching the connector.
- `P1-HITL-3` — approving with the raw token resumes the workflow; approving
  with a wrong token, a different org, or an insufficient role returns 403 and
  leaves the workflow parked. Replaying a consumed token fails.
- `P1-TEST-1` — green in CI.

**Do not start Phase 2 until every Phase-1 acceptance check passes.** Phases 2–4
each assume the state tables, the gate, and the ledger already work; building
them on a half-wired Phase 1 produces bugs that read as workflow bugs.

---

## 2. Phase 2 — Customer Employee (Open Loops, Decision Cards, Recovery)

**Exit condition:** a customer message containing a promise creates an open loop
with a due time; when that time passes with the promise unmet, the employee acts
on its own, and only a genuine judgment call reaches a human — as a decision
card with options, not as a forwarded chat.

| ID | Ticket | Size | Depends on | Files |
| :-- | :-- | :-: | :-- | :-- |
| `P2-EXT-1` | Obligation extractor — pull promises/commitments out of inbound messages | L | `P1-DAL-2` | extractor + hook point in `09 §C.1` |
| `P2-EXT-2` | Due-time inference (explicit date, relative phrase, org default) | M | `P2-EXT-1` | extractor |
| `P2-EXT-3` | Idempotency — same message reprocessed creates no second loop | S | `P2-EXT-1` | extractor |
| `P2-WF-1` | `OpenLoopMonitorWorkflow` — periodic, `continueAsNew`, singleton per org | M | `P1-DAL-2` | `services/workflows/src/workflows/open-loop-monitor.ts` |
| `P2-WF-2` | Due-loop sweep activity + per-loop action dispatch | M | `P2-WF-1` | activities |
| `P2-CARD-1` | Decision card on `work_items` (**no new table** — see `09 §C.3`) | M | `P1-GATE-3` | `work_items` writer |
| `P2-CARD-2` | Card payload: situation, options, recommendation, cost of each | M | `P2-CARD-1` | same |
| `P2-CARD-3` | Card UI + one-tap resolve wired to the approval route | M | `P2-CARD-2`, `P1-HITL-3` | dashboard UI |
| `P2-CONF-1` | Confidence gate — below threshold never auto-sends externally | S | `P1-GATE-1` | `09 §C.5` |
| `P2-WF-3` | `CustomerRecoveryWorkflow` — trigger, backoff, give-up condition | M | `P2-WF-1` | `services/workflows/src/workflows/customer-recovery.ts` |
| `P2-STATE-1` | Persistent per-customer state (history survives across sessions) | M | `P1-DB-1` | state DAL |
| `P2-TEST-1` | Time-skipping Temporal test: loop opens, fires, escalates | M | `P2-WF-2` | workflow test |

### Acceptance checks

- `P2-EXT-1/3` — feed the same inbound message twice: exactly one open loop.
  Feed a message with no commitment: zero loops.
- `P2-WF-1` — with the Temporal time-skipping test environment, advance past
  `target_check_at`: the loop transitions and an action is dispatched with no
  human input and no prompt.
- `P2-CARD-2` — every escalated card renders at least two options and a named
  recommendation. A card with one option is a bug: if there is only one option,
  the employee should have executed it.
- `P2-CONF-1` — force confidence below threshold: nothing leaves the system
  externally, and a ledger row records the suppression with its reason.
- `P2-TEST-1` — green in CI.

---

## 3. Phase 3 — Operations Employee (Expected vs Actual, Stuck Work)

**Exit condition:** the system holds an explicit expectation for operational
work, notices on a schedule when reality has diverged, and surfaces only the
divergences — and it can explain in plain language why it did *not* act.

| ID | Ticket | Size | Depends on | Files |
| :-- | :-- | :-: | :-- | :-- |
| `P3-WF-1` | `MorningCheckWorkflow` — daily `continueAsNew`, per `09 §D.1` | M | `P1-DAL-3` | `services/workflows/src/workflows/morning-check.ts` |
| `P3-BOOT-1` | Bootstrap periodic workflows at worker boot (singleton IDs, `09 §A.4–A.5`) | M | `P2-WF-1`, `P3-WF-1` | worker entrypoint |
| `P3-DEDUP-1` | Fuzzy dedup via `pg_trgm` (extension + similarity threshold) | M | `P1-DB-1` | migration + activity |
| `P3-EVA-1` | Expected-vs-Actual comparator → sets `is_discrepancy` | M | `P1-DAL-3` | activity |
| `P3-EVA-2` | Discrepancy → work item, with the deviation stated numerically | M | `P3-EVA-1`, `P2-CARD-1` | activity |
| `P3-WF-2` | `StuckWorkDetectorWorkflow` (skeleton from `09 §A.3`) | M | `P3-EVA-1` | `services/workflows/src/workflows/stuck-work.ts` |
| `P3-BRIEF-1` | Triage brief — filter to exceptions only, never a full dump | M | `P3-EVA-2` | brief builder |
| `P3-EXPLAIN-1` | `GET /api/agent/explain` — answer "why didn't you?" from the ledger | M | `P1-LEDGER-1` | `apps/dashboard/app/api/agent/explain/route.ts` |
| `P3-BUF-1` | Outage buffering — queue during connector downtime, replay on recovery | M | `P1-GATE-3` | connector layer |
| `P3-TEST-1` | Expectation settled on time → no discrepancy; missed → exactly one | S | `P3-EVA-1` | test |

### Acceptance checks

- `P3-BOOT-1` — restart the worker twice: still exactly one running instance of
  each periodic workflow (singleton IDs hold; no duplicate schedules).
- `P3-DEDUP-1` — two near-identical records ("Acme Corp." / "Acme Corp") merge
  into one candidate; two genuinely different ones do not.
- `P3-EVA-2` — a discrepancy work item names the expected value, the actual
  value, and the gap. A work item that only says "something is wrong" is a bug.
- `P3-BRIEF-1` — on a day with no exceptions, the brief says so in one line
  rather than listing everything that went fine.
- `P3-EXPLAIN-1` — ask about an action the employee declined: the response cites
  the ledger row, the rule that blocked it, and the confidence at the time.
- `P3-BUF-1` — kill a connector mid-run: actions queue, nothing is lost, and on
  recovery they replay exactly once.

---

## 4. Phase 4 — Growth Employee (Lookalikes, Signals, Opportunity Cards)

**Exit condition:** the employee proposes opportunities nobody asked it for, and
it stops proposing the kinds the owner has repeatedly rejected.

| ID | Ticket | Size | Depends on | Files |
| :-- | :-- | :-: | :-- | :-- |
| `P4-WF-1` | `GrowthWatcherWorkflow` — `continueAsNew` every 4h (`09 §E.1`) | M | `P3-BOOT-1` | `services/workflows/src/workflows/growth-watcher.ts` |
| `P4-ICP-1` | `loadOrBuildIcpActivity` — derive the ICP from won deals | L | `P1-DB-1` | activity |
| `P4-RANK-1` | `rankCandidatesActivity` — the scoring function (`09 §E.3`) | M | `P4-ICP-1` | activity |
| `P4-SIG-1` | Signal watcher — detect the trigger events worth acting on | L | `P4-WF-1` | activity |
| `P4-VIS-1` | Website visitor intent (widget upgrade) | M | — | widget + ingest |
| `P4-CARD-1` | Opportunity card on `work_items` (same pattern as `P2-CARD-1`) | S | `P2-CARD-1` | writer |
| `P4-PREF-1` | Negative preference synthesizer — learn from rejections (`09 §E.5`) | M | `P1-LEDGER-1`, `P4-CARD-1` | synthesizer |
| `P4-CHASE-1` | Generalize `StaleChaseWorkflow` to dormant-lead revival | M | `P4-WF-1` | existing workflow |
| `P4-TEST-1` | Rejecting a card class twice suppresses the third | S | `P4-PREF-1` | test |

### Acceptance checks

- `P4-RANK-1` — a known-won historical account ranks above a known-lost one on
  the same scoring pass. If it does not, the ICP features are wrong, not the
  weights.
- `P4-CARD-1` — every opportunity card states why *now* (the signal), not just
  why this account. A card with no timing rationale is noise.
- `P4-PREF-1` / `P4-TEST-1` — reject two cards of the same class; the third of
  that class is suppressed and the suppression is in the ledger with its reason.
- `P4-VIS-1` — a visitor session maps to an account with the confidence score
  recorded; below threshold it is stored but never surfaced as a card.

---

## 5. Phase 5 — Connect Scoping, ROI Ledger, Demo Hardening

**Exit condition:** one connection serves every employee at its own scope, the
business can see what the employees were worth, and the whole loop runs
end-to-end unattended.

| ID | Ticket | Size | Depends on | Files |
| :-- | :-- | :-: | :-- | :-- |
| `P5-ROLE-1` | `resolveOrgToolAllowlist(orgId, employeeRole?)` (`09 §F.1`) | M | `P1-GATE-1` | tool resolution |
| `P5-ROLE-2` | Per-role scoping enforced at execution, not just at display | M | `P5-ROLE-1` | `tool-executor.ts` |
| `P5-RATE-1` | Per-org, per-connector rate limiter | M | `P5-ROLE-2` | connector layer |
| `P5-ROI-1` | Migration `024_business_outcomes.sql` (`09 §F.2`) | M | `P1-DB-1` | `infra/db/migrations/024_business_outcomes.sql` |
| `P5-ROI-2` | Attribute outcomes to the employee action that caused them | M | `P5-ROI-1`, `P1-LEDGER-1` | attribution |
| `P5-ROI-3` | ROI view in the dashboard | M | `P5-ROI-2` | dashboard |
| `P5-INT-1` | Interactive Slack actions (approve from the message) | M | `P1-HITL-3` | Slack connector |
| `P5-INT-2` | Outlook / MS365 + Teams connectors | L | `P5-ROLE-1` | connectors |
| `P5-DEMO-1` | `demo-e2e.ts` acceptance script (`09 §F.3`) | M | all phases | `services/workflows/scripts/demo-e2e.ts` |

### Acceptance checks

- `P5-ROLE-2` — call a tool outside a role's allowlist directly, bypassing the
  UI: refused at execution, with a ledger row. Scoping that only hides buttons
  is not scoping.
- `P5-RATE-1` — burst past the limit: requests are shed or queued, and no
  connector returns a provider-side 429 to the user.
- `P5-ROI-2` — each outcome row traces back to a specific ledger decision. An
  unattributable outcome is excluded from the total rather than guessed at.
- `P5-DEMO-1` — the script runs the full loop with no human input except the
  approvals that are supposed to require one, and exits non-zero on any failure.

---

## 6. The Definition of Done (applies to every ticket)

A ticket is done only when all seven hold:

1. **Multi-tenant.** Every query goes through `getScopedClient(orgId)`. No raw
   pool access, no `org_id` passed as a filter the caller could forget.
2. **Idempotent.** Running the activity twice with the same input produces the
   same single effect. Temporal *will* retry; this is not optional.
3. **Ledgered.** Every decision the employee makes — including every decision
   *not* to act — writes a ledger row with its reason and confidence.
4. **Gated.** Anything with an external side effect passes through
   `checkAutonomy()`. No connector call bypasses the gate.
5. **Checked.** The ticket's acceptance check above passes, and any non-trivial
   branch leaves one runnable test behind.
6. **Documented.** `BUILD_STATE.md` updated in the same commit with what changed,
   why, and what was verified (`CLAUDE.md §5`).
7. **Committed alone.** One concern per commit, paths staged explicitly.

---

## 7. Sequencing Rules

- **Phase 1 is a hard gate.** Nothing in Phases 2–5 is safe to build on a
  partially-wired state layer. Finish it.
- **Phases 2, 3, 4 are independent of each other** once Phase 1 lands. If more
  than one person is building, split by phase here — not by layer, which
  produces merge conflicts in the same three files.
- **`P3-BOOT-1` is the shared bottleneck.** Both Phase 2 and Phase 4 workflows
  need bootstrapping. Build it once, during Phase 3, and register later
  workflows into the same boot path.
- **Phase 5 last**, because `P5-DEMO-1` is the acceptance test for the whole
  plan and cannot pass before the rest exists.

---

## 8. Where Each Ticket's Detail Lives

| Need | Read |
| :-- | :-- |
| Why a thing is required at all | `plan/` (the blueprint, by tab) |
| What exists today vs. what does not | `00_state_of_build.md`, `01`–`05` |
| Percentages and priority ordering | `07_completion_percentages_and_next_build.md` |
| Phase shape and milestones | `06_master_implementation_roadmap.md` |
| How to build it | `08_build_playbook.md` |
| Exact repo-shaped code for it | `09_build_playbook_deep.md` |
| Which ticket to pick up now | **this file** |
