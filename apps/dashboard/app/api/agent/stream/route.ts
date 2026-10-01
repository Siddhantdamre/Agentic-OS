import { usageBlockedResponse } from '@/lib/usage-gate';
import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { readJsonBody } from '@/lib/safe-json';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/agent-client';
import { retrieveForEmployee } from '@darex/workflows/dist/memory/employee-retrieve';
import { startAutonomousAgentWorkflow } from '@darex/workflows/dist/workflow-client';
import { channelTypesFromRows, mergeRuntimeAllowlist } from '@darex/workflows/dist/tool-executor';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const parsed = await readJsonBody<{ userMessage?: unknown; employeeId?: unknown; conversationId?: unknown; channelId?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!body.userMessage || !String(body.userMessage).trim()) {
      return NextResponse.json({ error: 'userMessage is required' }, { status: 400 });
    }
    const userMessageStr = String(body.userMessage).trim();

    const { client, orgId, userId } = await getScopedClient();
    const usageDenied = await usageBlockedResponse(orgId);
    if (usageDenied) {
      client.release();
      return usageDenied;
    }
    let employeeName = 'AI Assistant';
    let employeeRole = 'General Assistant';
    let employeePersona = 'A helpful business AI assistant.';
    let toolAllowlist: string[] = [];
    let connectedChannels: string[] = [];
    let priorMessages: Array<{ role: string; content: string }> = [];
    const { employeeId } = body;
    try {

      if (employeeId) {
        const empRes = await client.query(
          'SELECT name, role, persona, tool_allowlist FROM ai_employees WHERE id = $1 AND org_id = $2',
          [employeeId, orgId]
        );
        if (empRes.rows.length > 0) {
          const emp = empRes.rows[0];
          employeeName = emp.name;
          employeeRole = emp.role;
          employeePersona = emp.persona || employeePersona;
          try {
            toolAllowlist = typeof emp.tool_allowlist === 'string' ? JSON.parse(emp.tool_allowlist) : (emp.tool_allowlist ?? []);
          } catch { toolAllowlist = []; }
        }
      } else {
        const empRes = await client.query(
          `SELECT name, role, persona, tool_allowlist FROM ai_employees WHERE org_id = $1 AND status = 'active' LIMIT 1`,
          [orgId]
        );
        if (empRes.rows.length > 0) {
          const emp = empRes.rows[0];
          employeeName = emp.name;
          employeeRole = emp.role;
          employeePersona = emp.persona || employeePersona;
          try {
            toolAllowlist = typeof emp.tool_allowlist === 'string' ? JSON.parse(emp.tool_allowlist) : (emp.tool_allowlist ?? []);
          } catch { toolAllowlist = []; }
        }
      }

      const channelsRes = await client.query(
        `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
        [orgId]
      );
      connectedChannels = channelTypesFromRows(channelsRes.rows);

      // Mirror run route: persist the prompting user turn so streamed
      // conversations keep both sides of the history.
      if (typeof body.conversationId === 'string' && UUID_RE.test(body.conversationId)) {
        const histRes = await client.query(
          `SELECT role, content FROM (
             SELECT role, content, created_at FROM messages
             WHERE org_id = $1 AND conversation_id = $2
             ORDER BY created_at DESC
             LIMIT 15
           ) sub ORDER BY created_at ASC`,
          [orgId, body.conversationId]
        );
        priorMessages = histRes.rows.map((r) => ({
          role: String(r.role),
          content: String(r.content || ''),
        }));
        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
          [orgId, body.conversationId, userMessageStr]
        );
      }
    } finally {
      client.release();
    }

    const { conversationId, channelId } = body;
    const conversationIdStr = typeof conversationId === 'string' ? conversationId : undefined;
    const channelIdStr = typeof channelId === 'string' ? channelId : undefined;
    const employeeIdStr = typeof employeeId === 'string' ? employeeId : undefined;
    const retrievedMemory = await retrieveForEmployee({
      orgId,
      query: userMessageStr,
      employeeId: employeeIdStr,
      conversationId: conversationIdStr,
      employeeRole,
    });
    const agentInput = {
      orgId,
      userId,
      conversationId: conversationIdStr,
      channelId: channelIdStr,
      employeeId: employeeIdStr,
      // Isolated session for conversation-less calls (see run route).
      sessionKey: conversationIdStr ? undefined : `adhoc-stream:${Date.now()}`,
      employeeName,
      employeeRole,
      employeePersona,
      toolAllowlist: mergeRuntimeAllowlist(toolAllowlist, connectedChannels, employeeRole),
      userMessage: userMessageStr,
      connectedChannels,
      idempotencyKey: conversationIdStr ? `stream:${conversationIdStr}:${Date.now()}` : `stream:${Date.now()}`,
    };

    let handle: Awaited<ReturnType<typeof startAutonomousAgentWorkflow>> | null = null;
    try {
      handle = await startAutonomousAgentWorkflow(agentInput);
    } catch (err: any) {
      // start* throws when the workflow ran and failed — never fall through
      // to direct (tools may already have executed). Null means Temporal down.
      console.error('[Agent Stream] Temporal workflow failed:', err?.message);
      return NextResponse.json(
        { error: 'Agent workflow failed', detail: String(err?.message || 'unknown').slice(0, 300) },
        { status: 502 }
      );
    }

    const encoder = new TextEncoder();

    if (!handle) {
      const stream = new ReadableStream({
        async start(controller) {
          try {
            const result = await runAutonomousAgentDirect(agentInput, {
              retrievedMemory,
              priorMessages,
              onChunk: (text) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', text })}

`));
              },
              onToolProgress: (tool, label) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_progress', step: { action: tool, result: label, toolUsed: tool } })}

