# Crew Workflows Audit

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Hard cap of 3 child specialists | P0 | `crew-contract.ts` | 🟢 Done | `MAX_CREW_SPAWN = 3` + `capCrewSpecialists` in Temporal + direct paths. |
| 2 | Manager synthesis timeout | P0 | `crew-contract.ts`, `CrewWorkflow.ts`, `crew-runner.ts` | 🟢 Done | 3-minute dedicated synthesis timeout; partial reports on failure. |
| 3 | `Promise.all` crashes entire crew on one specialist failure | P0 | `CrewWorkflow.ts` / `crew-runner.ts` | 🟢 Done | `Promise.allSettled` + failed specialist reports. |
| 4 | Client abort does not cancel Temporal crew | P0 | `apps/dashboard/app/api/agent/crew/route.ts` + `lib/crew-abort.ts` | 🟢 Done | `startCrewWorkflow` + `awaitCrewHandleWithAbort` cancels on `request.signal`. |
| 5 | Zero automated crew tests | P1 | `crew-contract.test.ts` | 🟢 Done | Cap, timeout, synthesis honesty, and report-truncation tests. Full `@temporalio/testing` optional. |
| 6 | Pre-flight spend budget before crew spawn | P1 | `activities/crew-budget.ts`, `CrewWorkflow.ts`, `crew-runner.ts` | 🟢 Done | Blocks multi-specialist crews when `escalate_only` or daily spend ceiling hit. Dashboard UI still may want a 402 pre-check. |
| 7 | Manager synthesis context overflow on verbose reports | P1 | `crew-contract.ts:truncateSpecialistReport` | 🟢 Done | Each specialist report capped at 2500 chars before synthesis. |

## Status: closed (cap-3, timeout, allSettled, spend gate, truncation, client-abort Temporal cancel)

The crew execution subsystem (`CrewWorkflow.ts`, `services/workflows/src/crew-runner.ts`, `crew-contract.ts`, and `apps/dashboard/app/api/agent/crew/route.ts`) orchestrates multi-agent collaboration by planning and spawning up to 3 specialist AI agents (`MAX_CREW_SPAWN = 3`) and synthesizing their findings via a dedicated LLM manager prompt. Both the Temporal workflow runner and direct in-process fallback enforce tenant isolation via `getScopedClient()`.

**2026-09-26 update:** Cap-3 confirmed, manager synthesis hard-timeouted at 3 minutes, specialist fan-out isolated with `Promise.allSettled`, spend ceiling preflight, and specialist report truncation.

---

## What works (cite file:line)

1. **Cap-3 Enforced Across All Code Paths**:
   - `services/workflows/src/crew-contract.ts:6-10` — Defines `MAX_CREW_SPAWN = 3` and exports `capCrewSpecialists(specialists)` which strictly slices input arrays to at most 3 specialists.
   - Enforced uniformly in `CrewWorkflow.ts:33`, `crew-runner.ts:20`, and `apps/dashboard/app/api/agent/crew/route.ts:86`.
2. **Authentic Solo vs Crew Branching**:
   - `CrewWorkflow.ts:35` and `crew-runner.ts:22` inspect `specialists.length <= 1`.
   - Single-specialist requests execute via a lightweight solo turn, skipping manager synthesis overhead entirely.
   - Short greetings route to solo turns via regex and word count heuristics in `crew-planner.ts` (`apps/dashboard/lib/crew-planner.ts:25-45`).
3. **Dedicated Manager LLM Synthesis**:
   - `services/workflows/src/crew-contract.ts:23-47` — `buildCrewSynthesisPrompt`:
     - Aggregates specialist reports into structured markdown blocks.
     - Explicitly instructs the LLM: *"Combine specialist reports... Do not redo their tool work... If a specialist hit notConnected, say so honestly... Do not mention Temporal or internal routing"*.
     - Executed via `runAgentTurnActivity` (`CrewWorkflow.ts:129`) or `runAutonomousAgentDirect` (`crew-runner.ts:77`).
     - Uses an isolated memory namespace (`sessionKey: crew:{id}:manager`, `skipPersist: true`), preventing manager synthesis from polluting conversation history.
4. **Durable Turn Retry Bounds in Temporal**:
   - `services/workflows/src/workflows/AutonomousAgentWorkflow.ts:26-67`:
     - Enforces `MAX_TURNS = 3`.
     - Re-injects `priorToolResults` into the conversation history across retries to prevent models from redundantly re-executing completed external tools.
