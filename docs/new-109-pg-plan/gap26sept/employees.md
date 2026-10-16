# Employees Audit

## Status: improved (soft-delete + tool validation + detail page landed; hard-delete orphaning closed)

The AI employee management subsystem (`apps/dashboard/app/(dashboard)/employees/*`, `/api/employees/*`, and `services/workflows/src/activities/*`) provides lifecycle management for autonomous digital workers. It enforces session-level tenant isolation, auto-seeds default 8-member rosters (`Customer`, `Operations`, `Growth`, `Sarah`, `Emma`, `Marcus`, `Research`, `Finance`), and gates mutations behind strict RBAC role checks (`loadHumanRole() + canDisableEmployee()`).

However, **deleting an employee executes a hard delete that silently orphans active work items**, newly created custom employees fail to receive autonomy rules (bypassing gating tiers), the UI's optimistic state updates fail to roll back on HTTP 4xx/403 errors, deleting all employees triggers unwanted re-seeding of the default roster on page reload, and `tool_allowlist` accepts arbitrary unvalidated strings.

---

## What works (cite file:line)

1. **Multi-Tenant Scoped Employee Retrieval & Auto-Seeding**:
   - `apps/dashboard/app/api/employees/route.ts:77-129` — `GET /api/employees`:
     - Queries `ai_employees` strictly scoped to `org_id` via `getScopedClient()`.
     - Automatically seeds default 8-person roster upon initial organization load (`route.ts:6-71`), guaranteeing that new workspaces never display broken empty states.
2. **Employee Creation Route with Payload Normalization**:
   - `apps/dashboard/app/api/employees/route.ts:131-175` — `POST /api/employees`:
     - Validates non-empty `name` and `role`, normalizes persona text/JSON, defaults status to `active`, and returns the newly inserted row via SQL `RETURNING`.
3. **Strict RBAC Mutation Authorization**:
   - `apps/dashboard/app/api/employees/route.ts:135-138` and `apps/dashboard/app/api/employees/[id]/route.ts:14-17, 92-95`:
     - `POST`, `PATCH`, and `DELETE` enforce `loadHumanRole(client, orgId, userId)`.
     - Calls `canDisableEmployee(role)` (`apps/dashboard/lib/rbac.ts:35-48`), returning `403 Forbidden` for standard `member` and read-only `auditor` accounts before executing database mutations.
4. **Dynamic Parameterized Partial Updates**:
   - `apps/dashboard/app/api/employees/[id]/route.ts:24-66`:
     - Builds parameterized `SET` clauses containing only the specific fields supplied in the request body (`name`, `role`, `persona`, `tool_allowlist`, `status`), avoiding destructive null overwrites.
5. **Rollout Stage & Kill-Switch Safeguards**:
   - `apps/dashboard/lib/employee-rollout.ts:16-63`:
     - Implements state-machine gating across 4 progressive autonomy stages (Notice -> Draft -> Act Internally -> Act Externally Gated) and enforces the global emergency kill-switch.
6. **Defensive Connection Pool Release**:
   - `apps/dashboard/app/api/employees/route.ts:127, 172` and `[id]/route.ts:88, 120`:
     - Ensures `client.release()` is called unconditionally in `finally` blocks, preventing connection leaks.
7. **Persona JSON Parsing Resilience**:
   - `apps/dashboard/app/api/employees/route.ts:98-105`:
     - Safely parses persona JSON or string payloads, preventing server panics when persona definitions contain formatted markdown strings.
8. **Crew Spawn Panel Employee Integration**:
   - `apps/dashboard/components/employees/CrewSpawnPanel.tsx:28-85`:
     - Connects active AI employees directly to Temporal crew multi-agent planning workflows.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Hard Delete Silently Orphans In-Flight Work Items (P0) (`[id]/route.ts:96-103`)**:
   - `DELETE /api/employees/[id]` executes an immediate SQL `DELETE FROM ai_employees WHERE id = $1 AND org_id = $2`.
   - Due to the `ON DELETE SET NULL` foreign key constraint in `012_work_items.sql`, any active, in-flight customer support tickets or sales follow-ups assigned to that employee have their `assignee_employee_id` set to `NULL`.
   - **There is no offboarding reassignment step, no warning dialog, and no audit trail**. Work items in `waiting_approval` or `needs_attention` are left stranded in limbo without an owner.
