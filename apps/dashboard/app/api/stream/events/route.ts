import { getScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';

export const dynamic = 'force-dynamic';

function sseEventName(type: string): string {
  switch (type) {
    case 'needs_attention':
      return 'needs_attention';
    case 'conversation_updated':
      return 'conversation_updated';
    case 'message_received':
      return 'message_received';
    default:
      return 'event';
  }
}

/**
 * GET /api/stream/events
 * Server-Sent Events stream for per-org real-time inbox notifications.
 * Authenticates via the darex_session cookie, resolves the org_id, then pushes
 * `needs_attention` / `conversation_updated` / `message_received` events to the
 * connected client as they are published by webhooks and API routes.
 */
export async function GET(request: Request) {
  let orgId: string;
  try {
    const { client, orgId: resolvedOrgId } = await getScopedClient();
    orgId = resolvedOrgId;
    client.release();
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return new Response('Unauthorized', { status: 401 });
    }
    console.error('[SSE] Auth error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // client disconnected
        }
      };

      send('connected', { orgId, message: 'Realtime stream connected' });

      const unsubscribe = realtimeHub.subscribe(orgId, (payload) => {
        send(sseEventName(payload.type), payload);
      });

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15000);

      request.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        unsubscribe();
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
