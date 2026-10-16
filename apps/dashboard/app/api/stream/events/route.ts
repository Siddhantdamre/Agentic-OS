import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { acquireStreamSlot, realtimeHub, sseEventName, type EventPayload } from '@/lib/realtime-hub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_INTERVAL_MS = 10_000;
const POLL_LOOKBACK_MS = 30_000;

function parseSinceTs(request: Request): number | undefined {
  const lastEventId = request.headers.get('last-event-id') || request.headers.get('Last-Event-ID');
  if (lastEventId) {
    const n = Number(lastEventId);
    if (Number.isFinite(n) && n > 0) return n;
    // eventId format: `${ts}-${rand}`
    const head = lastEventId.split('-')[0];
    const fromId = Number(head);
    if (Number.isFinite(fromId) && fromId > 0) return fromId;
  }
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  if (since) {
    const n = Number(since);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * GET /api/stream/events
 * Server-Sent Events stream for per-org real-time inbox notifications.
 * Authenticates via the darex_session cookie, resolves the org_id, then pushes
 * events as Redis publishes them on `org:{id}`.
 *
 * Org is never taken from the query string or body — only the session.
 * Applies ReadableStream backpressure (desiredSize) and Last-Event-ID ring replay.
 * When Redis is unavailable, degrades to 10s DB polling for plan/conversation updates.
 */
export async function GET(request: Request) {
  let orgId: string;
  let userId: string;
  try {
    const { client, orgId: resolvedOrgId, userId: resolvedUserId } = await getScopedClient();
    orgId = resolvedOrgId;
    userId = resolvedUserId;
    client.release();
  } catch (err: unknown) {
    const authErr = scopedAuthErrorResponse(err);
    if (authErr) return authErr;
    console.error('[SSE] Auth error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }

  let redisOk = true;
  try {
    await realtimeHub.ensureReady();
  } catch (err: unknown) {
    console.warn('[SSE] Redis unavailable, degrading to polling mode:', err instanceof Error ? err.message : String(err));
    redisOk = false;
  }

  const releaseSlot = acquireStreamSlot(orgId, userId);
  if (!releaseSlot) {
    return new Response('Too many open realtime streams', {
      status: 429,
      headers: { 'Retry-After': '30' },
    });
  }

  const sinceTs = parseSinceTs(request);
  const encoder = new TextEncoder();
  const pending: EventPayload[] = [];
  let draining = false;
  let closed = false;
  let flushPending: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let closeController: (() => void) | undefined;

  // One teardown for abort, cancel and subscribe failure. cancel() alone
  // used to leave the Redis handler and the stream slot behind.
  const shutdown = () => {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    if (pollInterval) clearInterval(pollInterval);
    unsubscribe?.();
    unsubscribe = undefined;
    pending.length = 0;
    releaseSlot();
    closeController?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      closeController = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener('abort', shutdown);
      if (request.signal.aborted) {
        shutdown();
        return;
      }
      const enqueueRaw = (chunk: string): boolean => {
        if (closed) return false;
        const size = controller.desiredSize;
        // desiredSize null = errored; <=0 = apply backpressure (queue, don't enqueue).
        if (size !== null && size <= 0) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          shutdown();
          return false;
        }
      };

      const formatEvent = (event: string, data: unknown, id?: string | number): string => {
        const idLine = id != null ? `id: ${id}\n` : '';
        return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      };

      flushPending = () => {
        if (draining || closed) return;
        draining = true;
        try {
          while (pending.length > 0) {
            const size = controller.desiredSize;
            if (size !== null && size <= 0) break;
            const payload = pending.shift();
            if (!payload) break;
            const id = payload.eventId;
            if (!enqueueRaw(formatEvent(sseEventName(payload.type), payload, id))) {
              pending.unshift(payload);
              break;
            }
          }
        } finally {
          draining = false;
        }
      };

      const send = (event: string, data: unknown, id?: string | number) => {
        if (closed) return;
        const size = controller.desiredSize;
        if (size !== null && size <= 0) {
          if (data && typeof data === 'object' && 'type' in (data as object)) {
            pending.push(data as EventPayload);
          }
          return;
        }
        enqueueRaw(formatEvent(event, data, id));
      };

      // Polling fallback: queries DB directly when Redis is unavailable.
      const startPolling = (currentOrgId: string) => {
        let lastPolledAt = Date.now() - POLL_LOOKBACK_MS;
        pollInterval = setInterval(async () => {
          if (closed) return;
          const pollTs = Date.now();
          try {
            const { client } = await getScopedClient();
            try {
              const since = new Date(lastPolledAt).toISOString();
              const [planRes, convRes, workRes] = await Promise.all([
                client.query(
                  `SELECT id, status, updated_at FROM agent_plans WHERE org_id = $1 AND updated_at > $2 ORDER BY updated_at ASC LIMIT 20`,
                  [currentOrgId, since]
                ),
                client.query(
                  `SELECT id, status, updated_at FROM conversations WHERE org_id = $1 AND updated_at > $2 ORDER BY updated_at ASC LIMIT 20`,
                  [currentOrgId, since]
                ),
                client.query(
                  `SELECT id, status, updated_at FROM work_items WHERE org_id = $1 AND updated_at > $2 ORDER BY updated_at ASC LIMIT 20`,
                  [currentOrgId, since]
                ),
              ]);
              for (const row of planRes.rows) {
                const ts = new Date(row.updated_at).getTime();
                send('plan_updated', { type: 'plan_updated', orgId: currentOrgId, message: String(row.id), ts }, ts);
              }
              for (const row of convRes.rows) {
                const ts = new Date(row.updated_at).getTime();
                send('conversation_updated', { type: 'conversation_updated', orgId: currentOrgId, conversationId: row.id, ts }, ts);
              }
              for (const row of workRes.rows) {
                const ts = new Date(row.updated_at).getTime();
                send('work_item_updated', { type: 'work_item_updated', orgId: currentOrgId, message: String(row.id), ts }, ts);
              }
            } finally {
              client.release();
            }
          } catch (err: unknown) {
            console.warn('[SSE] Poll error:', err instanceof Error ? err.message : String(err));
          }
          lastPolledAt = pollTs;
        }, POLL_INTERVAL_MS);
      };

      if (redisOk) {
        // Ids delivered live while subscribing, so the replay below skips them.
        let liveIds: Set<string> | null = new Set<string>();
        try {
          const unsub = await realtimeHub.subscribe(orgId, (payload) => {
            const size = controller.desiredSize;
            if (size !== null && size <= 0) {
              pending.push(payload);
              if (pending.length > 200) pending.splice(0, pending.length - 200);
              return;
            }
            liveIds?.add(payload.eventId);
            send(sseEventName(payload.type), payload, payload.eventId);
          });
          if (closed) {
            // Client left while we were subscribing.
            unsub();
            return;
          }
          unsubscribe = unsub;
        } catch (err: unknown) {
          console.warn('[SSE] Redis subscribe failed mid-stream, switching to polling:', err instanceof Error ? err.message : String(err));
          send('degraded', { message: 'Realtime switched to polling mode' });
          redisOk = false;
          startPolling(orgId);
        }

        if (redisOk && sinceTs != null) {
          for (const missed of await realtimeHub.replayEvents(orgId, sinceTs)) {
            if (liveIds?.has(missed.eventId)) continue;
            send(sseEventName(missed.type), missed, missed.eventId);
          }
        }
        liveIds = null;


        if (redisOk) {
          send('connected', { orgId, message: 'Realtime stream connected', sinceTs: sinceTs ?? null });
        }
      } else {
        send('connected', { orgId, mode: 'polling', message: 'Realtime stream connected (polling mode)', sinceTs: sinceTs ?? null });
        startPolling(orgId);
      }

      keepAlive = setInterval(() => {
        if (closed) {
          if (keepAlive) clearInterval(keepAlive);
          return;
        }
        flushPending?.();
        const size = controller.desiredSize;
        if (size !== null && size <= 0) return;
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          shutdown();
        }
      }, 15000);
    },
    pull() {
      flushPending?.();
    },
    cancel() {
      shutdown();
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
