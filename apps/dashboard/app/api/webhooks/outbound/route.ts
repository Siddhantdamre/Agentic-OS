import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { pool, getOrgScopedClient } from '@/lib/db';
import { assertChatwootWebhookSignature, secretEquals, verifyChatwootSignature } from '@/lib/webhook-crypto';
import { replyTargetFromChannelMeta, sendChannelReply } from '@/lib/channel-outbound';
import { recordOutboundDelivery } from '@/lib/failed-webhooks';
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

  // The global inbox HMAC is not enough: it is shared, so a caller who has it
  // could inject into any org's conversation id. The secret must match this org.
  const secretRes = await pool.query(
    `SELECT meta->>'webhook_secret' AS secret FROM orgs WHERE id = $1`,
    [orgId]
  );
  const orgSecret = typeof secretRes.rows[0]?.secret === 'string' ? secretRes.rows[0].secret : '';
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const headerSecret = request.headers.get('x-darex-org-secret') || '';
  const orgSigOk = orgSecret
    ? verifyChatwootSignature(rawBody, request.headers.get('x-chatwoot-signature'), orgSecret)
    : false;
  const orgTokenOk = secretEquals(bearer, orgSecret) || secretEquals(headerSecret, orgSecret);
  if (!orgSigOk && !orgTokenOk) {
    return NextResponse.json(
      { error: 'Outbound webhook secret does not match this workspace' },
      { status: 403 }
    );
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
    // Channel and recipient always come from the stored conversation; body
    // `channel` / `recipient` are ignored like `org_id`. Honouring them would
    // let a caller send from this org's credentials to any number (CH-S01).
    const channelType = conv.channel_type || 'dashboard';
    const contactId = conv.contact_id || '';

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
    await recordOutboundDelivery({ orgId, messageId: msgRes.rows[0].id, result: sendResult });
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
    const errorId = randomUUID();
    const message = err instanceof Error ? err.message : String(err);
    console.error('[outbound webhook]', errorId, message);
    return NextResponse.json({ success: false, error: 'Internal error', errorId }, { status: 500 });
  } finally {
    if (!released) client.release();
  }
}
