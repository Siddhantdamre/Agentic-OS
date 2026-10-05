import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import {
  disconnectWhatsAppNumber,
  findWhatsAppChannel,
  isChannelId,
  listWhatsAppChannels,
  publicWhatsAppNumber,
} from '@/lib/whatsapp-numbers';
import { publicErrorMessage } from '@/lib/public-error';

/**
 * The org's linked WhatsApp numbers (QR and official API alike).
 *   GET     list them, primary first (any member)
 *   DELETE  ?channelId= unlink one (owners and admins)
 */

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const rows = await listWhatsAppChannels(client, orgId);
      return NextResponse.json({ numbers: rows.map(publicWhatsAppNumber) });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('GET /api/integrations/whatsapp/numbers Error:', err);
    return NextResponse.json({ message: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const channelId = new URL(request.url).searchParams.get('channelId');
      if (!isChannelId(channelId)) {
        return NextResponse.json({ success: false, message: 'channelId is required' }, { status: 400 });
      }
      const row = await findWhatsAppChannel(client, orgId, channelId);
      if (!row) return NextResponse.json({ success: false, message: 'That WhatsApp number was not found.' }, { status: 404 });
      const done = await disconnectWhatsAppNumber(client, orgId, userId, row);
      if (!done.ok) return NextResponse.json({ success: false, message: done.message }, { status: 502 });
      return NextResponse.json({ success: true, message: 'WhatsApp number disconnected' });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('DELETE /api/integrations/whatsapp/numbers Error:', err);
    return NextResponse.json({ success: false, message: publicErrorMessage(err) }, { status: 500 });
  }
}
