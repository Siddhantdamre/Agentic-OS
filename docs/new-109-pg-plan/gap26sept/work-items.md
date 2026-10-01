# Work Items Audit

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | `modifiedArgs` dropped from Temporal signal on `modify` | P0 | `apps/dashboard/app/api/work-items/[id]/decision/route.ts` | 🟢 Done | Persisted in metadata/events; passed on signal payload; also embedded in `optionId` JSON for `approveWorkItem`. |
| 2 | Temporal signal failure leaves Postgres approved (split-brain) | P0 | `…/decision/route.ts` | 🟢 Done | Release client → require Temporal client → signal → compensate status + `signal_failed` event → HTTP 502. |
| 3 | No dedicated `/work-items` dashboard page | P0 | `apps/dashboard/app/(dashboard)/work-items/page.tsx` | 🟢 Done | Kanban + list; live `GET /api/work-items`; approve/reject via decision API; nav link present. |
| 4 | Missing POST/PATCH CRUD + RBAC on decision | P0–P1 | `app/api/work-items/*` | 🟢 Done | `POST /api/work-items`, `GET/PATCH /api/work-items/[id]` (+ events); auditors blocked from decide/create/mutate. |
| 5 | Concurrent approval race | P0 | `…/decision/route.ts` | 🟢 Done | Conditional `UPDATE … WHERE status = $previous RETURNING`; loser gets 409. |
| 6 | List omitted metadata/payload | P1 | `app/api/work-items/route.ts` | 🟢 Done | Returns `metadata`, `payload`, `temporalWorkflowId`. |
| 7 | `work_events` write-only | P1 | `app/api/work-items/[id]/route.ts` | 🟢 Done | `GET` returns ordered events for the item. |
| 8 | SLA sweeper / human assignee column / dependency chains | P2 | `100_work_items_sla_assignee.sql` + `POST /api/work-items/sweep-sla` | 🟢 Done | Migration adds `assignee_user_id` (org member), `depends_on_id`, `sla_due_at`/`sla_breached_at`. API validates assignee is org user. Sweeper sets `sla_breached_at=NOW()` only when `sla_due_at` passed — no fabricated timestamps. |

## Status: working (CRUD + Kanban + decision hardening + SLA/assignee/deps live)

**Manual management UI:** 🟢 `/work-items` has a New item form (title, priority, employee assignee) and per-card priority and assignee selects wired to `POST /api/work-items` and `PATCH /api/work-items/[id]`; UI not exercised against a live session.

**Read gate:** 🟢 `GET` on `/api/work-items` now 403s for the `billing` role (`canReadOperations`: owner, admin, member, auditor may read). Jest covers the role matrix; not exercised live.

The work items subsystem (`infra/db/migrations/012_work_items.sql`, `apps/dashboard/app/api/work-items/*`, and `services/workflows/src/activities/*`) provides an asynchronous task queue and decision pipeline for AI employees. It features RLS-enforced schemas, idempotency-keyed audit logging in `work_events`, and a one-tap decision endpoint (`/api/work-items/[id]/decision`) that triggers real Temporal workflows or outbound emails via Gmail.

However, **there is no dedicated "Work Items" or "Tasks" page in the dashboard**, the API lacks generic `POST /api/work-items` creation and `PATCH /api/work-items/[id]` update routes, `POST /api/work-items/[id]/decision` lacks RBAC role gates (allowing any member to authorize real outbound actions), and concurrent approvals risk duplicate workflow execution.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Production-Grade Relational Schema**:
   - `infra/db/migrations/012_work_items.sql:9-42, 58-77`:
     - Implements `work_items` and `work_events` with `FORCE ROW LEVEL SECURITY`.
     - Compound indexes on `(org_id, status)` and `(org_id, assignee_employee_id)`.
     - Enforces one conversation-typed work item per conversation via partial unique index.
     - Append-only audit trail in `work_events` keyed on unique idempotency constraints (`idempotency_key`), defending against duplicate webhook processing.
