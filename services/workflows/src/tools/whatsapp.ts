import { openSecret, providerIdOf, sendWhatsApp as sendViaGateway } from '@darex/whatsapp-gateway';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveNangoAuth, withOrgScopedClient, fetchWithTimeout } from './shared.js';

const ACTIONS = ['send_whatsapp_message', 'list_messages'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('read')) return 'read';
  return 'send';
}

/** Last 10 digits, so +91 98765 43210 and 9876543210 match the same contact. */
export function phoneKey(v: unknown): string | null {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
}

/**
 * Recent WhatsApp messages as stored by the inbound webhook (messages.channel_key
 * = 'whatsapp'): role "user" is the contact, "assistant" is us. RLS-scoped.
 */
async function listMessages(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(payload.limit ?? payload.count)) || 20));
  const phone = payload.phone ? phoneKey(payload.phone) : null;
  if (payload.phone && !phone) {
    return { tool: 'whatsapp', action: 'list_messages', status: 'error' as const, message: 'That phone number is not valid.', data: null, timestamp };
  }
  const rows = await withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT m.id, m.role, m.content, m.created_at, c.id AS conversation_id, c.contact_id,
              c.metadata->>'sender_name' AS sender_name
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
        WHERE m.org_id = $1
          AND m.channel_key = 'whatsapp'
          AND ($2::text IS NULL OR right(regexp_replace(c.contact_id, '\\D', '', 'g'), 10) = $2)
        ORDER BY m.created_at DESC
        LIMIT $3`,
      [orgId, phone, limit],
    );
    return res.rows;
  });
  const messages = rows.map((r: any) => ({
    id: r.id,
    from: r.role === 'user' ? r.sender_name || r.contact_id : 'us',
    contactPhone: r.contact_id,
    direction: r.role === 'user' ? 'inbound' : 'outbound',
    text: r.content,
    at: r.created_at,
    conversationId: r.conversation_id,
  }));
  return {
    tool: 'whatsapp',
    action: 'list_messages',
    status: 'executed' as const,
    message: messages.length
      ? `Found ${messages.length} WhatsApp messages${phone ? ` with ${payload.phone}` : ''}`
      : `No WhatsApp messages found${phone ? ` with ${payload.phone}` : ''}`,
    data: { messages, count: messages.length },
    timestamp,
  };
}

async function execute(ctx: ToolActionContext) {
  if (ctx.actionName === 'list_messages') return listMessages(ctx);
  const { payload, orgId, timestamp } = ctx;
  const phone = payload.phone || payload.contactId || payload.to;
  const textMsg = payload.message || payload.content || payload.body;

  if (!textMsg) {
    return {
      tool: 'whatsapp',
      action: 'send_whatsapp_message',
      status: 'error' as const,
      message: 'Message text parameter (message/content/body) is required',
      data: null,
      timestamp,
    };
  }

  if (!phone) {
    return {
      tool: 'whatsapp',
      action: 'send_whatsapp_message',
      status: 'error' as const,
      message: 'Phone number is required to send WhatsApp message',
      data: null,
      timestamp,
    };
  }

  let metaAccessToken = null;
  // Set only when the Nango branch runs and fails (revoked vs never-connected).
  let _waAuthErr: ReturnType<typeof nangoAuthError> | null | undefined;
  let phoneNumberId = payload.phoneNumberId;
  let channel: any = null;
  await withOrgScopedClient(orgId, async (waClient) => {
    const dbRes = await waClient.query(
      'SELECT meta, nango_connection_id FROM channels WHERE org_id = $1 AND channel_type = $2',
      [orgId, 'whatsapp']
    );
    channel = dbRes.rows[0];
  });

  // QR-paired channel: send through the gateway (Evolution), not Meta Graph.
  if (channel?.meta && providerIdOf(channel.meta) === 'evolution') {
    const sent = await sendViaGateway(channel.meta, { to: String(phone), text: String(textMsg) });
    if (!sent.ok || !sent.messageId) {
      return {
        tool: 'whatsapp',
        action: 'send_whatsapp_message',
        status: 'error' as const,
        message: sent.ok ? 'WhatsApp (QR) accepted the message but returned no id' : sent.message,
        data: { recipientPhone: phone },
        timestamp,
      };
    }
    return {
      tool: 'whatsapp',
      action: 'send_whatsapp_message',
      status: 'executed' as const,
      message: `WhatsApp message sent to ${phone} via linked WhatsApp (QR)`,
      data: { wamid: sent.messageId, recipientPhone: phone, content: textMsg, provider: 'evolution' },
      timestamp,
    };
  }

  if (channel?.meta?.accessToken) {
    try {
      metaAccessToken = openSecret(channel.meta.accessToken);
    } catch (err: any) {
      return {
        tool: 'whatsapp',
        action: 'send_whatsapp_message',
        status: 'error' as const,
        message: `WhatsApp token cannot be read (${err.message}). Reconnect at /connectors.`,
        data: null,
        timestamp,
      };
    }
    phoneNumberId = phoneNumberId || channel.meta.phoneNumberId;
  } else if (channel?.nango_connection_id?.startsWith('manual_json:')) {
    const creds = JSON.parse(channel.nango_connection_id.split('manual_json:')[1]);
    metaAccessToken = creds.accessToken;
    phoneNumberId = phoneNumberId || creds.phoneNumberId;
  } else {
    const connId = `${orgId}_whatsapp`;
    const _waAuth = await resolveNangoAuth(connId, 'whatsapp');
    // Remember revoked-vs-never for the trailing honest error below; manual
    // BYOK rows above take precedence and skip Nango entirely.
    _waAuthErr =
      _waAuth.kind === 'connected' ? null : nangoAuthError('whatsapp', 'send_whatsapp_message', timestamp, _waAuth);
    const nangoData = (_waAuth.kind === 'connected' ? _waAuth.connection : null) as any;
    metaAccessToken = nangoData?.credentials?.raw?.access_token || nangoData?.credentials?.access_token || null;

    phoneNumberId = phoneNumberId
      || nangoData?.metadata?.phone_number_id
      || nangoData?.credentials?.raw?.phone_number_id
      || process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  if (metaAccessToken && phoneNumberId) {
    try {
      const metaRes = await fetchWithTimeout(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${metaAccessToken}`,
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: textMsg },
          }),
        }
      );

      if (metaRes.ok) {
        const metaData = await metaRes.json();
        const wamid = metaData.messages?.[0]?.id;
        if (!wamid) {
          return {
            tool: 'whatsapp',
            action: 'send_whatsapp_message',
            status: 'error' as const,
            message: 'Meta API responded OK but returned no message id',
            data: { recipientPhone: phone, meta_response: metaData },
            timestamp,
          };
        }
        return {
          tool: 'whatsapp',
          action: 'send_whatsapp_message',
          status: 'executed' as const,
          message: `✅ Real WhatsApp message delivered to ${phone} via Meta Cloud API`,
          data: {
            wamid,
            recipientPhone: phone,
            content: textMsg,
            meta_response: metaData,
          },
          timestamp,
        };
      } else {
        const errText = await metaRes.text();
        console.error('[WhatsApp Tool] Meta API error:', errText);
        return {
          tool: 'whatsapp',
          action: 'send_whatsapp_message',
          status: 'error' as const,
          message: /"code"\s*:\s*131047/.test(errText)
            ? 'Outside the 24-hour reply window: WhatsApp only allows an approved template to this contact now.'
            : `Meta API returned ${metaRes.status}: ${errText.slice(0, 200)}`,
          data: { recipientPhone: phone },
          timestamp,
        };
      }
    } catch (err: any) {
      console.error('[WhatsApp Tool] Network error:', err);
      return {
        tool: 'whatsapp',
        action: 'send_whatsapp_message',
        status: 'error' as const,
        message: `Network error sending WhatsApp: ${err.message}`,
        data: null,
        timestamp,
      };
    }
  }

  return _waAuthErr ?? notConnected('whatsapp', 'send_whatsapp_message', timestamp);
}

export const whatsapp: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
