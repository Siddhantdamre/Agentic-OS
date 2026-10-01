import { NextResponse } from 'next/server';
import {
  parseConfirmReason,
  requireOperator,
  requirePlatformAdmin,
} from '@/lib/platform-admin';
import {
  isPlatformSchemaMissing,
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';
import { loadRuntimeControls } from '@/lib/employee-metrics-query';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string }> };

/**
 * POST /api/platform/orgs/:orgId/kill-switch — operator only.
 * Same confirmation class as suspend. Does not replace suspend.
 *
 * org_runtime_controls is not in migration 119's first platform_audit_ok list.
 * We always write orgs.meta (covered); try org_runtime_controls best-effort.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;
    const denied = requireOperator(admin);
    if (denied) return denied;

    const { orgId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      confirm?: unknown;
      reason?: unknown;
      enabled?: unknown;
      active?: unknown;
    };
    const parsed = parseConfirmReason(body);
    if (parsed instanceof NextResponse) return parsed;

    const enabled =
      typeof body.enabled === 'boolean'
        ? body.enabled
        : typeof body.active === 'boolean'
          ? body.active
          : null;
    if (enabled === null) {
      return NextResponse.json(
        { error: 'enabled_required', message: 'enabled/active must be a boolean' },
        { status: 400 }
      );
    }

    const controls = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'autonomy.kill_switch',
        targetOrgId: orgId,
        targetTable: 'orgs',
        targetRowId: orgId,
        reason: parsed.reason,
      },
      async (client) => {
        await client.query(
          `UPDATE orgs
              SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('kill_switch', $2::boolean),
                  updated_at = NOW()
            WHERE id = $1`,
          [orgId, enabled]
        );

        try {
          await client.query(
            `INSERT INTO org_runtime_controls (org_id, kill_switch, autonomy_stage, updated_at)
             VALUES ($1, $2, 0, NOW())
             ON CONFLICT (org_id) DO UPDATE SET
               kill_switch = EXCLUDED.kill_switch,
               autonomy_stage = CASE
                 WHEN EXCLUDED.kill_switch THEN 0
                 ELSE org_runtime_controls.autonomy_stage
               END,
               updated_at = NOW()`,
            [orgId, enabled]
          );
        } catch (err) {
          // Table missing, or platform_audit_ok not yet on this relation.
          if (!isPlatformSchemaMissing(err)) {
            console.warn(
              '[platform kill-switch] org_runtime_controls write skipped:',
              err instanceof Error ? err.message : err
            );
          }
        }

        return loadRuntimeControls(client, orgId);
      }
    );

    return NextResponse.json({
      ok: true,
      orgId,
      enabled: controls.killSwitch,
      rolloutStage: controls.rolloutStage,
    });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/orgs/[orgId]/kill-switch', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
