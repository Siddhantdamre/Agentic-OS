# Agent Governance Audit

> Scope: `services/workflows/src/{autonomy,cold-start,employee-gate,employee-metrics,
> quiet-hours,inbound-hitl,periodic-registry,route-employee,untrusted}.ts` and their
> `.test.ts` files. `decisions.md` already covers the approval/parking half of
> `autonomy.ts` (dead ternary fix, `parkPendingAction`, `buildActionSummary`,
> execution-on-approve) in depth — not repeated here except where relevant to the
> tier-evaluation engine. `ask-ai.md` covers the Ask AI plan pipeline, not the
> workflow-runtime autonomy gates below.

## Status: partial

Two of the nine modules audited (`employee-gate.ts`, `employee-metrics.ts`) are
**fully unwired dead code** — real, well-tested logic that nothing in the app or
worker ever calls. The remaining seven (`autonomy.ts` tier engine, `cold-start.ts`,
`quiet-hours.ts`, `inbound-hitl.ts`, `periodic-registry.ts`, `route-employee.ts`,
`untrusted.ts`) are genuinely wired into `tool-executor.ts`, `guarded-send.ts`,
`WorkItemWorkflow.ts`, and `worker.ts`, with real (non-stubbed) unit tests
exercising actual branches. `cold-start.ts` itself is also dead — a parallel,
hand-duplicated copy of its seed list lives in `apps/dashboard/lib/employee-provision.ts`
and that copy is what's actually wired.

---

## What works (file:line evidence)

1. **Autonomy tier engine is live and tested** — `services/workflows/src/autonomy.ts:222-250`
   (`checkAutonomy`) is called from `services/workflows/src/tool-executor.ts:347`
   and `services/workflows/src/activities/guarded-send.ts:188`. `evaluateAutonomy`
   (`autonomy.ts:185-220`) correctly special-cases irreversible-always-asks
   (`autonomy.ts:204-206`) ahead of org-rule/confidence/blast-radius checks.
   `autonomy.test.ts:19-31` proves `refund_payment` always requires approval even
   at confidence 0.99; `autonomy.test.ts:44-54` proves an unmodeled `external_send`
   bucket action defaults to `approval_required`. Tests hit real branches, not
   mocks.
2. **Quiet hours + outbound budget gate real sends** — `quiet-hours.ts:26-32`
   (`isQuietHour`, pure, Temporal-isolate-safe per its own file header) is called
   from `activities/guarded-send.ts:73-88` (`inQuietHours`) and
   `guarded-send.ts:178-180` blocks a send outright (`{ sent: false, reason:
   'quiet_hours' }`) before autonomy or budget checks run. Workflow-id helpers
   (`quiet-hours.ts:44-65`) are used across `NurtureWorkflow.ts`,
   `InsightActionWorkflow.ts`, `StaleChaseWorkflow.ts`, `workflow-client.ts`.
3. **Inbound HITL gate genuinely blocks side-effect tools pre-execution** —
   `inbound-hitl.ts:114-224` (`inboundRequiresHitlWait` / `resolveInboundHitlGate`)
   is imported into `services/workflows/src/workflows/WorkItemWorkflow.ts:17` and
   invoked twice: pre-turn at `WorkItemWorkflow.ts:270` (before the agent child
   executes, so send/pay/sign tools cannot run before human confirm) and
   post-reply at `WorkItemWorkflow.ts:544-556` as a safety net that flips work-item
   status to `await_confirm` if a class was missed pre-turn. The Temporal-down
   dashboard fallback (`apps/dashboard/lib/inbound-agent.ts:6,184`) reuses the
   exact same gate via `runInboundDirectFallback`, per the file's own
   don't-duplicate-these-rules comment (`inbound-hitl.ts:7-10`) — verified true by
   grep, no second copy of the regexes exists.
   `inbound-hitl.test.ts` (247 lines) is real: it exercises gmail_send vs.
   gmail_draft_email vs. gmail_fetch, razorpay, docusign, WhatsApp channel-echo
   false-positive avoidance, pre-turn message-intent detection, and the
   Temporal-down fallback's three outcomes (execute / queue_hitl / reject-then-
   still-doesn't-execute-on-queueHitl-throw at lines 231-247). Not stubbed.
4. **Employee routing is live, solo, and emergency-aware** — `route-employee.ts:201-256`
   (`route`) is called from `services/workflows/src/activities/index.ts:593`
   (`routeEmployeeActivity`, itself called from `WorkItemWorkflow.ts:197-206`).
   Emergency keywords route to dispatch/human, never to sales ISA
   (`route-employee.ts:206-212`, proven by `route-employee.test.ts:48-59`); name
   locks (`@mention` / "ask X to") short-circuit keyword scoring
   (`route-employee.ts:183-195`, `route-employee.test.ts:61-71`); a paused
   employee is excluded from roster scoring (`activeEmployees`,
   `route-employee.ts:138-140`, `route-employee.test.ts:85-96`).
