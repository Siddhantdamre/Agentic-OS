import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { loadAgentHealth } from '@/lib/agent-health-query';

export const dynamic = 'force-dynamic';

/**
 * GET /api/observability/agents — is each AI employee doing its job? One row per employee with a status and the
 * reasons in plain words, plus notes about the workspace (customer messages that failed to arrive, the kill switch).
 * The workspace comes from the session only.
 */
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      return NextResponse.json(await loadAgentHealth(client, orgId));
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/observability/agents Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
