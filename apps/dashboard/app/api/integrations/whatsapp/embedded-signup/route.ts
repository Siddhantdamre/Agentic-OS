import { NextResponse } from 'next/server';
import { completeEmbeddedSignup } from '@darex/whatsapp-gateway';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { saveMetaCloudChannel } from '@/lib/whatsapp-meta-channel';
import { isChannelId } from '@/lib/whatsapp-numbers';

/**
 * POST /api/integrations/whatsapp/embedded-signup
 * Finishes Meta's "Log in with Facebook" WhatsApp signup. The browser sends the
 * one-time code and the ids it saw; completeEmbeddedSignup verifies them with
 * Meta before anything is saved. Needs META_APP_ID + META_APP_SECRET.
 */
export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;

      const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID || '';
      const appSecret = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '';
      if (!appId || !appSecret) {
        return NextResponse.json(
          { success: false, message: 'Facebook signup is not set up on this server (META_APP_ID and META_APP_SECRET).' },
          { status: 503 }
        );
      }

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const done = await completeEmbeddedSignup({
        code: typeof body.code === 'string' ? body.code : '',
        wabaId: typeof body.wabaId === 'string' ? body.wabaId : '',
        phoneNumberId: typeof body.phoneNumberId === 'string' ? body.phoneNumberId : '',
        appId,
        appSecret,
      });
      if (!done.ok) {
        return NextResponse.json({ success: false, message: done.message }, { status: done.status });
      }
      if (!done.webhookSubscribed) {
        console.warn('[whatsapp embedded-signup] webhook subscription failed for org %s', orgId);
      }
      return await saveMetaCloudChannel(client, {
        orgId,
        userId,
        accessToken: done.accessToken,
        phoneNumberId: done.phoneNumberId,
        wabaId: done.wabaId,
        authMode: 'embedded_signup',
        channelId: isChannelId(body.channelId) ? body.channelId : null,
        add: body.add === true,
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