2. **Parametric Querying with Graceful Degradation**:
   - `apps/dashboard/app/api/work-items/route.ts:14-39` — `GET /api/work-items`:
     - Filters safely by `type`, `priority`, and `assignee` using parameterized `$n` placeholders.
     - Degrades gracefully on missing tables (`42P01`) without throwing 500 errors.
3. **Deterministic One-Tap Decision Endpoint**:
   - `apps/dashboard/app/api/work-items/[id]/decision/route.ts:108-238` — `POST /api/work-items/[id]/decision`:
     - Validates UUIDs, rejects body `org_id` overrides, and validates action enums (`approve`, `reject`, `snooze`, `modify`).
     - Writes audit rows to `work_events` with deterministic idempotency keys (`card:${workItemId}:${kind}:${action}`).
     - When rejected with reason `'wrong_fit'`, writes persistent preference suppression rules to `org_preferences` to prevent the AI from repeating the error.
4. **Live Temporal Signal Propagation**:
   - `apps/dashboard/app/api/work-items/[id]/decision/route.ts:243-280`:
     - Signals active workflows (`signalWorkItemDecision`) when `temporal_workflow_id` is present.
     - For un-dispatched growth opportunities, `approve` launches a live `AutonomousAgentWorkflow` to dispatch drafted emails via Gmail.
5. **Playbook Promotion Engine**:
   - `apps/dashboard/app/api/work-items/playbook/route.ts:15-74`:
     - `POST /api/work-items/playbook` promotes successful plans into reusable organizational playbooks (`org_playbook_promotions`), automatically marking the source work item as `done`.
6. **Widespread Automated Writers Across Runtime**:
   - Work items are actively populated by the Temporal activity `upsertWorkItem` (`activities/index.ts:296-350`), inbound webhooks (`lib/inbound-agent.ts:336-365`), autonomy checks, memory conflict detectors, and visitor intent trackers.
7. **Safe DB Connection Checkout**:
   - `apps/dashboard/app/api/work-items/route.ts:40, 100`:
     - Guaranteed `client.release()` in finally blocks.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Total Absence of Dedicated Work Items UI Page (`/work-items` does not exist in dashboard) (P0)**:
   - *User Impact*: Operators have no centralized place to view all pending AI employee tasks, review approvals, or monitor task backlog.
   - *Code Cause*: There is no page component or navigation link in `AppShell.tsx` for work items.
2. **Missing Generic Task CRUD Endpoints (`POST`, `PATCH`, `DELETE`) (P0)**:
   - *User Impact*: Humans cannot manually assign tasks to AI employees or adjust priorities.
   - *Code Cause*: `app/api/work-items/` only has a high-level `GET` route and a specialized `decision/` route. Missing `POST /api/work-items` and `PATCH /api/work-items/[id]`.
3. **Missing RBAC Role Gates on Decision Approvals (`apps/dashboard/app/api/work-items/[id]/decision/route.ts:22-55`) (P0)**:
   - *User Impact*: Unauthorized members can trigger real emails or financial transactions.
   - *Code Cause*: The route checks session validity but never verifies human roles via `loadHumanRole()`. Unprivileged members or auditors can approve external actions.
4. **Race Condition on Concurrent Approvals (Duplicate Workflow Triggers)**:
   - *User Impact*: Customers receive duplicate outbound emails.
   - *Code Cause*: Two simultaneous requests check `status === 'waiting_approval'` before either writes `status = 'approved'`, launching parallel execution workflows.
5. **Data Truncation in List Endpoint (`apps/dashboard/app/api/work-items/route.ts:32-39`)**:
   - *User Impact*: UI cannot render drafted emails or task situation descriptions.
   - *Code Cause*: The SQL query omits `metadata` and `payload`, forcing secondary round-trips for every item.
6. **Write-Only Audit Ledger (`work_events`)**:
   - *User Impact*: Task history cannot be viewed by users.
   - *Code Cause*: No API route or component ever queries `work_events`.
