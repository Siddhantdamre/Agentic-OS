# Decisions Audit

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Approval never re-executes parked tool (`PATCH /api/decisions` dead-end) | P0 | `apps/dashboard/app/api/decisions/route.ts` | 🟢 Done | PATCH approves atomically, releases DB, runs `executeAutonomousToolAction` with `skipAutonomy`, writes `executed` / `execution_failed` + audit. Migration `101_decisions_execution.sql`. |
| 2 | Dead ternary `isRefund ? 'reject' : 'reject'` | P0 | `services/workflows/src/autonomy.ts` | 🟢 Done | Recommendation is `isRefund ? 'reject' : 'approve'`. |
| 3 | Missing payload summary on parked actions | P1 | `services/workflows/src/autonomy.ts` | 🟢 Done | `buildActionSummary` written into parked payload `summary`. |
| 4 | Work-item decision `modifiedArgs` + split-brain | P0 | `apps/dashboard/app/api/work-items/[id]/decision/route.ts` | 🟢 Done | Persists `modifiedArgs`; embeds them in Temporal `optionId` JSON; checks `getTemporalClient()` before signal; compensate+502 on failure; client released before Temporal. |
| 5 | Role gates / dual-auth / expiry sweeper / history on `/api/decisions` | P1–P2 | `/api/decisions` + `/api/decisions/sweep` | 🟢 Done | Auditors blocked; refunds owner/admin; refunds require 2 distinct approvals; `GET ?history=1`; `POST /api/decisions/sweep` expires past-due pending (never approves). |
| 6 | Approve/reject audit kinds rejected by `audit_events_kind_chk`, error swallowed (27sept OPS-B01) | P0 | `lib/decide-approval.ts`, migration `150` | 🟡 Tree | Migration 150 adds `decision.*` + conversation/channel/billing/skill/impersonation kinds; audit insert shares a transaction with the status change and throws `AuditWriteError` (rollback) instead of swallowing. `AUDIT_EVENT_KINDS` pinned to the newest CHECK by `audit-events.test.ts`. Unit-tested; migration not applied to a live DB. |
| 7 | `/api/agent/pending-actions` approved with no RBAC / dual approval / audit and never executed (27sept OPS-S01) | P0 | `app/api/agent/pending-actions/route.ts` | 🟡 Tree | Token route, `/api/decisions` PATCH and parked decision cards in `/api/work-items/[id]/decision` all call `decideApproval`: role gate (auditor/billing 403, refunds owner/admin, pay tools `canCallPayTools`), dual approval, expiry, execute-on-final-approval with timeout, `modifiedPayload` ≤16 KB object. `decide-approval.test.ts` (10 cases). |
| 8 | Expiry sweeper had no caller; manual sweep stamped `decided_by` = sweeping user (27sept OPS-G01) | P0 | `services/workflows/src/workflows/governance-sweep.ts` | 🟡 Tree | Worker sweep every 15 min per org expires past-due decisions with `decided_by` NULL, a system `decision.expired` audit row, and cancels the linked decision card; work-item SLA breach runs in the same sweep. Bundle + unit tests; not run against a live Temporal. |
| 9 | Approving a held send, payment, signature, publish or delete never ran it: the executor re-ran it as a new call, so the gate held it again (a new pending approval each time) while the API said "executed" and the audit log said approved_and_executed. A returned tool error was recorded as executed too. | P0 | `apps/dashboard/lib/decide-approval.ts` | 🟢 Done | Re-enters with the approved row id, the approver, source `approval` and the employee that asked; a returned error or a call held again is `execution_failed` with one plain sentence. Row 1 was only true for reads, drafts and writes. Proven by 11 unit tests and harness flows F3 to F6 against the real stack (exactly one send reaches the provider). |
| 10 | In Ask AI, approving in the chat card and then again in Decisions are two approvals for one action: the chat asks first, then the gate holds the call again as a database approval. | P1 | `services/workflows/src/local-turn.ts`, `tool-gate.ts` | 🔴 Open | Product decision: which is the single approval. Leading option: when a person allows a call in chat, create the database row already approved (with its audit entry) and run it through the gate as that row. Seen by harness flow F3. |
| 11 | A held chat approval lives in the memory of the server that asked. After a restart, or on a second replica, the card is dead and nothing runs. | P1 | `services/workflows/src/local-turn.ts` (`ActiveLocalSession`) | 🔴 Open | The person now sees "We could not finish that approval, so nothing was run. Please ask again, or approve it from Decisions" instead of "fetch failed" (harness flow F14). Making the approval durable is the same decision as row 10. |

