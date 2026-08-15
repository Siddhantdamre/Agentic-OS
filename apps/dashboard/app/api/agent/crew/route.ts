import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { planCrew, parseEmployeeAllowlist } from '@/lib/crew-planner';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import type { AgentTaskInput, CrewRosterMember, CrewWorkflowInput } from '@darex/shared-types';
import { MAX_CREW_SPAWN } from '@darex/shared-types';
import { channelTypesFromRows, mergeRuntimeAllowlist } from '@darex/workflows/dist/tool-executor';
import { triggerCrewWorkflow } from '@darex/workflows/dist/workflow-client';
import { runCrewDirect } from '@darex/workflows/dist/crew-runner';

function personaText(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (raw && typeof raw === 'object') return JSON.stringify(raw);
  return 'A helpful business AI assistant.';
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    let roster: CrewRosterMember[] = [];
    let connectedChannels: string[] = [];
    let body: { userMessage?: string; conversationId?: string; channelId?: string; org_id?: unknown };

    try {
      body = await request.json();
      if (body.org_id) {
        return NextResponse.json({ error: 'org_id is not accepted in the body' }, { status: 400 });
      }
      if (!body.userMessage || !String(body.userMessage).trim()) {
        return NextResponse.json({ error: 'userMessage is required' }, { status: 400 });
      }

      const empRes = await client.query(
        `SELECT id, name, role, persona, tool_allowlist, status
         FROM ai_employees
         WHERE org_id = $1
         ORDER BY created_at ASC`,
        [orgId]
      );
      roster = empRes.rows.map((row: {
        id: string;
        name: string;
        role: string;
        persona: unknown;
        tool_allowlist: unknown;
        status: string;
      }) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        persona: personaText(row.persona),
        tool_allowlist: parseEmployeeAllowlist(row.tool_allowlist),
        status: row.status,
      }));

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

    if (roster.length === 0) {
      return NextResponse.json({ error: 'No AI employees in this org. Hire one first.' }, { status: 400 });
    }

    const userMessage = String(body.userMessage);
    const plan = await planCrew(userMessage, roster);
    const byId = new Map(roster.map((e) => [e.id, e]));
    const stamp = `crew:${Date.now()}`;

    const specialistInputs: AgentTaskInput[] = plan.specialists.slice(0, MAX_CREW_SPAWN).flatMap((assignment) => {
      const emp = byId.get(assignment.employeeId);
      if (!emp) return [];
      const employeeTools = emp.tool_allowlist;
      const toolAllowlist = mergeRuntimeAllowlist(employeeTools, undefined);
      const visibleChannels = connectedChannels.filter((ch) =>
        toolAllowlist.some((t) => t === ch || t.startsWith(`${ch}-`) || ch.startsWith(`${t}-`))
      );
      return [{
        orgId,
        employeeId: emp.id,
        employeeName: emp.name,
        employeeRole: emp.role,
        employeePersona: emp.persona,
        toolAllowlist,
        connectedChannels: visibleChannels,
        userMessage: assignment.task || userMessage,
        sessionKey: `crew:${stamp}:${emp.id}`,
        skipPersist: true,
      }];
    });

    const managerEmp = byId.get(plan.specialists[0]?.employeeId) || roster[0];
    const managerAllowlist = mergeRuntimeAllowlist(managerEmp.tool_allowlist, undefined);
    const manager: AgentTaskInput = {
      orgId,
      conversationId: body.conversationId,
      channelId: body.channelId,
      employeeId: managerEmp.id,
      employeeName: managerEmp.name,
      employeeRole: managerEmp.role,
      employeePersona: managerEmp.persona,
      toolAllowlist: managerAllowlist,
      connectedChannels: connectedChannels.filter((ch) =>
        managerAllowlist.some((t) => t === ch || t.startsWith(`${ch}-`) || ch.startsWith(`${t}-`))
      ),
      userMessage,
      sessionKey: `crew:${stamp}:manager`,
    };

    const crewInput: CrewWorkflowInput = {
      orgId,
      conversationId: body.conversationId,
      channelId: body.channelId,
      userMessage,
      idempotencyKey: stamp,
      reason: plan.reason,
      manager,
      specialists: specialistInputs.length > 0 ? specialistInputs : [manager],
    };

    let usedTemporal = false;
    let result = await triggerCrewWorkflow(crewInput);
    if (result) {
      usedTemporal = true;
    } else {
      result = await runCrewDirect(crewInput);
    }

    if (body.conversationId && !usedTemporal && result.replyMessage) {
      const { client: persistClient } = await getScopedClient();
      try {
        await persistClient.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls) VALUES ($1, $2, 'assistant', $3, $4)`,
          [orgId, body.conversationId, result.replyMessage, JSON.stringify(result.spawned)]
        );
      } finally {
        persistClient.release();
      }
    }

    await logLangfuseTrace({
      name: `CrewExecution-${result.mode}`,
      orgId,
      input: { userMessage, mode: result.mode, specialists: plan.specialists.map((s) => s.employeeName) },
      output: result.replyMessage,
      metadata: {
        usedTools: result.usedTools,
        engine: usedTemporal ? 'temporal-crew' : 'direct-crew',
        reason: plan.reason,
      },
    }).catch((err) => console.warn('[Agent Crew] Langfuse trace failed:', err?.message));

    return NextResponse.json({
      success: result.success !== false,
      mode: result.mode,
      reason: result.reason || plan.reason,
      replyMessage: result.replyMessage,
      spawned: result.spawned.map((s) => ({
        employeeId: s.employeeId,
        employeeName: s.employeeName,
        employeeRole: s.employeeRole,
        task: s.task,
        replyMessage: s.result.replyMessage,
        usedTools: s.result.usedTools,
        success: s.result.success,
      })),
      usedTools: result.usedTools,
      usedTemporal,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/crew Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