5. **Strict DB Pool Release Prior to Workflow Dispatch**:
   - `apps/dashboard/app/api/agent/crew/route.ts:30-75`:
     - Scoped client resolves `orgId` from session and calls `client.release()` (`route.ts:74`) strictly *before* triggering `triggerCrewWorkflow` or `runCrewDirect`, honoring standing architecture rule #3 against connection pool deadlocks.
6. **Deterministic Idempotency Key Generation**:
   - `apps/dashboard/app/api/agent/crew/route.ts:98`:
     - Workflow IDs are generated using `crew-${orgId}-${Date.now()}`, preventing collision and allowing idempotent retries from Temporal SDK.
7. **Honest `notConnected` Protocol Adherence**:
   - `services/workflows/src/crew-contract.ts:35`:
     - System prompt mandates that when a specialist fails to connect to a third-party tool, the manager synthesis must transparently inform the user rather than fabricating simulated responses.
8. **Top-Level Langfuse Trace Scoping**:
   - `apps/dashboard/app/api/agent/crew/route.ts:167-177`:
     - Associates top-level crew execution with tenant `orgId` and tags multi-agent runs for observability.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Fragile `Promise.all` Child Workflow Crash Cascades (`CrewWorkflow.ts:77-104`) (P0)**:
   - In `CrewWorkflow.ts`, child workflows are executed via `Promise.all(specialists.map(s => executeChild(AutonomousAgentWorkflow, ...)))`.
   - While the agent model turn inside `runAgentTurnActivity` catches LLM errors, the child workflow's subsequent mandatory activities — `logChannelActivity` (`AutonomousAgentWorkflow.ts:72-84`), `saveMessageActivity` (86-95), and `extractObligationActivity` (97-114) — run **unguarded**.
   - If any of these secondary activities throws a non-retryable `ApplicationFailure` (such as a transient database constraint violation or unmapped column), the child workflow fails.
   - This immediately rejects the parent's `Promise.all`, **crashing the entire `CrewWorkflow`**. All results from sibling specialists who succeeded are discarded, and manager synthesis is aborted.
2. **Workflow Execution Timeout Drops All Results (`CrewWorkflow.ts:53, 94`) (P0)**:
   - Each specialist child workflow is started with `workflowExecutionTimeout: '20 minutes'`.
   - If Specialist 1 and Specialist 2 finish in 10 seconds, but Specialist 3 hangs on an external tool and times out, `Promise.all` throws `WorkflowExecutionTimedOutError`. The user receives an HTTP 502 with zero data, even though 2 out of 3 specialists completed their jobs successfully.
3. **Zero Cancellation Propagation on Client Abort (`apps/dashboard/app/api/agent/crew/route.ts:135-155`) (P0)**:
   - If a user cancels the request, closes their browser tab, or navigates away while the crew is executing, the Next.js HTTP socket closes (`request.signal.aborted === true`).
   - The API route does **not** signal or cancel the running Temporal parent workflow. The 3 child workflows and synthesis step continue executing in Temporal for up to 20 minutes, burning LLM tokens and external API rate limits for an abandoned client.
4. **Concurrent External Entity Mutation Conflicts**:
   - When two specialists run in parallel, they may operate on the same external CRM record (e.g. Specialist 1 updates HubSpot deal stage, while Specialist 2 updates deal contact notes).
   - There is zero entity locking, distributed mutex, or transactional sequencing across parallel specialists. Both tools execute concurrently against external APIs, causing race conditions and lost updates.
5. **Dead Code: Inert `skipPersist` on Direct Fallback (`crew-runner.ts:27, 33, 62, 80`)**:
   - `crew-runner.ts` sets `skipPersist: true` across task inputs, but `runAutonomousAgentDirect` (`trueforge-client.ts:887`) never inspects or honors this property. Persistence in the direct path is handled exclusively out-of-band in `route.ts:155-165`.
6. **Zero Automated Test Coverage Across Multi-Agent Tree**:
   - There are zero unit or integration tests for `CrewWorkflow.ts`, `crew-runner.ts`, `crew-contract.ts`, or `AutonomousAgentWorkflow.ts` anywhere in the repository.