## Status: working (approve executes parked tools; autonomy card/summary fixed; RBAC/dual-auth/sweep/history on `/api/decisions`)

The Human-in-the-Loop (HITL) decisions subsystem (`apps/dashboard/app/api/decisions/route.ts`, `services/workflows/src/autonomy.ts`, and `apps/dashboard/components/observability/PendingDecisionCard.tsx`) provides an approval gateway for autonomous actions exceeding confidence thresholds or carrying irreversible risk. It validates tokens, enforces session-scoped multi-tenancy, and applies status transitions (`pending` -> `approved` / `rejected`).

However, **approving an action is a dead end** (the database row is updated to `approved`, but no worker or runner ever re-executes the parked tool call), the recommendation logic contains a provably dead ternary (`isRefund ? 'reject' : 'reject'`), three duplicate endpoints read/write `agent_pending_actions` with divergent schemas, and the API lacks role-gated approval thresholds.

---

## What works (cite file:line)

1. **Multi-Tenant Pending Action Querying**:
   - `apps/dashboard/app/api/decisions/route.ts:4-15` — `GET /api/decisions`:
     - Resolves tenant context securely via `getScopedClient()`.
     - Queries `agent_pending_actions WHERE org_id = $1 AND status = 'pending' LIMIT 50`, returning typed camelCase objects.
2. **Conditional Atomic State Transitions**:
   - `apps/dashboard/app/api/decisions/route.ts:16-48` — `PATCH /api/decisions`:
     - Rejects body `org_id` overrides (`route.ts:21`).
     - Restricts transitions strictly to `status IN ('approved', 'rejected')`.
     - Conditional atomic update: `WHERE id = $1 AND org_id = $2 AND status = 'pending'`, preventing double-resolution.
     - Enforces server-side expiration checks: Appends `AND (expires_at IS NULL OR expires_at > NOW())` when approving, returning HTTP 409 Conflict if expired.
     - Stamped with the approving operator's user ID (`decided_by = $userId`).
3. **Autonomous Tool Interception & Parking**:
   - `services/workflows/src/autonomy.ts:310-381` — `parkPendingAction`:
     - Intercepts high-risk tool calls from `services/workflows/src/tool-executor.ts:267-282`.
     - Generates SHA-256 hashed approval tokens, never persisting raw authorization secrets in the database.
     - Automatically provisions linked `work_items` of type `'decision'` and dispatches non-blocking notifications to Slack.
4. **Autonomy Tier Evaluation Engine**:
   - `services/workflows/src/autonomy.ts:120-185`:
     - Evaluates proposed tool executions against four distinct autonomy tiers (`Notice`, `Draft`, `Act Internally`, `Act Externally`) and flags irreversible actions for mandatory human sign-off.
5. **Frontend Observation Wireup**:
   - `apps/dashboard/app/(dashboard)/observability/page.tsx:31-39`:
     - Fetches pending decisions and renders interactive `PendingDecisionCard` components with live approve/reject handlers.
6. **Connection Pool Safety Across Handlers**:
   - `apps/dashboard/app/api/decisions/route.ts:14, 46`:
     - Ensures checked-out database clients are promptly returned to the pool in `finally` blocks.
7. **Graceful Degradation on Inactive Actions**:
   - `apps/dashboard/app/api/decisions/route.ts:35-42`:
     - Returns explicit 404 when an action ID does not exist or has already been transitioned by another administrator.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Approval Never Triggers Tool Execution (Dead-End Approval) (P0)**:
   - When an operator clicks "Approve", `PATCH /api/decisions` updates `status = 'approved'` in `agent_pending_actions`.
   - However, **no background process, Temporal workflow, or cron job polls for approved actions or re-executes the tool**.
   - The tool execution parameters (`payload.tool`, `payload.action`, `payload.payload`) sit frozen in the database forever.
   - The UI informs the operator that the action was approved, but the underlying email is never sent, the refund is never processed, and the database change is never executed. This creates a severe false-positive UX.
