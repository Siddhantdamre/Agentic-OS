# Ask AI Audit

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | `dailySessionKey` omitted orgId → cross-tenant session cache leak | P0 | `apps/dashboard/app/api/ask-ai/route.ts` | 🟢 Done | `dailySessionKey(orgId, userId)` → `askai-${orgId}-${userId}-{day}`; already on branch. |
| 2 | Execute cancellation poll used raw `pool.connect()` → RLS hides cancelled plans | P0 | `apps/dashboard/app/api/ask-ai/execute/route.ts` | 🟢 Done | Uses `getOrgScopedClient(orgId)` then releases. |
| 3 | Disconnected client continues tool execution mid-stage | P0 | `apps/dashboard/app/api/ask-ai/execute/route.ts` | 🟢 Done | Stage-start abort + per-step `raceAbort(request.signal, …)` + cancel on AbortError; further stages not scheduled. |
| 4 | Unscoped plan lookups leak across users in same org | P0 | `apps/dashboard/app/api/ask-ai/plan/route.ts` | 🟢 Done | List/get scoped by session `user_id` (NULL user_id rows still readable for legacy). |
| 5 | Missing `userId` in `executeAutonomousToolAction` during plan execute | P1 | `apps/dashboard/app/api/ask-ai/execute/route.ts` | 🟢 Done | Session `userId` passed into executor params for actor attribution. |
| 6 | Thread context silenced on DB persist failure | P1 | `apps/dashboard/app/api/ask-ai/route.ts` | 🟢 Done | Emits NDJSON `warning` / JSON `warning` when context load fails; does not silently pretend history exists. |
| 7 | Double-click execute race | P0 | `apps/dashboard/app/api/ask-ai/execute/route.ts` | 🟢 Done | Atomic `UPDATE … WHERE status='approved' RETURNING` lock; second caller gets 409. |
| 8 | Prompt token bloat (30 raw messages) | P1 | `apps/dashboard/app/api/ask-ai/route.ts` | 🟢 Done | History capped to 12 messages × 2000 chars. |
| 9 | Interactive step parameter editor | P1 | `components/chat/PlanCard.tsx` + plan PATCH | 🟢 Done | Edit-params JSON editor; PATCH merges `payload`; wired from ask-ai page. |
| 10 | Ask AI Redis rate-limit + mid-plan failure freeze | P1–P2 | `execute/route.ts` / `PlanExecuteWorkflow.ts` / `105_ask_ai_plan_compensation.sql` | 🟢 Done | Redis limiter live. On mid-plan step failure after earlier successes: status=`completed_with_errors` (never `completed`), `compensation_steps` freeze log records priorSucceeded + failed step (SSE + Temporal). External connector undo still needs tool-level inverses (not in tool-executor this pass). |

## Status: working (classify-plan-confirm-execute live; Redis rate-limit + mid-plan failure freeze live)

The Ask AI domain (`apps/dashboard/app/(dashboard)/ask-ai/page.tsx`, `/api/ask-ai/*`, `lib/classify.ts`, and `lib/plan-generator.ts`) represents the flagship human-in-the-loop operational interface. It provides heuristic + LLM intent classification, plan generation with tool validation, RLS-enforced persistence in `agent_plans`, Temporal-backed durable execution for irreversible actions, NDJSON/SSE streaming, and promotion of successful plans into reusable organization playbooks.

However, **rate limiting is strictly in-memory (single-replica only)**, dropped client connections continue executing downstream tools in background stages, plan execution lacks Saga-style rollback/compensation on mid-workflow step failures, thread context is lost silently if conversation persistence throws, and pending plan lookups lack user-level scoping, risking privacy leaks within multi-user organizations.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Layered Intent Classification**:
   - `apps/dashboard/lib/classify.ts:93-141`:
     - Executes regex heuristics first for low latency, falling back to LiteLLM classification (`classifyWithAgent`, lines 57-88) with a 20-second timeout.
     - Degrades safely to `{ type: 'simple' }` when ambiguous (`classify.ts:140`), deliberately preventing premature complex plan generation.
2. **Strict Plan Tool Allowlist Sanitization**:
   - `apps/dashboard/lib/plan-generator.ts:23-33, 120-142`:
     - `sanitizeSteps` normalizes tool aliases (e.g. `calendar` -> `google-calendar`) and rejects any step referencing tools not present in `VALID_TOOLS`.
     - Deduplicates steps using a `tool:action:payload` signature check.
