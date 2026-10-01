# Plans Tab Audit

> Scope: `apps/dashboard/app/(dashboard)/plans/page.tsx` (the "Plans" inbox tab),
> `apps/dashboard/app/api/ask-ai/plan/route.ts`, `apps/dashboard/app/api/ask-ai/
> execute/route.ts` (GET SSE only — the POST/plan-generation side and
> Temporal-durable-execute internals are already covered in `ask-ai.md`, not
> repeated here), `apps/dashboard/components/chat/PlanCard.tsx` +
> `__tests__/PlanCard.test.tsx`, and `infra/db/migrations/007_agent_plans.sql`.
> `ask-ai.md` already covers: plan generation (`plan-generator.ts`), the FSM on
> `agent_plans`, Temporal durable-execute dispatch, disconnect-safe execution,
> RLS-scoped cancellation polling, and per-user plan-lookup scoping. This file
> focuses on the **`/plans` page specifically** — the standalone inbox that
> reuses the same `agent_plans` table and `PlanCard` component but is a
> different entry point than the Ask AI chat thread, and has gaps the chat
> integration does not.

## Status: partial

**Tracker:** 🟢 "Edit params" now wired on `/plans` (`handleUpdateStepPayload`; step toggles also keep payloads). 🟢 History: `GET /api/ask-ai/plan?history=1` (last 50, all statuses) plus a History toggle on `/plans`.

The `/plans` page is a real, working inbox: it lists an authenticated user's
own pending/approved/running plans, renders them with the same `PlanCard` used
in the Ask AI chat, drives the same approve → SSE-execute → status flow, and
handles the SSE event stream correctly. But it is wired to a **narrower slice**
of `PlanCard`'s capability than the Ask AI chat page is — the parameter-edit
feature (`onUpdateStepPayload`) that `decisions.md`/`ask-ai.md` mark "done" is
only wired on the chat page, not here — and once a plan leaves the
pending/approved/running window it disappears from this page permanently, with
no history view.

---

## What works (file:line evidence)

1. **Page loads the user's own in-flight plans only** —
   `apps/dashboard/app/(dashboard)/plans/page.tsx:84-100` (`loadPlans`) calls
   `GET /api/ask-ai/plan` with no `planId`, which
   `apps/dashboard/app/api/ask-ai/plan/route.ts:24-36` scopes by
   `WHERE org_id = $1 AND user_id = $2 AND status IN ('pending','approved','running')`
   — this is the fix `ask-ai.md` item 4 already verified; the `/plans` page is
   one of its two real consumers (the other being the Ask AI chat's plan
   restore-on-refresh).
2. **Approve flow correctly branches on already-approved plans** —
   `plans/page.tsx:175-197` (`handleApprove`) only PATCHes `action: 'approve'`
   when `plan.status === 'pending'`, and skips straight to opening the SSE
   stream when status is already `'approved'` — avoiding a redundant PATCH that
   would otherwise 409 against `plan/route.ts:95-100`'s
   `existing.status !== 'pending'` guard.
3. **SSE consumption is a real streaming parser, not a mock** —
   `plans/page.tsx:218-271` manually buffers `reader.read()` chunks, splits on
   `\n\n`, and parses `event:`/`data:` lines per the exact event contract
   documented at `execute/route.ts:71-76` (`execution_start`, `step_start`,
   `step_done`, `step_error`, `execution_done`). It correctly distinguishes
   `execution_done` with `status: 'completed_with_errors'` from a clean
   `'completed'` (`plans/page.tsx:249-254`) and treats a stream that ends
   without ever emitting `execution_done` as `completed_with_errors`
   (`plans/page.tsx:273-277`, `sawExecutionDone` guard) — a real defense
   against a silently-dropped connection, matching the disconnect-safety intent
   `ask-ai.md` documents for `execute/route.ts` itself.
4. **409 on already-executed plan is surfaced to the user, not swallowed** —
   `plans/page.tsx:204-216`: a non-OK/no-body response from the execute SSE GET
   is mapped to `'This plan was already executed.'` when `status === 409` and
   reverts the optimistic `status: 'running'` back to `'approved'`
   (`plans/page.tsx:211`) rather than leaving the UI stuck showing "running".
5. **Cancel reaches the Temporal signal path, not just the DB row** —
   `handleCancel` (`plans/page.tsx:161-173`) PATCHes `action: 'cancel'`, which
   `plan/route.ts:164-201` updates `agent_plans.status = 'cancelled'`, looks up
   any linked `work_items.temporal_workflow_id`, releases the DB client
   *before* calling `signalPlanDecision` (`plan/route.ts:178-186`, avoiding a
   held connection during a Temporal RPC), and — if the signal throws — reverts
   the plan back to `'pending'` with a fresh scoped client so the DB and
   Temporal never disagree (`plan/route.ts:187-199`). Same pattern on approve
   (`plan/route.ts:135-160`).
