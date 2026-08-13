import { NextResponse } from 'next/server';
import {
  isDeniedAdminTool,
  normalizeWidgetTool,
  orgHasInstalledPack,
  requireWidgetOrg,
  widgetForbidden,
  WIDGET_ALLOWLIST,
} from '../_lib';

/**
 * POST /api/widget/tools
 * Stolen embed token cannot call database_query, Drive, or any admin tool.
 */
export async function POST(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  void body.org_id;
  void body.orgId;

  const tool = typeof body.tool === 'string' ? body.tool : typeof body.name === 'string' ? body.name : '';
  const pack = await orgHasInstalledPack(auth.orgId);
  if (!pack) {
    return widgetForbidden('Widget is deny-all until a pack is installed.');
  }
  if (isDeniedAdminTool(tool) || normalizeWidgetTool(tool) === 'denied') {
    return widgetForbidden(
      `Widget token cannot call ${tool || 'this tool'}. Allowlist: ${WIDGET_ALLOWLIST.join(', ')}.`
    );
  }

  const kind = normalizeWidgetTool(tool);
  switch (kind) {
    case 'listings.search':
      return NextResponse.json({
        ok: true,
        tool: 'listings.search',
        hint: 'Use GET /api/widget/listings/search?q=',
      });
    case 'denied':
      return widgetForbidden(`Widget token cannot call ${tool || 'this tool'}.`);
    default: {
      const _never: never = kind;
      return widgetForbidden(String(_never));
    }
  }
}

export async function GET() {
  return NextResponse.json({
    allowlist: WIDGET_ALLOWLIST,
    denied: ['database_query', 'google-drive', 'drive'],
  });
}