3. **Robust Finite State Machine in `agent_plans`**:
   - `apps/dashboard/app/api/ask-ai/plan/route.ts:83-93` and `execute/route.ts:102-109`:
     - Enforces atomic transitions: `pending` -> `approved` -> `running` -> `completed` / `completed_with_errors` / `cancelled`.
     - Rejects attempts to execute unapproved or cancelled plans.
4. **Durable Temporal Offloading for Irreversible Steps**:
   - `apps/dashboard/app/api/ask-ai/execute/route.ts:130-156`:
     - Detects destructive actions (`planRequiresDurableExecute`) and dispatches `startPlanExecuteWorkflow` in Temporal.
     - If Temporal is offline, it honestly reverts plan status and returns HTTP 503 (*"Temporal is unavailable. Send/pay/sign plans cannot fall back to HTTP SSE"*), upholding strict anti-fabrication standards.
5. **Staged Parallel Tool Execution**:
   - `apps/dashboard/app/api/ask-ai/execute/route.ts:253, 276, 299`:
     - Evaluates dependency graphs via `stageSteps`, running independent tool actions in parallel while piping prior-stage outputs into dependent tools via `{{stepN_output}}` templates.
6. **Real-Time TrueForge Approval-Resume Loop**:
   - `apps/dashboard/app/api/ask-ai/approve/route.ts:48-184`:
     - Re-signs tenant context headers and calls `resumeTrueForgeTurn()` with strictly locked tool allowlists, preventing privilege escalation upon resumption.
7. **Playbook Self-Improvement Promotion Loop**:
   - `apps/dashboard/app/api/ask-ai/feedback/route.ts:168-243`:
     - Allows managers to promote successful multi-step plans into reusable organizational playbooks (`org_playbook_promotions`), training the organization's collective intelligence.
8. **Pool Hygiene Prior to SSE Streams**:
   - `apps/dashboard/app/api/ask-ai/route.ts:310-318`:
     - Releases pooled PostgreSQL clients before initiating SSE streaming responses, protecting against connection starvation.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Disconnected Client Continues Executing Downstream Tool Actions (`apps/dashboard/app/api/ask-ai/execute/route.ts:276-350`) (P0)**:
   - *User Impact*: Unmonitored actions executed in the wild. If a user closes their laptop while Step 1 is executing, the server continues executing subsequent steps (e.g. sending real emails, creating CRM deals, charging credit cards) without human supervision.
   - *Code Cause*: The execution loop does not listen to `request.signal.aborted`. It continues iterating through remaining stages and calling `executeAutonomousToolAction()`.
2. **Cross-User Information Leak in Unscoped Plan Lookups (`apps/dashboard/app/api/ask-ai/plan/route.ts:24-29`) (P0)**:
   - *User Impact*: Severe internal confidentiality breach. If an HR manager or executive drafts a plan involving sensitive employee salaries or private customer refunds, any coworker opening `/ask-ai` sees the drafted plan and parameters on their screen.
   - *Code Cause*: `GET /api/ask-ai/plan` queries `WHERE org_id = $1 AND status IN ('pending', 'approved', 'running')` without scoping by `user_id = $2`.
3. **Swallowed Thread Context Loss on Database Hiccups (`apps/dashboard/app/api/ask-ai/route.ts:273-276`) (P1)**:
   - *User Impact*: Sudden AI amnesia during long research sessions. The AI suddenly answers as if it never saw previous messages in the thread.
   - *Code Cause*: The route wraps message insertion in a `try/catch` block that resets `priorMessages = []` on any Postgres glitch. The turn proceeds without history and without alerting the user that previous context was discarded.
4. **In-Memory Rate Limiting Cluster Failure (`apps/dashboard/lib/rate-limit.ts:17`) (P1)**:
   - *User Impact*: Multi-replica bypass. Rapid clicks or automated scripts flood the LiteLLM gateway, exhausting monthly budgets and saturating database connections.
   - *Code Cause*: Rate limiting and concurrency locks (`RATE_LIMIT_ASK_AI_CONCURRENCY = 3`) are stored in a local in-memory JavaScript `Map` that is not shared across multi-container or serverless deployments.