2. **Custom Hired Employees Bypass Autonomy Gating (`api/employees/route.ts:131-175`) (P0)**:
   - While default roster employees have safety rules seeded at organization setup (`seedDefaultAutonomyRules`), **new employees created via the dashboard modal never receive autonomy rules**.
   - No records are inserted into `employee_autonomy_rules` for the new employee ID.
   - When the agent attempts actions, the runtime falls through to unconfigured fallback logic, risking under-gated execution of external tools.
3. **Broken UI Optimistic State on HTTP 4xx / 403 Errors (`employees/page.tsx:117-143`) (P0)**:
   - In `handleToggleStatus` and `handleDelete`, the React component updates state optimistically:
     ```typescript
     setEmployees(prev => prev.filter(e => e.id !== id));
     await fetch(`/api/employees/${id}`, { method: 'DELETE' });
     ```
   - `fetch()` does not throw on HTTP 403 (Forbidden) or 500.
   - If a standard `member` (without admin rights) clicks "Delete", the API rejects the request with HTTP 403. But because the promise resolved, the UI permanently removes the employee card from the screen until full browser reload, misleading the user into thinking the deletion succeeded.
4. **Unintended Reseeding on Complete Roster Deletion (`route.ts:80-92`)**:
   - `GET /api/employees` executes:
     ```typescript
     if (rows.length === 0) {
       await seedDefaultEmployees(client, orgId);
     }
     ```
   - If an organization intentionally archives or removes all employees to halt operations, the very next page refresh automatically re-seeds the entire 8-employee default roster!
5. **Cosmetic Dead Data: `graph_id` (`route.ts:161`, `employee-provision.ts:200`)**:
   - Code writes `graph_id: 'emp-' + crypto.randomUUID()`.
   - A global codebase search reveals zero consumers of `graph_id`. It is dead data that was originally intended for a LangGraph runner that was removed from the codebase.
6. **Unvalidated Tool Allowlist String Injection (`route.ts:151-153`)**:
   - `POST` and `PATCH` accept any string array for `tool_allowlist`.
   - An operator can input `tool_allowlist: ['non_existent_tool', 'fake_connector']`. The API persists the record without validating against the 62 supported tools in `tool-executor.ts`. The error only surfaces as a silent runtime failure during tool execution.
7. **Concurrent Status Modification Race Conditions**:
   - If two workspace managers attempt to toggle an employee's status (`active` vs `paused`) at the same time, the last query wins without checking `updated_at` optimistic locks (`ETag` or version check), leading to silent state overwrites.
8. **In-Flight Active Conversation Memory Desync**:
   - When an employee is paused or deleted, ongoing chat sessions linked to that employee are not terminated. The active Temporal workflow continues running under the deleted employee's persona.
9. **Autonomy Level Slider is Purely Cosmetic**:
   - The UI displays an autonomy slider (1 to 5), but modifying this slider only updates a numeric column; it does not dynamically configure which tools require human confirmation in `employee_autonomy_rules`.
10. **Lack of Audit Logging on Roster Changes**:
    - Adding, modifying, or deleting an AI employee fails to write entries into `audit_events`.
11. **Lack of Per-Employee Model Selection**:
    - All employees run on whatever system model is default. An organization cannot assign Claude 3.5 Sonnet to Marcus (Coder/Ops) and GPT-4o to Sarah (Customer Success).
12. **Missing Rate Limiting on Employee Creation**:
    - There is no quota check on `POST /api/employees`. A script can generate 5,000 AI employees, exhausting database storage and degrading dashboard queries.
13. **Prompt Injection Risk in Persona Builder**:
    - Custom persona prompts are directly concatenated into the TrueForge system prompt without delimiter escaping, allowing malicious instructions to bypass system guardrails.
14. **Silent Inbound Lead Dropping on Paused Employees**:
    - When an employee assigned to inbound webhooks is paused, inbound messages are discarded without being routed to an active colleague or human triage queue.

---

## What's missing vs full product vision

