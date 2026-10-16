import { getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { extractVisitorToken, verifyVisitorSession } from '@/lib/widget-token';
import {
  orgHasInstalledPack,
  requireWidgetOrg,
  widgetForbidden,
  widgetPreflight,
  withWidgetCors,
} from '../_lib';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function OPTIONS(request: Request) {
  return widgetPreflight(request);
}

/**
 * GET /api/widget/stream
 * Public-safe SSE for a widget session. Requires site key + signed visitor token.
 * Never awaits an agent turn here — only forwards persisted message events.
 */
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
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return withWidgetCors(
      request,
      new Response(JSON.stringify({ error: 'sessionId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
      auth.allowedOrigins
    );
  }

  const visitorToken = extractVisitorToken(request);
  if (!verifyVisitorSession(visitorToken, auth.orgId, sessionId)) {
    return withWidgetCors(
      request,
      new Response(JSON.stringify({ error: 'Forbidden: invalid visitor session signature' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
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
        new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
        auth.allowedOrigins
      );
    }
  } finally {
    client.release();
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('connected', { status: 'streaming', sessionId });

      await realtimeHub.ensureReady();
      unsubscribe = await realtimeHub.subscribe(auth.orgId, (payload) => {
        if (payload.conversationId && payload.conversationId !== sessionId) return;
        send('message', payload);
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 15000);

      request.signal.addEventListener('abort', () => {
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    },
  });

  const headers = new Headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // apply CORS onto SSE response
  const origin = request.headers.get('origin');
  if (origin && (auth.allowedOrigins.includes('*') || auth.allowedOrigins.includes(origin))) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }

  return new Response(stream, { headers });
}
