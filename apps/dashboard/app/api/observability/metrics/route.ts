import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { getOrComputeDailyMetrics, loadRuntimeControls } from '@/lib/employee-metrics-query';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const controls = await loadRuntimeControls(client, orgId);
      const { metrics, asOf } = await getOrComputeDailyMetrics(client, orgId);
      return NextResponse.json({
        orgId,
        asOf,
        metrics,
        alertCount: metrics.filter((m) => m.status === 'alert').length,
        killSwitch: controls.killSwitch,
        rolloutStage: controls.rolloutStage,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/observability/metrics Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
