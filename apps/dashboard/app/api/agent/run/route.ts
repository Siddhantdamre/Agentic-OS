import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/atomic-agent-client';
import { logLangfuseTrace } from '@/lib/langfuse-trace';

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

      const agentInput = {
        orgId,
        conversationId,
        channelId,
        employeeName,
        employeeRole,
        employeePersona,
        toolAllowlist,
        userMessage,
      };

      // Try Temporal first for durable, retryable execution
      let result: any = null;
      try {
        const { triggerAutonomousAgentWorkflow } = await import('@darex/workflows/dist/workflow-client');
        result = await triggerAutonomousAgentWorkflow(agentInput);
        console.log('[Agent Run] Task executed via Temporal workflow');
      } catch (temporalErr: any) {
        console.warn('[Agent Run] Temporal unavailable, falling back to direct execution:', temporalErr.message);
      }

      // Fallback: direct in-process execution via atomic-agent
      if (!result) {
        result = await runAutonomousAgentDirect(agentInput);
        console.log('[Agent Run] Task executed via direct atomic-agent loop');
      }

      // Save to DB if conversationId provided
      if (conversationId) {
        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
          [orgId, conversationId, userMessage]
        );
        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls) VALUES ($1, $2, 'assistant', $3, $4)`,
          [orgId, conversationId, result.replyMessage, JSON.stringify(result.executedSteps)]
        );
      }

      await logLangfuseTrace({
        name: `AgentExecution-${employeeName}`,
        orgId,
        input: { userMessage, employeeName, employeeRole },
        output: result.replyMessage,
        metadata: { usedTools: result.usedTools, steps: result.executedSteps.length },
      });

      try {
        await client.query(
          `INSERT INTO channel_logs (org_id, channel_id, log_type, payload) VALUES ($1, $2, 'AGENT_EXECUTION', $3)`,
          [orgId, channelId || null, JSON.stringify({ employeeName, tools: result.usedTools })]
        );
      } catch (e) { /* non-critical */ }

      return NextResponse.json({
        success: true,
        replyMessage: result.replyMessage,
        executedSteps: result.executedSteps,
        usedTools: result.usedTools,
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/run Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