7. **Lack of Per-Turn Rate Limit Throttling Across Parallel Children**:
   - Spawning 3 specialists simultaneously fires 3 concurrent LLM completion calls to LiteLLM/Groq/Gemini.
   - For free-tier or restricted provider API keys, 3 simultaneous large prompts often breach provider RPM/TPM limits, causing 429 rate limit errors on 2 of the 3 workers.
8. **Manager Synthesis Context Overflow on Verbose Specialist Reports**:
   - If 3 specialists each return 3,000 words of analysis, the concatenated reports total 9,000 words (~12,000 tokens) plus tool trace outputs.
   - Feeding this directly into the manager synthesis model with small context windows (8k) causes immediate token limit truncation or HTTP 413 errors.
9. **Hallucination Risk When Specialists Fail**:
   - If a specialist fails with an error string, the manager synthesis prompt sometimes interprets the error text as factual domain information, hallucinatory answering on behalf of the broken specialist.
10. **Race Conditions in Message Order Insertion**:
    - When specialists complete, if `saveMessageActivity` runs asynchronously, messages in `conversation_messages` can be saved out-of-order, confusing conversation history.
11. **No Granular Progress Reporting in UI (Black-Box Spinner)**:
    - The client receives a generic loading state while all 3 specialists run. There is no SSE or WebSocket stream broadcasting when Specialist 1 finishes, Specialist 2 is running, or Manager synthesis has begun.
12. **Inability to Retry Individual Specialist Failures**:
    - If 1 specialist fails due to a temporary connector timeout, the user must re-run the entire crew from scratch, re-spending tokens on the two specialists who already succeeded.
13. **Missing Per-Specialist Token Attribution**:
    - Token spend is not broken down by specialist in the billing table, preventing tenants from seeing which employee archetype incurs the highest API costs.
14. **Circular Dependency Lockout in Cross-Agent Communication**:
    - If future workflows allow specialists to request input from one another, the absence of an event broker or mailbox causes deadlock when both wait on mutual signals.

---

## What's missing vs full product vision

1. **Token Budget & Financial Spend Ceilings**:
   - A single crew execution (3 children × 3 turns + synthesis) can execute up to 12 LLM turns with extensive tool results.
   - The crew subsystem lacks any cost-checking logic. It does not check `org_cost_ceilings` or enforce a per-crew token budget before spawning agents.
2. **Granular Per-Specialist Observability**:
   - `route.ts:167-177` logs only a single top-level Langfuse trace for the entire crew.
   - Operators cannot see token usage, latency, or tool failures broken down per specialist without manually parsing the nested response JSON.
3. **Crew-Level Human-in-the-Loop (HITL) Escalation**:
   - If 2 out of 3 specialists encounter missing credentials (`notConnected`) or fail confidence gates, the manager synthesis is simply left to summarize the failure in text.
   - Missing an automated crew-level escalation path to generate a `work_items` review card when a multi-agent workflow encounters blockers.
4. **Dynamic Specialist Dependency DAGs**:
   - Currently, all specialists are forced to execute in parallel. The system cannot model dependencies where Specialist B requires the output of Specialist A (e.g., Lead Researcher must complete before Copywriter drafts email).
5. **Shared Ephemeral Scratchpad Across Specialists**:
   - Specialists run completely blind to each other's progress until manager synthesis. If Specialist 1 finds a customer's account ID, Specialist 2 cannot use it and must independently re-query the CRM.
6. **Streaming Progress Updates to Frontend**:
   - Streaming SSE pipeline broadcasting per-specialist milestones (`specialist_started`, `tool_executed`, `specialist_completed`, `synthesis_started`).
7. **Heterogeneous Model Selection per Specialist**:
   - Inability to route Researcher to DeepSeek R1 / o3-mini and Customer Support to Claude 3.5 Sonnet within the same crew.
8. **Automated Post-Crew Action Item Extractor**:
   - Automatically parsing manager synthesis into executable checklist tasks in the `work_items` table.

---

## What to add for full SaaS