`));
              },
            });
            if (conversationIdStr && UUID_RE.test(conversationIdStr) && result?.replyMessage) {
              try {
                const { client: persistClient } = await getScopedClient();
                try {
                  await persistClient.query(
                    `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls) VALUES ($1, $2, 'assistant', $3, $4)`,
                    [orgId, conversationIdStr, result.replyMessage, JSON.stringify(result.executedSteps || [])]
                  );
                } finally {
                  persistClient.release();
                }
              } catch (persistErr: any) {
                console.warn('[Agent Stream] Failed to persist assistant reply:', persistErr?.message);
              }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'reply', result })}

`));
          } catch (err: any) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}

`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const workflowHandle = handle;

    const stream = new ReadableStream({
      async start(controller) {
        let isDone = false;
        let finalResult: any = null;
        let error: any = null;
        let closed = false;
        const onAbort = () => {
          closed = true;
          isDone = true;
          try { controller.close(); } catch { /* already closed */ }
        };
        request.signal.addEventListener('abort', onAbort, { once: true });

        workflowHandle.result().then((res) => {
          isDone = true;
          finalResult = res;
        }).catch((err) => {
          isDone = true;
          error = err;
        });

        let lastStepCount = 0;

        // Bound the poll loop (~240s: covers the 180s turn budget plus tail)
        // so a hung workflow can't leak the stream forever; also break early
        // on client disconnect.
        for (let i = 0; i < 240 && !isDone && !closed && !request.signal.aborted; i++) {
          try {
            const steps: any[] = await workflowHandle.query('agentProgressQuery');
            if (steps && steps.length > lastStepCount) {
              for (let i = lastStepCount; i < steps.length; i++) {
                const data = JSON.stringify({ type: 'tool_progress', step: steps[i] });
                controller.enqueue(encoder.encode(`data: ${data}

`));
              }
              lastStepCount = steps.length;
            }
          } catch {
            // Ignore query errors during execution, workflow might be completing
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        request.signal.removeEventListener('abort', onAbort);
        if (closed || request.signal.aborted) return;

        if (!isDone && !finalResult && !error) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Stream timed out waiting for workflow' })}

`));
          controller.close();
          return;
        }

        if (error) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: error.message })}

`));
        } else if (finalResult) {
          const steps = finalResult.executedSteps || [];
          if (steps.length > lastStepCount) {
            for (let i = lastStepCount; i < steps.length; i++) {
              const data = JSON.stringify({ type: 'tool_progress', step: steps[i] });
              controller.enqueue(encoder.encode(`data: ${data}

`));
            }
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'reply', result: finalResult })}

`));
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error: any) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/agent/stream Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
