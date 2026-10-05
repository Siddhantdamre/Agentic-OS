import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { canManageOrgSettings, canReadOperations, loadHumanRole } from '@/lib/rbac';
import { tryReadJson } from '@/lib/safe-json';
import { recordAuditEvent } from '@/lib/audit-events';

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
      try {
        const res = await client.query(
          `SELECT id, action_type, employee_role, autonomy_tier, reversibility,
                  requires_human_approval, confidence_threshold, updated_at
             FROM employee_autonomy_rules
            WHERE org_id = $1
            ORDER BY action_type ASC`,
          [orgId]
        );
        return NextResponse.json({
          orgId,
          rules: res.rows.map((row) => ({
            id: row.id,
            actionType: row.action_type,
            employeeRole: row.employee_role,
            autonomyTier: row.autonomy_tier,
            reversibility: row.reversibility,
            requiresHumanApproval: row.requires_human_approval,
            confidenceThreshold: row.confidence_threshold,
            updatedAt: row.updated_at,
            locked: row.reversibility === 'irreversible',
          })),
        });
      } catch (err: unknown) {
        if (isMissingTable(err, 'employee_autonomy_rules')) {
          return NextResponse.json({ orgId, rules: [] });
        }
        throw err;
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/settings/autonomy Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }

      const actionType = typeof body.actionType === 'string' ? body.actionType.trim() : '';
      if (!actionType) {
        return NextResponse.json({ error: 'actionType is required' }, { status: 400 });
      }

      const employeeRole =
        typeof body.employeeRole === 'string' && body.employeeRole.trim()
          ? body.employeeRole.trim()
          : null;

      let autonomyTier: number | null = null;
      if (typeof body.autonomyTier === 'number' && Number.isFinite(body.autonomyTier)) {
        autonomyTier = Math.trunc(body.autonomyTier);
      } else if (typeof body.autonomyTier === 'string') {
        const map: Record<string, number> = {
          notice: 1,
          draft: 2,
          act_internally: 3,
          act_externally: 4,
        };
        autonomyTier = map[body.autonomyTier] ?? null;
      }
      if (autonomyTier == null || autonomyTier < 1 || autonomyTier > 4) {
        return NextResponse.json(
          { error: 'autonomyTier must be 1-4 or notice|draft|act_internally|act_externally' },
          { status: 400 }
        );
      }

      const minConfidence =
        typeof body.minConfidence === 'number' && Number.isFinite(body.minConfidence)
          ? body.minConfidence
          : typeof body.confidenceThreshold === 'number' && Number.isFinite(body.confidenceThreshold)
            ? body.confidenceThreshold
            : null;
      if (minConfidence != null && (minConfidence < 0 || minConfidence > 1)) {
        return NextResponse.json({ error: 'minConfidence must be between 0 and 1' }, { status: 400 });
      }

      const reversibility =
        body.reversibility === 'irreversible' || body.reversibility === 'reversible'
          ? body.reversibility
          : 'reversible';

      try {
        const findRule = () =>
          client.query<{ id: string }>(
            `SELECT id FROM employee_autonomy_rules
             WHERE org_id = $1 AND action_type = $2
               AND COALESCE(employee_role, '*') = COALESCE($3, '*')
             LIMIT 1`,
            [orgId, actionType, employeeRole]
          );
        const updateRule = (id: string) =>
          client.query(
            `UPDATE employee_autonomy_rules SET
               autonomy_tier = $2,
               reversibility = $3,
               requires_human_approval = $2 < 4,
               confidence_threshold = COALESCE($4, confidence_threshold),
               updated_at = NOW()
             WHERE id = $1 AND org_id = $5`,
            [id, autonomyTier, reversibility, minConfidence, orgId]
          );

        const existing = await findRule();
        if (existing.rows[0]) {
          await updateRule(existing.rows[0].id);
        } else {
          try {
            await client.query(
              `INSERT INTO employee_autonomy_rules (
                 org_id, action_type, employee_role, autonomy_tier, reversibility,
                 requires_human_approval, confidence_threshold, updated_at
               ) VALUES ($1, $2, $3, $4, $5, $4 < 4, COALESCE($6, 0.85), NOW())`,
              [orgId, actionType, employeeRole, autonomyTier, reversibility, minConfidence]
            );
          } catch (insertErr: unknown) {
            // Select-then-insert: an identical save running at the same moment inserted the row first
            // (unique violation). That is not a failure; apply this request's values to that row.
            if ((insertErr as { code?: string } | null)?.code !== '23505') throw insertErr;
            const winner = await findRule();
            if (!winner.rows[0]) throw insertErr;
            await updateRule(winner.rows[0].id);
          }
        }
      } catch (err: unknown) {
        if (isMissingTable(err, 'employee_autonomy_rules')) {
          return NextResponse.json({ error: 'Autonomy rules not available' }, { status: 501 });
        }
        throw err;
      }

      await recordAuditEvent(
        {
          orgId,
          kind: 'settings.update',
          actor: { actorType: 'user', userId },
          action: 'settings.autonomy_updated',
          resultStatus: 'ok',
          riskClass: 'high',
          payload: { actionType, employeeRole, autonomyTier, minConfidence, reversibility },
        },
        { client, orgId }
      );

      realtimeHub.publish(orgId, { type: 'settings_updated', message: 'autonomy' });
      return NextResponse.json({
        success: true,
        actionType,
        employeeRole,
        autonomyTier,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/settings/autonomy Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
