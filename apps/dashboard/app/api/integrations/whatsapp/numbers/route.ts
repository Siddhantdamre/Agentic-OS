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
    return NextResponse.json({ message: err instanceof Error ? err.message : String(err) }, { status: 500 });
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
    return NextResponse.json({ success: false, message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
