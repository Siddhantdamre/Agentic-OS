import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { canManageOrgSettings, canReadOperations, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadOperations(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      let preferences: Array<Record<string, unknown>> = [];
      let suppressions: Array<Record<string, unknown>> = [];

      try {
        const prefs = await client.query(
          `SELECT id, org_id, rules, updated_at
             FROM org_preferences
            WHERE org_id = $1`,
          [orgId]
        );
        preferences = prefs.rows.map((row) => ({
          id: row.id,
          rules: row.rules,
          updatedAt: row.updated_at,
        }));
      } catch (err: unknown) {
        if (!isMissingTable(err, 'org_preferences')) throw err;
      }

      try {
        const rows = await client.query(
          `SELECT id, employee_role, dimension, pattern_key, rejection_count,
                  weight, last_rejected_at, dismissed_by_user, created_at
             FROM agent_preference_suppressions
            WHERE org_id = $1
            ORDER BY last_rejected_at DESC`,
          [orgId]
        );
        suppressions = rows.rows.map((row) => ({
          id: row.id,
          employeeRole: row.employee_role,
          dimension: row.dimension,
          patternKey: row.pattern_key,
          rejectionCount: row.rejection_count,
          weight: row.weight,
          lastRejectedAt: row.last_rejected_at,
          dismissed: row.dismissed_by_user,
          createdAt: row.created_at,
        }));
      } catch (err: unknown) {
        if (!isMissingTable(err, 'agent_preference_suppressions')) throw err;
      }

      return NextResponse.json({ orgId, preferences, suppressions });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/settings/suppressions Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const url = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.org_id !== undefined || body.orgId !== undefined) {
        return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
      }
      const id = (typeof body.id === 'string' && body.id) || url.searchParams.get('id') || '';
      if (!id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 });
      }

      let dismissed = 0;
      try {
        const res = await client.query(
          `UPDATE agent_preference_suppressions
              SET dismissed_by_user = TRUE
            WHERE id = $1 AND org_id = $2
            RETURNING id`,
          [id, orgId]
        );
        dismissed += res.rowCount || 0;
      } catch (err: unknown) {
        if (!isMissingTable(err, 'agent_preference_suppressions')) throw err;
      }

      if (dismissed === 0) {
        try {
          const res = await client.query(
            `UPDATE org_preferences
                SET rules = COALESCE(rules, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('dismissed', TRUE)),
                    updated_at = NOW()
              WHERE id = $1 AND org_id = $2
              RETURNING id`,
            [id, orgId]
          );
          dismissed += res.rowCount || 0;
        } catch (err: unknown) {
          if (!isMissingTable(err, 'org_preferences')) throw err;
        }
      }

      if (dismissed === 0) {
        return NextResponse.json({ error: 'Suppression not found' }, { status: 404 });
      }
      realtimeHub.publish(orgId, { type: 'settings_updated', message: 'suppression' });
      return NextResponse.json({ ok: true, dismissed: true, id });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('DELETE /api/settings/suppressions Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
