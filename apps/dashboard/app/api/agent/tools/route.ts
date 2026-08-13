import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { canCallPayTools, isPayTool, loadHumanRole } from '@/lib/rbac';
import { AUTONOMOUS_TOOL_CATALOG, executeAutonomousToolAction, mergeRuntimeAllowlist } from '@darex/workflows/dist/tool-executor';

export async function GET() {
  try {
    const { client } = await getScopedClient();
    client.release();
    return NextResponse.json({
      tools: AUTONOMOUS_TOOL_CATALOG,
      totalCount: AUTONOMOUS_TOOL_CATALOG.length,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API GET /api/agent/tools Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { tool, action, payload } = body;

    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    let allowlist: string[] = [];
    try {
      if (!tool) {
        return NextResponse.json({ error: 'Tool parameter is required' }, { status: 400 });
      }

      const role = await loadHumanRole(client, userId);
      if (isPayTool(String(tool), typeof action === 'string' ? action : undefined) && !canCallPayTools(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const empRes = await client.query(
        `SELECT tool_allowlist FROM ai_employees WHERE org_id = $1 AND status = 'active'`,
        [orgId]
      );
      const employeeTools: string[] = [];
      for (const row of empRes.rows) {
        try {
          const list = Array.isArray(row.tool_allowlist)
            ? row.tool_allowlist
            : JSON.parse(row.tool_allowlist || '[]');
          employeeTools.push(...list.map(String));
        } catch {
          // ignore malformed allowlists
        }
      }
      const chanRes = await client.query(
        `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('connected','active')`,
        [orgId]
      );
      allowlist = mergeRuntimeAllowlist(employeeTools, chanRes.rows.map((r: any) => r.channel_type));
    } finally {
      client.release();
    }

    const result = await executeAutonomousToolAction({
      tool,
      action: action || 'auto_execute',
      payload: payload || {},
      orgId,
      toolAllowlist: allowlist,
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

    return NextResponse.json({ success: result.status === 'executed', result });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/tools Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