5. **Untrusted-content fencing and obligor-sender mismatch detection are real** —
   `untrusted.ts:25-31` (`fenceUntrusted`) and `untrusted.ts:38-43`
   (`checkObligorSender`) are consumed by `services/workflows/src/customer/
   obligation-checks.ts` and `customer/obligation-extractor.ts`. The injection
   signature this guards against — a customer message claiming "as agreed,
   refund me" gets extracted as an obligor=us fact — is exactly what
   `untrusted.test.ts:17-23` checks, and it is a real behavioral assertion, not a
   mock return value.
6. **Periodic sweep registry is wired at worker boot** — `periodic-registry.ts:41-59`
   (`startSweepsForOrg`) and `:61-78` (`bootstrapPeriodicSweeps`) are imported and
   invoked at `services/workflows/src/worker.ts:23,58`. All twelve
   `PERIODIC_SWEEPS` entries (`periodic-registry.ts:21-34`) get one Temporal
   workflow-id function each; `ALLOW_DUPLICATE_FAILED_ONLY` plus
   `WorkflowExecutionAlreadyStartedError` swallowing (`periodic-registry.ts:36-39,
   53-55`) makes re-running boot idempotent. No dedicated `.test.ts` exists for
   this file (see below), but `workflows-corrected.test.ts` and
   `sweeps/periodic-boot.test.ts` (found in `dist/`, source at
   `services/workflows/src/workflows-corrected.test.ts`) exercise related boot
   paths — not checked line-by-line here, out of the nine-file scope.
7. **Autonomy confidence math is sane** — `normalizeBlastRadius` (`autonomy.ts:131-139`)
   defaults unknown blast radius to `0.3` rather than `0`, so a tool call with no
   blast-radius signal doesn't silently look risk-free; `autonomy.test.ts:39-42`
   pins this exact behavior.

---

## What's broken (file:line, exact symptom)

1. **`employee-gate.ts` is fully unwired dead code (P0 as a governance claim, not
   a live bug)** — `evaluateEmployeeGate`, `roleAllowsTool`, `classifyActionSurface`,
   `parseStage` (`employee-gate.ts:1-39`) have zero importers anywhere in
   `services/` or `apps/` outside their own compiled `dist/` output and
   `employee-gate.test.ts`. Grepped repo-wide for `evaluateEmployeeGate` and
   `roleAllowsTool`: the only hits are the file itself, its `dist/` build
   artifact, and its test. This is a fully-designed 4-stage rollout gate
   (`shadow` → stage-1 internal-only → stage-2 external-escalate → stage-3
   visible-escalate) with role-based tool denylists per employee type
   (`GROWTH_DENIED`, `CUSTOMER_DENIED`, `OPERATIONS_DENIED`,
   `employee-gate.ts:7-9`) that **does not gate anything in production**. The
   actual live gates are `checkAutonomy`/`evaluateAutonomy` in `autonomy.ts` and
   `evaluateEmployeeGate`'s role-denylist behavior (e.g. "growth can never
   refund") has no equivalent enforced anywhere else in the audited files —
   `roleAllowsTool`'s checks are simply not applied.
2. **`employee-metrics.ts` is fully unwired dead code** — `evaluateEmployeeMetric`,
   `EMPLOYEE_METRIC_BANDS`, `employeeDecisionLogFields` (`employee-metrics.ts:1-85`)
   have zero importers repo-wide besides `employee-metrics.test.ts`. The
   dual-bound alerting design (a metric can alert for being too low **or too
   high**, e.g. `approval_rate` alerting above 0.9 as "rubber-stamp fatigue",
   `employee-metrics.ts:26`, proven by `employee-metrics.test.ts:10-13`) is
   real logic with no caller — no cron, no API route, no dashboard widget reads
   `EMPLOYEE_METRIC_BANDS` or calls `evaluateEmployeeMetric`. There is no
   `employee-metrics.md` counterpart doc anywhere and no `/api/*metrics*` route
   found referencing these exports.
