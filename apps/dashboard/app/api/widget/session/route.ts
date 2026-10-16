import { NextResponse } from 'next/server';
import { persistInboundMessage } from '@/lib/channel-normalize';
import { signVisitorSession } from '@/lib/widget-token';
import {
  ignoreBodyOrgId,
  orgHasInstalledPack,
  requireWidgetOrg,
  resolveWidgetToolAllowlist,
  widgetForbidden,
  widgetPreflight,
  withWidgetCors,
} from '../_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

/**
 * POST /api/widget/session
 * Public embed token → session (conversation). Deny-all until a pack is installed.
 * Body org_id is ignored; tenant is the site key.
 * Returns signed visitorToken bound to orgId + sessionId.
 */
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: Request) {
  return widgetPreflight(request);
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

  let contactHint = 'widget-visitor';
  try {
    const body = await jsonBodyOrEmpty<Record<string, unknown>>(request);
    ignoreBodyOrgId(body);
    if (typeof body.visitorId === 'string' && body.visitorId.trim()) {
      contactHint = body.visitorId.trim().slice(0, 80);
    }
  } catch {
    // empty body is fine
  }

  try {
    const allowlist = await resolveWidgetToolAllowlist(auth.orgId);
    const persisted = await persistInboundMessage({
      orgId: auth.orgId,
      channelKey: 'widget',
      channelType: 'widget',
      contactId: `widget:${contactHint}`,
      content: '[widget session started]',
      skipAgent: true,
      extraMeta: { surface: 'widget' },
    });

    const visitorToken = signVisitorSession(auth.orgId, persisted.conversationId, contactHint);

    return withWidgetCors(
      request,
      NextResponse.json({
        sessionId: persisted.conversationId,
        conversationId: persisted.conversationId,
        visitorToken,
        allowlist,
      }),
      auth.allowedOrigins
    );
  } catch (err: unknown) {
    console.error('POST /api/widget/session Error:', err);
    return withWidgetCors(
      request,
      NextResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
      auth.allowedOrigins
    );
  }
}
