import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/atomic-agent-client';
import { retrieveMemory } from '@darex/workflows/dist/memory/retrieve';
import { startAutonomousAgentWorkflow } from '@darex/workflows/dist/workflow-client';
import { channelTypesFromRows, mergeRuntimeAllowlist } from '@darex/workflows/dist/tool-executor';

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    let employeeName = 'AI Assistant';
    let employeeRole = 'General Assistant';
    let employeePersona = 'A helpful business AI assistant.';
    let toolAllowlist: string[] = [];
    let connectedChannels: string[] = [];
    let body: any;
    try {
      body = await request.json();
      const { userMessage, employeeId } = body;

      if (!userMessage) {
        return NextResponse.json({ error: 'userMessage is required' }, { status: 400 });
      }

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
    } finally {
      client.release();
    }

    const { userMessage, employeeId, conversationId, channelId } = body;
    const retrievedMemory = await retrieveMemory({
      orgId,
      query: userMessage,
      employeeId: typeof employeeId === 'string' ? employeeId : undefined,
      conversationId: typeof conversationId === 'string' ? conversationId : undefined,
    });
    const agentInput = {
      orgId,
      conversationId,
      channelId,
      employeeId,
      employeeName,
      employeeRole,
      employeePersona,
      toolAllowlist: mergeRuntimeAllowlist(toolAllowlist, connectedChannels),
      userMessage,
      connectedChannels,
      idempotencyKey: conversationId ? `stream:${conversationId}:${Date.now()}` : `stream:${Date.now()}`,
    };

    let handle: Awaited<ReturnType<typeof startAutonomousAgentWorkflow>> | null = null;
    try {
      handle = await startAutonomousAgentWorkflow(agentInput);
    } catch (err: any) {
      console.warn('[Agent Stream] Temporal start failed, using direct stream:', err.message);
    }

    const encoder = new TextEncoder();

    if (!handle) {
      const stream = new ReadableStream({
        async start(controller) {
          try {
            const result = await runAutonomousAgentDirect(agentInput, {
              retrievedMemory,
              onChunk: (text) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', text })}

`));
              },
              onToolProgress: (tool, label) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_progress', step: { action: tool, result: label, toolUsed: tool } })}

`));
              },
            });
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

        workflowHandle.result().then((res) => {
          isDone = true;
          finalResult = res;
        }).catch((err) => {
          isDone = true;
          error = err;
        });

        let lastStepCount = 0;

        while (!isDone) {
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
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/stream Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
