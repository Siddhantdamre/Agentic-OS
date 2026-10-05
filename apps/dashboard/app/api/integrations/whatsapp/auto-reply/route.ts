import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { auditConnectorChange, denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { providerIdOf } from '@darex/whatsapp-gateway';
import { parseAutoReply, validateAutoReply } from '@/lib/whatsapp-auto-reply-config';
import { findWhatsAppChannel, isChannelId } from '@/lib/whatsapp-numbers';
import { tryReadJson } from '@/lib/safe-json';
import { publicErrorMessage } from '@/lib/public-error';

/**
 * How this org's WhatsApp connection replies (QR and official API alike).
 *   GET  current settings (any member)
 *   PUT  save settings (owners and admins)
 * Both take `?channelId=` to name one of the org's numbers (default: the primary).
 */

function wantedChannel(request: Request): string | null | 'bad' {
  const v = new URL(request.url).searchParams.get('channelId');
  if (!v) return null;
  return isChannelId(v) ? v : 'bad';
}

export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const wanted = wantedChannel(request);
      if (wanted === 'bad') return NextResponse.json({ message: 'Invalid channelId' }, { status: 400 });
      const row = await findWhatsAppChannel(client, orgId, wanted);
      const emp = await client.query(
        `SELECT id, name, role FROM ai_employees WHERE org_id = $1 AND status = 'active' ORDER BY created_at ASC NULLS LAST`,
        [orgId]
      );
      return NextResponse.json({
        connected: row?.status === 'connected',
        provider: providerIdOf(row?.meta),
        settings: parseAutoReply(row?.meta?.auto_reply),
        employees: emp.rows,
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('GET /api/integrations/whatsapp/auto-reply Error:', err);
    return NextResponse.json({ message: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;

      const wanted = wantedChannel(request);
      if (wanted === 'bad') return NextResponse.json({ success: false, message: 'Invalid channelId' }, { status: 400 });
      const target = await findWhatsAppChannel(client, orgId, wanted);
      const checked = validateAutoReply(await tryReadJson(request));
      if (!checked.ok) {
        return NextResponse.json({ success: false, message: checked.error }, { status: 400 });
      }

      if (checked.value.employeeId) {
        const found = await client.query(
          `SELECT 1 FROM ai_employees WHERE org_id = $1 AND id = $2 AND status = 'active'`,
          [orgId, checked.value.employeeId]
        );
        if (!found.rowCount) {
          return NextResponse.json(
            { success: false, message: 'That AI employee is not active in your workspace.' },
            { status: 400 }
          );
        }
      }

      const res = await client.query(
        `UPDATE channels
            SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{auto_reply}', $2::jsonb, true)
          WHERE org_id = $1 AND id = $3 AND channel_type = 'whatsapp'
        RETURNING id`,
        [orgId, JSON.stringify(checked.value), target?.id ?? null]
      );
      if (!res.rowCount) {
        return NextResponse.json(
          { success: false, message: 'Connect WhatsApp first, then choose how it replies.' },
          { status: 409 }
        );
      }

      await auditConnectorChange(client, {
        orgId,
        kind: 'connector.config_update',
        actor: { actorType: 'user', userId },
        tool: 'whatsapp',
        action: 'auto_reply_update',
        resultStatus: 'ok',
        riskClass: 'medium',
        payload: { accountId: target?.account_key || 'primary', mode: checked.value.mode, employeeId: checked.value.employeeId },
      });
      return NextResponse.json({ success: true, settings: checked.value });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('PUT /api/integrations/whatsapp/auto-reply Error:', err);
    return NextResponse.json({ success: false, message: publicErrorMessage(err) }, { status: 500 });
  }
}
