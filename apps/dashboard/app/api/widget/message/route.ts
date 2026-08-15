import { NextResponse } from 'next/server';
import { fireInboundAgent, parseToolAllowlist } from '@/lib/inbound-agent';
import {
  inboundJobFromPersist,
  persistInboundMessage,
} from '@/lib/channel-normalize';
import { getOrgScopedClient } from '@/lib/db';
import { denyWebhookIfLimited } from '@/lib/rate-limit';
import {
  ignoreBodyOrgId,
  orgHasInstalledPack,
  requireWidgetOrg,
  widgetForbidden,
  widgetPreflight,
  withWidgetCors,
} from '../_lib';

/**
 * POST /api/widget/message
 * Persist inbound + HTTP 200. Fire-and-forget WorkItem — never await the model.
 * Session-scoped chat. Agent allowlist is listings.search only — never database_query / Drive.
 */
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function OPTIONS(request: Request) {
  return widgetPreflight(request);
}

export async function GET(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;

  const pack = await orgHasInstalledPack(auth.orgId);
  if (!pack) {
    return withWidgetCors(
      request,
      widgetForbidden('Widget is deny-all until a pack is installed.'),
      auth.allowedOrigins
    );
  }

  const url = new URL(request.url);
  const sessionId = (url.searchParams.get('sessionId') || url.searchParams.get('conversationId') || '').trim();
  const after = (url.searchParams.get('after') || '').trim();
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return withWidgetCors(
      request,
      NextResponse.json({ error: 'sessionId is required' }, { status: 400 }),
      auth.allowedOrigins
    );
  }

  const { client } = await getOrgScopedClient(auth.orgId);
  try {
    const conv = await client.query(
      `SELECT id FROM conversations
        WHERE org_id = $1 AND id = $2
          AND (
            contact_id LIKE 'widget:%'
            OR COALESCE(metadata->>'channel', '') = 'widget'
            OR COALESCE(metadata->>'surface', '') = 'widget'
          )
        LIMIT 1`,
      [auth.orgId, sessionId]
    );
    if (conv.rows.length === 0) {
      return withWidgetCors(
        request,
        NextResponse.json({ error: 'Session not found' }, { status: 404 }),
        auth.allowedOrigins
      );
    }

    const afterId = UUID_RE.test(after) ? after : null;
    const res = await client.query(
      `SELECT id, role, content, created_at
         FROM messages
        WHERE org_id = $1 AND conversation_id = $2
          AND role IN ('user', 'assistant')
          AND ($3::uuid IS NULL OR created_at > (
            SELECT created_at FROM messages WHERE org_id = $1 AND id = $3::uuid
          ))
        ORDER BY created_at ASC
        LIMIT 50`,
      [auth.orgId, sessionId, afterId]
    );
    return withWidgetCors(
      request,
      NextResponse.json({ messages: res.rows }),
      auth.allowedOrigins
    );
  } catch (err: unknown) {
    console.error('GET /api/widget/message Error:', err);
    return withWidgetCors(
      request,
      NextResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
      auth.allowedOrigins
    );
  } finally {
    client.release();
  }
}

export async function POST(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;

  const pack = await orgHasInstalledPack(auth.orgId);
  if (!pack) {
    return withWidgetCors(
      request,
      widgetForbidden('Widget is deny-all until a pack is installed.'),
      auth.allowedOrigins
    );
  }

  const limited = denyWebhookIfLimited(auth.orgId);
  if (limited) return withWidgetCors(request, limited, auth.allowedOrigins);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return withWidgetCors(
      request,
      NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }),
      auth.allowedOrigins
    );
  }
  ignoreBodyOrgId(body);

  const sessionId =
    (typeof body.sessionId === 'string' && body.sessionId) ||
    (typeof body.conversationId === 'string' && body.conversationId) ||
    '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!sessionId || !UUID_RE.test(sessionId) || !content) {
    return withWidgetCors(
      request,
      NextResponse.json({ error: 'sessionId and content are required' }, { status: 400 }),
      auth.allowedOrigins
    );
  }

  try {
    const { client } = await getOrgScopedClient(auth.orgId);
    let contactId = `widget:${sessionId}`;
    try {
      const conv = await client.query(
        `SELECT id, contact_id FROM conversations
          WHERE org_id = $1 AND id = $2
            AND (
              contact_id LIKE 'widget:%'
              OR COALESCE(metadata->>'channel', '') = 'widget'
              OR COALESCE(metadata->>'surface', '') = 'widget'
            )
          LIMIT 1`,
        [auth.orgId, sessionId]
      );
      if (conv.rows.length === 0) {
        return withWidgetCors(
          request,
          NextResponse.json({ error: 'Session not found' }, { status: 404 }),
          auth.allowedOrigins
        );
      }
      contactId = conv.rows[0].contact_id || contactId;
    } finally {
      client.release();
    }

    const persisted = await persistInboundMessage({
      orgId: auth.orgId,
      channelKey: 'widget',
      channelType: 'widget',
      contactId,
      content,
      extraMeta: { surface: 'widget', sessionId },
    });

    if (persisted.shouldFireAgent) {
      const job = inboundJobFromPersist(
        auth.orgId,
        {
          orgId: auth.orgId,
          channelKey: 'widget',
          channelType: 'widget',
          contactId,
          content,
        },
        persisted
      );
      job.toolAllowlist = parseToolAllowlist(['listings.search'], ['listings.search']);
      fireInboundAgent(job);
    }

    return withWidgetCors(
      request,
      NextResponse.json({
        ok: true,
        conversationId: persisted.conversationId,
        messageId: persisted.messageId,
      }),
      auth.allowedOrigins
    );
  } catch (err: unknown) {
    console.error('POST /api/widget/message Error:', err);
    return withWidgetCors(
      request,
      NextResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
      auth.allowedOrigins
    );
  }
}