7. **Lack of Stale Task Cleanup or Reminders**:
   - *User Impact*: Customer requests sit in `waiting_approval` indefinitely with no escalation.
   - *Code Cause*: No background sweeper exists to flag tasks exceeding SLA deadlines.
8. **Foreign Key Task Orphaning on Employee Deletion**:
   - *User Impact*: Tasks become stranded when an AI employee is deactivated.
   - *Code Cause*: `assignee_employee_id` becomes `NULL` with no reassignment alert.
9. **Missing Task Assignment to Human Specialists**:
   - *User Impact*: Inability to escalate complex issues from an AI agent to a human team member.
   - *Code Cause*: Schema lacks `assignee_user_id` column.
10. **Idempotency Key Collisions on Task Re-Opening**:
    - *User Impact*: Database unique constraint errors when reopening snoozed tasks.
    - *Code Cause*: Static key generation without unique salt or timestamps.
11. **Absence of Dependency Chains**:
    - *User Impact*: Cannot enforce prerequisite tasks (e.g. Task B waits for Task A).
    - *Code Cause*: No `depends_on_id` column in schema.
12. **Static Client Lifecycle (No Live WebSocket/SSE Sync)**:
    - *User Impact*: Task statuses do not update in real time across browser tabs.
    - *Code Cause*: No real-time subscription on task lists.
13. **Dropped `modifiedArgs` on Modify Action in Temporal Signal (`apps/dashboard/app/api/work-items/[id]/decision/route.ts:159-167, 243-249`) (P0)**:
    - *User Impact*: Ignored human edits. When an operator modifies parameters before approving (e.g. changing an email recipient, updating pricing, or correcting dates), the AI executes the action using the original unedited arguments!
    - *Code Cause*: In `decision/route.ts:243-249`, `signalWorkItemDecision` is called with:
      ```ts
      await signalWorkItemDecision({
        workflowId,
        decision: action === 'reject' ? 'rejected' : 'approved',
        optionId,
      });
      ```
      `modifiedArgs` is completely omitted from the payload sent to Temporal! The workflow activity runs with whatever args were initially proposed by the agent.
    - *Fix*: Include `modifiedArgs` in `signalWorkItemDecision`:
      ```ts
      await signalWorkItemDecision({
        workflowId,
        decision: action === 'reject' ? 'rejected' : 'approved',
        optionId,
        modifiedArgs: action === 'modify' ? modifiedArgs : undefined,
      });
      ```
14. **Unhandled Post-Transaction Temporal Signal Failure Creating Split-Brain State (`apps/dashboard/app/api/work-items/[id]/decision/route.ts:243-250`) (P0)**:
    - *User Impact*: Stuck workflows and phantom approvals. The dashboard shows the task as "Approved", but the Temporal workflow never executes the action and sits waiting indefinitely until it times out.
    - *Code Cause*: `signalWorkItemDecision` is invoked outside a transaction and without `try/catch` error recovery after `client.release()`. If the signal call throws an error (e.g. Temporal network blip or workflow completion race), HTTP returns 500 but PostgreSQL has already committed `status = 'approved'`, leaving the system in an inconsistent split-brain state.
    - *Fix*: Wrap `signalWorkItemDecision` in a `try/catch` block that reverts the database status or retries the signal with exponential backoff before returning.

---

## What's missing vs full vision

1. **Universal AI Employee Task Board (`/work-items`)**:
   - Interactive Kanban and List view:
     - Columns: `Backlog`, `In Progress`, `Needs Approval`, `Completed`.
     - Filter by AI Employee, Human Assignee, Priority, and Due Date.
     - Slide-over inspector drawer with full payload preview and event history.
2. **Manual Task Delegation Modal**:
   - Modal allowing human operators to delegate ad-hoc assignments to AI employees:
     - Select AI Employee (e.g. Marcus, Sarah).
     - Natural language instructions ("Draft a proposal for client XYZ").
     - Priority, tags, and SLA deadline.
