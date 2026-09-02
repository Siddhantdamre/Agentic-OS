import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

/**
 * GET /api/employees/[id] — what this employee has actually done.
 *
 * Until this existed you could pause or delete an employee but never see its
 * work, even though every action has named its employee since the outcome
 * ledger shipped. The roster was a list of permissions with no history behind
 * it, which is the wrong half: the permission answers "what may it touch", and
 * the only question an operator actually asks is "what did it do".
 *
 * Every field below is read from a persisted row. Nothing is derived from a
 * model, estimated, or filled in when absent — a counter with no rows returns
 * 0 and the page says so. An invented metric on this page would undo the
 * attribution work it exists to display.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const { client, orgId } = await getScopedClient();
    try {
      const emp = await client.query(
        `SELECT id, name, role, status, persona, tool_allowlist, created_at
           FROM ai_employees WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [id, orgId]
      );
      if (!emp.rows[0]) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }

      // What it did, by kind. agent_actions is the ledger the outcome pipeline
      // materialises; action_kind is its own vocabulary, not a UI label.
      const actions = await client.query(
        `SELECT action_kind, COUNT(*)::int AS n, MAX(occurred_at) AS last_at
           FROM agent_actions
          WHERE org_id = $1 AND employee_id = $2
          GROUP BY action_kind ORDER BY n DESC`,
        [orgId, id]
      );

      // The threads it owns, newest first. Capped — this is a summary view.
      const conversations = await client.query(
        `SELECT id, status, summary, contact_id, started_at, resolved_at
           FROM conversations
          WHERE org_id = $1 AND employee_id = $2
          ORDER BY started_at DESC LIMIT 20`,
        [orgId, id]
      );

      const convStats = await client.query(
        `SELECT
           COUNT(*)::int                                              AS total,
           COUNT(*) FILTER (WHERE status = 'resolved')::int           AS resolved,
           COUNT(*) FILTER (WHERE status = 'needs_attention')::int    AS needs_attention,
           COUNT(*) FILTER (WHERE status = 'open')::int               AS open
         FROM conversations WHERE org_id = $1 AND employee_id = $2`,
        [orgId, id]
      );

      // Recent individual actions, so the page can show real timestamps rather
      // than only aggregates. metadata carries whatever the source row had.
      const recent = await client.query(
        `SELECT a.action_kind, a.occurred_at, a.conversation_id, a.metadata,
                a.source_table, a.source_id
           FROM agent_actions a
          WHERE a.org_id = $1 AND a.employee_id = $2
          ORDER BY a.occurred_at DESC LIMIT 25`,
        [orgId, id]
      );

      const e = emp.rows[0];
      const persona = typeof e.persona === 'object' && e.persona
        ? (e.persona as { text?: string }).text ?? null
        : null;

      return NextResponse.json({
        id: e.id,
        name: e.name,
        role: e.role,
        status: e.status,
        persona,
        tools: Array.isArray(e.tool_allowlist) ? e.tool_allowlist : [],
        createdAt: e.created_at,
        conversationStats: convStats.rows[0],
        actionsByKind: actions.rows,
        conversations: conversations.rows,
        recentActions: recent.rows,
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error?.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[employees/:id GET]', error);
    return NextResponse.json({ error: 'Could not load this employee.' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const { client, orgId } = await getScopedClient();
    try {
      const body = await request.json();
      const { name, role, persona, tool_allowlist, status } = body;

      const fields: string[] = [];
      const values: any[] = [id, orgId];
      let valIdx = 3;

      if (name !== undefined) {
        fields.push(`name = $${valIdx++}`);
        values.push(name);
      }
      if (role !== undefined) {
        fields.push(`role = $${valIdx++}`);
        values.push(role);
      }
      if (persona !== undefined) {
        fields.push(`persona = $${valIdx++}::jsonb`);
        values.push(JSON.stringify(typeof persona === 'string' ? persona : persona));
      }
      if (tool_allowlist !== undefined) {
        fields.push(`tool_allowlist = $${valIdx++}`);
        values.push(
          Array.isArray(tool_allowlist)
            ? tool_allowlist.filter((item: unknown): item is string => typeof item === 'string')
            : []
        );
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

      return NextResponse.json({ employee: res.rows[0] });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/employees/[id] PATCH Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        'DELETE FROM ai_employees WHERE id = $1 AND org_id = $2 RETURNING id',
        [id, orgId]
      );
      if (res.rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, deletedId: id });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/employees/[id] DELETE Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