6. **PlanCard itself is real and unit-tested** — `PlanCard.tsx:1-246` renders
   steps, supports toggling a step off (`onToggleStep`, tested at
   `PlanCard.test.tsx:46-64`), adding a free-text instruction step
   (`onAddInstruction`, tested at `:118-140`), and a real "Edit params" inline
   JSON editor (`PlanCard.tsx:142-150, 159-187`) that validates the pasted JSON
   is a non-array object before calling `onUpdateStepPayload`
   (`PlanCard.tsx:52-66`) — not a stub, it actually round-trips
   `JSON.parse`/`JSON.stringify` and shows a parse-error message
   (`PlanCard.tsx:63-64`).
7. **RLS on `agent_plans` is real, not just app-level filtering** —
   `infra/db/migrations/007_agent_plans.sql:24-29` enables and forces RLS with
   `USING (org_id = current_setting('app.current_org_id', true)::UUID)`, so the
   `/plans` page's org isolation holds even if a route forgot the `org_id`
   predicate (`ask-ai.md` already flagged and fixed one such case in
   `execute/route.ts`'s old raw-`pool.connect()` cancellation check).

---

## What's broken (file:line, exact symptom)

1. **"Edit params" is silently absent on the `/plans` page (P1)** —
   `plans/page.tsx:336-345` instantiates `<PlanCard>` with `planId`, `summary`,
   `steps`, `disabled`, `onApprove`, `onCancel`, `onToggleStep`,
   `onAddInstruction` — **no `onUpdateStepPayload` prop**. Compare to the Ask
   AI chat page, which passes `onUpdateStepPayload={handleUpdateStepPayload}`
   (grep hit, chat page `PlanCard` usage, line ~1766). Per
   `PlanCard.tsx:142-150`, the "Edit params" button only renders when
   `isEditing && onUpdateStepPayload && !disabled` — so on `/plans`, clicking
   "Edit" (`plans/page.tsx` doesn't even define an `isEditing` state; that's
   internal to `PlanCard`) toggles edit mode but **no step ever shows an "Edit
   params" button**, because the prop that gates it is `undefined`. `ask-ai.md`
   item 9 and `decisions.md`'s referenced work mark "Interactive step parameter
   editor" as done and "wired from ask-ai page" — that phrasing is accurate but
   narrow: it is wired from the *chat* page only, not from this inbox page that
   the task description calls out as the canonical Plans-tab flow. A user who
   opens a complex plan from `/plans` (e.g. after navigating away from the
   chat, or via a notification link) cannot correct a wrong parameter before
   approving — they can only toggle a step off or add a new instruction step
   and re-run, which does not let them fix e.g. a wrong refund amount on an
   existing step.
2. **Completed / cancelled / errored plans vanish from `/plans` on refresh (P1)**
   — `GET /api/ask-ai/plan` with no `planId` (`plan/route.ts:26-34`) filters
   `status IN ('pending','approved','running')`. The moment a plan reaches
   `'completed'`, `'completed_with_errors'`, or `'cancelled'`, it is excluded
   from every future `loadPlans()` call. `plans/page.tsx` only shows the
   post-execution status for a plan still held in local React state
   (`execution` map, `patchPlan`) during the same session — a page refresh, a
   second tab, or a different device loses all visibility into what a
   completed/failed plan actually did. There is no `/plans/history` route and
   no `status IN (...)` toggle in the UI. This is the same class of gap
   `ask-ai.md` records generically for Ask AI ("no historical decision log
   view"), but concretely it means the Plans tab — the one screen whose whole
   job is "review plans" — cannot show you a plan from yesterday.
3. **Secondary work-item Temporal signal path is always a no-op (P2)** —
   `plan/route.ts:124-131` (approve) and `:169-174` (cancel) both query
   `work_items WHERE temporal_workflow_id IS NOT NULL AND metadata->>'planId' = $2`
   to find additional `WorkItemWorkflow`s to signal alongside the plan's own
   `PlanExecuteWorkflow`. Grepping the whole repo for any write of
   `metadata` containing a `planId` key on `work_items` turns up nothing — no
   code path was found that ever sets `work_items.metadata->>'planId'`. This
   query therefore always returns zero rows in practice, and
   `signalPlanDecision`'s `workItemWorkflowIds` argument
   (`plan/route.ts:132-143`) is always `[]`. `signalPlanDecision` still signals
   the plan's own `PlanExecuteWorkflow` correctly (computed independently via
   `planExecuteWorkflowId(orgId, planId)`), so this is not a live bug for the
   documented Ask AI complex flow, but the "signal any waiting WorkItemWorkflow
   too" branch is dead weight that never fires — either the link was never
   implemented, or it was replaced by a different mechanism and the query was
   never removed.
4. **No loading/error state distinguishes "no plans" from "fetch failed" (P2)**
   — `loadPlans` (`plans/page.tsx:84-100`) sets `plans: []` on both a non-OK
   response (`:88-91`) and a thrown network error (`:95-96`), so a 500 from the
   API or an auth failure renders the identical "No plans in the inbox" empty
   state (`plans/page.tsx:308-313`) as a genuinely empty inbox. A user whose
   session expired mid-day sees "No plans in the inbox" with no indication
   anything went wrong.
5. **No test file exists for the `/plans` page itself (P2)** — only
   `PlanCard.test.tsx` (the shared component) is tested; there is no
   `plans/page.test.tsx` covering `loadPlans`, `handleApprove`'s SSE parsing,
   or the 409-already-executed revert path. Given `handleApprove` is ~110 lines
   of hand-rolled SSE buffering logic (`plans/page.tsx:175-284`) with several
   branches, this is real untested logic, not boilerplate.

---

## What's missing vs full product vision

1. **Batch approve / batch view.** Every plan renders as its own full
   `PlanCard` with no multi-select — an operator with 10 pending plans must
   open and approve each individually. (Mirrors the equivalent gap
   `decisions.md` documents for the Decisions/HITL inbox.)
2. **Plan history / audit tab**, as noted above — filter by status
   (`completed`, `cancelled`, `completed_with_errors`), by date, by who
   approved (the `agent_plans` schema has no `approved_by` column at all —
   `007_agent_plans.sql:8-22` has no such field, and `plan/route.ts`'s approve
   path only writes an `audit_events` row via `recordAuditEvent`
   (`plan/route.ts:107-119`), it does not persist the approver on the plan row
   itself, so the plan itself can't answer "who approved me" without a join).
3. **Parameter editing parity between entry points** — either wire
   `onUpdateStepPayload` into `/plans` too, or explicitly decide plan editing
   is chat-only and remove the dead-weight capability check from `PlanCard` for
   this call site (currently it silently no-ops instead of documenting the
   decision).
4. **No plan-level rollback/compensation surfaced on this page** —
   `ask-ai.md` documents `compensation_steps` freeze-log behavior on mid-plan
   failure at the API level; `/plans` has no UI element rendering
   `compensation_steps` or offering any recovery action for a
   `completed_with_errors` plan beyond re-reading the (already-gone, per #2
   above) status.
5. **No live polling / websocket for plans created by *other* concurrent
   sessions of the same user** — `/plans` only reloads on mount and on manual
   "Refresh" click (`plans/page.tsx:296-303`); a plan approved from the Ask AI
   chat tab open alongside `/plans` in another tab won't reflect there until
   a manual refresh.

---

## What to add for full SaaS

1. **Wire `onUpdateStepPayload` on `/plans`.** Add a `handleUpdateStepPayload`
   mirroring the chat page's, PATCHing `/api/ask-ai/plan` with the edited
   step's `payload` merged in (the route already supports this — `plan/route.ts:
   205-251` merges `patch.payload` into the matching step when present) and
   pass it through at `plans/page.tsx:336-345`. This is a small, contained fix
   since both the backend and the shared component already support it — only
   the page's prop wiring is missing.
2. **Add a plan history endpoint/view.** Extend `GET /api/ask-ai/plan` with an
   optional `?history=1` (matching the pattern `decisions.md` already
   documents for `/api/decisions?history=1`) that drops the `status IN (...)`
   filter and orders by `updated_at DESC LIMIT N`, and add a "History" toggle
   on `/plans` reusing the same list rendering in a read-only mode (no
   approve/cancel buttons, just status + summary + timestamp).
3. **Persist `approved_by` / `cancelled_by` on `agent_plans`.** A small
   migration (`ADD COLUMN approved_by UUID REFERENCES users(id)`,
   similarly for cancelled) plus one extra `SET approved_by = $userId` in the
   existing approve/cancel UPDATE statements in `plan/route.ts` removes the
   need to join `audit_events` just to answer "who approved this."
4. **Remove or actually implement the `work_items.metadata->>'planId'` link.**
   Either delete the dead lookup at `plan/route.ts:124-131,169-174` (simplify:
   `signalPlanDecision` already signals the real `PlanExecuteWorkflow`
   independently), or, if there's a real intended use case (Ask-AI-originated
   plans that also spawn a `WorkItemWorkflow`, e.g. via inbound conversations),
   wire the write side so the query isn't permanently empty.
5. **Distinguish empty vs. errored state in `loadPlans`.** Track a
   `loadError` boolean/string separately from `plans.length === 0` and render a
   distinct "Couldn't load plans — try again" state instead of reusing the
   empty-inbox illustration.
6. **Add `plans/page.test.tsx`** covering: SSE event parsing for all five
   event types, the 409-already-executed revert, the `sawExecutionDone`
   false-negative fallback, and the pending-vs-approved branch in
   `handleApprove`.

---

## Fix priority: P1

The core approve → execute → status flow on `/plans` works and is genuinely
tested at the component level (`PlanCard.test.tsx`) and defensively coded at
the API level (atomic transitions, Temporal-signal-then-revert-on-failure).
The **P1** items are the parameter-edit parity gap (#1 under "what's broken" —
a real capability that exists elsewhere in the app but is invisibly absent
here) and the disappearing-plan-history gap (#2) — both are user-facing
correctness/trust gaps on the one page whose job is reviewing plans. The dead
`work_items.metadata->>'planId'` lookup and missing page-level test are P2.
