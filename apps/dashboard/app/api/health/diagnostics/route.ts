import { NextResponse } from 'next/server';
import { getScopedClient, pool, scopedAuthErrorResponse } from '@/lib/db';
import { collectRuntimeTelemetry } from '@/lib/runtime-telemetry';
import { canReadAudit, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health/diagnostics — owner/admin/auditor runtime snapshot.
 * Session required. Does not leak connection strings.
 */
export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadAudit(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const runtime = await collectRuntimeTelemetry();
      return NextResponse.json({
        orgId,
        role,
        environment: process.env.NODE_ENV,
        runtime,
        dbPool: {
          totalCount: typeof pool.totalCount === 'number' ? pool.totalCount : null,
          idleCount: typeof pool.idleCount === 'number' ? pool.idleCount : null,
          waitingCount: typeof pool.waitingCount === 'number' ? pool.waitingCount : null,
          max: 10,
        },
        configured: {
          redis: Boolean(process.env.REDIS_URL?.trim()),
          temporal: Boolean(process.env.TEMPORAL_ADDRESS?.trim()),
          litellm: Boolean(
            process.env.LITELLM_BASE_URL?.trim() || process.env.LITELLM_URL?.trim()
          ),
          cognee: Boolean(process.env.COGNEE_URL?.trim()),
          hindsight: Boolean(process.env.HINDSIGHT_URL?.trim()),
          mcpBridge: Boolean(process.env.MCP_BRIDGE_URL?.trim()),
        },
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/health/diagnostics Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
