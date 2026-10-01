# Plans

Date: 2026-09-27.

"Plans" here means Ask AI multi-step plans stored in `agent_plans`, not
the billing `orgs.plan` column (`free` by default in
`001_core_schema.sql`).

## Table

`infra/db/migrations/007_agent_plans.sql`, plus
`compensation_steps` from `105_ask_ai_plan_compensation.sql`.

| Column | Role |
|---|---|
| `id`, `org_id`, `user_id` | Tenant and owner. RLS on `org_id`. |
| `thread_id` | Defaults to `ask-ai`. |
| `summary` | Short description shown on the card. |
| `steps` | JSONB array of steps (tool, description, payload). |
| `status` | `pending` → `approved` → `running` → `completed` or `completed_with_errors`, or `cancelled`. |
| `current_step` | Index while executing. |
| `draft`, `reasoning`, `feedback` | Generator output and user feedback. |
| `compensation_steps` | JSONB log of steps that already succeeded when a later step fails. Status becomes `completed_with_errors`. This is a freeze log, not an automatic undo of Gmail / Stripe / HubSpot side effects. |

Indexes: `org_id`, `user_id`, `status`.

## Flow

1. Ask AI classifies a complex request and `generatePlan` writes an
   `agent_plans` row (`pending`).
2. The chat `PlanCard` (and the `/plans` inbox) shows the steps.
3. Approve is `PATCH /api/ask-ai/plan` with `action: 'approve'`. Only a
   `pending` row can be approved. The DB client is released before the
   Temporal signal.
4. Execute is `GET /api/ask-ai/execute` (SSE): `execution_start`,
   `step_start`, `step_done`, `step_error`, `execution_done`. Independent
   steps run in parallel. A stream that ends without `execution_done` is
   treated as `completed_with_errors`.
5. Cancel sets `status = 'cancelled'` and signals the plan workflow. If
   the signal throws, the row is put back to `pending`.

Org id on these routes comes from the session. A second user in another
org cannot read the row through RLS.

## `/plans` inbox

`apps/dashboard/app/(dashboard)/plans/page.tsx` lists the signed-in
user's own plans via `GET /api/ask-ai/plan` with no plan id.

That list query is:

```sql
status IN ('pending', 'approved', 'running')
```

(`apps/dashboard/app/api/ask-ai/plan/route.ts`). Completed, cancelled,
and `completed_with_errors` rows disappear from the inbox on the next
load. There is no history view.

The inbox `PlanCard` receives approve, cancel, toggle-step, and
add-instruction. It does **not** receive `onUpdateStepPayload`, so the
"Edit params" control that the Ask AI chat page passes does not render
on `/plans`. A user who opens the plan from the inbox cannot change a
step payload before approving.

A failed `loadPlans` currently clears the list the same way an empty
inbox does, so a 500 and "no plans" look the same.

The work-item side signal (`work_items.metadata->>'planId'`) has no
writer in the repo. The plan's own workflow is still signaled. The
work-item branch returns no rows.

## What is already solid

- RLS on `agent_plans`.
- Approve skips a second PATCH when the row is already `approved`
  (a repeat approve would 409).
- Execute 409 ("already executed") is shown and the optimistic
  `running` state is reverted.
- Partial failure is stored on `compensation_steps` and the status is
  `completed_with_errors`, not `completed`.
