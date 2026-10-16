import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { canDisableEmployee, loadHumanRole } from '@/lib/rbac';
import {
  provisionCustomEmployee,
  seedDefaultEmployees,
} from '@/lib/employee-provision';
import { validateToolAllowlist } from '@/lib/tool-allowlist';

function isMissingColumn(err: unknown): boolean {
  return (err as { code?: string })?.code === '42703';
}

async function connectedChannelTypes(client: PoolClient, orgId: string): Promise<string[]> {
  try {
    const ch = await client.query(
      `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('connected', 'active')`,
      [orgId],
    );
    return ch.rows.map((row) => String(row.channel_type || '')).filter(Boolean);
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      let res;
      try {
        res = await client.query(
          `SELECT id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at
             FROM ai_employees
            WHERE org_id = $1 AND archived_at IS NULL
            ORDER BY created_at ASC`,
          [orgId],
        );
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        res = await client.query(
          `SELECT id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at
             FROM ai_employees
            WHERE org_id = $1
            ORDER BY created_at ASC`,
          [orgId],
        );
      }

      if (res.rows.length === 0) {
        await seedDefaultEmployees(client, orgId);
        try {
          const seeded = await client.query(
            `SELECT id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at
               FROM ai_employees
              WHERE org_id = $1 AND archived_at IS NULL
              ORDER BY created_at ASC`,
            [orgId],
          );
          return NextResponse.json({
            employees: seeded.rows,
            connectedChannels: await connectedChannelTypes(client, orgId),
          });
        } catch (err) {
          if (!isMissingColumn(err)) throw err;
          const seeded = await client.query(
            `SELECT id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at
               FROM ai_employees WHERE org_id = $1 ORDER BY created_at ASC`,
            [orgId],
          );
          return NextResponse.json({
            employees: seeded.rows,
            connectedChannels: await connectedChannelTypes(client, orgId),
          });
        }
      }

      return NextResponse.json({
        employees: res.rows,
        connectedChannels: await connectedChannelTypes(client, orgId),
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/employees GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const humanRole = await loadHumanRole(client, userId);
      if (!canDisableEmployee(humanRole)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const { name, role: empRole, persona, tool_allowlist, status } = body as {
        name?: unknown; role?: unknown; persona?: unknown; tool_allowlist?: unknown; status?: unknown;
      };

      if (typeof name !== 'string' || !name.trim() || typeof empRole !== 'string' || !empRole.trim()) {
        return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
      }

      const rawTools = Array.isArray(tool_allowlist)
        ? tool_allowlist.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
        : [];
      const validated = validateToolAllowlist(rawTools);
      if (!validated.ok) {
        return NextResponse.json(
          { error: `Invalid tools: ${validated.invalid.join(', ')}` },
          { status: 400 },
        );
      }
      const empStatus = status === 'paused' ? 'paused' : 'active';
      const personaJson = JSON.stringify(typeof persona === 'string' ? persona : persona ?? '');

      const employee = await provisionCustomEmployee(client, orgId, {
        name: name.trim(),
        role: (empRole as string).trim(),
        personaJson,
        toolAllowlist: validated.tools,
        status: empStatus,
        graphId: `emp-${crypto.randomUUID()}`,
      });

      return NextResponse.json({ employee }, { status: 201 });
    } finally {
      client.release();
    }
  } catch (error: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('API /api/employees POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const humanRole = await loadHumanRole(client, userId);
      if (!canDisableEmployee(humanRole)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const id = typeof body?.id === 'string' ? body.id : '';
      const name = typeof body?.name === 'string' ? body.name : '';
      const status = body?.status === 'paused' ? 'paused' : body?.status === 'active' ? 'active' : '';
      if (!status || (!id && !name)) {
        return NextResponse.json({ error: 'id or name, and status, are required' }, { status: 400 });
      }

      const res = id
        ? await client.query(
            `UPDATE ai_employees SET status = $3, updated_at = NOW()
             WHERE id = $1 AND org_id = $2
             RETURNING id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at`,
            [id, orgId, status]
          )
        : await client.query(
            `UPDATE ai_employees SET status = $3, updated_at = NOW()
             WHERE org_id = $1 AND lower(name) = lower($2)
             RETURNING id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at`,
            [orgId, name, status]
          );

      if (res.rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }
      return NextResponse.json({ employee: res.rows[0] });
    } finally {
      client.release();
    }
  } catch (error: any) {
    const __scopedAuth3 = scopedAuthErrorResponse(error);
    if (__scopedAuth3) return __scopedAuth3;
    console.error('API /api/employees PATCH Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
