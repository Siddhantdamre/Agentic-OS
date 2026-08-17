import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoConnection, notConnected, withOrgScopedClient } from './shared.js';

const ACTIONS = ['send_whatsapp_message'] as const;

function riskFor(_action: string): ToolRisk {
  return 'send';
}

async function execute(ctx: ToolActionContext) {
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
  let phoneNumberId = payload.phoneNumberId;
  let channel: any = null;
  await withOrgScopedClient(orgId, async (waClient) => {
    const dbRes = await waClient.query(
      'SELECT meta, nango_connection_id FROM channels WHERE org_id = $1 AND channel_type = $2',
      [orgId, 'whatsapp']
    );
    channel = dbRes.rows[0];
  });

  if (channel?.meta?.accessToken) {
    metaAccessToken = channel.meta.accessToken;
    phoneNumberId = phoneNumberId || channel.meta.phoneNumberId;
  } else if (channel?.nango_connection_id?.startsWith('manual_json:')) {
    const creds = JSON.parse(channel.nango_connection_id.split('manual_json:')[1]);
    metaAccessToken = creds.accessToken;
    phoneNumberId = phoneNumberId || creds.phoneNumberId;
  } else {
    const connId = `${orgId}_whatsapp`;
    const nangoData = await getNangoConnection(connId, 'whatsapp');
    metaAccessToken = nangoData?.credentials?.raw?.access_token || nangoData?.credentials?.access_token || null;

    phoneNumberId = phoneNumberId
      || nangoData?.metadata?.phone_number_id
      || nangoData?.credentials?.raw?.phone_number_id
      || process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  if (metaAccessToken && phoneNumberId) {
    try {
      const metaRes = await fetch(
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
          message: `Meta API returned ${metaRes.status}: ${errText.slice(0, 200)}`,
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

  return notConnected('whatsapp', 'send_whatsapp_message', timestamp);
}

export const whatsapp: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