### 1. Robust `Promise.allSettled` Execution in `CrewWorkflow.ts`
Update `services/workflows/src/workflows/CrewWorkflow.ts`:
```typescript
import { executeChild, workflowInfo } from '@temporalio/workflow';
import { AutonomousAgentWorkflow } from './AutonomousAgentWorkflow';
import { SpecialistReport, buildCrewSynthesisPrompt } from '../crew-contract';

export interface CrewWorkflowInput {
  orgId: string;
  conversationId: string;
  userMessage: string;
  specialists: Array<{
    role: string;
    name: string;
    employeeId: string;
    task: string;
  }>;
}

export interface CrewWorkflowResult {
  replyMessage: string;
  specialistReports: SpecialistReport[];
}

export async function CrewWorkflow(input: CrewWorkflowInput): Promise<CrewWorkflowResult> {
  const specialists = input.specialists.slice(0, 3);

  // If solo, bypass crew orchestration
  if (specialists.length <= 1) {
    const singleSpec = specialists[0];
    const soloResult = await executeChild(AutonomousAgentWorkflow, {
      workflowId: `${workflowInfo().workflowId}-solo`,
      args: [{
        orgId: input.orgId,
        conversationId: input.conversationId,
        channel: 'crew',
        userMessage: singleSpec ? singleSpec.task : input.userMessage,
        employeeId: singleSpec?.employeeId,
        turnLimit: 3,
      }],
      workflowExecutionTimeout: '5 minutes',
    });
    return {
      replyMessage: soloResult.replyMessage,
      specialistReports: singleSpec ? [{
        role: singleSpec.role,
        name: singleSpec.name,
        status: 'completed',
        output: soloResult.replyMessage,
        toolsUsed: soloResult.toolsUsed || [],
      }] : [],
    };
  }

  // Execute child workflows concurrently with individual error isolation
  const childPromises = specialists.map((specialist) =>
    executeChild(AutonomousAgentWorkflow, {
      workflowId: `${workflowInfo().workflowId}-${specialist.role.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      args: [{
        orgId: input.orgId,
        conversationId: input.conversationId,
        channel: 'crew',
        userMessage: specialist.task,
        employeeId: specialist.employeeId,
        turnLimit: 3,
      }],
      workflowExecutionTimeout: '5 minutes',
    })
  );

  const settledResults = await Promise.allSettled(childPromises);

  const specialistReports: SpecialistReport[] = settledResults.map((result, idx) => {
    const spec = specialists[idx];
    if (result.status === 'fulfilled') {
      return {
        role: spec.role,
        name: spec.name,
        status: 'completed',
        output: result.value.replyMessage,
        toolsUsed: result.value.toolsUsed || [],
      };
    } else {
      console.warn(`[CrewWorkflow] Specialist ${spec.role} failed:`, result.reason);
      return {
        role: spec.role,
        name: spec.name,
        status: 'failed',
        output: `Specialist was unable to complete task: ${result.reason?.message || 'Execution timeout'}`,
        toolsUsed: [],
      };
    }
  });

  // Synthesize results even if one or two specialists failed
  const synthesisPrompt = buildCrewSynthesisPrompt(input.userMessage, specialistReports);
  const managerResult = await executeChild(AutonomousAgentWorkflow, {
    workflowId: `${workflowInfo().workflowId}-manager`,
    args: [{
      orgId: input.orgId,
      conversationId: input.conversationId,
      channel: 'crew',
      userMessage: synthesisPrompt,
      sessionKey: `crew:${workflowInfo().workflowId}:manager`,
      skipPersist: true,
      turnLimit: 1,
    }],
    workflowExecutionTimeout: '3 minutes',
  });

  return {
    replyMessage: managerResult.replyMessage,
    specialistReports,
  };
}
```

### 2. Client Abort Cancellation Propagation in `route.ts`
In `apps/dashboard/app/api/agent/crew/route.ts`:
```typescript
const workflowHandle = await temporalClient.workflow.start(CrewWorkflow, {
  taskQueue: 'agent-tasks',
  workflowId: `crew-${orgId}-${Date.now()}`,
  args: [crewInput],
});