3. **Atomic Conditional Updates with Human RBAC**:
   - Strict role gating requiring `owner` or `admin` permissions to approve outbound actions.
4. **Task Escalation to Human Users**:
   - Support for assigning tasks directly to human team members (`assignee_user_id`).
5. **Automated SLA Breach Sweeper**:
   - Background Temporal worker evaluating task SLA deadlines and alerting managers via Slack.
6. **Bulk Action Capabilities**:
   - Multi-select actions: "Approve all low-risk items", "Reassign selected tasks".
7. **Complete Event History Audit Drawer**:
   - Viewing timeline of all `work_events` associated with a specific task.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Work Items Hardening & Human Escalation (`045_work_items_enhancements.sql`)
```sql
-- 1. Enhance work_items with human assignment and SLA tracking
ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS depends_on_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_work_items_human_assignee
  ON work_items(org_id, assignee_user_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_work_items_sla_sweep
  ON work_items(org_id, sla_expires_at)
  WHERE status IN ('open', 'waiting_approval', 'needs_attention') AND sla_breached = false;
```

### 2. Task Creation & Delegation Route (`apps/dashboard/app/api/work-items/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { broadcastToOrg } from '@/lib/realtime-hub';

export async function POST(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const body = await req.json();
    if (body.orgId || body.org_id) {
      return NextResponse.json({ error: 'Specifying orgId is forbidden' }, { status: 400 });
    }

    const {
      title,
      type = 'task',
      priority = 'normal',
      assigneeEmployeeId,
      assigneeUserId,
      payload,
      dueAt,
      slaHours
    } = body;

    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    const slaDeadline = slaHours ? new Date(Date.now() + slaHours * 3600 * 1000) : null;

    const res = await client.query(
      `INSERT INTO work_items (
         org_id, title, type, status, priority,
         assignee_employee_id, assignee_user_id, payload, due_at, sla_expires_at
       ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        orgId,
        title.trim(),
        type,
        priority,
        assigneeEmployeeId || null,
        assigneeUserId || null,
        JSON.stringify(payload || {}),
        dueAt || null,
        slaDeadline
      ]
    );

    const task = res.rows[0];

    // Log in work_events
    await client.query(
      `INSERT INTO work_events (org_id, work_item_id, actor_id, event_type, payload, idempotency_key)
       VALUES ($1, $2, $3, 'task_created', $4::jsonb, $5)`,
      [orgId, task.id, userId, JSON.stringify({ title, priority }), `created:${task.id}:${Date.now()}`]
    );

    broadcastToOrg(orgId, { type: 'work_item_created', task });
    return NextResponse.json({ task }, { status: 201 });
  } finally {
    client.release();
  }
}
```

### 3. Individual Task Mutation Route (`apps/dashboard/app/api/work-items/[id]/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { client, orgId } = await getScopedClient();
  try {
    const itemRes = await client.query(
      `SELECT w.*, e.name as employee_name, e.role as employee_role, u.name as user_name
       FROM work_items w
       LEFT JOIN ai_employees e ON e.id = w.assignee_employee_id
       LEFT JOIN users u ON u.id = w.assignee_user_id
       WHERE w.id = $1 AND w.org_id = $2`,
      [params.id, orgId]
    );

    if (itemRes.rowCount === 0) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const eventsRes = await client.query(
      `SELECT * FROM work_events WHERE work_item_id = $1 AND org_id = $2 ORDER BY created_at ASC`,
      [params.id, orgId]
    );

    return NextResponse.json({ task: itemRes.rows[0], events: eventsRes.rows });
  } finally {
    client.release();
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const updates = await req.json();
    const allowed = ['priority', 'status', 'due_at', 'assignee_employee_id', 'assignee_user_id'];

    const setClauses: string[] = [];
    const values: any[] = [params.id, orgId];

    Object.keys(updates).forEach((key) => {
      if (allowed.includes(key)) {
        values.push(updates[key]);
        setClauses.push(`${key} = $${values.length}`);
      }
    });

    if (setClauses.length === 0) {
      return NextResponse.json({ error: 'No valid update fields provided' }, { status: 400 });
    }

    setClauses.push('updated_at = NOW()');
    const query = `
      UPDATE work_items
      SET ${setClauses.join(', ')}
      WHERE id = $1 AND org_id = $2
      RETURNING *
    `;

    const res = await client.query(query, values);
    return NextResponse.json({ task: res.rows[0] });
  } finally {
    client.release();
  }
}
```

### 4. Interactive Work Items Dashboard UI (`apps/dashboard/app/(dashboard)/work-items/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  CheckSquare,
  Plus,
  Clock,
  AlertTriangle,
  User,
  CheckCircle2,
  ChevronRight,
  Filter
} from 'lucide-react';
import { toast } from 'sonner';