2. **Provably Dead Ternary in Recommendation Engine (P0) (`services/workflows/src/autonomy.ts:296-297`)**:
   - In `autonomy.ts`, the recommendation builder contains:
     ```typescript
     recommendation: {
       optionId: isRefund ? 'reject' : 'reject',
       confidence: 0.9,
     }
     ```
   - Both branches of the ternary return `'reject'`.
   - For normal, non-refund actions (such as sending a follow-up email or creating a calendar event), the system erroneously tells the operator to reject the action, creating unnecessary operational friction.
3. **Generic Cards Due to Missing Payload Summary (`autonomy.ts:363`, `PendingDecisionCard.tsx:6`)**:
   - `PendingDecisionCard.tsx` displays `payload.summary`, falling back to `"Proposed " + actionType` if missing.
   - `parkPendingAction` never writes a `summary` property to `payload`.
   - Every decision card in the dashboard renders a generic title (*"Proposed send_email"*, *"Proposed refund"*), omitting the actual dollar amount, customer name, or message snippet contained in `payload.payload`.
4. **Three Duplicate Routes with Divergent Error Handling**:
   - The exact same `agent_pending_actions` table is managed by three independent routes:
     1. `/api/decisions` (`apps/dashboard/app/api/decisions/route.ts`)
     2. `/api/agent/pending-actions` (`apps/dashboard/app/api/agent/pending-actions/route.ts`)
     3. `/api/settings/pending` (`apps/dashboard/app/api/settings/pending/route.ts`)
   - `/api/settings/pending` handles missing tables gracefully, while `/api/decisions` throws unhandled 500 errors. None of the three trigger execution upon approval.
5. **Missing RBAC Checks on Financial Approvals**:
   - `PATCH /api/decisions` permits any logged-in organization member to approve pending actions.
   - There are no financial limits or role restrictions: a junior support agent can approve a $10,000 refund with zero admin escalation.
6. **Race Condition on Concurrent Multi-User Approvals**:
   - Two administrators open the dashboard and review a pending refund card simultaneously.
   - While the SQL `UPDATE ... WHERE status = 'pending'` prevents duplicate status updates, the lack of an execution worker lock means that if execution is triggered on approval, both could trigger external actions if not guarded by distributed locks.
7. **No Action Expiration Notification & Stale Row Buildup**:
   - When an action expires past its `expires_at` window, it remains in the database in `status = 'pending'`. The operator is only alerted of the expiration when clicking the Approve button and encountering an unexpected HTTP 409 error.
8. **Suspended Conversations Hang Indefinitely**:
   - When an agent parks an action pending approval, the conversation thread with the customer is placed in a waiting state. If the operator rejects or ignores the decision, no message is dispatched back to the customer informing them that their request was denied.
9. **Inability to Edit / Modify Parameters Prior to Approval**:
   - Operators can only click binary "Approve" or "Reject". If an AI proposes refunding $100 but policy requires $50, the operator cannot edit the parameter before approving.
10. **Missing Audit Logging on Decisions**:
    - Decisions approved or rejected do not write to the primary `audit_events` table, preventing compliance traceability.
11. **Lack of Idempotency Key in Tool Execution**:
    - If the tool execution fails with a network timeout after charging or refunding, a retry can duplicate the financial transaction because no unique idempotency key is passed to the underlying provider.
12. **Missing Batch Approval Capability in UI**:
    - In high-volume environments (e.g. 50 routine low-risk emails parked for review), operators must click "Approve" 50 times individually, with no "Approve All Verified" action.
13. **Absence of Real-Time UI Expiry Countdown**:
    - Decision cards do not display an active timer showing when the pending action will expire, leading to race conditions where an operator spends minutes reviewing a proposal only to have it expire mid-read.
14. **Silent Notification Failures on Slack Rate Limits**:
    - When Slack incoming webhook quotas are exceeded, notification dispatches fail silently, leaving operators unaware of urgent pending decisions.

---

## What's missing vs full product vision

1. **Automatic Execution Worker for Approved Actions**:
   - An automated consumer that listens for `action.approved` events or queries `WHERE status = 'approved' AND executed_at IS NULL`, calls `executeAutonomousToolAction()`, updates status to `executed`, and logs results.
