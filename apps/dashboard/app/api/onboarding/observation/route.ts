import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { mapObservationRow } from '@/lib/onboarding-rollout';
import { findUnansweredThreads, persistFirstObservation } from '@/lib/onboarding-observation-query';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const existing = await client.query(`SELECT id, headline, detail, thread_count, conversation_ids, shown_at FROM org_first_observations WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, [orgId]);
      if (existing.rows[0]) return NextResponse.json({ orgId, observation: mapObservationRow(existing.rows[0]) });
      const observation = await persistFirstObservation(client, orgId, await findUnansweredThreads(client, orgId));
      return NextResponse.json({ orgId, observation: { ...observation, shownAt: new Date().toISOString() } });
    } finally { client.release(); }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
