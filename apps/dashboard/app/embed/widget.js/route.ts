import { NextResponse } from 'next/server';
import { widgetEmbedSrc } from '@/lib/widget-embed-src';
import { publicAppUrl } from '@/lib/widget-embed';

/**
 * GET /embed/widget.js
 * Public chat widget (H6). No secrets — site key is supplied by the host page.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const apiBase = publicAppUrl(new URL(request.url).origin);
  return new NextResponse(widgetEmbedSrc(apiBase), {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
