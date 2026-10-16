import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { canCallPayTools, isPayTool, loadHumanRole } from '@/lib/rbac';
import { AUTONOMOUS_TOOL_CATALOG, executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client } = await getScopedClient();
    client.release();
    return NextResponse.json({
      tools: AUTONOMOUS_TOOL_CATALOG,
      totalCount: AUTONOMOUS_TOOL_CATALOG.length,
    });
  } catch (error: any) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API GET /api/agent/tools Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await tryReadJson<Record<string, unknown>>(request);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { tool, action, payload, employeeId } = body as {
      tool?: unknown; action?: unknown; payload?: unknown; employeeId?: unknown;
    };

    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    try {
      if (!tool) {
        return NextResponse.json({ error: 'Tool parameter is required' }, { status: 400 });
      }

      const role = await loadHumanRole(client, userId);
      if (isPayTool(String(tool), typeof action === 'string' ? action : undefined) && !canCallPayTools(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } finally {
      client.release();
    }

    const result = await executeAutonomousToolAction({
      tool: String(tool),
      action: typeof action === 'string' ? action : 'auto_execute',
      payload: (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
      orgId,
      // The executor loads this employee's card for the session org. With no
      // employee named, the call runs as the Executive (17 §3), never as the
      // union of every card.
      ...(typeof employeeId === 'string' && employeeId ? { employeeId } : { employeeRole: 'executive' }),
      actorUserId: userId,
      source: 'chat',
    });

    try {
      const { client: logClient } = await getScopedClient();
      try {
        await logClient.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
           VALUES ($1, $2, 'TOOL_ACTION_EXECUTION', $3, $4, $5, $6)`,
          [orgId, tool, result.status === 'executed' ? 'success' : 'error', result.status === 'executed' ? 200 : 400, result.message, JSON.stringify(result.data)]
        );
      } finally {
        logClient.release();
      }
    } catch {
      // Non-critical audit log
    }

    const completed = result.status === 'executed' || result.status === 'pending_approval';
    return NextResponse.json({
      success: completed,
      result,
      error: completed ? undefined : result.message,
    });
  } catch (error: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('API /api/agent/tools Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