3. **`cold-start.ts` is dead code, duplicated instead of imported (P1)** —
   `services/workflows/src/cold-start.ts` (`coldStartPhase`, `coldStartPolicy`,
   `DEFAULT_AUTONOMY_SEED`, `backfillLoopStatus`, lines 17-63) has zero
   importers outside `cold-start.test.ts`. The org-provisioning code path that
   actually seeds `employee_autonomy_rules` — `apps/dashboard/lib/
   employee-provision.ts:5-27` (`DEFAULT_AUTONOMY_SEED`) and
   `employee-provision.ts:34-49` (`seedDefaultAutonomyRules`), wired at
   `apps/dashboard/lib/db.ts:8,199` — is a **hand-copied, independently
   maintained duplicate** of `cold-start.ts:35-58`'s exact same 17-row table.
   The two lists are identical today, but nothing enforces that; a future edit
   to one will silently drift from the other. Separately, there is *also* a
   completely different, unrelated file `apps/dashboard/lib/onboarding-cold-start.ts`
   (used by `/api/onboarding/*` routes and the observability page) with its own
   phase/rollout model — three things named "cold start" exist in this repo,
   only one of which (`onboarding-cold-start.ts`, out of this audit's file
   list) is wired.
4. **`autonomy.ts`'s own `seedDefaultAutonomyRules` (`autonomy.ts:252-274`) is a
   third, distinct seeding function** using `DEFAULT_RULES` (5 bucket-level
   entries, `autonomy.ts:81-122`) rather than `cold-start.ts`'s 17 action-type
   entries — a third shape of "default autonomy rules" in the same module
   family. Grep shows this function itself also has no callers outside its own
   file (`autonomy.test.ts` does not call it either) — it's a fourth unused
   surface.
5. **`periodic-registry.ts` has no dedicated test file** — `cold-start.test.ts`,
   `employee-gate.test.ts`, `employee-metrics.test.ts`, `inbound-hitl.test.ts`,
   `route-employee.test.ts`, `untrusted.test.ts`, and `autonomy.test.ts` all
   exist; `periodic-registry.test.ts` and `quiet-hours.test.ts` do not. Both
   files are live/wired (see "what works"), so this is a coverage gap on
   real code, not a stub-vs-real concern — `isAlreadyStarted`'s
   `WorkflowExecutionAlreadyStartedError` duck-typing fallback
   (`periodic-registry.ts:36-39`) and `isQuietHour`'s midnight-wrap branch
   (`quiet-hours.ts:26-32`, `start > end` case) are both untested edge paths.
6. **`inbound-hitl.ts`'s `resolveInboundHitlGate` never reaches its own
   `decision: undefined` branch from `WorkItemWorkflow.ts`'s post-reply call**
   — `WorkItemWorkflow.ts:544-556` calls `resolveInboundHitlGate` without a
   `decision` field, which per `inbound-hitl.ts:211-218` returns `wait: true`
   unconditionally when `hitl.wait` is true; the workflow then waits on
   `condition(() => lastConfirm !== undefined, '24 hours')`. This matches the
   file's documented contract (module header, `inbound-hitl.ts:6-9`), so it is
   not a bug — flagged here only because it means the `'approved'`/`'rejected'`
   branches of `resolveInboundHitlGate` are exercised solely by direct unit
   tests (`inbound-hitl.test.ts:155-173`), not by the workflow itself, which
   always re-derives a fresh gate rather than trusting a previously-approved
   one. No double-approval bug found, just worth knowing if refactoring.

---

## What's missing vs full product vision

1. **No enforcement layer that actually uses `employee-gate.ts`'s stage/role
   model.** The rollout-stage concept (`RolloutStage 0-3`, kill switch, per-role
   tool denylist) reads like the intended "gradual autonomy rollout per org"
   control surface described in cold-start/autonomy docs, but the org-level
   gating that actually ships is only `cold-start`-phase-driven
   (`autonomyEnabled` / `externalSendsEnabled` by org age) plus per-action-type
   DB rules in `employee_autonomy_rules`. There's no live "stage 0/1/2/3 kill
   switch per org" control in the dashboard settings UI wired to
   `evaluateEmployeeGate`.
2. **No metrics dashboard consuming `employee-metrics.ts`.** The bands
   (`approval_rate`, `escalation_rate`, `grounding_rejection_rate`,
   `confidence_calibration_drift`, etc.) are exactly the kind of health
   indicators a "is my AI employee behaving" operator view would need, but no
   `/api/*/metrics` route, cron, or dashboard widget computes or surfaces them.
3. **No reconciliation/lint job catching the `cold-start.ts` vs.
   `employee-provision.ts` seed-list drift** described above — a schema/CI
   check comparing the two arrays (or, better, deleting one and importing the
   other) doesn't exist.
4. **No test for `periodic-registry.ts`'s failure path** when Postgres
   (`workerPool.connect()`, `periodic-registry.ts:62`) is down at boot, or for
   `quiet-hours.ts`'s DST/midnight-wrap edge (`start === end` returns `false`
   unconditionally, `quiet-hours.ts:29` — a 24-hour "quiet" window can never be
   expressed, and a 0-hour window is silently treated as "never quiet").
