import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import crypto from 'crypto';

/**
 * Resolve the correct org_id from the webhook request.
 * The webhook URL must include ?org_id=<orgId> or use a per-org secret token.
 * Falls back to matching by channel meta if token is provided.
 */
async function resolveOrgFromRequest(
  request: Request,
  client: any
): Promise<string | null> {
  const url = new URL(request.url);

  // Option 1: org_id passed explicitly in query (for internal/trusted calls)
  const orgIdParam = url.searchParams.get('org_id');
  if (orgIdParam) {
    const orgRes = await client.query('SELECT id FROM orgs WHERE id = $1 AND status = $2', [
      orgIdParam,
      'active',
    ]);
    if (orgRes.rows.length > 0) return orgRes.rows[0].id;
  }

  // Option 2: secret token in Authorization header -> match to org
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (token) {
    const orgRes = await client.query(
      `SELECT id FROM orgs WHERE meta->>'webhook_secret' = $1 AND status = 'active' LIMIT 1`,
      [token]
    );
    if (orgRes.rows.length > 0) return orgRes.rows[0].id;
  }

  // Option 3: X-Chatwoot-User-Id header  
  const chatwootOrgHeader = request.headers.get('X-Darex-Org-Id');
  if (chatwootOrgHeader) {
    const orgRes = await client.query('SELECT id FROM orgs WHERE id = $1 AND status = $2', [
      chatwootOrgHeader,
      'active',
    ]);
    if (orgRes.rows.length > 0) return orgRes.rows[0].id;
  }

  return null;
}

export async function POST(request: Request) {
  const startTime = Date.now();

  // Clone request so we can read body twice (once for sig check, once for JSON)
  const rawBody = await request.text();

  // Optional HMAC signature verification
  const chatwootSecret = process.env.CHATWOOT_WEBHOOK_SECRET;
  if (chatwootSecret) {
    const signature = request.headers.get('x-chatwoot-signature') || '';
    const expectedSig = crypto
      .createHmac('sha256', chatwootSecret)
      .update(rawBody)
      .digest('hex');
    if (signature !== `sha256=${expectedSig}`) {
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const client = await pool.connect();

  try {
    const {
      event = 'message_created',
      channel_type = 'whatsapp',
      chatwoot_conv_id,
      contact_id,
      sender_name = 'Customer',
      content = 'Inbound message',
      employee_id = null,
      meta = {},
    } = payload;

    if (!contact_id) {
      console.error('[Chatwoot Webhook] contact_id is required to route messages in a multi-tenant system');
      return NextResponse.json(
        { error: 'contact_id is required in webhook payload for multi-tenant routing' },
        { status: 400 }
      );
    }

    // Resolve org — MUST be correct org, not just LIMIT 1
    let orgId = await resolveOrgFromRequest(request, client);

    if (!orgId) {
      // Last resort: if only 1 org exists (single-tenant test env), use it
      const orgCount = await client.query('SELECT COUNT(*) as count FROM orgs WHERE status = $1', ['active']);
      if (parseInt(orgCount.rows[0].count, 10) === 1) {
        const orgRes = await client.query("SELECT id FROM orgs WHERE status = 'active' LIMIT 1");
        orgId = orgRes.rows[0].id;
      } else {
        console.error('[Chatwoot Webhook] Cannot resolve org_id — webhook must include org_id param or auth token');
        return NextResponse.json(
          { error: 'Cannot resolve organization. Include org_id in webhook URL or Authorization header.' },
          { status: 400 }
        );
      }
    }

    // Enforce Row Level Security
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

    // Ensure channel exists
    let channelId: string | null = null;
    const channelRes = await client.query(
      `SELECT id FROM channels WHERE org_id = $1 AND channel_type = $2 LIMIT 1`,
      [orgId, channel_type]
    );

    if (channelRes.rows.length > 0) {
      channelId = channelRes.rows[0].id;
    } else {
      const newChan = await client.query(
        `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
         VALUES ($1, $2, 'active', $3, NOW()) RETURNING id`,
        [orgId, channel_type, JSON.stringify({ name: `${channel_type} Channel` })]
      );
      channelId = newChan.rows[0].id;
    }

    // Find or create conversation by chatwoot_conv_id or contact_id
    let conversationId: string;
    const convIdInput = chatwoot_conv_id || null; // Do NOT generate random IDs — use null if not provided

    const existingConv = await client.query(
      `SELECT id, status FROM conversations WHERE org_id = $1 AND ($2::text IS NULL OR chatwoot_conv_id::text = $2::text) AND contact_id = $3 LIMIT 1`,
      [orgId, convIdInput, contact_id]
    );

    if (existingConv.rows.length > 0) {
      conversationId = existingConv.rows[0].id;
      await client.query(
        `UPDATE conversations SET updated_at = NOW(), summary = $1, metadata = metadata || $2 WHERE id = $3 AND org_id = $4`,
        [content.slice(0, 100), JSON.stringify({ sender_name, ...meta }), conversationId, orgId]
      );
    } else {
      // Pick the default active employee for this org
      const empRes = await client.query(
        `SELECT id FROM ai_employees WHERE org_id = $1 AND status = 'active' LIMIT 1`,
        [orgId]
      );
      const assignedEmployeeId = employee_id || (empRes.rows[0]?.id ?? null);

      const newConv = await client.query(
        `INSERT INTO conversations (org_id, channel_id, chatwoot_conv_id, status, contact_id, employee_id, summary, metadata, started_at)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, NOW())
         RETURNING id`,
        [orgId, channelId, convIdInput, contact_id, assignedEmployeeId, content.slice(0, 100), JSON.stringify({ sender_name, ...meta })]
      );
      conversationId = newConv.rows[0].id;
    }

    // Insert message
    // chatwoot_msg_id: use provided value, don't fabricate random IDs
    const chatwootMsgId = payload.chatwoot_msg_id || null;
    const msgRes = await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, chatwoot_msg_id, created_at)
       VALUES ($1, $2, 'user', $3, $4, NOW())
       RETURNING id, created_at`,
      [orgId, conversationId, content, chatwootMsgId]
    );

    // Audit log
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, 'inbound_message', 'success', 200, $3, $4)`,
      [
        orgId,
        channel_type,
        `Inbound message from ${sender_name} (${contact_id})`,
        JSON.stringify({ conversationId, messageId: msgRes.rows[0].id, content }),
      ]
    );

    const latencyMs = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      latencyMs,
      org_id: orgId,
      conversation_id: conversationId,
      message_id: msgRes.rows[0].id,
      event,
      channel_type,
    });
  } catch (err: any) {
    console.error('Chatwoot Webhook Ingestion Error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
