import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import {
  fetchOrgWeeklyCost,
  LangfuseUnavailableError,
  queryConfirmRejectDrift,
  WEEK_DAYS,
  type ConfirmRejectDrift,
} from '@/lib/org-cost';
import { LangfuseConfigError } from '@/lib/langfuse-trace';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/cost
 * Weekly LLM cost for the session org (Langfuse, not guessed) plus
 * confirm-reject drift from agent_plans. Org id comes from the session via
 * getScopedClient — never from the request body or query string.
 */
export async function GET() {
  let confirmReject: ConfirmRejectDrift | null = null;
  let orgId = '';

  try {
    const scoped = await getScopedClient();
    orgId = scoped.orgId;
    try {
      const from = new Date(Date.now() - WEEK_DAYS * 24 * 60 * 60 * 1000);
      confirmReject = await queryConfirmRejectDrift(scoped.client, orgId, from);
    } finally {
      scoped.client.release();
    }

    const cost = await fetchOrgWeeklyCost(orgId);
    return NextResponse.json({
      ...cost,
      confirmReject,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof LangfuseUnavailableError || error instanceof LangfuseConfigError) {
      console.error('API /api/analytics/cost Langfuse:', error.message);
      return NextResponse.json(
        {
          error: error.message,
          verified: false,
          source: 'langfuse',
          orgId: orgId || undefined,
          confirmReject,
        },
        { status: 503 }
      );
    }
    console.error('API /api/analytics/cost Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
