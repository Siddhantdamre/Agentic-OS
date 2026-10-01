import { getOrgScopedClient, getScopedClient, releaseScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  denyAskAiBusy,
  denyAskAiIfLimited,
  isRateLimitError,
  responseFromRateLimit,
  tryAcquireConcurrency,
} from '@/lib/rate-limit';
import { assertUsageAllowed } from '@/lib/usage-gate';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';
import { resolvePlanStepActor } from '@darex/workflows/dist/plan-step-actor';
import {
  planRequiresDurableExecute,
  stageSteps,
  wireDependencies,
} from '@darex/workflows/dist/plan-steps';
import {
  getPlanExecuteHandle,
  signalPlanDecision,
  startPlanExecuteWorkflow,
} from '@darex/workflows/dist/workflow-client';

import { activePlanExecutions } from '@/lib/ask-ai-plan-execution-state';

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

/** Race a tool call against client disconnect so in-flight steps stop scheduling work after abort. */
function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Client disconnected', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Client disconnected', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
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
    const { orgId, userId } = scoped;

    const usageBlock = await assertUsageAllowed(orgId);
    if (usageBlock) {
      if (client) {
        client.release();
        client = null;
      }
      return new Response(
        JSON.stringify({
          error: usageBlock.error,
          message: usageBlock.message,
          reasons: usageBlock.gate.reasons,
        }),
        { status: 402, headers: { 'Content-Type': 'application/json' } }
      );
    }

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
      `SELECT * FROM agent_plans
        WHERE id = $1 AND org_id = $2
          AND (user_id = $3 OR user_id IS NULL)`,
      [planId, orgId, userId]
    )).rows;
    if (rows.length === 0) {
      releaseEarly();
      return new Response('Plan not found', { status: 404 });
    }
    const plan = rows[0];
    let steps = Array.isArray(plan.steps) ? plan.steps : [];
    const enabledSteps = steps.filter((s: any) => s.enabled !== false);
    const durable = planRequiresDurableExecute(steps);

    if (plan.status === 'completed' || plan.status === 'completed_with_errors' || plan.status === 'cancelled') {
      releaseEarly();
      return new Response(`Plan already ${plan.status}`, { status: 409 });
    }
    if (plan.status === 'approved') {
      // Atomic lock — only one concurrent execute may claim an approved plan.
      const locked = await client.query(
        `UPDATE agent_plans
            SET status = 'running', updated_at = NOW()
          WHERE id = $1 AND org_id = $2 AND status = 'approved'
          RETURNING id`,
        [planId, orgId]
      );
      if (locked.rowCount === 0) {
        releaseEarly();
        return new Response('Plan is already executing', { status: 409 });
      }
    } else if (plan.status === 'running') {
      // Re-attaching / resuming:
      // Durable runs progress in the Temporal workflow.
      // Non-durable runs resume from current_step, replaying already-completed steps (ASK-B01).
      if (!durable) {
        if (activePlanExecutions.has(planId)) {
          releaseEarly();
          return new Response('Plan is already executing in an active stream.', { status: 409 });
        }
      }
    } else {
      releaseEarly();
      return new Response(`Plan must be approved before execution (status: ${plan.status})`, { status: 409 });
    }

    const acquired = tryAcquireConcurrency(orgId, 'ask_ai');
    if (!acquired) {
      if (plan.status === 'approved') {
        await client.query(
          `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2 AND status = 'running'`,
          [planId, orgId]
        );
      }
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
        const { client: pc } = await getOrgScopedClient(orgId);
        try {
          await pc.query(
            `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2 AND status = 'running'`,
            [planId, orgId]
          );
        } finally {
          await releaseScopedClient(pc);
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
          const onAbort = () => {
            clientDisconnected = true;
            try { controller.close(); } catch { /* already closed */ }
          };
          request.signal.addEventListener('abort', onAbort, { once: true });
          const send = (event: string, data: unknown) => {
            if (clientDisconnected || request.signal.aborted) return;
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              clientDisconnected = true;
            }
          };
          try {
            for (let i = 0; i < 600; i++) {
              if (clientDisconnected || request.signal.aborted) break;
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
            request.signal.removeEventListener('abort', onAbort);
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
        const onAbort = () => {
          clientDisconnected = true;
          try { controller.close(); } catch { /* already closed */ }
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        const send = (event: string, data: unknown) => {
          if (clientDisconnected || request.signal.aborted) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            clientDisconnected = true;
          }
        };

        // Short-lived org-scoped write used for mid-stream progress updates.
        const updatePlan = async (patch: {
          status?: string;
          current_step?: number;
          compensation_steps?: unknown;
          steps?: unknown;
        }) => {
          // Short-lived checkout per update — never hold across the SSE stream.
          const { client: pc } = await getOrgScopedClient(orgId);
          try {
            const sets: string[] = ['updated_at = NOW()'];
            const params: unknown[] = [];
            if (patch.status) {
              // Never mark fully succeeded when a compensation freeze is recorded.
              const status =
                patch.compensation_steps != null && patch.status === 'completed'
                  ? 'completed_with_errors'
                  : patch.status;
              params.push(status);
              sets.push(`status = $${params.length}`);
            }
            if (patch.current_step !== undefined) {
              params.push(patch.current_step);
              sets.push(`current_step = $${params.length}`);
            }
            if (patch.compensation_steps !== undefined) {
              params.push(JSON.stringify(patch.compensation_steps));
              sets.push(`compensation_steps = $${params.length}::jsonb`);
            }
            if (patch.steps !== undefined) {
              params.push(JSON.stringify(patch.steps));
              sets.push(`steps = $${params.length}::jsonb`);
            }
            params.push(planId, orgId);
            await pc.query(
              `UPDATE agent_plans SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length}`,
              params
            );
          } finally {
            await releaseScopedClient(pc);
          }
        };

        const buildCompensationFreeze = (failedStepIndex: number, error: string) => {
          const priorSucceeded = results
            .map((r, idx) => ({ r, idx }))
            .filter(({ r }) => {
              if (!r || typeof r !== 'object') return false;
              const st = String((r as { status?: string }).status || '');
              return st !== 'error' && st !== 'cancelled' && st !== 'skipped' && st !== '';
            })
            .map(({ r, idx }) => {
              const step = steps[idx] as { tool?: string; action?: string } | undefined;
              return {
                stepIndex: idx,
                tool: step?.tool || null,
                action: step?.action || null,
                status: String((r as { status?: string }).status || ''),
              };
            });
          return [
            {
              kind: 'partial_failure_freeze',
              failedStepIndex,
              error,
              priorSucceeded,
              recordedAt: new Date().toISOString(),
            },
          ];
        };

        send('execution_start', { planId, totalSteps: enabledSteps.length });
        activePlanExecutions.add(planId);
        const results: any[] = [];
        // Hydrate results array from previously completed steps in agent_plans (ASK-B01 reconnect resume)
        for (let idx = 0; idx < steps.length; idx++) {
          const s = steps[idx];
          if (s && (s.status === 'completed' || s.status === 'skipped')) {
            results[idx] = {
              stepIndex: idx,
              status: s.status,
              message: s.message || (s.status === 'skipped' ? 'Skipped' : 'Completed in prior run'),
              data: s.result ?? s.data ?? null,
            };
          }
        }
        try {
          const stages = stageSteps(steps);
          const noteTools = new Set(['user_instruction', 'note', 'agent.user_instruction']);

          for (const stage of stages) {
            // Respect Stop Execution: abort if client aborted or plan was cancelled
            if (request.signal.aborted) {
              const { client: pcCheck } = await getOrgScopedClient(orgId);
              let wasExplicitCancel = false;
              try {
                const statusRow = await pcCheck.query('SELECT status FROM agent_plans WHERE id = $1', [planId]);
                if (statusRow.rows[0]?.status === 'cancelled') wasExplicitCancel = true;
              } finally {
                await releaseScopedClient(pcCheck);
              }
              if (wasExplicitCancel) {
                send('execution_done', { planId, status: 'cancelled', results });
              }
              return;
            }
            // Must use org-scoped client so RLS can see this plan's status.
            // Raw pool.connect() leaves app.current_org_id unset → 0 rows → cancel never fires.
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
              await releaseScopedClient(pcCheck);
            }

            // Run a stage's independent steps concurrently, but keep results
            // ordered by global step index for dependency wiring.
            const stageOutcomes = await Promise.all(
              stage.map(async (item) => {
                const i = item.i;
                const step = item.s;
                if (request.signal.aborted || clientDisconnected) {
                  return { i, outcome: { status: 'cancelled', message: 'Client disconnected', data: null } };
                }
                if (step.enabled === false) {
                  return { i, outcome: { status: 'skipped', message: step.description, data: null } };
                }
                if (noteTools.has(String(step.tool || ''))) {
                  send('step_done', {
                    stepIndex: i,
                    status: 'skipped',
                    message: 'Instruction noted — not an executable tool.',
                    data: null,
                  });
                  return { i, outcome: { status: 'skipped', message: 'Instruction noted — not an executable tool.', data: null } };
                }

                // Check if already completed in prior run (ASK-B01 reconnect resume)
                const sStep = step as any;
                const isAlreadyCompleted =
                  sStep.status === 'completed' ||
                  (typeof plan.current_step === 'number' &&
                    plan.current_step > i &&
                    sStep.status !== 'error' &&
                    sStep.status !== 'cancelled');

                if (isAlreadyCompleted) {
                  const cachedOutcome = {
                    status: sStep.status || 'completed',
                    message: sStep.message || 'Already completed in prior execution',
                    data: sStep.result ?? sStep.data ?? null,
                  };
                  send('step_start', {
                    stepIndex: i,
                    description: step.description,
                    tool: step.tool,
                    action: step.action,
                  });
                  send('step_done', {
                    stepIndex: i,
                    status: cachedOutcome.status,
                    message: cachedOutcome.message,
                    data: cachedOutcome.data,
                  });
                  return { i, outcome: cachedOutcome };
                }

                send('step_start', {
                  stepIndex: i,
                  description: step.description,
                  tool: step.tool,
                  action: step.action,
                });
                try {
                  // Run as the stamped employee: their card, persona and confirm gate.
                  const actor = await resolvePlanStepActor(
                    orgId,
                    step,
                    (plan as any).employee_id || (plan as any).employeeId,
                    (plan as any).employee_role || (plan as any).employeeRole
                  );
                  if (actor.ok === false) {
                    send('step_error', { stepIndex: i, message: actor.message });
                    return { i, outcome: { status: 'error', message: actor.message, data: { reason: actor.reason } } };
                  }
                  const payload = wireDependencies(step, results);
                  const result = await raceAbort(
                    request.signal,
                    executeAutonomousToolAction({
                      tool: step.tool || '',
                      action: step.action || '',
                      payload,
                      orgId,
                      toolAllowlist: actor.toolAllowlist,
                      employeeRole: actor.employeeRole,
                      employeeId: actor.employeeId,
                      actorUserId: userId,
                      source: 'plan',
                      workflowId: `plan-${planId}`,
                    })
                  );
                  if (request.signal.aborted || clientDisconnected) {
                    return { i, outcome: { status: 'cancelled', message: 'Client disconnected', data: null } };
                  }
                  send('step_done', {
                    stepIndex: i,
                    status: result.status,
                    message: result.message,
                    data: result.data,
                  });
                  return { i, outcome: { status: result.status, message: result.message, data: result.data } };
                } catch (err: any) {
                  if (err?.name === 'AbortError' || request.signal.aborted || clientDisconnected) {
                    return { i, outcome: { status: 'cancelled', message: 'Client disconnected', data: null } };
                  }
                  const msg = String(err?.message || 'step execution failed');
                  send('step_error', { stepIndex: i, message: msg });
                  return { i, outcome: { status: 'error', message: msg, data: null } };
                }
              })
            );

            stageOutcomes.sort((a, b) => a.i - b.i);
            if (request.signal.aborted || clientDisconnected) {
              return;
            }
            if (stageOutcomes.some((o) => o.outcome.status === 'cancelled')) {
              await updatePlan({ status: 'cancelled' });
              send('execution_done', { planId, status: 'cancelled', results });
              return;
            }
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
                provider: 'trueforge',
              }).catch((e) => console.debug('langfuse trace failed (non-fatal):', planId, i, e));
              recordAuditEvent({
                orgId,
                kind: 'tool.execute',
                actor: userId
                  ? { actorType: 'user', userId }
                  : stepForTrace?.employee_id
                  ? { actorType: 'employee', employeeId: stepForTrace.employee_id }
                  : { actorType: 'system', component: 'plan_executor' },
                planId,
                tool: stepForTrace?.tool || null,
                action: stepForTrace?.action || null,
                resultStatus: outcome.status === 'error' ? 'error' : 'ok',
                payload: {
                  stepIndex: i,
                  description: stepForTrace?.description,
                  message: outcome.message,
                  employeeId: stepForTrace?.employee_id || null,
                },
              }).catch((e) => console.warn('[execute/route] audit record failed:', e));
              // Only keep a non-skipped outcome (keep a slot for skipped ones so
              // indices stay aligned).
              results[i] = { stepIndex: i, ...outcome };
              steps[i] = {
                ...steps[i],
                status: outcome.status,
                result: outcome.data,
                message: outcome.message,
              };
              if (outcome.status === 'error') {
                const errMsg = String(outcome.message || 'step execution failed');
                await updatePlan({ current_step: i + 1, steps }).catch((e) =>
                  console.error('updatePlan(current_step) failed:', planId, e)
                );
                // Saga freeze: record prior successes + failure; never mark plan "completed".
                await updatePlan({
                  status: 'completed_with_errors',
                  compensation_steps: buildCompensationFreeze(i, errMsg),
                }).catch((e) => console.error('updatePlan(compensation) failed:', planId, e));
                send('execution_done', {
                  planId,
                  status: 'completed_with_errors',
                  results: results.filter(Boolean),
                  compensation: 'partial_failure_freeze',
                });
                return;
              }
              await updatePlan({ current_step: i + 1, steps }).catch((e) =>
                console.error('updatePlan(current_step) failed:', planId, e)
              );
            }
          }

          const done = results.filter(Boolean);
          const failed = done.filter((r) => r.status === 'error').length;
          const finalStatus = failed > 0 ? 'completed_with_errors' : 'completed';
          if (failed > 0) {
            const firstErr = done.find((r) => r.status === 'error');
            await updatePlan({
              status: 'completed_with_errors',
              compensation_steps: buildCompensationFreeze(
                typeof firstErr?.stepIndex === 'number' ? firstErr.stepIndex : -1,
                String(firstErr?.message || 'step execution failed')
              ),
            });
          } else {
            await updatePlan({ status: finalStatus });
          }

          logLangfuseTrace({
            name: 'PlanExecutionSummary',
            orgId,
            input: { planId, totalSteps: steps.length, tools: Array.from(new Set(steps.map((s: any) => s.tool))) },
            output: { status: finalStatus, results: done },
            metadata: { planId },
            provider: 'trueforge',
          }).catch((e) => console.debug('langfuse summary trace failed (non-fatal):', planId, e));

          send('execution_done', { planId, status: finalStatus, results: done });
        } catch (err: any) {
          console.error('SSE execution failed:', err);
          try {
            await updatePlan({ status: 'completed_with_errors' });
          } catch (updateErr: unknown) {
            console.warn(
              '[Ask AI execute] Failed to mark plan completed_with_errors:',
              updateErr instanceof Error ? updateErr.message : updateErr
            );
          }
          send('execution_error', { message: String(err?.message || 'execution failed') });
        } finally {
          activePlanExecutions.delete(planId);
          request.signal.removeEventListener('abort', onAbort);
          lease?.release();
          try {
            controller.close();
          } catch (closeErr: unknown) {
            console.debug(
              '[Ask AI execute] controller already closed:',
              closeErr instanceof Error ? closeErr.message : closeErr
            );
          }
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
    const authErr = scopedAuthErrorResponse(error);
    if (authErr) return authErr;
    console.error('GET /api/ask-ai/execute Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}