5. **Absence of Plan Rollback / Compensating Actions (Saga Pattern)**:
   - *User Impact*: Inconsistent state across external systems when mid-plan steps fail.
   - *Code Cause*: If Step 1 creates a HubSpot contact and Step 2 creates a Google Calendar event, but Step 3 fails, the workflow simply stops. There is no automated rollback or "Undo Executed Steps" action to clean up orphaned records.
6. **Race Condition on Double-Clicking Execute**:
   - *User Impact*: Duplicate emails sent to customers and double-booked calendar slots.
   - *Code Cause*: When execute is clicked twice rapidly, both requests pass the initial `status === 'approved'` check before either updates the status to `running`, launching two concurrent execution loops.
7. **Severe Prompt Token Bloat in Long Conversations (`apps/dashboard/app/api/ask-ai/route.ts:285`)**:
   - *User Impact*: Slow responses (>15s latency) and ballooning LLM token costs.
   - *Code Cause*: Threads load up to 30 raw messages, including verbose multi-kilobyte JSON tool payloads, resulting in 40k+ prompt tokens sent to LiteLLM on every conversational turn.
8. **UI Table Flickering During Markdown Streaming**:
   - *User Impact*: Distracting layout jitter as tables stream.
   - *Code Cause*: The streaming markdown renderer continually unmounts and remounts table elements before complete row closing delimiters (`|`) arrive in the SSE stream.
9. **Inability to Edit Plan Step Parameters in the UI**:
   - *User Impact*: Friction in human-in-the-loop workflows. If the AI suggests sending an email to the wrong address or picking 2:00 PM instead of 3:00 PM, the user must reject the entire plan and re-prompt from scratch.
   - *Code Cause*: `PlanCard.tsx` only renders read-only step summaries and action buttons (`Approve`, `Reject`).
10. **Lack of In-App Token & Cost Visibility**:
    - *User Impact*: Blindness to infrastructure costs. Operators cannot see how many tokens or cents a query consumed.
    - *Code Cause*: The SSE stream omits `usage` metadata in its final chunk.
11. **Stuck In-Flight Plans on Process Restart**:
    - *User Impact*: Plans permanently frozen in `running` state.
    - *Code Cause*: No startup reconciliation sweep marks stale `running` plans as `failed` or `resumable`.
12. **Missing Multi-Modal Attachment Support**:
    - *User Impact*: Users cannot drag-and-drop spreadsheets or screenshots into the prompt bar for instant analysis.
    - *Code Cause*: The input bar only accepts plain text strings.
13. **Cross-Tenant Session Cache Leakage in `dailySessionKey` (`apps/dashboard/app/api/ask-ai/route.ts:49-52, 427`) (P0)**:
    - *User Impact*: Multi-tenant data contamination. A user belonging to multiple organizations or switching orgs during the same day has their conversation history, memory chunks, and previous tool outputs from Org A injected into their session in Org B.
    - *Code Cause*: `dailySessionKey` is defined as:
      ```ts
      function dailySessionKey(userId: string): string {
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        return `askai-${userId}-${day}`;
      }
      ```
      It completely omits `orgId`. In `runDirectAgentStream` (line 427), this key is passed directly to the agent runtime (`runAutonomousAgentDirect({ sessionKey, ... })`), causing the TrueForge agent loop to retrieve the session cache from the first tenant for queries run under the second tenant.
14. **Silent Failure of Execution Cancellation Polling Check Due to Missing Session RLS (`apps/dashboard/app/api/ask-ai/execute/route.ts:263-272`) (P0)**:
    - *User Impact*: Unstoppable runaway tool executions. When a user clicks "Stop Execution" or the plan is cancelled via API, the stage loop ignores the cancellation and executes every remaining destructive tool action.
    - *Code Cause*: The stage execution loop checks cancellation using a raw pool checkout:
      ```ts
      const pcCheck = await pool.connect();
      try {
        const statusRow = await pcCheck.query('SELECT status FROM agent_plans WHERE id = $1', [planId]);
        if (statusRow.rows[0]?.status === 'cancelled') { ... }
      } finally {
        pcCheck.release();
      }
      ```
      `agent_plans` has Row Level Security (`ENABLE ROW LEVEL SECURITY`) with `USING (org_id = current_setting('app.current_org_id', true)::uuid)`. Connecting directly via `pool.connect()` leaves `app.current_org_id` unset (NULL), so Postgres returns 0 rows. `statusRow.rows[0]` is undefined, making it impossible for the loop to detect plan cancellation!