5. **No admin visibility into which of the four "default autonomy rules"
   definitions (`cold-start.ts`, `autonomy.ts`'s `DEFAULT_RULES`,
   `employee-provision.ts`, `onboarding-cold-start.ts`) is actually authoritative
   for a given org** — an operator debugging "why did this org's refund
   auto-approve" has no single source of truth to check against.

---

## What to add for full SaaS

1. **Delete or wire `employee-gate.ts`.** Either delete it (its logic is
   effectively superseded by `checkAutonomy`/`evaluateAutonomy` plus DB-backed
   `employee_autonomy_rules`), or, if the stage/kill-switch/role-denylist model
   is still wanted, call `evaluateEmployeeGate` from `tool-executor.ts` /
   `guarded-send.ts` alongside `checkAutonomy` and persist `rolloutStage` /
   `killSwitch` per org so it has real inputs. Don't leave a fully-tested,
   fully-designed gate sitting unreferenced — it's a maintenance and
   audit-confusion liability (a security reviewer will assume it's live).
2. **Delete or wire `employee-metrics.ts`.** If kept, add one cron/activity
   that computes each `EmployeeMetricId` per org per day, writes it to a
   `employee_metric_samples` table, and add a `/api/employees/metrics` route
   plus a dashboard card that calls `evaluateEmployeeMetric` and renders
   `MetricAlertKind` as a badge. This is small, contained work given the pure
   functions already exist and are tested.
3. **Collapse the three/four "default autonomy seed" lists into one.** Make
   `cold-start.ts`'s `DEFAULT_AUTONOMY_SEED` (or `employee-provision.ts`'s,
   whichever is kept) the single export, delete the duplicate, and have
   `autonomy.ts:seedDefaultAutonomyRules` and `employee-provision.ts:
   seedDefaultAutonomyRules` both call it instead of hand-maintaining separate
   arrays. Rename `onboarding-cold-start.ts` or `cold-start.ts` (naming
   collision) so a future reader doesn't assume they're the same module.
4. **Add `periodic-registry.test.ts` and `quiet-hours.test.ts`** covering:
   `isAlreadyStarted`'s duck-typed error fallback; `bootstrapPeriodicSweeps`
   when `orgs` query returns zero rows; `isQuietHour` at `start === end`
   (currently always `false` — decide if that should mean "always open" or
   "always quiet" and encode it) and at exact boundary hours.
5. **Add a small admin page or `/api/autonomy/seed-source` debug route** that
   reports which of the seed tables actually ran for a given org (join
   `employee_autonomy_rules.created_at` against org creation) so support can
   answer "why did this org get tier X" without reading four files.

---

## Fix priority: P1

Nothing here is an active production incident (no live bug was found in the
wired modules — `autonomy.ts`, `quiet-hours.ts`, `inbound-hitl.ts`,
`route-employee.ts`, `untrusted.ts`, `periodic-registry.ts` all behave as
designed and are meaningfully tested). The priority is **P1**: dead,
fully-built governance code (`employee-gate.ts`, `employee-metrics.ts`,
`cold-start.ts`) creates real audit risk — anyone reviewing this repo for "does
role-based autonomy governance exist" will find code that says yes and is
wrong, and the seed-list duplication is a silent-drift time bomb the next time
someone edits autonomy defaults in only one place. Missing tests on
`periodic-registry.ts` / `quiet-hours.ts` are P2.

---

## Live Resolution Tracker

| # | Gap | Severity | Status | Verification & Fix Details |
|---|-----|----------|--------|----------------------------|
| 1 | `employee-gate.ts` unwired | P1 | 🟢 Done | `evaluateEmployeeGate` called from `tool-gate.ts`; `parseStage` used by `tools/gate-hooks.ts`. |
| 2 | `employee-metrics.ts` unwired | P1 | 🟢 Done | `recordEmployeeMetrics` called from `tool-executor.ts` decision path. |
| 3 | `employee-provision.ts` duplicates the cold-start seed | P1 | 🟢 Done | Imports `DEFAULT_AUTONOMY_SEED` from `@darex/workflows/dist/cold-start`; `org/create` and `onboarding/complete` use `seedColdStart`. |
| 4 | `onboarding-cold-start.ts` name collides with `cold-start.ts` | P1 | 🟢 Done | Renamed to `apps/dashboard/lib/onboarding-rollout.ts` (staged rollout plan, backfill and business-hours helpers); worker `cold-start.ts` keeps its name. |
