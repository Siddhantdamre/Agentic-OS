import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/platform-admin';
import { platformErrorResponse, withPlatformTransaction } from '@/lib/platform-db';

export const dynamic = 'force-dynamic';

const LIMIT = 500;

/**
 * GET /api/platform/users — every member of every org in one audited read.
 * Tokens are metered per org (billing_meters), so llmTokens is the org's meter, not the user's.
 * `disabled` is the real users.disabled_at state; the frontend never guesses it.
 */
export async function GET() {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const result = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'user.list',
        reason: 'cross-org users',
      },
      async (client) => {
        const res = await client.query(
          `SELECT om.user_id, om.role, u.email, o.id AS org_id, o.name AS org_name, o.status AS org_status,
                  COALESCE(u.session_epoch, 0) AS session_epoch,
                  (u.disabled_at IS NOT NULL) AS disabled,
                  login.last_login_at,
                  tok.quantity AS tok_quantity, tok.soft_limit AS tok_soft, tok.hard_limit AS tok_hard
             FROM organization_memberships om
             JOIN users u ON u.id = om.user_id
             JOIN orgs o ON o.id = om.org_id
             LEFT JOIN LATERAL (
               SELECT MAX(created_at) AS last_login_at
                 FROM audit_events ae
                WHERE ae.org_id = om.org_id AND ae.actor_user_id = om.user_id AND ae.kind = 'login'
             ) login ON true
             LEFT JOIN LATERAL (
               SELECT quantity, soft_limit, hard_limit
                 FROM billing_meters bm
                WHERE bm.org_id = om.org_id AND bm.meter_kind = 'llm_tokens' AND bm.period_end >= CURRENT_DATE
                ORDER BY bm.period_end DESC
                LIMIT 1
             ) tok ON true
            ORDER BY o.name, u.email
            LIMIT ${LIMIT + 1}`
        );
        const truncated = res.rows.length > LIMIT;
        return { rows: res.rows.slice(0, LIMIT), truncated };
      }
    );

    return NextResponse.json({
      platformRole: admin.platformRole,
      truncated: result.truncated,
      users: result.rows.map((row) => ({
        userId: row.user_id as string,
        email: row.email as string | null,
        role: row.role as string | null,
        orgId: row.org_id as string,
        orgName: row.org_name as string,
        orgStatus: row.org_status as string,
        sessionEpoch: Number(row.session_epoch) || 0,
        disabled: row.disabled === true,
        lastLoginAt: row.last_login_at as string | Date | null,
        llmTokens:
          row.tok_quantity != null
            ? {
                quantity: Number(row.tok_quantity),
                softLimit: row.tok_soft != null ? Number(row.tok_soft) : null,
                hardLimit: row.tok_hard != null ? Number(row.tok_hard) : null,
              }
            : null,
      })),
    });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('GET /api/platform/users', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