interface Task {
  id: string;
  title: string;
  type: string;
  status: 'open' | 'waiting_approval' | 'done' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  due_at: string | null;
  employee_name: string | null;
}

export default function WorkItemsDashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/work-items');
      const data = await res.json();
      setTasks(data.workItems || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const filteredTasks = tasks.filter((t) =>
    filterStatus === 'all' ? true : t.status === filterStatus
  );

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <CheckSquare className="w-6 h-6 text-emerald-400" />
            AI Employee Work Items & Tasks
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Asynchronous task queue, decision pipeline, and human escalations.
          </p>
        </div>

        <button
          onClick={() => toast.info('Delegate Task Modal')}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-sm transition"
        >
          <Plus className="w-4 h-4" /> Delegate New Task
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2">
        {['all', 'open', 'waiting_approval', 'done'].map((st) => (
          <button
            key={st}
            onClick={() => setFilterStatus(st)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition ${
              filterStatus === st
                ? 'bg-slate-800 text-white border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {st.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* Tasks Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-800/60 text-slate-400 uppercase tracking-wider">
            <tr>
              <th className="p-3">Task Title</th>
              <th className="p-3">Assignee</th>
              <th className="p-3">Priority</th>
              <th className="p-3">Status</th>
              <th className="p-3">Due Date</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-300">
            {filteredTasks.map((task) => (
              <tr key={task.id} className="hover:bg-slate-800/40">
                <td className="p-3 font-medium text-slate-200">{task.title}</td>
                <td className="p-3 text-slate-400">{task.employee_name || 'Unassigned'}</td>
                <td className="p-3">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                      task.priority === 'urgent'
                        ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        : task.priority === 'high'
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {task.priority}
                  </span>
                </td>
                <td className="p-3 capitalize">{task.status.replace('_', ' ')}</td>
                <td className="p-3 text-slate-400">
                  {task.due_at ? new Date(task.due_at).toLocaleDateString() : 'No deadline'}
                </td>
                <td className="p-3 text-right">
                  <button className="text-emerald-400 hover:underline">Inspect →</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Propagate `modifiedArgs` in `signalWorkItemDecision` on `modify` actions so Temporal executes human supervisor edits rather than original AI proposals.
- **P0**: Handle `signalWorkItemDecision` failures with transactional rollback/retry to prevent split-brain status desynchronization between Postgres and Temporal.
- **P0**: Add RBAC role checks to `POST /api/work-items/[id]/decision` to prevent unprivileged users from approving live external actions.
- **P0**: Enforce atomic conditional updates to prevent duplicate workflow launches on concurrent approvals.
- **P0**: Build dedicated `/work-items` dashboard page so operators have a centralized task management console.
- **P1**: Implement `POST /api/work-items` and `PATCH /api/work-items/[id]` to allow manual task delegation and status updates.
- **P1**: Support task assignment to human users (`assignee_user_id`) for escalations.
- **P2**: Surface `work_events` audit history inside the task detail view.
- **P2**: Deploy background SLA sweeper to flag overdue tasks.
