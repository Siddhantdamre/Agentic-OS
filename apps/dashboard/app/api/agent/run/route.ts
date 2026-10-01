import { usageBlockedResponse } from '@/lib/usage-gate';
import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { readJsonBody } from '@/lib/safe-json';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/agent-client';
import { retrieveForEmployee } from '@darex/workflows/dist/memory/employee-retrieve';
import { triggerAutonomousAgentWorkflow } from '@darex/workflows/dist/workflow-client';
import { channelTypesFromRows, mergeRuntimeAllowlist } from '@darex/workflows/dist/tool-executor';
import { logLangfuseTrace } from '@/lib/langfuse-trace';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const parsed = await readJsonBody<{ userMessage?: unknown; employeeId?: unknown; conversationId?: unknown; channelId?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const { userMessage } = body;

    if (!userMessage || !String(userMessage).trim()) {
      return NextResponse.json({ error: 'userMessage is required' }, { status: 400 });
    }

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
    try {
      const { employeeId } = body;

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
          [orgId, body.conversationId, body.userMessage]
        );
      }
    } finally {
      client.release();
    }

    const { employeeId, conversationId, channelId } = body;
    const userMessageStr = String(userMessage).trim();
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
      // Isolated session for conversation-less calls so unrelated adhoc turns
      // never share an employeeId/date-keyed TrueForge session.
      sessionKey: conversationIdStr ? undefined : `adhoc-run:${Date.now()}`,
      employeeName,
      employeeRole,
      employeePersona,
      toolAllowlist: mergeRuntimeAllowlist(toolAllowlist, connectedChannels, employeeRole),
      userMessage: userMessageStr,
      connectedChannels,
      idempotencyKey: conversationIdStr ? `run:${conversationIdStr}:${Date.now()}` : `run:${Date.now()}`,
    };

    let result: any = null;
    let usedTemporal = false;
    // trigger* returns null ONLY when Temporal is down (safe to run direct).
    // It throws when the workflow ran and failed — never re-run direct then,
    // tools may already have executed.
    try {
      result = await triggerAutonomousAgentWorkflow(agentInput);
      if (result) {
        usedTemporal = true;
        console.log('[Agent Run] Task executed via Temporal workflow');
      }
    } catch (temporalErr: any) {
      console.error('[Agent Run] Temporal workflow failed (no direct re-run):', temporalErr?.message);
      return NextResponse.json(
        { error: 'Agent workflow failed', detail: String(temporalErr?.message || 'unknown').slice(0, 300) },
        { status: 502 }
      );
    }

    if (!result) {
      console.warn('[Agent Run] Temporal unavailable, falling back to direct execution');
      result = await runAutonomousAgentDirect(agentInput, { retrievedMemory, priorMessages });
      console.log('[Agent Run] Task executed via direct TrueForge loop');
    }

    if (conversationIdStr && UUID_RE.test(conversationIdStr) && !usedTemporal) {
      const { client: persistClient } = await getScopedClient();
      try {
        await persistClient.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls) VALUES ($1, $2, 'assistant', $3, $4)`,
          [orgId, conversationIdStr, result.replyMessage, JSON.stringify(result.executedSteps)]
        );
      } finally {
        persistClient.release();
      }
    }

    await logLangfuseTrace({
      name: `AgentExecution-${employeeName}`,
      orgId,
      input: { userMessage: userMessageStr, employeeName, employeeRole },
      output: result.replyMessage,
      metadata: {
        usedTools: result.usedTools,
        steps: result.executedSteps.length,
        approvalsRequested: (result.executedSteps || []).filter((s: any) => s.toolUsed === 'approval_required' || s.action === 'approval_required').length,
        engine: usedTemporal ? 'temporal' : 'direct',
      },
    }).catch((err) => console.warn('[Agent Run] Langfuse trace failed:', err?.message));

    return NextResponse.json({
      success: result.success !== false,
      replyMessage: result.replyMessage,
      executedSteps: result.executedSteps,
      usedTools: result.usedTools,
    });
  } catch (error: any) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/agent/run Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