// Propagate client disconnect to cancel Temporal workflow
request.signal.addEventListener('abort', async () => {
  try {
    console.warn(`[crew-route] Client disconnected. Terminating workflow ${workflowHandle.workflowId}`);
    await workflowHandle.cancel();
  } catch (err) {
    console.error(`[crew-route] Failed to cancel workflow ${workflowHandle.workflowId}:`, err);
  }
});
```

### 3. Pre-Flight Token & Spend Budget Enforcement
In `apps/dashboard/app/api/agent/crew/route.ts`:
```typescript
const { client } = await getScopedClient();
try {
  const budgetRes = await client.query(
    `SELECT daily_spend_usd, max_daily_budget_usd 
       FROM org_usage_limits 
      WHERE org_id = $1`,
    [orgId]
  );
  if (budgetRes.rowCount && budgetRes.rows[0].daily_spend_usd >= budgetRes.rows[0].max_daily_budget_usd) {
    return NextResponse.json({
      error: 'Daily AI spend quota exceeded. Multi-agent crew execution blocked. Upgrade plan or increase budget.'
    }, { status: 402 });
  }
} finally {
  client.release();
}
```

### 4. Real-Time Specialist Progress SSE Broadcast
Create `apps/dashboard/app/api/agent/crew/stream/route.ts`:
```typescript
import { NextRequest } from 'next/server';
import { redisClient } from '@/lib/redis';
import { getScopedClient } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const crewId = searchParams.get('crewId');
  if (!crewId) return new Response('Missing crewId', { status: 400 });

  const { orgId } = await getScopedClient();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const channel = `crew:progress:${orgId}:${crewId}`;
      const subscriber = redisClient.duplicate();
      await subscriber.connect();

      await subscriber.subscribe(channel, (msg) => {
        controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
      });

      req.signal.addEventListener('abort', async () => {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
        controller.close();
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}
```

### 5. Automated `@temporalio/testing` Suite
Create `services/workflows/src/__tests__/CrewWorkflow.test.ts`:
```typescript
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { CrewWorkflow } from '../workflows/CrewWorkflow';

describe('CrewWorkflow Resilience', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it('completes manager synthesis even if 1 of 3 specialists times out', async () => {
    const { client, nativeConnection } = testEnv;
    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'test-crew-queue',
      workflowsPath: require.resolve('../workflows/CrewWorkflow'),
      activities: {
        runAgentTurnActivity: async (args: any) => {
          if (args.employeeId === 'failing-spec') {
            throw new Error('Simulated external tool timeout');
          }
          return { replyMessage: 'Success analysis report', toolsUsed: ['hubspot_lookup'] };
        }
      }
    });

    const result = await worker.runUntil(async () => {
      return await client.workflow.execute(CrewWorkflow, {
        workflowId: 'test-crew-run-1',
        taskQueue: 'test-crew-queue',
        args: [{
          orgId: 'org-test-123',
          conversationId: 'conv-test-123',
          userMessage: 'Analyze pipeline and prepare email',
          specialists: [
            { role: 'Researcher', name: 'Marcus', employeeId: 'spec-1', task: 'Analyze deals' },
            { role: 'BrokenWorker', name: 'Faulty', employeeId: 'failing-spec', task: 'Fetch data' },
          ]
        }]
      });
    });

    expect(result.specialistReports).toHaveLength(2);
    expect(result.specialistReports[0].status).toBe('completed');
    expect(result.specialistReports[1].status).toBe('failed');
    expect(result.replyMessage).toBeDefined();
  });
});
```

### 6. Database Migration: `029_crew_executions.sql`
```sql
-- Migration: 029_crew_executions.sql
-- Tracks multi-agent crew execution plans, specialist token breakdowns, and synthesis logs

CREATE TABLE IF NOT EXISTS crew_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_query TEXT NOT NULL,
  specialist_count INT NOT NULL DEFAULT 1,
  specialists JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  total_tokens INT DEFAULT 0,
  total_cost_usd NUMERIC(10, 4) DEFAULT 0,
  synthesis_output TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crew_executions_org ON crew_executions(org_id, started_at DESC);
```

---

## Fix priority

- **P0**: Replace `Promise.all` with `Promise.allSettled` in `CrewWorkflow.ts` so that individual specialist failures do not crash the entire crew.
- **P0**: Wire `request.signal.addEventListener('abort')` to cancel background Temporal workflows on client disconnect.
- **P1**: Enforce pre-execution budget checks before launching 3-agent crews.
- **P1**: Add `@temporalio/testing` automated test suite to prevent regressions in multi-agent orchestration.
- **P1**: Truncate and summarize verbose specialist reports before feeding into manager synthesis to prevent context window overflow.
- **P2**: Implement real-time SSE streaming for granular per-specialist progress updates.
- **P2**: Implement nested Langfuse traces for individual specialists to monitor token usage and latency.
- **P2**: Create `crew_executions` table to log multi-agent executions and track token attribution.
