import { NextResponse } from 'next/server';
import { fireInboundAgent, parseToolAllowlist } from '@/lib/inbound-agent';
import {
  inboundJobFromPersist,
  persistInboundMessage,
} from '@/lib/channel-normalize';
import { getOrgScopedClient } from '@/lib/db';
import { orgHasInstalledPack, requireWidgetOrg, widgetForbidden } from '../_lib';

/**
 * POST /api/widget/message
 * Session-scoped chat. Agent allowlist is listings.search only — never database_query / Drive.
 */
export async function POST(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;

  const pack = await orgHasInstalledPack(auth.orgId);
  if (!pack) {
    return widgetForbidden('Widget is deny-all until a pack is installed.');
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  void body.org_id;
  void body.orgId;

  const sessionId =
    (typeof body.sessionId === 'string' && body.sessionId) ||
    (typeof body.conversationId === 'string' && body.conversationId) ||
    '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!sessionId || !content) {
    return NextResponse.json({ error: 'sessionId and content are required' }, { status: 400 });
  }

  const { client } = await getOrgScopedClient(auth.orgId);
  let contactId = `widget:${sessionId}`;
  try {
    const conv = await client.query(
      `SELECT id, contact_id FROM conversations WHERE org_id = $1 AND id = $2 LIMIT 1`,
      [auth.orgId, sessionId]
    );
    if (conv.rows.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
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

  return NextResponse.json({
    ok: true,
    conversationId: persisted.conversationId,
    messageId: persisted.messageId,
  });
}
