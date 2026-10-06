# Autonomy Tab Audit

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | No UI calls `PATCH /api/settings/autonomy` — tier editor missing | P0 | `components/settings/AutonomySettings.tsx` | 🟢 Done | Per-rule Mode select PATCHes `{ actionType, employeeRole, autonomyTier, reversibility, confidenceThreshold }`; echoes reversibility so irreversible rules stay locked. Jest covers the PATCH body. |
| 2 | Pending section has no Approve/Reject | P0 | `components/settings/AutonomySettings.tsx` | 🟢 Done | Approve/Reject call `PATCH /api/decisions` with `{ id, status }`; row removed on success; API errors surfaced. Jest covers approve + failed approve (RBAC). Live UI not exercised (no shared stack / port 3000). |
| 3 | `/api/settings/pending` has no PATCH (must use `/api/decisions`) | P1 | `api/settings/pending/route.ts` | 🟡 Partial | Intentional: Autonomy UI now uses `/api/decisions`. Route consolidation deferred (see `decisions.md`). |
| 4 | No UI hint that pending + decisions share one table | P2 | AutonomySettings Pending section | 🟡 Partial | Operators can approve here; Observability still uses the same endpoint. Copy consolidation not required for P0. |
| 5 | Confidence / reversibility / new-rule form | P1–P2 | AutonomySettings | 🟢 Done | Per-rule min-confidence (0-1) + reversibility with Save (irreversible rules stay locked), and an Add rule form (action type, optional role, tier, reversibility, confidence) all PATCH `/api/settings/autonomy`, which already enforces `canManageOrgSettings` and range validation; client rejects out-of-range confidence before calling. Jest covers save, create and the invalid case. Live UI not exercised (no shared stack on port 3000). |
| 6 | Moving up a level was decided on numbers typed into the request (weeks, divergences, approval rate, decisions), and `force` skipped the check; first-level evidence (`shadow_reviewed`/`shadow_agreed`) was never written by anything | P0 | `api/org/rollout/route.ts`, `lib/trust-stage.ts` | 🟢 Done | Evidence is counted on the server (`lib/trust-query.ts`); body numbers are ignored. Operator answers about watching-mode decisions are rows in `agent_shadow_reviews` (migration 211) and the exit rule counts them. `force` still works but is recorded as an override with the evidence at that moment. Proven by 14 route tests, 11 real-database tests, and a real-browser run that sends forged evidence and is refused. |
| 7 | No record of who changed the level, when, or why; a pause silently reset the level to 0 | P1 | `org_autonomy_stage_events`, `lib/employee-metrics-query.ts` | 🟢 Done | Every change writes one row with the measured evidence, in the same transaction as the change; pausing from the app records the drop. Not covered: a pause by Darex support (recorded in the platform audit log, not here); the page then dates the level as approximate instead of guessing. |

## Status: working (tier edits + approve/reject wired from Settings → Autonomy)

This audit covers `apps/dashboard/app/(dashboard)/settings/autonomy/page.tsx`,
the component it renders (`apps/dashboard/components/settings/AutonomySettings.tsx`),
and the three routes it fetches from: `GET /api/settings/autonomy`,
`GET /api/settings/pending`, and `GET`/`DELETE /api/settings/suppressions`.
`decisions.md` in this folder already audits the backend approval/execution
engine (`services/workflows/src/autonomy.ts`, `PATCH /api/decisions`) in
depth — this file does not repeat those findings except where the Autonomy
tab's own wiring changes the verdict for this specific page.

---

## What works (file:line evidence)

1. **Page shell is thin and correctly delegates to the client component** —
   `apps/dashboard/app/(dashboard)/settings/autonomy/page.tsx:1-18` renders a
   static header and mounts `<AutonomySettings />`; no fabricated data here.
2. **Three real GET calls, parallelized** —
   `AutonomySettings.tsx:44-49` (`load`) fires `Promise.all` against
   `/api/settings/autonomy`, `/api/settings/pending`, `/api/settings/suppressions`.
   Each response is defensively defaulted (`a.ok ? await a.json() : { rules: [] }`,
   etc. at lines 50-52) so a single failing endpoint doesn't blank the whole page.
3. **Autonomy rules list is genuinely live** —
   `apps/dashboard/app/api/settings/autonomy/route.ts:16-59` (`GET`) queries
   `employee_autonomy_rules` for the real org, returns `[]` on a missing table
   (42P01, line 44) rather than fabricating rows, and the component renders
   each rule's `actionType`, `autonomyTier`, `requiresHumanApproval`, and a
   locked/irreversible note (`AutonomySettings.tsx:93-113`).
4. **Pending list is genuinely live** —
   `apps/dashboard/app/api/settings/pending/route.ts:13-53` queries
   `agent_pending_actions WHERE status = 'pending'` for the real org and
   computes `age_hours` server-side; the component renders each row's
   `actionType`, `employeeRole`, and an "overdue for a reminder" flag at
   ≥24h (`AutonomySettings.tsx:126-136`). No mock data.
5. **Suppression dismiss is a real, working write** —
   `AutonomySettings.tsx:65-75` (`dismiss`) calls
   `DELETE /api/settings/suppressions` with the row `id`, and only flips the
   row to `dismissed: true` in local state after `res.ok`. This is the one
   write path in the whole tab that is actually wired end-to-end from a
   button click.
