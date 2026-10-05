import { NextResponse } from 'next/server';
import {
  evolutionConfigured,
  evolutionInstanceName,
  getEvolutionQr,
  getEvolutionState,
  providerIdOf,
  startEvolutionPairing,
  stopEvolutionInstance,
} from '@darex/whatsapp-gateway';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { markWhatsAppQrConnected } from '@/lib/whatsapp-evolution-channel';
import { disconnectWhatsAppNumber, findWhatsAppChannel, isChannelId, resolveConnectSlot } from '@/lib/whatsapp-numbers';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { publicErrorMessage } from '@/lib/public-error';

/**
 * QR (WhatsApp Web) connect flow, served by the self-hosted Evolution API.
 *   POST   start pairing, returns the QR to scan. Body `{ channelId }` re-pairs
 *          that number, `{ add: true }` links an extra number, empty = primary.
 *   GET    poll state (?qr=1 also returns a fresh QR while not yet linked)
 *   DELETE unlink the phone
 * GET and DELETE take `?channelId=` to name a number (default: the primary).
 * The official-API option is POST /api/integrations/whatsapp.
 */

function webhookConfig(): { url: string; secret: string } | null {
  const url = process.env.EVOLUTION_WEBHOOK_URL?.trim();
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

function notConfigured(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      message:
        'QR connect is not set up on this server. Set EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_WEBHOOK_URL and EVOLUTION_WEBHOOK_SECRET.',
    },
    { status: 503 }
  );
}

function channelIdParam(request: Request): string | null | 'bad' {
  const v = new URL(request.url).searchParams.get('channelId');
  if (!v) return null;
  return isChannelId(v) ? v : 'bad';
}

const BAD_CHANNEL = () => NextResponse.json({ success: false, message: 'Invalid channelId' }, { status: 400 });

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const hook = webhookConfig();
      if (!evolutionConfigured() || !hook) return notConfigured();

      const body = (await jsonBodyOrEmpty(request)) as { channelId?: unknown; add?: unknown };
      if (body.channelId != null && !isChannelId(body.channelId)) return BAD_CHANNEL();
      const slot = await resolveConnectSlot(client, orgId, {
        channelId: (body.channelId as string | undefined) ?? null,
        add: body.add === true,
      });
      if (!slot.ok) return NextResponse.json({ success: false, message: slot.message }, { status: 404 });
      const accountKey = slot.accountKey;

      const row = (
        await client.query(
          `SELECT status, meta FROM channels WHERE org_id = $1 AND channel_type = 'whatsapp' AND account_key = $2`,
          [orgId, accountKey]
        )
      ).rows[0] as { status?: string; meta?: Record<string, unknown> } | undefined;
      const provider = providerIdOf(row?.meta);
      if (row?.status === 'connected' && provider === 'meta-cloud' && row.meta?.phone_number_id) {
        return NextResponse.json(
          {
            success: false,
            message: 'WhatsApp is already connected through the official API. Disconnect it first to link by QR.',
          },
          { status: 409 }
        );
      }

      const instance = evolutionInstanceName(orgId, accountKey);
      const started = await startEvolutionPairing({
        instance,
        webhookUrl: hook.url,
        webhookSecret: hook.secret,
      });
      if (!started.ok) {
        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
           VALUES ($1, 'whatsapp', 'connect', 'error', $2, $3)`,
          [orgId, started.status, started.message]
        );
        return NextResponse.json({ success: false, message: started.message }, { status: 502 });
      }

      const saved = await client.query(
        `INSERT INTO channels (org_id, channel_type, account_key, status, meta, connected_at)
         VALUES ($1, 'whatsapp', $3, 'pairing', $2::jsonb, NULL)
         ON CONFLICT (org_id, channel_type, account_key)
         DO UPDATE SET status = CASE WHEN channels.status = 'connected' AND channels.meta->>'provider' = 'evolution'
                                     THEN channels.status ELSE 'pairing' END,
                       meta = CASE WHEN channels.meta ? 'auto_reply'
                                   THEN $2::jsonb || jsonb_build_object('auto_reply', channels.meta->'auto_reply')
                                   ELSE $2::jsonb END,
                       connected_at = CASE WHEN channels.meta->>'provider' = 'evolution'
                                           THEN channels.connected_at ELSE NULL END
         RETURNING id`,
        [orgId, JSON.stringify({ provider: 'evolution', evolution_instance: instance, evolution_mode: 'qr' }), accountKey]
      );

      return NextResponse.json({
        success: true,
        channelId: saved.rows[0].id as string,
        state: 'pairing',
        qrBase64: started.qrBase64,
        pairingCode: started.pairingCode,
        message: started.message,
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('POST /api/integrations/whatsapp/evolution Error:', err);
    return NextResponse.json({ success: false, message: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const wanted = channelIdParam(request);
      if (wanted === 'bad') return BAD_CHANNEL();
      const row = await findWhatsAppChannel(client, orgId, wanted);
      const instance = row?.meta?.evolution_instance;
      if (providerIdOf(row?.meta) !== 'evolution' || typeof instance !== 'string') {
        return NextResponse.json({ provider: providerIdOf(row?.meta), state: 'none', connected: false });
      }

      // The Evolution webhook may already have marked the link as done; trust that.
      if (row?.status === 'connected') {
        return NextResponse.json({ provider: 'evolution', state: 'open', connected: true });
      }

      const live = await getEvolutionState(instance);
      if (live.state === 'open') {
        if (row?.status !== 'connected') {
          await markWhatsAppQrConnected(client, orgId, userId, row!.id);
        }
        return NextResponse.json({ provider: 'evolution', state: 'open', connected: true });
      }
      if (live.state === 'error') {
        return NextResponse.json({ provider: 'evolution', state: 'error', connected: false, message: live.message }, { status: 502 });
      }

      let qr: { qrBase64: string | null; pairingCode: string | null } | null = null;
      if (new URL(request.url).searchParams.get('qr') === '1' && live.state !== 'missing') {
        const fresh = await getEvolutionQr(instance);
        qr = { qrBase64: fresh.qrBase64, pairingCode: fresh.pairingCode };
      }
      return NextResponse.json({
        provider: 'evolution',
        state: live.state,
        connected: false,
        ...(qr ?? {}),
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('GET /api/integrations/whatsapp/evolution Error:', err);
    return NextResponse.json({ message: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const wanted = channelIdParam(request);
      if (wanted === 'bad') return BAD_CHANNEL();
      const row = await findWhatsAppChannel(client, orgId, wanted);
      if (!row || providerIdOf(row.meta) !== 'evolution' || typeof row.meta.evolution_instance !== 'string') {
        return NextResponse.json({ success: true, message: 'No QR-linked WhatsApp to disconnect' });
      }
      const done = await disconnectWhatsAppNumber(client, orgId, userId, row);
      if (!done.ok) return NextResponse.json({ success: false, message: done.message }, { status: 502 });
      return NextResponse.json({ success: true, message: 'WhatsApp disconnected' });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('DELETE /api/integrations/whatsapp/evolution Error:', err);
    return NextResponse.json({ success: false, message: publicErrorMessage(err) }, { status: 500 });
  }
}
