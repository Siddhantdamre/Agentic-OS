import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = await request.json();
      const { userMessage, employeeId, conversationId, channelId } = body;

      if (!userMessage) {
        return NextResponse.json({ error: 'userMessage is required' }, { status: 400 });
      }

      // Fetch employee profile from DB
      let employeeName = 'AI Assistant';
      let employeeRole = 'General Assistant';
      let employeePersona = 'A helpful business AI assistant.';
      let toolAllowlist: string[] = [];

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
        `SELECT * FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
        [orgId]
      );
      const connectedChannels = channelsRes.rows;

      const agentInput = {
        orgId,
        conversationId,
        channelId,
        employeeName,
        employeeRole,
        employeePersona,
        toolAllowlist,
        userMessage,
        connectedChannels,
      };

      const { startAutonomousAgentWorkflow } = await import('@darex/workflows/dist/workflow-client');
      const handle = await startAutonomousAgentWorkflow(agentInput);

      if (!handle) {
        return NextResponse.json({ error: 'Failed to start Temporal workflow' }, { status: 500 });
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let isDone = false;
          let finalResult: any = null;
          let error: any = null;

          // Listen for completion
          handle.result().then(res => {
            isDone = true;
            finalResult = res;
          }).catch(err => {
            isDone = true;
            error = err;
          });

          let lastStepCount = 0;

          while (!isDone) {
            try {
              const steps: any[] = await handle.query('agentProgressQuery');
              if (steps && steps.length > lastStepCount) {
                for (let i = lastStepCount; i < steps.length; i++) {
                  const data = JSON.stringify({ type: 'tool_progress', step: steps[i] });
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                }
                lastStepCount = steps.length;
              }
            } catch (e) {
              // Ignore query errors during execution, workflow might be completing
            }
            
            // Wait 1 second before next poll
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          if (error) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`));
          } else if (finalResult) {
            // Pick up any last steps
            const steps = finalResult.executedSteps || [];
            if (steps.length > lastStepCount) {
              for (let i = lastStepCount; i < steps.length; i++) {
                const data = JSON.stringify({ type: 'tool_progress', step: steps[i] });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'reply', result: finalResult })}\n\n`));
          }

          controller.close();
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });

    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/stream Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