2. **Historical Decision Audit Log View (`/decisions/history`)**:
   - Operators cannot review past decisions (who approved what and when). The UI only shows the current pending queue, and lacks a "Decision History" tab with filters for actor, employee, and status.
3. **Multi-Level Dual-Authorization Policies**:
   - Inability to configure dual-authorization rules (e.g. *"Refunds > $500 require approval from 2 managers"*).
4. **Proactive Background Expiration Sweeper**:
   - Automated cron job that periodically transitions expired pending actions to `expired` status and notifies the assigned agent to resume conversation with a timeout message.
5. **Contextual Conversation & Customer Sidecar**:
   - A decision card showing a customer refund or contract cancellation lacks a 1-click link to view the complete underlying conversation thread and CRM profile, forcing operators to manually search for context.
6. **Parameter Modification Modal ("Approve with Edits")**:
   - Allowing operators to adjust the draft email text or dollar amount before clicking "Approve with Modifications".
7. **Multi-Channel Urgent Escalation**:
   - When high-severity decisions sit unreviewed for >30 minutes, automatically escalate via SMS or phone call to the on-call manager.
8. **Compensating Rollback Button**:
   - A single-click "Revert Action" for executed decisions that automatically dispatches inverse operations (e.g. un-canceling a lease or cancelling a scheduled event).

---

## What to add for full SaaS

### 1. Database Schema Enhancements Migration
Create `infra/db/migrations/030_decisions_execution_and_policies.sql`:
```sql
-- Migration: 030_decisions_execution_and_policies.sql
-- Enables tool execution state tracking, modifications, and role-based decision policies

ALTER TABLE agent_pending_actions
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_result JSONB,
  ADD COLUMN IF NOT EXISTS execution_error TEXT,
  ADD COLUMN IF NOT EXISTS modified_payload JSONB,
  ADD COLUMN IF NOT EXISTS required_role VARCHAR(32) DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64) DEFAULT encode(gen_random_bytes(32), 'hex');

CREATE TABLE IF NOT EXISTS decision_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  tool_name VARCHAR(64) NOT NULL,
  min_role VARCHAR(32) NOT NULL DEFAULT 'admin',
  max_auto_amount NUMERIC(10, 2) DEFAULT 0,
  require_two_approvals BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_org_tool_policy UNIQUE(org_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_execution 
  ON agent_pending_actions(org_id, status) 
  WHERE status IN ('approved', 'pending');

CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_expiry
  ON agent_pending_actions(expires_at)
  WHERE status = 'pending';
```

### 2. Complete Execution Engine on Approval (`apps/dashboard/app/api/decisions/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';
import { broadcastToOrg } from '@/lib/realtime-hub';
import { executeAutonomousToolAction } from '@/services/workflows/dist/tool-executor';

