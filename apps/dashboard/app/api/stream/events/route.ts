import { getScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sseEventName(type: string): string {
  switch (type) {
    case 'needs_attention':
      return 'needs_attention';
    case 'conversation_updated':
      return 'conversation_updated';
    case 'message_received':
      return 'message_received';
    case 'plan_updated':
      return 'plan_updated';
    case 'memory.updated':
      return 'memory.updated';
    case 'connector.health':
      return 'connector.health';
    case 'work_item.updated':
      return 'work_item.updated';
    default:
      return 'event';
  }
}

/**
 * GET /api/stream/events
 * Server-Sent Events stream for per-org real-time inbox notifications.
 * Authenticates via the darex_session cookie, resolves the org_id, then pushes
 * `needs_attention` / `conversation_updated` / `message_received` events as
 * Redis publishes them on `org:{id}` (every dashboard replica).
 *
 * Org is never taken from the query string or body — only the session.
 */
export async function GET(request: Request) {
  let orgId: string;
  try {
    const { client, orgId: resolvedOrgId } = await getScopedClient();
    orgId = resolvedOrgId;
    client.release();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Unauthorized') {
      return new Response('Unauthorized', { status: 401 });
    }
    console.error('[SSE] Auth error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }

  try {
    await realtimeHub.ensureReady();
  } catch (err: unknown) {
    console.error('[SSE] Redis event bus unavailable:', err);
    return new Response('Realtime bus unavailable', { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // client disconnected
        }
      };

      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = await realtimeHub.subscribe(orgId, (payload) => {
          send(sseEventName(payload.type), payload);
        });
      } catch (err: unknown) {
        console.error('[SSE] Redis subscribe failed:', err);
        send('error', { error: 'Realtime bus unavailable' });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      send('connected', { orgId, message: 'Realtime stream connected' });

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15000);

      const shutdown = () => {
        clearInterval(keepAlive);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', shutdown);
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
