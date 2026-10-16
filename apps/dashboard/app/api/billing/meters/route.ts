import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { assertUsageAllowed, isUsageBlocked } from '@/lib/usage-gate';
import { CLIENT_ORG_ID_ERROR, refreshOrgMeters, requestHasClientOrgId } from '../_lib';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/meters
 * LLM (Langfuse cost API) + WhatsApp conversations + seats for the session org.
 * notConnected / disconnected tools are metered separately and do not count as success.
 * Surfaces `isUsageBlocked` / `assertUsageAllowed` for circuit-breaker consumers.
 */
export async function GET(request: Request) {
  if (requestHasClientOrgId(request)) {
    return NextResponse.json({ error: CLIENT_ORG_ID_ERROR }, { status: 400 });
  }
  let orgId = '';
  try {
    const scoped = await getScopedClient({ allowSuspended: true });
    orgId = scoped.orgId;
    scoped.client.release();

    const meters = await refreshOrgMeters(orgId);
    const gate = await isUsageBlocked(orgId);
    const block = await assertUsageAllowed(orgId);
    return NextResponse.json({
      orgId,
      ...meters,
      gate,
      usageGate: block
        ? { allowed: false, error: block.error, message: block.message, reasons: block.gate.reasons }
        : { allowed: true },
      note: 'Disconnected tools (notConnected) increment disconnected_actions only — never successful_actions.',
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/billing/meters GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
