import { getScopedClient, pool } from '@/lib/db';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import {
  denyAskAiBusy,
  denyAskAiIfLimited,
  isRateLimitError,
  responseFromRateLimit,
  tryAcquireConcurrency,
} from '@/lib/rate-limit';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';
import {
  planExecuteAllowlist,
  planRequiresDurableExecute,
  stageSteps,
  wireDependencies,
} from '@darex/workflows/dist/plan-steps';
import {
  getPlanExecuteHandle,
  signalPlanDecision,
  startPlanExecuteWorkflow,
} from '@darex/workflows/dist/workflow-client';
import type { PoolClient } from 'pg';

export const dynamic = 'force-dynamic';

type PlanProgress = {
  status: string;
  events: Array<{ seq: number; event: string; data: unknown }>;
  results: unknown[];
  done: boolean;
};

function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET /api/ask-ai/execute?planId=...
 * SSE stream that executes an APPROVED plan step-by-step through the real
 * tool-execution backend. Emits:
 *   event: execution_start  { planId, totalSteps }
 *   event: step_start       { stepIndex, description, tool, action }
 *   event: step_done        { stepIndex, status, message, data }
 *   event: step_error       { stepIndex, message }
 *   event: execution_done   { planId, status, results }
 * Updates agent_plans status/current_step/draft as it runs so a refresh
 * reflects what actually happened.
 */