export async function PATCH(request: Request) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const body = await request.json();
    const { id, status, modifiedPayload } = body;

    if (!id || !['approved', 'rejected'].includes(status)) {
      return NextResponse.json({ error: 'Invalid decision payload' }, { status: 400 });
    }

    const role = await loadHumanRole(client, orgId, userId);

    // Fetch existing pending action
    const existing = await client.query(
      `SELECT * FROM agent_pending_actions WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    if (existing.rowCount === 0) {
      return NextResponse.json({ error: 'Decision action not found' }, { status: 404 });
    }
    const action = existing.rows[0];

    // Enforce role gates for sensitive financial tools
    if (action.payload?.tool === 'stripe_refund' && role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Only workspace owners and admins can approve refunds.' }, { status: 403 });
    }

    if (status === 'approved') {
      // 1. Mark as approved atomically with expiration check
      const lockRes = await client.query(
        `UPDATE agent_pending_actions
            SET status = 'approved',
                decided_by = $1,
                modified_payload = COALESCE($2::jsonb, modified_payload),
                updated_at = NOW()
          WHERE id = $3 AND org_id = $4 AND status = 'pending'
            AND (expires_at IS NULL OR expires_at > NOW())
          RETURNING *`,
        [userId, modifiedPayload ? JSON.stringify(modifiedPayload) : null, id, orgId]
      );

      if (lockRes.rowCount === 0) {
        return NextResponse.json({ error: 'Action already resolved or expired.' }, { status: 409 });
      }

      const lockedRow = lockRes.rows[0];
      const payloadToExecute = lockedRow.modified_payload || lockedRow.payload?.payload;

      // 2. Immediately execute tool action with idempotency
      try {
        const executionResult = await executeAutonomousToolAction(
          lockedRow.payload?.tool,
          payloadToExecute,
          { 
            orgId, 
            userId, 
            isResumedApproval: true,
            idempotencyKey: lockedRow.idempotency_key 
          }
        );

        // 3. Mark executed in DB
        await client.query(
          `UPDATE agent_pending_actions
              SET status = 'executed',
                  executed_at = NOW(),
                  execution_result = $1::jsonb
            WHERE id = $2`,
          [JSON.stringify(executionResult), id]
        );

        // 4. Audit Log
        await client.query(
          `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
           VALUES ($1, 'user', $2, 'decision.approved_and_executed', 'agent_pending_actions', $3, 'high', 'success', $4)`,
          [orgId, userId, id, JSON.stringify({ tool: lockedRow.payload?.tool, result: executionResult })]
        );

        broadcastToOrg(orgId, { type: 'decision_executed', id, result: executionResult });
        return NextResponse.json({ success: true, status: 'executed', result: executionResult });
      } catch (execErr: any) {
        await client.query(
          `UPDATE agent_pending_actions
              SET status = 'execution_failed',
                  execution_error = $1
            WHERE id = $2`,
          [execErr.message || String(execErr), id]
        );

        await client.query(
          `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
           VALUES ($1, 'user', $2, 'decision.execution_failed', 'agent_pending_actions', $3, 'high', 'failure', $4)`,
          [orgId, userId, id, JSON.stringify({ error: execErr.message })]
        );

        return NextResponse.json({ success: false, status: 'execution_failed', error: execErr.message }, { status: 500 });
      }
    } else {
      // Rejection logic
      await client.query(
        `UPDATE agent_pending_actions
            SET status = 'rejected',
                decided_by = $1,
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3 AND status = 'pending'`,
        [userId, id, orgId]
      );

      // Audit Log
      await client.query(
        `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status)
         VALUES ($1, 'user', $2, 'decision.rejected', 'agent_pending_actions', $3, 'medium', 'success')`,
        [orgId, userId, id]
      );

      broadcastToOrg(orgId, { type: 'decision_rejected', id });
      return NextResponse.json({ success: true, status: 'rejected' });
    }
  } finally {
    client.release();
  }
}
```

### 3. Fix Dead Ternary in Recommendation Engine
In `services/workflows/src/autonomy.ts:296-297`:
```typescript
recommendation: {
  optionId: isRefund ? 'reject' : 'approve',
  confidence: isRefund ? 0.95 : 0.85,
}
```

### 4. Enforce Rich Human-Readable Summary on Action Creation
In `services/workflows/src/autonomy.ts:360`:
```typescript
export function buildActionSummary(tool: string, action: string, payload: any): string {
  if (tool === 'stripe_refund' || tool === 'mcp.darex.billing_refund') {
    return `Refund $${(payload.amount / 100).toFixed(2)} to ${payload.customerEmail || payload.customerId || 'Customer'}`;
  }
  if (tool === 'gmail_send' || tool === 'mcp.darex.email_send') {
    return `Send email "${payload.subject || 'Follow-up'}" to ${payload.to}`;
  }
  if (tool === 'calendar_create' || tool === 'mcp.darex.calendar_create') {
    return `Schedule showing for ${payload.summary || 'Property'} on ${payload.startTime}`;
  }
  if (tool === 'hubspot_deal_update') {
    return `Update deal "${payload.dealName || payload.dealId}" stage to "${payload.stage}"`;
  }
  return `Execute ${tool}.${action || 'run'}`;
}
```

