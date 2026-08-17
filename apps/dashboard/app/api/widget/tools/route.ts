import { NextResponse } from 'next/server';
import {
  ignoreBodyOrgId,
  isDeniedAdminTool,
  normalizeWidgetTool,
  orgHasInstalledPack,
  requireWidgetOrg,
  widgetForbidden,
  widgetPreflight,
  withWidgetCors,
  WIDGET_ALLOWLIST,
} from '../_lib';

/**
 * POST /api/widget/tools
 * Stolen embed token cannot call database_query, Drive, or any admin tool.
 */
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: Request) {
  return widgetPreflight(request);
}

export async function POST(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  ignoreBodyOrgId(body);

  const tool = typeof body.tool === 'string' ? body.tool : typeof body.name === 'string' ? body.name : '';
  const pack = await orgHasInstalledPack(auth.orgId);
  if (!pack) {
    return withWidgetCors(
      request,
      widgetForbidden('Widget is deny-all until a pack is installed.'),
      auth.allowedOrigins
    );
  }
  if (isDeniedAdminTool(tool) || normalizeWidgetTool(tool) === 'denied') {
    return withWidgetCors(
      request,
      widgetForbidden(
        `Widget token cannot call ${tool || 'this tool'}. Allowlist: ${WIDGET_ALLOWLIST.join(', ')}.`
      ),
      auth.allowedOrigins
    );
  }

  const kind = normalizeWidgetTool(tool);
  switch (kind) {
    case 'listings.search':
      return withWidgetCors(
        request,
        NextResponse.json({
          ok: true,
          tool: 'listings.search',
          hint: 'Use GET /api/widget/listings/search?q=',
        }),
        auth.allowedOrigins
      );
    case 'denied':
      return withWidgetCors(
        request,
        widgetForbidden(`Widget token cannot call ${tool || 'this tool'}.`),
        auth.allowedOrigins
      );
    default: {
      const _never: never = kind;
      return withWidgetCors(request, widgetForbidden(String(_never)), auth.allowedOrigins);
    }
  }
}

export async function GET(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;
  return withWidgetCors(
    request,
    NextResponse.json({
      allowlist: WIDGET_ALLOWLIST,
      denied: ['database_query', 'google-drive', 'drive'],
    }),
    auth.allowedOrigins
  );
}