6. **PATCH backend for autonomy tiers exists and is well-guarded** —
   `apps/dashboard/app/api/settings/autonomy/route.ts:61-190`: role-gated via
   `canManageOrgSettings` (line 66-68), rejects client-supplied `org_id`
   (line 74-79), validates `actionType`/`autonomyTier`/`minConfidence`/
   `reversibility`, upserts into `employee_autonomy_rules` (lines 125-159),
   and writes an audit event (`recordAuditEvent`, lines 161-172) tagged
   `settings.autonomy_updated`. This endpoint is real and safe to call — it
   is simply never called from this page (see "What's broken" #1).
7. **Live announcements for accessibility** — `AutonomySettings.tsx:4,40,79`
   uses `<LiveRegion>` to announce `"Suppression dismissed"` after a
   successful dismiss.

---

## What's broken (file:line, exact symptom)

1. **No UI control anywhere on this page calls `PATCH
   /api/settings/autonomy`.** `AutonomySettings.tsx` has no form, dropdown,
   toggle, or button that lets an operator change an `autonomyTier`,
   `reversibility`, or `confidenceThreshold` for any action type. The rules
   section (lines 92-114) is read-only `<li>` markup — no `onClick` handler
   exists that references `/api/settings/autonomy` with method `PATCH`
   anywhere in this file (confirmed via grep: the only fetch to that path is
   the `GET` in `load()`, line 46). The backend write path exists and is
   correct (see "What works" #6), but nothing in the Autonomy tab can reach
   it — an admin cannot change a single policy from this screen.
2. **The "Pending" section has zero approve/reject actions.**
   `AutonomySettings.tsx:117-138`: each pending row renders `actionType`,
   `employeeRole`, and age only. There is no Approve/Reject button, no link
   into `PATCH /api/decisions` (the working approval+execution endpoint
   documented in `decisions.md`), and no link to `/observability` where
   `PendingDecisionCard` actually lives. An operator viewing Settings →
   Autonomy sees the backlog but has no way to act on it from this screen —
   they must separately know to go to the Observability page.
3. **`/api/settings/pending` itself has no PATCH/POST handler** —
   `apps/dashboard/app/api/settings/pending/route.ts` exports only `GET`
   (confirmed: no other exported function in the file). Even if the
   Autonomy tab grew approve/reject buttons, they could not target this
   route directly — they would need to call `/api/decisions` instead,
   which is a different endpoint operating on the same
   `agent_pending_actions` table (the split-brain duplicate-route pattern
   `decisions.md` already flags at its "What's broken" #4).
4. **No indication in the UI that `/api/settings/pending` and
   `/api/decisions` are two different views of the same underlying table.**
   An operator has no way to know that resolving items must happen
   elsewhere.

---

## What's missing vs full product vision

1. **Tier editor UI.** No slider/dropdown per action type to move between
   Notice (1) / Draft (2) / Act Internally (3) / Act Externally (4), despite
   the backend fully supporting it.
2. **Approve/Reject/Edit controls inline in the Pending section**, wired to
   the same execution path `decisions.md` documents (`PATCH /api/decisions`),
   so autonomy policy and its live backlog live on one screen instead of
   split across Settings and Observability.
3. **Confidence threshold and reversibility controls** — the PATCH endpoint
   accepts `minConfidence` and `reversibility`, but no input for either
   exists anywhere in the dashboard.
4. **Per-employee-role autonomy override view** — the schema supports
   `employeeRole` scoping (`employee_autonomy_rules.employee_role`), but the
   list rendering only shows it as a trailing text fragment
   (`AutonomySettings.tsx:100`), not as a filter or grouping.
5. **A "create new rule" affordance** for action types that don't have a row
   yet (currently the only way to create one is via a raw PATCH call with a
   new `actionType`, since there's no "no rule for X yet" default editor).

---

## What to add for full SaaS

1. Add an inline tier selector (segmented control or dropdown) to each rule
   `<li>` in `AutonomySettings.tsx`, calling
   `PATCH /api/settings/autonomy` with `{ actionType, employeeRole,
   autonomyTier, minConfidence, reversibility }` on change, then refetch or
   optimistically update `rules` state.
2. Add Approve / Reject buttons to each row in the Pending section, calling
   `PATCH /api/decisions` (the already-working execution path from
   `decisions.md`) with `{ id, status: 'approved' | 'rejected' }`, and remove
   the row from `pending` state (or refetch `load()`) on success.
3. Surface `expiresAt` (already returned by `/api/settings/pending`, line
   30-31 of that route, but not read by the component — `PendingAction` type
   in `AutonomySettings.tsx:18-24` omits `expiresAt` entirely) as a countdown
   next to each pending row.
4. Add a lightweight "New Rule" form (action type input + tier picker) for
   action types with no existing row.
5. Once approve/reject is wired here, cross-link to `decisions.md`'s planned
   canonical-route consolidation so this page and `/observability` call the
   same endpoint rather than two separate ones reading/writing the same table.

---

## Fix priority

- **P0**: Wire Approve/Reject into the Pending section so this screen isn't
  purely informational — an operator currently cannot act on anything they
  see here (What's broken #2).
- **P0**: Wire the tier/reversibility/confidence editor to the existing
  `PATCH /api/settings/autonomy` endpoint — the backend is done and audited
  safe, only the UI call is missing (What's broken #1).
- **P1**: Add `expiresAt` to the `PendingAction` type and render a countdown,
  since the data is already returned by the API and silently dropped.
- **P2**: Resolve the `/api/settings/pending` vs `/api/decisions` duplicate-
  route confusion at the UI layer (link out or consolidate), consistent with
  `decisions.md`'s P2 backend consolidation recommendation.
