import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PRESENCE_TTL_SECONDS = 45;

type PresenceAction = 'viewing' | 'typing' | 'left';

function isPresenceAction(value: unknown): value is PresenceAction {
  return value === 'viewing' || value === 'typing' || value === 'left';
}

/**
 * POST /api/stream/presence
 * Heartbeat from an authenticated operator viewing/typing in a conversation.
 * Only real session users are recorded — no invented presence.
 * Org and user come from the session, never the body.
 */
export async function POST(request: Request) {
  let client;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
    if (body.orgId != null || body.org_id != null) {
      return NextResponse.json({ error: 'org_id must not be supplied in body' }, { status: 400 });
    }
    const conversationId =
      typeof body.conversationId === 'string'
        ? body.conversationId
        : typeof body.conversation_id === 'string'
          ? body.conversation_id
          : null;
    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
    }
    if (!isPresenceAction(body.action)) {
      return NextResponse.json(
        { error: 'action must be viewing, typing, or left' },
        { status: 400 }
      );
    }
    const action = body.action;

    const conv = await client.query(
      `SELECT id FROM conversations WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`,
      [conversationId, orgId]
    );
    if (!conv.rowCount) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const user = await client.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1::uuid LIMIT 1`,
      [userId]
    );
    const userName =
      (typeof body.userName === 'string' && body.userName.trim()) ||
      user.rows[0]?.email ||
      'operator';

    if (action === 'left') {
      await client.query(
        `DELETE FROM conversation_presence
          WHERE org_id = $1::uuid AND conversation_id = $2::uuid AND user_id = $3::uuid`,
        [orgId, conversationId, userId]
      );
    } else {
      await client.query(
        `INSERT INTO conversation_presence (
           org_id, conversation_id, user_id, user_name, action, last_heartbeat_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, NOW())
         ON CONFLICT (org_id, conversation_id, user_id) DO UPDATE
           SET user_name = EXCLUDED.user_name,
               action = EXCLUDED.action,
               last_heartbeat_at = NOW()`,
        [orgId, conversationId, userId, userName, action]
      );
    }

    // Drop stale heartbeats so we never report ghosts.
    await client.query(
      `DELETE FROM conversation_presence
        WHERE org_id = $1::uuid
          AND conversation_id = $2::uuid
          AND last_heartbeat_at < NOW() - ($3 || ' seconds')::interval`,
      [orgId, conversationId, String(PRESENCE_TTL_SECONDS)]
    );

    const viewers = await client.query<{
      user_id: string;
      user_name: string;
      action: string;
      last_heartbeat_at: string;
    }>(
      `SELECT user_id, user_name, action, last_heartbeat_at
         FROM conversation_presence
        WHERE org_id = $1::uuid AND conversation_id = $2::uuid
        ORDER BY last_heartbeat_at DESC`,
      [orgId, conversationId]
    );

    realtimeHub.publish(orgId, {
      type: 'presence_updated',
      conversationId,
      message: JSON.stringify({
        viewers: viewers.rows.map((r) => ({
          userId: r.user_id,
          userName: r.user_name,
          action: r.action,
          at: r.last_heartbeat_at,
        })),
      }),
    });

    return NextResponse.json({
      conversationId,
      viewers: viewers.rows.map((r) => ({
        userId: r.user_id,
        userName: r.user_name,
        action: r.action,
        at: r.last_heartbeat_at,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    if (/conversation_presence|relation .* does not exist/i.test(message)) {
      return NextResponse.json(
        { error: 'Presence table missing — apply migration 103' },
        { status: 503 }
      );
    }
    console.error('[presence] error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    client?.release();
  }
}
