import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

/**
 * GET /api/integrations/nango-token
 * Returns Nango public key and scoped connection metadata for the authenticated user's org
 */
export async function GET(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    client.release();

    const url = new URL(request.url);
    const provider = url.searchParams.get('provider') || 'unknown';

    const nangoPublicKey = process.env.NEXT_PUBLIC_NANGO_PUBLIC_KEY;
    const nangoHost = process.env.NEXT_PUBLIC_NANGO_HOST || 'http://localhost:3003';
    const connectionId = `${orgId}_${provider}`;

    return NextResponse.json({
      nangoPublicKey,
      nangoHost,
      connectionId,
      orgId,
      userId,
      provider,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Nango token GET error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/integrations/nango-token
 * Called after Nango OAuth popup completes to confirm connection in PostgreSQL database
 */
export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { provider, connectionId, success } = await request.json();

      if (!provider) {
        return NextResponse.json({ error: 'provider is required' }, { status: 400 });
      }

      const nangoConnId = connectionId || `${orgId}_${provider}`;
      const status = success ? 'connected' : 'failed';

      // Upsert channel record strictly scoped to current orgId
      await client.query(
        `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, connected_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (org_id, channel_type)
         DO UPDATE SET status = $3, nango_connection_id = $4, connected_at = NOW()`,
        [orgId, provider, status, nangoConnId]
      );

      // Audit log event
      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
         VALUES ($1, $2, 'nango_oauth', $3, $4, $5, $6)`,
        [
          orgId,
          provider,
          success ? 'success' : 'error',
          success ? 200 : 400,
          `Nango OAuth ${success ? 'completed' : 'failed'} for ${provider}`,
          JSON.stringify({ connectionId: nangoConnId, provider }),
        ]
      );

      return NextResponse.json({
        success,
        connectionId: nangoConnId,
        message: `${provider} ${success ? 'connected via Nango' : 'connection failed'}`,
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Nango token confirm error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