### 5. Proactive Expiration Sweeper Cron (`services/workflows/src/workflows/expiration-sweeper.ts`)
```typescript
import { getPool } from '@/lib/db';
import { broadcastToOrg } from '@/lib/realtime-hub';

export async function sweepExpiredDecisions() {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE agent_pending_actions
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING id, org_id, conversation_id`
  );

  for (const row of res.rows) {
    broadcastToOrg(row.org_id, { type: 'decision_expired', id: row.id });
    if (row.conversation_id) {
      // Notify conversation thread that the approval timed out
      await pool.query(
        `INSERT INTO messages (conversation_id, org_id, role, content, meta)
         VALUES ($1, $2, 'system', 'The requested action timed out before receiving manager approval.', '{"reason":"decision_expired"}')`,
        [row.conversation_id, row.org_id]
      );
    }
  }
}
```

### 6. Interactive Decision Card with Edit Modal (`PendingDecisionCard.tsx`)
```tsx
'use client';

import { useState } from 'react';
import { CheckCircle2, XCircle, Clock, Edit3, AlertTriangle } from 'lucide-react';

export function PendingDecisionCard({ action, onActionComplete }: { action: any; onActionComplete: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modifiedJson, setModifiedJson] = useState(JSON.stringify(action.payload?.payload, null, 2));

  const handleDecision = async (status: 'approved' | 'rejected', payload?: any) => {
    setLoading(true);
    try {
      const res = await fetch('/api/decisions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: action.id,
          status,
          modifiedPayload: payload,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to resolve decision');
      }
      onActionComplete();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-900/50 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            {action.payload?.tool || 'Action Required'}
          </span>
          {action.expires_at && (
            <span className="text-xs text-gray-500 flex items-center">
              <Clock className="w-3.5 h-3.5 mr-1" />
              Expires {new Date(action.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="text-xs text-gray-500 hover:text-blue-600 flex items-center"
        >
          <Edit3 className="w-3.5 h-3.5 mr-1" /> {isEditing ? 'Cancel Edit' : 'Edit Params'}
        </button>
      </div>

      <h4 className="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-2">
        {action.payload?.summary || `Proposed ${action.action_type || 'Execution'}`}
      </h4>

      {isEditing ? (
        <div className="mb-4">
          <textarea
            value={modifiedJson}
            onChange={(e) => setModifiedJson(e.target.value)}
            rows={5}
            className="w-full text-xs font-mono bg-gray-50 dark:bg-gray-950 p-2.5 rounded border border-gray-300 dark:border-gray-800"
          />
        </div>
      ) : (
        <pre className="text-xs bg-gray-50 dark:bg-gray-950 p-3 rounded-lg overflow-x-auto text-gray-700 dark:text-gray-300 mb-4 max-h-36">
          {JSON.stringify(action.payload?.payload, null, 2)}
        </pre>
      )}

      <div className="flex space-x-3">
        <button
          disabled={loading}
          onClick={() => {
            const parsed = isEditing ? JSON.parse(modifiedJson) : undefined;
            handleDecision('approved', parsed);
          }}
          className="flex-1 inline-flex justify-center items-center py-2 px-4 border border-transparent rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none"
        >
          <CheckCircle2 className="w-4 h-4 mr-1.5" />
          {isEditing ? 'Approve with Edits' : 'Approve & Execute'}
        </button>
        <button
          disabled={loading}
          onClick={() => handleDecision('rejected')}
          className="inline-flex justify-center items-center py-2 px-4 border border-gray-300 dark:border-gray-700 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <XCircle className="w-4 h-4 mr-1.5" />
          Reject
        </button>
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Close the execution loop on approval so that approved tool actions actually execute against target APIs instead of terminating in a dead-end database update.
- **P0**: Fix the dead ternary in `autonomy.ts` that erroneously recommends rejecting all non-refund actions.
- **P1**: Add role-based approval limits to prevent unprivileged members from approving sensitive actions or refunds.
- **P1**: Populate human-readable summaries on pending action payloads to replace generic `"Proposed <action>"` card labels.
- **P1**: Implement parameter modification modal ("Approve with Edits") to avoid blocking operations over minor discrepancies.
- **P2**: Consolidate duplicate endpoints (`/api/decisions`, `/api/agent/pending-actions`, `/api/settings/pending`) into a single canonical route.
- **P2**: Build a historical decision audit log view in the dashboard (`/decisions/history`).
- **P2**: Deploy background expiration sweeper to automatically mark stale decisions expired and resume waiting conversation threads.
