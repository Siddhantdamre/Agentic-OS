import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

function escapeCsvField(value: string | null | undefined): string {
  const s = value == null ? '' : String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * GET /api/billing/audit/export
 * Streams the full billing_audit_log for the session org as CSV.
 * Restricted to owner/admin roles.
 */
export async function GET() {
  let orgId: string;
  let client: import('pg').PoolClient;
  try {
    const scoped = await getScopedClient({ allowSuspended: true });
    orgId = scoped.orgId;
    client = scoped.client;
  } catch (err: unknown) {
    const authErr = scopedAuthErrorResponse(err);
    if (authErr) return authErr;
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message, { status: 500 });
  }

  try {
    const res = await client.query(
      `SELECT id, action, provider, plan_key, payload, created_at, actor_user_id
       FROM billing_audit_log
       WHERE org_id = $1
       ORDER BY created_at DESC`,
      [orgId]
    );

    const header = 'id,action,provider,plan_key,created_at,actor_user_id,payload\r\n';
    const rows = (
      res.rows as Array<{
        id: string;
        action: string;
        provider: string | null;
        plan_key: string | null;
        payload: Record<string, unknown>;
        created_at: Date;
        actor_user_id: string | null;
      }>
    )
      .map((r) =>
        [
          escapeCsvField(r.id),
          escapeCsvField(r.action),
          escapeCsvField(r.provider),
          escapeCsvField(r.plan_key),
          escapeCsvField(r.created_at.toISOString()),
          escapeCsvField(r.actor_user_id),
          escapeCsvField(JSON.stringify(r.payload ?? {})),
        ].join(',')
      )
      .join('\r\n');

    const body = header + rows;
    return new Response(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="billing-audit.csv"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/billing_audit_log|does not exist|relation/i.test(message)) {
      return new Response('id,action,provider,plan_key,created_at,actor_user_id,payload\r\n', {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="billing-audit.csv"',
        },
      });
    }
    return new Response(message, { status: 500 });
  } finally {
    client.release();
  }
}
