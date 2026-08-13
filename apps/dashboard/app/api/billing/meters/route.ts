import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { CLIENT_ORG_ID_ERROR, refreshOrgMeters, requestHasClientOrgId } from '../_lib';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/meters
 * LLM (Langfuse cost API) + WhatsApp conversations + seats for the session org.
 * notConnected / disconnected tools are metered separately and do not count as success.
 */
export async function GET(request: Request) {
  if (requestHasClientOrgId(request)) {
    return NextResponse.json({ error: CLIENT_ORG_ID_ERROR }, { status: 400 });
  }
  let orgId = '';
  try {
    const scoped = await getScopedClient();
    orgId = scoped.orgId;
    scoped.client.release();

    const meters = await refreshOrgMeters(orgId);
    return NextResponse.json({
      orgId,
      ...meters,
      note: 'Disconnected tools (notConnected) increment disconnected_actions only — never successful_actions.',
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/billing/meters GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