15. **Missing `userId` in `executeAutonomousToolAction` (`apps/dashboard/app/api/ask-ai/execute/route.ts:300-306`) (P1)**:
    - *User Impact*: Tool executions lack user attribution, corrupting audit trails and failing user-delegated OAuth connector calls.
    - *Code Cause*: `execute/route.ts` authenticates the session and resolves `userId`, but invokes `executeAutonomousToolAction({ tool: step.tool, action: step.action, payload, orgId, toolAllowlist: planTools })` without passing `userId`. Tool executors cannot log the initiating actor in `audit_logs` or resolve per-user OAuth tokens.
16. **20-Second LiteLLM Classifier Stall Without Client Feedback (`apps/dashboard/lib/classify.ts:81`) (P1)**:
    - *User Impact*: Frontend UI appears frozen for up to 20 seconds during model cold starts or upstream API latency.
    - *Code Cause*: `classifyWithAgent` sets `timeoutMs: 20000` with no intermediate heartbeats or streaming progress events sent to the client.

---

## What's missing vs full vision

1. **Interactive Plan Step Parameter Editor**:
   - Ability for human operators to click "Edit Step", tweak generated parameters (e.g. changing email recipients, dates, or payload notes), and save the plan before approving execution.
2. **Saga Compensating Rollback Engine**:
   - Schema and logic supporting reverse actions (e.g. Delete created event, archive created deal) with an interactive "Roll Back Partial Steps" button when an execution fails mid-workflow.
3. **Rolling Conversation Summarization (Token Compactor)**:
   - Dynamic background summarizer that compresses conversational turns older than 6 turns into a concise structured memory block, keeping prompt tokens under 4,000.
4. **Per-Turn Token Usage & Cost Badges**:
   - Small transparent chips beneath every assistant message displaying prompt tokens, completion tokens, latency, and estimated cost in cents (*"1,240 tokens · $0.002 · 1.4s"*).
5. **Multi-Modal Document & Image Input**:
   - Drag-and-drop file uploader supporting PDF, CSV, and image attachments, parsed and injected into the prompt context via text extraction or vision models.
6. **Distributed Redis Sliding-Window Rate Limiter**:
   - Enterprise-grade rate limiting enforcing strict concurrency and requests-per-minute limits across all server replicas.
7. **Side-by-Side Visual Plan Diff Viewer**:
   - Visual comparison highlighting the exact fields and databases that will be modified prior to hitting "Approve".
8. **Interactive Voice Mode (Streaming WebRTC)**:
   - Real-time voice interaction allowing executives to talk with Ask AI hands-free.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Plan Scoping & Saga Rollbacks (`039_ask_ai_user_scoping_and_saga.sql`)
```sql
-- 1. Index for user-scoped plan lookups
CREATE INDEX IF NOT EXISTS idx_agent_plans_user_lookup
  ON agent_plans (org_id, user_id, status, updated_at DESC);

-- 2. Add compensation actions and rollback tracking to agent_plans
ALTER TABLE agent_plans
  ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS compensation_steps JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_usage JSONB DEFAULT '{}'::jsonb;

-- 3. Stale plan cleanup function on server startup
CREATE OR REPLACE FUNCTION sweep_stale_running_plans() RETURNS VOID AS $$
BEGIN
  UPDATE agent_plans
  SET status = 'completed_with_errors',
      updated_at = NOW()
  WHERE status = 'running' AND updated_at < NOW() - INTERVAL '15 minutes';
END;
$$ LANGUAGE plpgsql;
```

