import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import type { PoolClient } from 'pg';
import {
  employeePersonaText,
  fireInboundAgent,
  parseToolAllowlist,
} from '@/lib/inbound-agent';
import { replyTargetFromChannelMeta, sendChannelReply } from '@/lib/channel-outbound';

type MessageRole = 'user' | 'customer' | 'human_agent' | 'assistant';

function normalizeRole(role: unknown): MessageRole {
  switch (role) {
    case 'user':
      return 'user';
    case 'customer':
      return 'customer';
    case 'human_agent':
      return 'human_agent';
    case 'assistant':
      return 'assistant';
    default:
      return 'user';
  }
}

// GET message history for a conversation
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await params;
    const { client, orgId } = await getScopedClient();
    try {
      const messagesRes = await client.query(
        `SELECT id, org_id, conversation_id, role, content, tool_calls, chatwoot_msg_id, created_at
         FROM messages
         WHERE org_id = $1 AND conversation_id = $2
         ORDER BY created_at ASC`,
        [orgId, conversationId]
      );

      const convRes = await client.query(
        `SELECT c.*, ch.channel_type, e.name as employee_name, e.role as employee_role
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
         LEFT JOIN ai_employees e ON c.employee_id = e.id
         WHERE c.org_id = $1 AND c.id = $2`,
        [orgId, conversationId]
      );

      if (convRes.rows.length === 0) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      return NextResponse.json({
        conversation: convRes.rows[0],
        messages: messagesRes.rows,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Messages GET Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST message & trigger AI Model Response (atomic-agent)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await params;
    const { content, role = 'user' } = await request.json();

    if (!content || !content.trim()) {
      return NextResponse.json({ error: 'Message content is required' }, { status: 400 });
    }

    const { client: clientPool, orgId } = await getScopedClient();
    let client: PoolClient | null = clientPool;
    try {
      // Check conversation exists & fetch assigned employee details
      const convRes = await client.query(
        `SELECT c.id, c.channel_id, c.employee_id, c.contact_id, c.chatwoot_conv_id, c.metadata,
                ch.channel_type, ch.meta as channel_meta,
                e.name as employee_name, e.role as employee_role, e.persona as employee_persona,
                e.tool_allowlist as employee_tool_allowlist
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
         LEFT JOIN ai_employees e ON c.employee_id = e.id
         WHERE c.org_id = $1 AND c.id = $2`,
        [orgId, conversationId]
      );

      if (convRes.rows.length === 0) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      const conv = convRes.rows[0];
      const messageRole = normalizeRole(role);

      const userMsgRes = await client.query(
        `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, org_id, conversation_id, role, content, chatwoot_msg_id, created_at`,
        [orgId, conversationId, messageRole === 'customer' ? 'user' : messageRole, content]
      );

      await client.query(
        `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
        [content.slice(0, 100), conversationId, orgId]
      );

      const connectedRes = await client.query(
        `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
        [orgId]
      );
      const connectedChannels = connectedRes.rows.map((row: { channel_type: string }) => row.channel_type);

      const channelType = conv.channel_type ?? 'dashboard';
      const contactId = conv.contact_id ?? 'unknown';
      const chanMeta = (conv.channel_meta || {}) as Record<string, unknown>;
      const replyTarget = replyTargetFromChannelMeta(channelType, contactId, chanMeta, {
        chatwootConvId: conv.chatwoot_conv_id,
      });

      if (messageRole === 'user' || messageRole === 'customer') {
        realtimeHub.publish(orgId, {
          type: 'needs_attention',
          conversationId,
          message: content.slice(0, 200),
          contactId,
          channelType,
        });
      } else {
        realtimeHub.publish(orgId, {
          type: 'conversation_updated',
          conversationId,
          message: content.slice(0, 200),
          contactId,
          channelType,
        });
      }

      client.release();
      client = null;

      switch (messageRole) {
        case 'user':
        case 'customer':
          fireInboundAgent({
            orgId,
            conversationId,
            channelId: conv.channel_id ?? undefined,
            employeeId: conv.employee_id ?? undefined,
            employeeName: conv.employee_name || 'AI Assistant',
            employeeRole: conv.employee_role || 'Support',
            employeePersona: employeePersonaText(conv.employee_persona),
            toolAllowlist: parseToolAllowlist(conv.employee_tool_allowlist),
            connectedChannels,
            userMessage: content,
            replyTarget,
          });
          break;
        case 'human_agent':
          void sendChannelReply(orgId, replyTarget, content);
          break;
        case 'assistant':
          break;
        default: {
          const _never: never = messageRole;
          void _never;
        }
      }

      return NextResponse.json({
        success: true,
        userMessage: userMsgRes.rows[0],
        aiResponse: null,
      });
    } finally {
      if (client) client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Messages POST Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
