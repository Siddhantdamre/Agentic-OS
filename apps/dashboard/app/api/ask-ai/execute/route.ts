import { getScopedClient, pool } from '@/lib/db';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';
import type { PoolClient } from 'pg';

export const dynamic = 'force-dynamic';

/**
 * Fill params a step needs but that could not be known at plan time, using the
 * output of a previously executed step (e.g. sheets_append_row needs the
 * spreadsheetId returned by an earlier sheets_create; docs_append and
 * docs_read need documentId from docs_create; drive_get_text needs fileId
 * from drive_upload / drive_search). Missing fields are filled in-place so the
 * plan's payloads stay human-readable but the executor always gets real IDs.
 */
function wireDependencies(step: any, previousResults: any[]): any {
  const payload = { ...(step.payload || {}) };
  const lastNonFailed = previousResults.filter((r) => r.status === 'executed').map((r) => r.data || {});
  const pick = (keys: string[]): string | undefined => {
    for (const result of lastNonFailed) {
      for (const key of keys) {
        const value = result?.[key];
        if (value) return String(value);
      }
    }
    return undefined;
  };

  if (step.tool === 'google-sheets' && !payload.spreadsheetId && (step.action === 'sheets_read' || step.action === 'sheets_append_row')) {
    const spreadsheetId = pick(['spreadsheetId', 'spreadsheet_id', 'id']);
    if (spreadsheetId) payload.spreadsheetId = spreadsheetId;
  }
  if (step.tool === 'google-docs' && !payload.documentId && (step.action === 'docs_read' || step.action === 'docs_append')) {
    const documentId = pick(['documentId', 'document_id', 'id']);
    if (documentId) payload.documentId = documentId;
  }
  if (step.tool === 'google-drive' && !payload.fileId && (step.action === 'drive_get_text' || step.action === 'drive_share')) {
    const fileId = pick(['fileId', 'file_id', 'id']);
    if (fileId) payload.fileId = fileId;
  }

  function interpolate(value: any): any {
    if (typeof value === 'string') {
      return value.replace(/\{\{step(\d+)_output\}\}/g, (match, stepNum) => {
        const idx = parseInt(stepNum, 10) - 1;
        if (idx >= 0 && idx < previousResults.length) {
          const res = previousResults[idx];
          if (res && res.status === 'executed' && res.data) {
             if (res.data.results) return JSON.stringify(res.data.results, null, 2);
             if (res.data.content) return res.data.content;
             return JSON.stringify(res.data, null, 2);
          }
        }
        return '';
      });
    } else if (Array.isArray(value)) {
      return value.map(interpolate);
    } else if (value !== null && typeof value === 'object') {
      const obj: any = {};
      for (const [k, v] of Object.entries(value)) {
        obj[k] = interpolate(v);
      }
      return obj;
    }
    return value;
  }

  return interpolate(payload);
}

/**
 * Partition plan steps into sequential "stages". Independent steps (those whose
 * payload has no {{stepN_output}} interpolation and no known ID dependency on a
 * prior step's output) run concurrently within a stage, so a large multi-app
 * plan executes faster instead of serially awaiting every step. Steps that DO
 * depend on an earlier result drop to later stages and keep their wiring.
 */
function stageSteps(steps: any[]): any[][] {
  const stages: any[][] = [];
  const dependsOnEarlier = (step: any) => {
    const payloadStr = String(JSON.stringify(step.payload || ''));
    if (/\{\{step\d+_output\}\}/.test(payloadStr)) return true;
    if (step.tool === 'google-sheets' && ['sheets_read', 'sheets_append_row'].includes(step.action) && !step.payload?.spreadsheetId) return true;
    if (step.tool === 'google-docs' && ['docs_read', 'docs_append'].includes(step.action) && !step.payload?.documentId) return true;
    if (step.tool === 'google-drive' && ['drive_get_text', 'drive_share'].includes(step.action) && !step.payload?.fileId) return true;
    return false;
  };

  let remaining = steps.map((s, i) => ({ s, i }));
  while (remaining.length > 0) {
    const stage: any[] = [];
    const stageIdx = new Set<number>();
    for (const item of remaining) {
      if (!dependsOnEarlier(item.s)) {
        stage.push(item);
        stageIdx.add(item.i);
      }
    }
    if (stage.length === 0) {
      // Every remaining step depends on a not-yet-emitted step: emit the first.
      stage.push(remaining[0]);
      stageIdx.add(remaining[0].i);
    }
    remaining = remaining.filter((item) => !stageIdx.has(item.i));
    stages.push(stage);
  }
  return stages;
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
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId } = scoped;

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

    // Explicit allowlist for plan execution: the union of tools the approved
    // plan's steps depend on + the always-allowed atomic core. This guarantees
    // the plan runs the connectors it was approved with, independent of which
    // employee was seeded first in the org.
    const coreTools = [
      'web_search', 'web_extract', 'database_query', 'db_query', 'sql_analytics',
      'file_ops', 'workspace_file', 'file_system', 'sandbox', 'code_execution', 'execute_code',
    ];
    const planTools = Array.from(
      new Set<string>([
        ...coreTools,
        ...steps.map((s: any) => String(s.tool || '').toLowerCase()).filter(Boolean),
      ])
    );

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

    // Release the pooled connection before the (potentially long) SSE stream so
    // a plan execution never holds a pool slot. Mid-stream DB writes re-acquire
    // a short-lived connection + org context on demand instead.
    client.release();
    client = null;

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
                    tool: step.tool,
                    action: step.action,
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
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    if (client) client.release();
    if (error.message === 'Unauthorized') {
      return new Response('Unauthorized', { status: 401 });
    }
    console.error('GET /api/ask-ai/execute Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}