### 2. User-Scoped Plan Lookup & Atomic Lock (`apps/dashboard/app/api/ask-ai/plan/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  const { searchParams } = new URL(req.url);
  const planId = searchParams.get('id');

  try {
    if (planId) {
      const res = await client.query(
        `SELECT id, title, status, steps, compensation_steps, token_usage, created_at, updated_at
         FROM agent_plans
         WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      if (res.rowCount === 0) {
        return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
      }
      return NextResponse.json({ plan: res.rows[0] });
    }

    // Scoped strictly by user_id to prevent cross-user privacy leaks
    const res = await client.query(
      `SELECT id, title, status, steps, created_at, updated_at
       FROM agent_plans
       WHERE org_id = $1 AND user_id = $2 AND status IN ('pending', 'approved', 'running')
       ORDER BY updated_at DESC
       LIMIT 5`,
      [orgId, userId]
    );

    return NextResponse.json({ plans: res.rows });
  } finally {
    client.release();
  }
}
```

### 3. Disconnect-Safe Execution Loop (`apps/dashboard/app/api/ask-ai/execute/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { executeAutonomousToolAction } from '@darex/workflows';

export async function POST(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  const { planId } = await req.json();

  try {
    // 1. Atomic lock: transition from approved to running
    const lockRes = await client.query(
      `UPDATE agent_plans
       SET status = 'running', updated_at = NOW()
       WHERE id = $1 AND org_id = $2 AND status = 'approved'
       RETURNING id, steps, compensation_steps`,
      [planId, orgId]
    );

    if (lockRes.rowCount === 0) {
      return NextResponse.json(
        { error: 'Plan cannot be executed (must be in approved status and not already running)' },
        { status: 409 }
      );
    }

    const { steps, compensation_steps } = lockRes.rows[0];
    const executedSteps: any[] = [];

    for (let i = 0; i < steps.length; i++) {
      // 2. Client Disconnect Check: Halt immediately if client disconnects
      if (req.signal.aborted) {
        console.warn(`[AskAI Execute] Client aborted connection for plan ${planId}. Halting remaining steps.`);
        await client.query(
          `UPDATE agent_plans SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
          [planId]
        );
        return new Response('Execution halted due to client disconnect', { status: 499 });
      }

      const step = steps[i];
      try {
        const result = await executeAutonomousToolAction(orgId, step.tool, step.payload);
        executedSteps.push({ stepId: step.id, result });
      } catch (stepErr: any) {
        console.error(`[AskAI Execute] Step ${step.id} failed:`, stepErr);
        await client.query(
          `UPDATE agent_plans
           SET status = 'completed_with_errors',
               token_usage = jsonb_set(COALESCE(token_usage, '{}'::jsonb), '{error}', $1::jsonb),
               updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify({ failedStep: step.id, error: stepErr.message }), planId]
        );
        return NextResponse.json({ error: `Step failed: ${stepErr.message}`, executedSteps }, { status: 500 });
      }
    }

    // 3. Complete plan
    await client.query(
      `UPDATE agent_plans SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [planId]
    );

    return NextResponse.json({ success: true, executedSteps });
  } finally {
    client.release();
  }
}
```

### 4. Interactive Step Parameter Editor Component (`components/ask-ai/PlanCard.tsx`)
```tsx
'use client';

import React, { useState } from 'react';
import { Check, X, Edit2, Play, AlertTriangle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

interface Step {
  id: string;
  tool: string;
  action: string;
  payload: Record<string, any>;
}

interface PlanCardProps {
  planId: string;
  title: string;
  steps: Step[];
  status: string;
  onExecuted: () => void;
}

export function PlanCard({ planId, title, steps, status, onExecuted }: PlanCardProps) {
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editedPayload, setEditedPayload] = useState<string>('');
  const [currentSteps, setCurrentSteps] = useState<Step[]>(steps);
  const [executing, setExecuting] = useState(false);

  const startEdit = (step: Step) => {
    setEditingStepId(step.id);
    setEditedPayload(JSON.stringify(step.payload, null, 2));
  };

  const saveEdit = async (stepId: string) => {
    try {
      const parsed = JSON.parse(editedPayload);
      const updated = currentSteps.map((s) => (s.id === stepId ? { ...s, payload: parsed } : s));
      setCurrentSteps(updated);
      setEditingStepId(null);

      // Persist edited steps
      await fetch(`/api/ask-ai/plan/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: updated })
      });
      toast.success('Step parameters updated');
    } catch {
      toast.error('Invalid JSON payload');
    }
  };

  const handleExecute = async () => {
    setExecuting(true);
    try {
      const res = await fetch('/api/ask-ai/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId })
      });
      if (res.ok) {
        toast.success('Plan executed successfully!');
        onExecuted();
      } else {
        toast.error('Plan execution encountered errors');
      }
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4 my-4">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div>
          <span className="text-[10px] uppercase font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
            Action Plan · Confirmation Required
          </span>
          <h3 className="text-base font-semibold text-slate-100 mt-1">{title}</h3>
        </div>
      </div>

      <div className="space-y-3">
        {currentSteps.map((step, idx) => (
          <div key={step.id} className="p-3 bg-slate-800/60 border border-slate-700/60 rounded-lg text-xs space-y-1">
            <div className="flex items-center justify-between text-slate-300 font-medium">
              <span>
                {idx + 1}. {step.tool} → <span className="text-emerald-400">{step.action}</span>
              </span>
              {status === 'pending' && editingStepId !== step.id && (
                <button
                  onClick={() => startEdit(step)}
                  className="text-slate-400 hover:text-slate-200 flex items-center gap-1"
                >
                  <Edit2 className="w-3 h-3" /> Edit
                </button>
              )}
            </div>

            {editingStepId === step.id ? (
              <div className="mt-2 space-y-2">
                <textarea
                  rows={4}
                  value={editedPayload}
                  onChange={(e) => setEditedPayload(e.target.value)}
                  className="w-full p-2 bg-slate-950 font-mono text-[11px] text-slate-300 rounded border border-slate-700"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setEditingStepId(null)}
                    className="px-2 py-1 text-slate-400 hover:text-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => saveEdit(step.id)}
                    className="px-2.5 py-1 bg-emerald-600 text-white rounded font-medium"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <pre className="text-slate-400 overflow-x-auto text-[10px] bg-slate-900/50 p-2 rounded mt-1">
                {JSON.stringify(step.payload, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>

      <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2">
        <button
          disabled={executing || status !== 'pending'}
          onClick={handleExecute}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold shadow-sm transition"
        >
          <Play className="w-3.5 h-3.5" />
          {executing ? 'Executing Plan...' : 'Approve & Execute Plan'}
        </button>
      </div>
    </div>
  );
}
### 5. Multi-Tenant Session Key Isolation (`apps/dashboard/app/api/ask-ai/route.ts`)
```typescript
// Fix for route.ts:49-52 - Ensure session cache is partitioned strictly by orgId AND userId
export function dailySessionKey(orgId: string, userId: string): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `askai-${orgId}-${userId}-${day}`;
}

// In runDirectAgentStream (route.ts:427):
const sessionKey = dailySessionKey(args.orgId, args.userId);
```

### 6. RLS-Scoped Execution Cancellation Polling Check (`apps/dashboard/app/api/ask-ai/execute/route.ts`)
```typescript
// Fix for execute/route.ts:263-272:
// MUST checkout via getOrgScopedClient(orgId) so PostgreSQL RLS permits reading the agent_plans row
const { client: pcCheck } = await getOrgScopedClient(orgId);
try {
  const statusRow = await pcCheck.query(
    'SELECT status FROM agent_plans WHERE id = $1',
    [planId]
  );
  if (statusRow.rows[0]?.status === 'cancelled') {
    send('execution_done', { planId, status: 'cancelled', results });
    return;
  }
} finally {
  pcCheck.release();
}

// Fix for execute/route.ts:300-306 - Propagate authenticated userId into tool executor:
const result = await executeAutonomousToolAction({
  tool: step.tool || '',
  action: step.action || '',
  payload,
  orgId,
  userId, // Propagate actor context for audit logs & user-delegated tokens
  toolAllowlist: planTools,
});
```

---

## Fix priority

- **P0**: Fix `dailySessionKey(orgId, userId)` to prevent cross-tenant memory/cache leaks when switching organizations.
- **P0**: Use `getOrgScopedClient(orgId)` for cancellation checks in `execute/route.ts` so PostgreSQL RLS does not silently hide cancelled plans.
- **P0**: Listen to `request.signal.aborted` in plan execution to prevent disconnected clients from executing unmonitored tool actions.
- **P0**: Scope all plan lookups by `user_id` to eliminate sensitive cross-user privacy leaks within multi-member teams.
- **P1**: Propagate `userId` into `executeAutonomousToolAction` so audit trails and user OAuth tokens are preserved.
- **P1**: Replace in-memory rate limiting with distributed Redis sliding window to prevent cluster bypasses.
- **P1**: Display visual warning alerts when transient database errors trigger thread context loss.
- **P1**: Implement interactive step parameter editing so users can tweak generated plan payloads directly.
- **P2**: Display per-turn token spend chips beneath chat responses.
- **P2**: Build Saga compensating rollback mechanism for partial plan failures.
