import { getOrgScopedClient } from '@/lib/db';
import { replyTargetFromChannelMeta } from '@/lib/channel-outbound';
import { employeePersonaText, parseToolAllowlist, type InboundAgentJob } from '@/lib/inbound-agent';
import { realtimeHub } from '@/lib/realtime-hub';
import { parseAutoReply, personaWithInstructions, shouldAutoReply } from '@/lib/whatsapp-auto-reply-config';

export type WhatsAppMediaMeta = {
  type: string;
  id: string | null;
  mimeType: string | null;
  sha256: string | null;
  filename: string | null;
  caption: string | null;
};

type EmployeeRow = {
  id: string;
  name: string;
  role: string;
  persona: unknown;
  tool_allowlist: unknown;
};

async function resolveEmployeeForConversation(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: EmployeeRow[] }> },
  orgId: string,
  assignedEmployeeId: string | null,
  preferredEmployeeId: string | null = null
): Promise<EmployeeRow | undefined> {
  // A conversation keeps the employee it was given; new ones use the owner's pick.
  for (const id of [assignedEmployeeId, preferredEmployeeId]) {
    if (!id) continue;
    const byId = await client.query(
      `SELECT id, name, role, persona, tool_allowlist FROM ai_employees
       WHERE org_id = $1 AND id = $2 AND status = 'active'`,
      [orgId, id]
    );
    if (byId.rows[0]) return byId.rows[0];
  }
  // Automatic: a customer or support employee answers customers before anyone else.
  const fallback = await client.query(
    `SELECT id, name, role, persona, tool_allowlist FROM ai_employees
     WHERE org_id = $1 AND status = 'active'
     ORDER BY (role ~* '(customer|support)') DESC, created_at ASC NULLS LAST
     LIMIT 1`,
    [orgId]
  );
  return fallback.rows[0];
}


export type InboundWhatsApp = {
  orgId: string;
  /** Null when the org has no channel row yet; one is created from `newChannelMeta`. */
  channelId: string | null;
  channelMeta: Record<string, unknown>;
  newChannelMeta: Record<string, unknown>;
  from: string;
  messageId: string;
  text: string;
  media: WhatsAppMediaMeta | null;
  /** Inline file (Evolution). Handed to media reading only, never saved. */
  mediaBase64?: string | null;
  senderName?: string | null;
};

/**
 * Persist one inbound WhatsApp message (conversation, message row, log,
 * realtime ping) and return the agent job to fire. Null = nothing to run
 * (duplicate delivery or AI paused for a human takeover). Shared by every
 * WhatsApp provider webhook so they behave identically.
 */