export async function GET(request: Request) {
  let client: any = null;
  let lease: { release: () => void } | null = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId } = scoped;

    const limited = denyAskAiIfLimited(orgId);
    if (limited) {
      if (client) {
        client.release();
        client = null;
      }
      return limited;
    }

    const url = new URL(request.url);
    const planId = url.searchParams.get('planId');
    const releaseEarly = () => {
      if (client) {
        client.release();
        client = null;
      }
    };
    if (!planId) {
      releaseEarly();
      return new Response('planId is required', { status: 400 });
    }

    const rows = (await client.query(
      `SELECT * FROM agent_plans WHERE id = $1 AND org_id = $2`,
      [planId, orgId]
    )).rows;
    if (rows.length === 0) {
      releaseEarly();
      return new Response('Plan not found', { status: 404 });
    }
    const plan = rows[0];
    let steps = Array.isArray(plan.steps) ? plan.steps : [];
    const enabledSteps = steps.filter((s: any) => s.enabled !== false);
    const durable = planRequiresDurableExecute(steps);
    const planTools = planExecuteAllowlist(steps);

    if (plan.status === 'completed' || plan.status === 'completed_with_errors' || plan.status === 'cancelled') {
      releaseEarly();
      return new Response(`Plan already ${plan.status}`, { status: 409 });
    }
    if (plan.status !== 'approved' && plan.status !== 'running') {
      releaseEarly();
      return new Response(`Plan must be approved before execution (status: ${plan.status})`, { status: 409 });
    }

    await client.query(
      `UPDATE agent_plans SET status = 'running', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
      [planId, orgId]
    );

    const acquired = tryAcquireConcurrency(orgId, 'ask_ai');
    if (!acquired) {
      await client.query(
        `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      releaseEarly();
      return denyAskAiBusy();
    }
    lease = acquired;

    client.release();
    client = null;

    if (durable) {
      await signalPlanDecision({ orgId, planId, decision: 'approved' });
      const handle =
        (await startPlanExecuteWorkflow({
          orgId,
          planId,
          waitForApproval: false,
          idempotencyKey: planId,
        })) || (await getPlanExecuteHandle(orgId, planId));
      if (!handle) {
        lease.release();
        const pc = await pool.connect();
        try {
          await pc.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
          await pc.query(
            `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2 AND status = 'running'`,
            [planId, orgId]
          );
        } finally {
          try { await pc.query('RESET app.current_org_id'); } catch { /* ignore */ }
          pc.release();
        }
        return new Response(
          'Temporal is unavailable. Send/pay/sign/publish/delete plans cannot fall back to HTTP SSE.',
          { status: 503 }
        );
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let lastSeq = 0;
          let clientDisconnected = false;
          const send = (event: string, data: unknown) => {
            if (clientDisconnected) return;
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              clientDisconnected = true;
            }
          };
          try {
            for (let i = 0; i < 600; i++) {
              let progress: PlanProgress | null = null;
              try {
                progress = (await handle.query('planProgressQuery')) as PlanProgress;
              } catch {
                progress = null;
              }
              if (progress) {
                for (const ev of progress.events || []) {
                  if (ev.seq > lastSeq) {
                    send(ev.event, ev.data);
                    lastSeq = ev.seq;
                  }
                }
                if (progress.done) break;
              }
              await sleep(400);
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            send('execution_error', { message });
          } finally {
            lease?.release();
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          }
        },
      });
      return new Response(stream, { headers: sseHeaders() });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let clientDisconnected = false;
        const send = (event: string, data: unknown) => {
          if (clientDisconnected) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            clientDisconnected = true;
          }
        };

        // Short-lived org-scoped write used for mid-stream progress updates.
        const updatePlan = async (patch: { status?: string; current_step?: number }) => {
          const pc: PoolClient = await pool.connect();
          try {
            await pc.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const sets: string[] = ['updated_at = NOW()'];
            const params: any[] = [];
            if (patch.status) { params.push(patch.status); sets.push(`status = $${params.length}`); }
            if (patch.current_step !== undefined) { params.push(patch.current_step); sets.push(`current_step = $${params.length}`); }
            params.push(planId, orgId);
            await pc.query(
              `UPDATE agent_plans SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length}`,
              params
            );
          } finally {
            try { await pc.query('RESET app.current_org_id'); } catch { /* ignore */ }
            pc.release();
          }
        };

        send('execution_start', { planId, totalSteps: enabledSteps.length });
        const results: any[] = [];
        try {
          const stages = stageSteps(steps);
          const noteTools = new Set(['user_instruction', 'note', 'agent.user_instruction']);

          for (const stage of stages) {
            // Keep executing after SSE disconnect — the user already approved.
            // Only skip enqueueing events once the client is gone.

            // Run a stage's independent steps concurrently, but keep results
            // ordered by global step index for dependency wiring.
            const stageOutcomes = await Promise.all(
              stage.map(async (item) => {
                const i = item.i;
                const step = item.s;
                if (step.enabled === false) {
                  return { i, outcome: { status: 'skipped', message: step.description } };
                }
                if (noteTools.has(String(step.tool || ''))) {
                  send('step_done', {
                    stepIndex: i,
                    status: 'skipped',
                    message: 'Instruction noted — not an executable tool.',
                    data: null,
                  });
                  return { i, outcome: { status: 'skipped', message: 'Instruction noted — not an executable tool.' } };
                }
                send('step_start', {
                  stepIndex: i,
                  description: step.description,
                  tool: step.tool,
                  action: step.action,
                });
                try {
                  const payload = wireDependencies(step, results);
                  const result = await executeAutonomousToolAction({
                    tool: step.tool || '',
                    action: step.action || '',
                    payload,
                    orgId,
                    toolAllowlist: planTools,
                  });
                  send('step_done', {
                    stepIndex: i,
                    status: result.status,
                    message: result.message,
                    data: result.data,
                  });
                  return { i, outcome: { status: result.status, message: result.message, data: result.data } };
                } catch (err: any) {
                  const msg = String(err?.message || 'step execution failed');
                  send('step_error', { stepIndex: i, message: msg });
                  return { i, outcome: { status: 'error', message: msg } };
                }
              })
            );

            stageOutcomes.sort((a, b) => a.i - b.i);
            for (const { i, outcome } of stageOutcomes) {
              // Per-step Langfuse trace so each plan step's tool call (tool,
              // action, payload, result) is observable in the dashboard.
              const stepForTrace = steps[i];
              logLangfuseTrace({
                name: `PlanExecution-${stepForTrace?.tool || 'step'}`,
                orgId,
                input: { planId, stepIndex: i, tool: stepForTrace?.tool, action: stepForTrace?.action, payload: stepForTrace?.payload },
                output: { status: outcome.status, message: outcome.message, data: outcome.data },
                metadata: { planId, step: i + 1 },
                provider: 'atomic-agent',
              }).catch(() => {});
              // Only keep a non-skipped outcome (keep a slot for skipped ones so
              // indices stay aligned).
              results[i] = { stepIndex: i, ...outcome };
              if (outcome.status === 'error') {
                await updatePlan({ current_step: i + 1 }).catch(() => {});
                const firedSoFar = results.filter(Boolean).length;
                // Stop scheduling further stages on an error (fail-fast).
                await updatePlan({
                  status: results.some((r) => r?.status === 'error') ? 'completed_with_errors' : 'completed',
                }).catch(() => {});
                send('execution_done', { planId, status: 'completed_with_errors', results: results.filter(Boolean) });
                void firedSoFar;
                return;
              }
              await updatePlan({ current_step: i + 1 }).catch(() => {});
            }
          }

          const done = results.filter(Boolean);
          const failed = done.filter((r) => r.status === 'error').length;
          const finalStatus = failed > 0 ? 'completed_with_errors' : 'completed';
          await updatePlan({ status: finalStatus });

          logLangfuseTrace({
            name: 'PlanExecutionSummary',
            orgId,
            input: { planId, totalSteps: steps.length, tools: Array.from(new Set(steps.map((s: any) => s.tool))) },
            output: { status: finalStatus, results: done },
            metadata: { planId },
            provider: 'atomic-agent',
          }).catch(() => {});

          send('execution_done', { planId, status: finalStatus, results: done });
        } catch (err: any) {
          console.error('SSE execution failed:', err);
          try { await updatePlan({ status: 'completed_with_errors' }); } catch {}
          send('execution_error', { message: String(err?.message || 'execution failed') });
        } finally {
          lease?.release();
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: sseHeaders(),
    });
  } catch (error: any) {
    lease?.release();
    if (client) client.release();
    if (isRateLimitError(error)) {
      return responseFromRateLimit(error);
    }
    if (error.message === 'Unauthorized') {
      return new Response('Unauthorized', { status: 401 });
    }
    console.error('GET /api/ask-ai/execute Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}