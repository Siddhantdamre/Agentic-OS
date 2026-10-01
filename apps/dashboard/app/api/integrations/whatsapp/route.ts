import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { saveMetaCloudChannel } from '@/lib/whatsapp-meta-channel';
import { providerIdOf } from '@darex/whatsapp-gateway';
import { isChannelId, listWhatsAppChannels, publicWhatsAppNumber } from '@/lib/whatsapp-numbers';

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const { accessToken, phoneNumberId, wabaId, channelId, add } = await request.json();
      if (channelId != null && !isChannelId(channelId)) {
        return NextResponse.json({ message: 'Invalid channelId' }, { status: 400 });
      }

      if (!accessToken || !phoneNumberId) {
        return NextResponse.json({ message: 'Access Token and Phone Number ID are required' }, { status: 400 });
      }

      const saved = await saveMetaCloudChannel(client, { orgId, userId, accessToken, phoneNumberId, wabaId, authMode: 'byok', channelId, add: add === true });
      if (saved.ok) realtimeHub.publish(orgId, { type: 'integration_updated', message: 'whatsapp' });
      return saved;
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('WhatsApp Manual Connect Error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const all = await listWhatsAppChannels(client, orgId);
      const row = all.find((r) => r.account_key === '');
      const meta = row?.meta || {};
      const hasToken = Boolean(meta.accessToken || meta.meta_access_token);
      const phoneNumberId = meta.phoneNumberId || meta.phone_number_id || null;
      const provider = providerIdOf(meta);
      return NextResponse.json({
        provider,
        connected:
          provider === 'evolution'
            ? Boolean(meta.evolution_instance && row?.status === 'connected')
            : Boolean(hasToken && phoneNumberId && (row?.status === 'connected' || row?.status === 'active')),
        phoneNumberId,
        wabaId: meta.wabaId || meta.whatsapp_business_account_id || null,
        connectedAt: row?.connected_at || null,
        hasToken,
        numbers: all.map(publicWhatsAppNumber),
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