1. **Dedicated Employee Profile & Performance Page (`/employees/[id]`)**:
   - Clicking an employee tile does not navigate to a detail view.
   - Missing an operational command center per employee: persona tuning, connected data sources, individual conversation history, and autonomous tool permissions.
2. **Per-Employee Analytics & Scorecard**:
   - `org_employee_metrics_daily` records metrics with `employee_role = '*'`.
   - Operators cannot see individual employee resolution times, customer approval ratings, or cost per employee.
3. **Structured Employee Offboarding Wizard**:
   - When deactivating an employee, prompt the manager: *"Reassign 14 active tasks to Emma before archiving?"*.
4. **Tool Permission Selector Mapped to Real Catalog**:
   - The creation modal only lists 12 hardcoded tool checkboxes, omitting 50 tools from the actual 62-tool catalog (such as `apollo`, `database_query`, `web_extract`, `notion`).
5. **A/B Testing Prompt Variations per Employee**:
   - Organizations cannot test two versions of an employee's system prompt to measure differences in conversion rates or CSAT scores.
6. **Working Hours & Shift Configuration**:
   - Ability to configure active operational hours (e.g. Marcus works 9 AM - 6 PM EST; Sarah handles night shifts).
7. **Synthetic Voice Profile Selection**:
   - For voice-call agents, selecting ElevenLabs / Cartesia voice profiles directly from the employee card.
8. **Multi-Agent Collaboration Graph Visualizer**:
   - An interactive visual graph showing how Sarah delegates escalations to Marcus and passes financial queries to Emma.

---

## What to add for full SaaS

### 1. Database Schema Enhancements Migration
Create `infra/db/migrations/028_employees_soft_delete_and_profiles.sql`:
```sql
-- Migration: 028_employees_soft_delete_and_profiles.sql
-- Enables employee soft-deletion, task reassignment, model overrides, and working hours

ALTER TABLE ai_employees
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS voice_id TEXT,
  ADD COLUMN IF NOT EXISTS model_override VARCHAR(64),
  ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '{"timezone":"UTC","all_hours":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS prompt_version INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Replace hard delete index with active partial index
CREATE INDEX IF NOT EXISTS idx_ai_employees_active_org 
  ON ai_employees (org_id, status) 
  WHERE archived_at IS NULL;

-- Track whether initial onboarding seeding has occurred so we never reseed deleted rosters
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS employees_seeded BOOLEAN DEFAULT FALSE;
```

