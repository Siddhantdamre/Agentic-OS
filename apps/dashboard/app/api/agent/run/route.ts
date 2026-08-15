import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/atomic-agent-client';
import { retrieveMemory } from '@darex/workflows/dist/memory/retrieve';
import { triggerAutonomousAgentWorkflow } from '@darex/workflows/dist/workflow-client';
import { channelTypesFromRows, mergeRuntimeAllowlist } from '@darex/workflows/dist/tool-executor';
import { logLangfuseTrace } from '@/lib/langfuse-trace';

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

      if (body.conversationId) {
        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
          [orgId, body.conversationId, body.userMessage]
        );
      }
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
      idempotencyKey: conversationId ? `run:${conversationId}:${Date.now()}` : `run:${Date.now()}`,
    };

    let result: any = null;
    let usedTemporal = false;
    try {
      result = await triggerAutonomousAgentWorkflow(agentInput);
      if (result) {
        usedTemporal = true;
        console.log('[Agent Run] Task executed via Temporal workflow');
      }
    } catch (temporalErr: any) {
      console.warn('[Agent Run] Temporal unavailable, falling back to direct execution:', temporalErr.message);
    }

    if (!result) {
      result = await runAutonomousAgentDirect(agentInput, { retrievedMemory });
      console.log('[Agent Run] Task executed via direct atomic-agent loop');
    }

    if (conversationId && !usedTemporal) {
      const { client: persistClient } = await getScopedClient();
      try {
        await persistClient.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls) VALUES ($1, $2, 'assistant', $3, $4)`,
          [orgId, conversationId, result.replyMessage, JSON.stringify(result.executedSteps)]
        );
      } finally {
        persistClient.release();
      }
    }

    await logLangfuseTrace({
      name: `AgentExecution-${employeeName}`,
      orgId,
      input: { userMessage, employeeName, employeeRole },
      output: result.replyMessage,
      metadata: { usedTools: result.usedTools, steps: result.executedSteps.length, engine: usedTemporal ? 'temporal' : 'direct' },
    }).catch((err) => console.warn('[Agent Run] Langfuse trace failed:', err?.message));

    return NextResponse.json({
      success: result.success !== false,
      replyMessage: result.replyMessage,
      executedSteps: result.executedSteps,
      usedTools: result.usedTools,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/run Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
