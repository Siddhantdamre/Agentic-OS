import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { publicErrorMessage } from '@/lib/public-error';

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const limited = denyWebhookIfLimited(orgId);
      if (limited) {
        return limited;
      }
      const payload = await jsonBodyOrEmpty(request);

      const provider = payload.provider || payload.type || 'nango';
      const eventType = payload.event || 'webhook_received';
      const message = `Inbound webhook received from ${provider}: ${eventType}`;

      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
         VALUES ($1, $2, 'webhook', 'success', 200, $3, $4)`,
        [orgId, provider, message, JSON.stringify(payload)]
      );

      return NextResponse.json({ success: true, message: 'Webhook logged successfully' });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (isRateLimitError(err)) {
      return responseFromRateLimit(err);
    }
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('Webhook Endpoint Error:', err);
    return NextResponse.json({ message: publicErrorMessage(err) }, { status: 500 });
  }
}
