import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { canDisableEmployee, loadHumanRole } from '@/lib/rbac';
import { validateToolAllowlist } from '@/lib/tool-allowlist';
import { recordAuditEvent } from '@/lib/audit-events';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMissingColumn(err: unknown): boolean {
  return (err as { code?: string })?.code === '42703';
}

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { id } = params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid employee id' }, { status: 400 });
    }
    const { client, orgId } = await getScopedClient();
    try {
      let res;
      try {
        res = await client.query(
          `SELECT id, name, role, persona, tool_allowlist, graph_id, status, archived_at, created_at, updated_at
             FROM ai_employees
            WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
          [id, orgId],
        );
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        res = await client.query(
          `SELECT id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at
             FROM ai_employees WHERE id = $1 AND org_id = $2`,
          [id, orgId],
        );
      }
      if (res.rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }
      return NextResponse.json({ employee: res.rows[0] });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/employees/[id] GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { id } = params;
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
      const { name, role: empRole, persona, tool_allowlist, status } = body;

      const fields: string[] = [];
      const values: unknown[] = [id, orgId];
      let valIdx = 3;

      if (name !== undefined) {
        fields.push(`name = $${valIdx++}`);
        values.push(name);
      }
      if (empRole !== undefined) {
        fields.push(`role = $${valIdx++}`);
        values.push(empRole);
      }
      if (persona !== undefined) {
        fields.push(`persona = $${valIdx++}::jsonb`);
        values.push(JSON.stringify(typeof persona === 'string' ? persona : persona));
      }
      if (tool_allowlist !== undefined) {
        const raw = Array.isArray(tool_allowlist)
          ? tool_allowlist.filter((item: unknown): item is string => typeof item === 'string')
          : [];
        const validated = validateToolAllowlist(raw);
        if (!validated.ok) {
          return NextResponse.json(
            { error: `Invalid tools: ${validated.invalid.join(', ')}` },
            { status: 400 },
          );
        }
        fields.push(`tool_allowlist = $${valIdx++}`);
        values.push(validated.tools);
      }
      if (status !== undefined) {
        fields.push(`status = $${valIdx++}`);
        values.push(status === 'paused' ? 'paused' : 'active');
      }

      fields.push(`updated_at = NOW()`);

      if (fields.length === 1) {
        return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
      }

      const query = `
        UPDATE ai_employees
        SET ${fields.join(', ')}
        WHERE id = $1 AND org_id = $2
        RETURNING id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at
      `;

      const res = await client.query(query, values);
      if (res.rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }

      await recordAuditEvent(
        { orgId, kind: 'employee.update', actor: { actorType: 'user', userId }, resultStatus: 'ok', payload: { employeeId: id } },
        { client, orgId }
      );

      return NextResponse.json({ employee: res.rows[0] });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('API /api/employees/[id] PATCH Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { id } = params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid employee id' }, { status: 400 });
    }
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canDisableEmployee(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const { searchParams } = new URL(request.url);
      const reassignTo = searchParams.get('reassignTo');
      if (reassignTo && !UUID_RE.test(reassignTo)) {
        return NextResponse.json({ error: 'Invalid reassignTo id' }, { status: 400 });
      }

      let taskCount = 0;
      try {
        const openTasks = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM work_items
            WHERE assignee_employee_id = $1 AND org_id = $2
              AND status IN ('open', 'needs_attention', 'waiting_approval', 'in_progress')`,
          [id, orgId],
        );
        taskCount = parseInt(openTasks.rows[0]?.count || '0', 10);
      } catch (err) {
        if ((err as { code?: string })?.code !== '42P01') throw err;
      }

      if (taskCount > 0 && !reassignTo) {
        return NextResponse.json(
          {
            error: `Employee has ${taskCount} active tasks. Pass reassignTo to reassign before archiving.`,
            activeTaskCount: taskCount,
          },
          { status: 409 },
        );
      }

      await client.query('BEGIN');
      try {
        if (taskCount > 0 && reassignTo) {
          const target = await client.query(
            `SELECT id FROM ai_employees WHERE id = $1 AND org_id = $2 AND (archived_at IS NULL OR archived_at IS NOT NULL)`,
            [reassignTo, orgId],
          );
          // Prefer non-archived target when column exists
          let targetOk = target.rowCount && target.rowCount > 0;
          try {
            const activeTarget = await client.query(
              `SELECT id FROM ai_employees WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
              [reassignTo, orgId],
            );
            targetOk = Boolean(activeTarget.rowCount);
          } catch (err) {
            if (!isMissingColumn(err)) throw err;
          }
          if (!targetOk) {
            await client.query('ROLLBACK');
            return NextResponse.json({ error: 'reassignTo employee not found' }, { status: 400 });
          }
          await client.query(
            `UPDATE work_items
                SET assignee_employee_id = $1, updated_at = NOW()
              WHERE assignee_employee_id = $2 AND org_id = $3
                AND status IN ('open', 'needs_attention', 'waiting_approval', 'in_progress')`,
            [reassignTo, id, orgId],
          );
        }

        let res;
        try {
          res = await client.query(
            `UPDATE ai_employees
                SET status = 'paused', archived_at = NOW(), updated_at = NOW()
              WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
              RETURNING id, name`,
            [id, orgId],
          );
        } catch (err) {
          if (!isMissingColumn(err)) throw err;
          // Fallback hard delete if migration not applied yet — still reassign first.
          res = await client.query(
            `DELETE FROM ai_employees WHERE id = $1 AND org_id = $2 RETURNING id, name`,
            [id, orgId],
          );
        }

        if (!res.rowCount) {
          await client.query('ROLLBACK');
          return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
        }

        await client.query('COMMIT');

        await recordAuditEvent(
          { orgId, kind: 'employee.delete', actor: { actorType: 'user', userId }, resultStatus: 'ok', payload: { employeeId: id, reassignTo: reassignTo || null } },
          { client, orgId }
        );

        return NextResponse.json({
          success: true,
          archived: res.rows[0],
          reassignedTasks: taskCount,
          reassignTo: reassignTo || null,
        });
      } catch (inner) {
        await client.query('ROLLBACK');
        throw inner;
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth3 = scopedAuthErrorResponse(error);
    if (__scopedAuth3) return __scopedAuth3;
    console.error('API /api/employees/[id] DELETE Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
