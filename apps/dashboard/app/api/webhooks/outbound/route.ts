import { NextResponse } from 'next/server';
import { pool, getOrgScopedClient } from '@/lib/db';
import { assertChatwootWebhookSignature } from '@/lib/webhook-crypto';
import { replyTargetFromChannelMeta, sendChannelReply } from '@/lib/channel-outbound';
import { realtimeHub } from '@/lib/realtime-hub';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';

/**
 * POST /api/webhooks/outbound
 * Authenticated inbox-gateway send. Tenant is resolved from the conversation
 * row — body org_id is ignored.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const sig = assertChatwootWebhookSignature(rawBody, request.headers.get('x-chatwoot-signature'));
  if (!sig.ok) {
    return NextResponse.json({ error: sig.error || 'Invalid webhook signature' }, { status: sig.status });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  void body.org_id;
  void body.orgId;

  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!conversationId || !content) {
    return NextResponse.json({ error: 'conversationId and content are required' }, { status: 400 });
  }

  let orgId: string | null = null;
  try {
    const res = await pool.query(`SELECT resolve_conversation_org($1::uuid) AS org_id`, [conversationId]);
    orgId = (res.rows[0]?.org_id as string) || null;
  } catch {
    const res = await pool.query(`SELECT org_id FROM conversations WHERE id = $1`, [conversationId]);
    orgId = (res.rows[0]?.org_id as string) || null;
  }

  if (!orgId) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const webhookLimited = denyWebhookIfLimited(orgId);
  if (webhookLimited) {
    return webhookLimited;
  }

  const { client } = await getOrgScopedClient(orgId);
  let released = false;
  try {
    const convRes = await client.query(
      `SELECT c.id, c.contact_id, c.chatwoot_conv_id, ch.channel_type, ch.meta as channel_meta
       FROM conversations c
       LEFT JOIN channels ch ON c.channel_id = ch.id
       WHERE c.org_id = $1 AND c.id = $2`,
      [orgId, conversationId]
    );
    if (convRes.rows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const conv = convRes.rows[0];
    const channelType =
      (typeof body.channel === 'string' && body.channel) || conv.channel_type || 'dashboard';
    const contactId =
      (typeof body.recipient === 'string' && body.recipient) || conv.contact_id || '';

    const msgRes = await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
       VALUES ($1, $2, 'human_agent', $3, NOW())
       RETURNING id, created_at`,
      [orgId, conversationId, content]
    );
    await client.query(
      `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
      [content.slice(0, 100), conversationId, orgId]
    );

    const target = replyTargetFromChannelMeta(
      channelType,
      contactId,
      (conv.channel_meta || {}) as Record<string, unknown>,
      { chatwootConvId: conv.chatwoot_conv_id }
    );

    client.release();
    released = true;

    const sendResult = await sendChannelReply(orgId, target, content);
    realtimeHub.publish(orgId, {
      type: 'conversation_updated',
      conversationId,
      message: content.slice(0, 200),
      contactId,
      channelType,
    });

    return NextResponse.json({
      success: sendResult.sent || !sendResult.attempted,
      attempted: sendResult.attempted,
      sent: sendResult.sent,
      statusCode: sendResult.statusCode,
      message: sendResult.message,
      messageId: msgRes.rows[0].id,
      conversationId,
    });
  } catch (err: unknown) {
    if (isRateLimitError(err)) {
      return responseFromRateLimit(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[outbound webhook]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    if (!released) client.release();
  }
}
