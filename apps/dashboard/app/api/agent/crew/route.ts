import { usageBlockedResponse } from '@/lib/usage-gate';
import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { readJsonBody } from '@/lib/safe-json';
import {
  isActiveCrewMember,
  planCrew,
  parseEmployeeAllowlist,
  resolveCrewAssignments,
} from '@/lib/crew-planner';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import type { AgentTaskInput, CrewRosterMember, CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';
import { channelTypesFromRows, mergeRuntimeAllowlist } from '@darex/workflows/dist/tool-executor';
import { startCrewWorkflow } from '@darex/workflows/dist/workflow-client';
import { runCrewDirect } from '@darex/workflows/dist/crew-runner';
import { awaitCrewHandleWithAbort } from '@/lib/crew-abort';

function personaText(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (raw && typeof raw === 'object') return JSON.stringify(raw);
  return 'A helpful business AI assistant.';
}

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const parsed = await readJsonBody<{ userMessage?: unknown; conversationId?: unknown; channelId?: unknown; org_id?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const earlyBody = parsed.body;
    if (earlyBody.org_id) {
      return NextResponse.json({ error: 'org_id is not accepted in the body' }, { status: 400 });
    }
    if (!earlyBody.userMessage || !String(earlyBody.userMessage).trim()) {
      return NextResponse.json({ error: 'userMessage is required' }, { status: 400 });
    }

    const { client, orgId } = await getScopedClient();
    const usageDenied = await usageBlockedResponse(orgId);
    if (usageDenied) {
      client.release();
      return usageDenied;
    }
    let roster: CrewRosterMember[] = [];
    let connectedChannels: string[] = [];
    // Reuse the already-validated body; never re-parse request.json() here.
    const body = earlyBody as { userMessage?: string; conversationId?: string; channelId?: string; org_id?: unknown };

    try {

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
    const stamp = `crew:${Date.now()}`;

    const { resolved, unmatchedEmployeeIds, inactiveEmployeeIds } = resolveCrewAssignments(
      plan.specialists,
      roster,
    );
    if (unmatchedEmployeeIds.length > 0) {
      console.warn(
        `[Agent Crew] plan referenced unknown employeeId(s): ${unmatchedEmployeeIds.join(', ')}`,
      );
    }
    if (inactiveEmployeeIds.length > 0) {
      console.warn(
        `[Agent Crew] skipped inactive employeeId(s) before dispatch: ${inactiveEmployeeIds.join(', ')}`,
      );
    }

    const specialistInputs: AgentTaskInput[] = resolved.map(({ assignment, employee: emp }) => {
      const employeeTools = emp.tool_allowlist;
      const toolAllowlist = mergeRuntimeAllowlist(employeeTools, connectedChannels, emp.role);
      const visibleChannels = connectedChannels.filter((ch) =>
        toolAllowlist.some((t) => t === ch || t.startsWith(`${ch}-`) || ch.startsWith(`${t}-`))
      );
      return {
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
      };
    });

    const activeRoster = roster.filter(isActiveCrewMember);
    const managerEmp = resolved[0]?.employee || activeRoster[0];
    if (!managerEmp) {
      return NextResponse.json({ error: 'No active AI employees available for crew.' }, { status: 400 });
    }
    const managerAllowlist = mergeRuntimeAllowlist(managerEmp.tool_allowlist, connectedChannels, managerEmp.role);
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
    let result: CrewWorkflowResult;
    try {
      const handle = await startCrewWorkflow(crewInput);
      if (handle) {
        usedTemporal = true;
        result = await awaitCrewHandleWithAbort(handle, request.signal);
      } else {
        console.warn('[Agent Crew] Temporal unavailable, falling back to direct execution');
        result = await runCrewDirect(crewInput, { signal: request.signal });
      }
    } catch (crewErr: any) {
      if (crewErr?.name === 'AbortError' || request.signal.aborted) {
        return NextResponse.json({ error: 'Client aborted' }, { status: 499 });
      }
      console.error('[Agent Crew] Temporal workflow failed (no direct re-run):', crewErr?.message);
      return NextResponse.json(
        { error: 'Crew workflow failed', detail: String(crewErr?.message || 'unknown').slice(0, 300) },
        { status: 502 }
      );
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
      spawned: (result.spawned as Array<{
        employeeId: string;
        employeeName: string;
        employeeRole: string;
        task: string;
        result: { replyMessage: string; usedTools: string[]; success: boolean };
      }>).map((s) => ({
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
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/agent/crew Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