### 2. Guarded Soft-Delete with Task Reassignment (`apps/dashboard/app/api/employees/[id]/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole, canDisableEmployee } from '@/lib/rbac';

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (!canDisableEmployee(role)) {
      return NextResponse.json({ error: 'Forbidden: Insufficient privileges' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const reassignTo = searchParams.get('reassignTo');

    // 1. Check for open work items assigned to this employee
    const openTasks = await client.query(
      `SELECT COUNT(*) AS count FROM work_items 
        WHERE assignee_employee_id = $1 AND org_id = $2 
          AND status IN ('open', 'needs_attention', 'waiting_approval')`,
      [params.id, orgId]
    );

    const taskCount = parseInt(openTasks.rows[0].count, 10);
    if (taskCount > 0 && !reassignTo) {
      return NextResponse.json({
        error: `Employee has ${taskCount} active tasks. You must provide a reassignTo parameter to reassign them before archiving.`,
        activeTaskCount: taskCount
      }, { status: 409 });
    }

    await client.query('BEGIN');

    // 2. Reassign open tasks if target employee provided
    if (taskCount > 0 && reassignTo) {
      await client.query(
        `UPDATE work_items 
            SET assignee_employee_id = $1, updated_at = NOW() 
          WHERE assignee_employee_id = $2 AND org_id = $3`,
        [reassignTo, params.id, orgId]
      );
    }

    // 3. Soft-delete employee
    const res = await client.query(
      `UPDATE ai_employees 
          SET status = 'archived', archived_at = NOW(), updated_at = NOW() 
        WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
        RETURNING id, name`,
      [params.id, orgId]
    );

    if (res.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // 4. Record audit event
    await client.query(
      `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
       VALUES ($1, 'user', $2, 'employee.archived', 'ai_employee', $3, 'medium', 'success', $4)`,
      [orgId, userId, params.id, JSON.stringify({ reassignedTasks: taskCount, reassignTo })]
    );

    await client.query('COMMIT');
    return NextResponse.json({ success: true, archived: res.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

### 3. Autonomy Rule Auto-Seeding on Custom Employee Creation
In `apps/dashboard/app/api/employees/route.ts`:
```typescript
import { VALID_TOOL_NAMES } from '@/lib/tool-catalog';

// Inside POST handler:
const { name, role, persona, toolAllowlist, autonomyTier = 'act_internally', modelOverride } = body;

// Validate tools against official catalog
if (toolAllowlist && Array.isArray(toolAllowlist)) {
  const invalid = toolAllowlist.filter((t: string) => !VALID_TOOL_NAMES.has(t));
  if (invalid.length > 0) {
    return NextResponse.json({
      error: `Invalid tools specified: ${invalid.join(', ')}. Must belong to official tool catalog.`,
    }, { status: 400 });
  }
}

// Insert employee
const empRes = await client.query(
  `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status, model_override, created_by_user_id)
   VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
   RETURNING *`,
  [orgId, name, role, persona, toolAllowlist || [], modelOverride || null, userId]
);

const newEmp = empRes.rows[0];

// Automatically seed autonomy rules for this role
await client.query(
  `INSERT INTO employee_autonomy_rules (org_id, employee_role, autonomy_tier, min_confidence, reversibility)
   VALUES ($1, $2, $3, 0.85, 'reversible')
   ON CONFLICT (org_id, employee_role) DO NOTHING`,
  [orgId, newEmp.role, autonomyTier]
);
```

### 4. Robust React UI Error Rollback (`apps/dashboard/app/(dashboard)/employees/page.tsx`)
```typescript
async function handleDelete(id: string) {
  const previous = [...employees];
  setEmployees(prev => prev.filter(e => e.id !== id));

  try {
    const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      setEmployees(previous); // Rollback optimistic state
      alert(err.error || 'Failed to archive employee');
      return;
    }
  } catch (err) {
    setEmployees(previous); // Rollback optimistic state
    alert('Network error archiving employee');
  }
}
```

### 5. Dedicated Employee Profile Page (`/employees/[id]/page.tsx`)
```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Bot, Shield, Wrench, Clock, Activity } from 'lucide-react';

export function EmployeeDetailPage() {
  const params = useParams();
  const [employee, setEmployee] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/employees/${params.id}`)
      .then(res => res.json())
      .then(data => {
        setEmployee(data.employee);
        setLoading(false);
      });
  }, [params.id]);

  if (loading) return <div className="p-8 text-center text-gray-500">Loading digital worker...</div>;
  if (!employee) return <div className="p-8 text-center text-gray-500">Employee not found.</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center space-x-4 bg-white dark:bg-gray-900 p-6 rounded-xl border">
        <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
          <Bot className="w-8 h-8 text-blue-600 dark:text-blue-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{employee.name}</h1>
          <p className="text-sm text-gray-500">{employee.role} · Model: {employee.model_override || 'Default System'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-900 p-6 rounded-xl border">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center">
            <Wrench className="w-4 h-4 mr-2" /> Tool Permissions ({employee.tool_allowlist?.length || 0})
          </h3>
          <div className="flex flex-wrap gap-2">
            {employee.tool_allowlist?.map((tool: string) => (
              <span key={tool} className="px-2.5 py-1 text-xs bg-gray-100 dark:bg-gray-800 rounded-md font-mono">
                {tool}
              </span>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 p-6 rounded-xl border">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center">
            <Clock className="w-4 h-4 mr-2" /> Working Hours & Schedule
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {employee.working_hours?.all_hours ? 'Active 24/7 (Always responding)' : 'Custom shift schedule'}
          </p>
        </div>
      </div>
    </div>
  );
}
### 6. Employee Activity History Endpoint (`/api/employees/[id]/activity/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const { client, orgId } = await getScopedClient();
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '25', 10), 50);

    const res = await client.query(
      `SELECT wi.id, wi.title, wi.status, wi.priority, wi.created_at, wi.updated_at
         FROM work_items wi
        WHERE wi.org_id = $1 AND wi.assignee_employee_id = $2
        ORDER BY wi.updated_at DESC
        LIMIT $3`,
      [orgId, params.id, limit]
    );

    return NextResponse.json({ activities: res.rows });
  } finally {
    client.release();
  }
}
```

### 7. Prompt Versioning & Evaluation Engine (`/api/employees/[id]/prompts/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { systemPrompt, changeDescription } = await request.json();
    if (!systemPrompt) return NextResponse.json({ error: 'System prompt required' }, { status: 400 });

    await client.query('BEGIN');

    // Archive current prompt version
    const current = await client.query(
      `SELECT persona, prompt_version FROM ai_employees WHERE id = $1 AND org_id = $2`,
      [params.id, orgId]
    );
    if (current.rowCount === 0) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    const newVersion = (current.rows[0].prompt_version || 1) + 1;

    // Record prompt history
    await client.query(
      `INSERT INTO employee_prompt_history (org_id, employee_id, version, prompt, changed_by_user_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, params.id, newVersion, systemPrompt, userId, changeDescription || 'Updated persona prompt']
    );

    // Update active persona
    await client.query(
      `UPDATE ai_employees 
          SET persona = $1, prompt_version = $2, updated_at = NOW()
        WHERE id = $3 AND org_id = $4`,
      [systemPrompt, newVersion, params.id, orgId]
    );

    await client.query('COMMIT');
    return NextResponse.json({ success: true, version: newVersion });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

---

## Fix priority

- **P0**: Hard deletion of employees silently orphans active customer tickets with zero reassignment; implement guarded soft-delete with mandatory task reassignment.
- **P0**: Custom hired employees bypass autonomy gating rules; auto-seed `employee_autonomy_rules` on employee creation.
- **P0**: Fix UI optimistic desynchronization to rollback component state when API rejects mutations.
- **P0**: Prevent automatic re-seeding of the default 8 employees when an organization intentionally empties its roster by setting `employees_seeded = true`.
- **P1**: Validate `tool_allowlist` against the master tool catalog to prevent runtime execution errors.
- **P1**: Build dedicated `/employees/[id]` detail view so operators can inspect persona configuration and activity logs.
- **P2**: Implement per-employee analytics breakdown in `org_employee_metrics_daily`.
- **P2**: Clean up dead `graph_id` legacy column in database and application routes.

---

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Multi-step roster/custom hire can leave orphan `ai_employees` rows | P0 | `apps/dashboard/lib/employee-provision.ts` | 🟢 Done | Transactional `seedDefaultEmployees` + `provisionCustomEmployee` with ROLLBACK. |
| 2 | GET reseeds default roster after intentional empty | P0 | `038_org_employees_seeded.sql` | 🟢 Done | `orgs.employees_seeded` respected on seed. |
| 3 | Custom hire skips autonomy rules | P0 | `provisionCustomEmployee` | 🟢 Done | Seeds autonomy rules in same txn. |
| 4 | Cold-start observation for new employee | P1 | `ensureEmployeeColdStart` | 🟢 Done | Stage-0 `org_runtime_controls` + real `org_first_observations`. |
| 5 | UI optimistic desync on 403/4xx | P0 | `employees/page.tsx` | 🟢 Done | Rollback on failed PATCH/DELETE. |
| 6 | Hard-delete orphans work items | P0 | `[id]/route.ts` DELETE | 🟢 Done | Soft-archive (`archived_at`) + mandatory `reassignTo` when open tasks exist (migration 039). |
| 7 | Tool allowlist unvalidated | P1 | `lib/tool-allowlist.ts` | 🟢 Done | POST/PATCH validate against `VALID_TOOLS` + known extras. |
| 8 | `/employees/[id]` profile page | P1 | `employees/[id]/page.tsx` + activity API | 🟢 Done | Real employee + work_items activity. |
| 9 | Per-employee metrics keyed on employee UUID | P1 | `lib/employee-performance.ts` + `employees/[id]/metrics/route.ts` | 🟢 Done | Work-item counts, completion rate, avg resolution per `assignee_employee_id`; shown on the profile page. Decision-ledger stats stay role-level (`agent_decision_ledger` has no employee UUID column). |