export async function ingestWhatsAppInbound(m: InboundWhatsApp): Promise<InboundAgentJob | null> {
  const { orgId, from, messageId, text } = m;
  let channelId = m.channelId;
  const chanMeta = m.channelMeta;
  const autoReply = parseAutoReply(chanMeta.auto_reply);
  const { client } = await getOrgScopedClient(orgId);
  try {
    if (!channelId) {
      const newChan = await client.query(
        `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
         VALUES ($1, 'whatsapp', 'active', $2, NOW()) RETURNING id`,
        [
          orgId,
          JSON.stringify(m.newChannelMeta),
        ]
      );
      channelId = newChan.rows[0].id;
    }

    const connectedRes = await client.query(
      `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
      [orgId]
    );
    const connectedChannels = connectedRes.rows.map((row: { channel_type: string }) => row.channel_type);

    let conversationId: string;
    let assignedEmployeeId: string | null = null;
    let aiPausedUntil: Date | null = null;
    let existingConv: { rows: Array<Record<string, unknown>> };
    try {
      existingConv = await client.query(
        `SELECT id, employee_id, ai_paused_until
         FROM conversations
         WHERE org_id = $1 AND contact_id = $2 AND status != 'resolved'
           AND (channel_id = $3 OR channel_id IS NULL)
         ORDER BY (channel_id = $3) DESC NULLS LAST, updated_at DESC
         LIMIT 1`,
        [orgId, from, channelId]
      );
    } catch {
      existingConv = await client.query(
        `SELECT id, employee_id
         FROM conversations
         WHERE org_id = $1 AND contact_id = $2 AND status != 'resolved'
           AND (channel_id = $3 OR channel_id IS NULL)
         ORDER BY (channel_id = $3) DESC NULLS LAST, updated_at DESC
         LIMIT 1`,
        [orgId, from, channelId]
      );
    }

    if (existingConv.rows.length > 0) {
      conversationId = existingConv.rows[0].id as string;
      assignedEmployeeId = (existingConv.rows[0].employee_id as string | null) ?? null;
      const pausedRaw = existingConv.rows[0].ai_paused_until;
      aiPausedUntil = pausedRaw ? new Date(pausedRaw as string) : null;
      await client.query(
        `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
        [text.slice(0, 100), conversationId, orgId]
      );
    } else {
      const employeeForInsert = await resolveEmployeeForConversation(client, orgId, null, autoReply.employeeId);
      const newConv = await client.query(
        `INSERT INTO conversations (org_id, channel_id, contact_id, employee_id, status, summary, metadata, started_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $6, NOW(), NOW())
         RETURNING id, employee_id`,
        [
          orgId,
          channelId,
          from,
          employeeForInsert?.id ?? null,
          text.slice(0, 100),
          JSON.stringify({ sender_name: m.senderName || from, channel: 'whatsapp' }),
        ]
      );
      conversationId = newConv.rows[0].id;
      assignedEmployeeId = (newConv.rows[0].employee_id as string | null) ?? null;
    }

    const employee = await resolveEmployeeForConversation(client, orgId, assignedEmployeeId, autoReply.employeeId);

    let inserted = true;
    if (messageId) {
      const dup = await client.query(
        `SELECT id FROM messages WHERE org_id = $1 AND chatwoot_msg_id = $2 LIMIT 1`,
        [orgId, messageId]
      );
      if (dup.rows.length > 0) {
        inserted = false;
      }
    }
    if (inserted) {
      try {
        const toolCalls = m.media
          ? JSON.stringify({
              media: {
                type: m.media.type,
                id: m.media.id,
                mime_type: m.media.mimeType,
                sha256: m.media.sha256,
                filename: m.media.filename,
                caption: m.media.caption,
                transcript: null,
                note: 'Media metadata from webhook only - no transcript generated',
              },
            })
          : null;
        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, chatwoot_msg_id, channel_key, tool_calls, created_at)
           VALUES ($1, $2, 'user', $3, $4, 'whatsapp', $5::jsonb, NOW())`,
          [orgId, conversationId, text, messageId || null, toolCalls]
        );
      } catch (insertErr: unknown) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes('idx_messages_org_chatwoot_msg_id') || msg.includes('unique')) {
          inserted = false;
        } else {
          throw insertErr;
        }
      }
    }

    if (!inserted) {
      return null;
    }

    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, 'whatsapp', 'inbound_message', 'success', 200, $2, $3)`,
      [
        orgId,
        `Inbound WhatsApp from ${from}`,
        JSON.stringify({
          from,
          messageId,
          text: text.slice(0, 300),
          media: m.media,
        }),
      ]
    );

    realtimeHub.publish(orgId, {
      type: 'needs_attention',
      conversationId,
      message: text.slice(0, 200),
      contactId: from,
      channelType: 'whatsapp',
    });

    const paused =
      aiPausedUntil != null && !Number.isNaN(aiPausedUntil.getTime()) && aiPausedUntil.getTime() > Date.now();
    if (paused) {
      console.info(
        '[WhatsApp Webhook] Skipping agent - ai_paused_until active until %s for conversation %s',
        aiPausedUntil?.toISOString(),
        conversationId
      );
      return null;
    }

    // Who gets a reply: the message above is already saved and visible to the team either way.
    const gate = shouldAutoReply(autoReply, from, existingConv.rows.length === 0);
    if (!gate.reply) {
      console.info('[WhatsApp Webhook] no auto-reply for org %s (%s) - message saved', orgId, gate.reason);
      return null;
    }

    const readableMedia =
      autoReply.readMedia && m.media && (m.media.type === 'audio' || m.media.type === 'image')
        ? {
            type: m.media.type,
            id: m.media.id,
            mimeType: m.media.mimeType,
            filename: m.media.filename,
            caption: m.media.caption,
            base64: m.mediaBase64 ?? null,
          }
        : undefined;

    return {
      autoReply,
      media: readableMedia,
      orgId,
      conversationId,
      channelId: channelId ?? undefined,
      employeeId: employee?.id,
      employeeName: employee?.name ?? 'AI Assistant',
      employeeRole: employee?.role ?? 'Support',
      employeePersona: personaWithInstructions(employeePersonaText(employee?.persona), autoReply),
      toolAllowlist: parseToolAllowlist(employee?.tool_allowlist),
      connectedChannels,
      userMessage: text,
      inboundEventId: messageId || undefined,
      channelKey: 'whatsapp',
      replyTarget: replyTargetFromChannelMeta('whatsapp', from, chanMeta),
    };
  } finally {
    client.release();
  }
}
