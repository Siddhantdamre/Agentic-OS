# Realtime / SSE Stream Audit

## Live Resolution Tracker
| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|---|---|---|---|---|
| 1 | Hard 503 / no polling fallback | P0 | `conversations/page.tsx` | 🟢 | On EventSource error: 5s list/thread polling fallback + exponential reconnect with jitter (max 30s). SSE route still may 503; inbox stays fresh via poll. |
| 2 | No durable replay / Last-Event-ID | P1 | `realtime-hub.ts` | 🟢 | Per-org in-memory ring (500) + `recentEvents(orgId, sinceTs)` for process-local gap fill; pub/sub still primary. |
| 3 | Missing reconnect backoff/jitter | P1 | inbox page EventSource | 🟢 | `1.5^n` backoff + random 0–2s jitter on `onerror`. |
| 4 | Unvalidated publish payloads | P1 | `realtime-hub.ts` | 🟢 | Allowlisted types, string field checks, message length cap before Redis PUBLISH. |
| 5 | Bus latency visibility | P2 | `realtime-hub.ts` | 🟢 | Warns when `Date.now()-ts > 5s` on subscribe delivery. |
| 6 | Tenant topic flooding | P2 | inbox page | 🟢 | Message refetch scoped to open conversation id; list refresh debounced. |
| 7 | RESP TCP fragmentation | P1 | `event-bus.ts` | 🟢 | Accumulating buffer + `consumeRespFrames`; incomplete frames wait for next chunk; NaN length guard; heartbeat PING; unit test chunk-split frames. |
| 8 | SSE backpressure / presence / web push | P2 | stream route + infra | 🟢 | `desiredSize` queue + Last-Event-ID ring replay; `POST /api/stream/presence` real DB heartbeats (103); push-subscribe + VAPID-gated delivery (no fake pushes). |
| 9 | Event type drift between hub, route and clients (CH-B02) | P1 | `shared-types/realtime.ts`, `realtime-hub.ts`, stream route, `use-realtime-stream.ts` | 🟢 | One `RealtimeEventType` union; hub allowlist + exhaustive SSE mapping; shared `useRealtimeStream` hook with typed event lists used by inbox and Customer page. |
| 10 | Ring duplicates on reconnect; unbounded per-org rings (CH-B07, CH-B08) | P1 | `realtime-hub.ts` | 🟢 | Ring dedupes by `eventId`; LRU cap 1000 orgs + 15 min idle TTL. Jest `realtime-hub.test.ts`. |
| 11 | cancel() leaked Redis subscription; no SSE connection cap (CH-B09, CH-E03) | P1 | `stream/events/route.ts`, `realtime-hub.ts` | 🟢 | Shared `shutdown()` from abort/cancel/errors; per-process cap 6/user, 200/org with 429. Cap is per replica. |
| 12 | SSE hard 503 when Redis is down (summary P0 #13); tabs outside inbox not live | P0 | `stream/events/route.ts`, `use-realtime-stream.ts`, work-items + plans pages | 🟢 | Route keeps a 200 event stream in `polling` mode (10s DB poll of conversations, agent_plans, work_items) when Redis is unreachable or subscribe fails; client hook reconnects with 1.5^n backoff + jitter and exposes `fallback`. New `work_item_updated` / `plan_updated` bus types published from work-items and plan mutation routes. Jest `app/api/stream/events/__tests__/route.test.ts`. |

## Status: working (hub validation, ring buffer, inbox polling fallback + jitter, RESP framing, SSE backpressure/presence/push)


The real-time streaming pipeline utilizes a custom, zero-dependency RESP2 Redis pub/sub client (`apps/dashboard/lib/event-bus.ts`), a centralized organizational event hub (`apps/dashboard/lib/realtime-hub.ts`), and an authenticated Server-Sent Events (SSE) route (`apps/dashboard/app/api/stream/events/route.ts`). It avoids pooled connection deadlocks by immediately releasing the DB client upon session verification.

However, **the system relies on ephemeral, fire-and-forget pub/sub with zero message replay**, hard-503s on Redis downtime with no frontend polling fallback, lacks client-side reconnect backoff jitter, and floods tenant tabs via single-topic broadcast without room/conversation scoping.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Zero-Dependency Native RESP2 Redis Client**:
   - `apps/dashboard/lib/event-bus.ts:1-480`:
     - Raw TCP/TLS socket implementation (`net`/`tls`) without `ioredis` or `node-redis` npm dependencies.
     - Implements RESP2 parser (`event-bus.ts:88-141`), automatic AUTH / PING handshakes (lines 260-270), and pipelined command queues.
     - Automatic reconnection with exponential backoff capped at 5s (`event-bus.ts:346-359`), triggering `resubscribeAll()` (lines 457-463) on socket re-establishment.
     - Dedicated instance guard (`event-bus.ts:57-61`): Throws an explicit error if `REDIS_URL` points to `langfuse-redis`, enforcing architectural separation between observability and real-time messaging.
2. **Tenant Topic Isolation & Payload Cross-Check**:
   - `apps/dashboard/lib/realtime-hub.ts:27-58`:
     - Enforces strict channel naming format: `org:{orgId}`.
     - `parsePayload()` validates that `payload.orgId === topicOrgId`. If a cross-tenant payload arrives or JSON parsing fails, the message is immediately dropped and logged (`realtime-hub.ts:43-48`), preventing cross-tenant data leakage.
3. **Widespread Mutation Hooking**:
   - `realtimeHub.publish()` is executed across all core state transition paths:
     - WhatsApp inbound: `apps/dashboard/app/api/webhooks/whatsapp/route.ts:283`
     - Chatwoot inbound: `apps/dashboard/app/api/webhooks/chatwoot/route.ts:405`
     - Conversation status updates: `apps/dashboard/app/api/conversations/[id]/route.ts:58`
     - Outbound messages: `apps/dashboard/app/api/conversations/[id]/messages/route.ts:150, 158`
     - Temporal in-process runner: `apps/dashboard/lib/inbound-agent.ts:262, 269, 431`
4. **Safe SSE Connection Lifecycle**:
   - `apps/dashboard/app/api/stream/events/route.ts:37-120`:
     - Authenticates securely via `darex_session` cookie; strictly ignores any `org_id` passed via URL query parameters (`route.ts:35-42`).
     - **Releases database client immediately** (`client.release()`, line 42) before initializing the `ReadableStream`, completely preventing pool deadlock during long-lived HTTP streams.
     - Emits 15-second `: keep-alive\n\n` comments (lines 90-96) to defeat Cloudflare/ALB idle proxy timeouts.
     - Binds to `request.signal.addEventListener('abort', ...)` (lines 98-108) to cleanly clearInterval, unsubscribe from Redis, and close the stream on client disconnect.
5. **Client Resource Management**:
   - `apps/dashboard/app/(dashboard)/conversations/page.tsx:102-164`:
     - Listens to discrete SSE event types (`needs_attention`, `conversation_updated`, `message_received`).
     - Actively closes the `EventSource` on `document.hidden` and reconnects on visibility change (lines 148-163), saving server memory when dashboard tabs are inactive.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Hard Outage on Redis Downtime (Zero Fallback) (`apps/dashboard/app/api/stream/events/route.ts:52-57`) (P0)**:
   - *User Impact*: Total communication blindness during Redis maintenance or reboot. The inbox freezes completely and does not show incoming customer messages.
   - *Code Cause*: When Redis is unreachable, `/api/stream/events` returns `HTTP 503 Realtime bus unavailable`. The frontend lacks a fallback polling mechanism, leaving human operators unaware of new messages.
2. **Fire-and-Forget Message Loss (No Replay / Stream Gap) (`apps/dashboard/lib/realtime-hub.ts:27-58`) (P1)**:
   - *User Impact*: Dropped notifications and missed customer replies when a user's laptop transitions between Wi-Fi networks or wakes from sleep.
   - *Code Cause*: Standard Redis pub/sub does not store messages. If a connection drops for 5 seconds, all events published during that window are permanently lost with no `Last-Event-ID` offset recovery.
3. **Missing Browser Reconnect Backoff & Jitter (P1)**:
   - *User Impact*: Thundering herd server crashes. When the web app container restarts, dozens of connected browsers hit `/api/stream/events` at the exact same millisecond.
   - *Code Cause*: Native `EventSource` reconnect lacks randomized jitter and exponential backoff.
4. **TCP Chunk Fragmentation in Custom RESP Parser (`apps/dashboard/lib/event-bus.ts:88-141`) (P1)**:
   - *User Impact*: Corrupted or dropped events under high event throughput or large payloads.
   - *Code Cause*: `parseResp()` assumes that every complete RESP payload arrives in a single `socket.on('data')` chunk. When large event payloads (e.g. `plan_updated` with 10 steps) are fragmented across multiple TCP packets, parsing breaks and drops the event.
5. **Single-Topic Tenant Flooding**:
   - *User Impact*: High client CPU usage and wasted bandwidth.
   - *Code Cause*: Every event is broadcast to the root `org:{id}` channel. A user viewing a single conversation receives message events for all 50 other conversations happening across the workspace.
6. **No Socket Heartbeat Verification from Redis Client**:
   - *User Impact*: Silent half-open TCP connections.
   - *Code Cause*: The custom client only sends PING during initial handshake, leaving stale connections open if an intermediate proxy drops the socket without sending a TCP FIN.
7. **Backpressure Buffer Overflow in Stream Controller**:
   - *User Impact*: Memory leaks on slow client connections.
   - *Code Cause*: `controller.enqueue()` is called without monitoring `controller.desiredSize`.
8. **Zombie Subscription Leaks on Dropped Connections**:
   - *User Impact*: Accumulating Redis memory usage.
   - *Code Cause*: In certain reverse proxy setups, if client disconnect signals are missed, Redis subscriptions remain active until server restart.
9. **Lack of User Presence & Collision Indicators**:
   - *User Impact*: Two operators open the same conversation and type conflicting answers to a customer.
   - *Code Cause*: No presence broadcasting (`agent_typing`, `agent_viewing`) exists.
10. **Absence of Real-Time Bus Latency Metrics**:
    - *User Impact*: Operators cannot tell if real-time delivery is delayed.
    - *Code Cause*: No metrics track the time delta between event publication in Redis and SSE delivery to the browser.
11. **No System Web Push Notifications**:
    - *User Impact*: Missed urgent customer escalations when dashboard is minimized.
    - *Code Cause*: No Web Push API integration for background desktop notifications.
12. **Unvalidated JSON Payloads on Ingestion**:
    - *User Impact*: Client-side crashes when a malformed event is broadcast.
    - *Code Cause*: Event publishing lacks Zod schema validation before calling Redis `PUBLISH`.

---

## What's missing vs full vision

1. **Redis Streams Durable Message Backbone (`XADD` / `XREADGROUP`)**:
   - Storing events in Redis Streams with 24-hour retention (~10,000 events per org).
   - Supporting `Last-Event-ID` headers to seamlessly replay missed events when clients reconnect.
2. **Client-Side Polling Fallback Engine**:
   - Transparently switching from SSE to 5-second HTTP polling whenever the SSE connection fails, ensuring zero communication blackout.
3. **Granular Conversation-Scoped Sub-Topics**:
   - Supporting topic channels: `org:{id}:conv:{id}`, `org:{id}:tasks`, `org:{id}:alerts`.
   - Browsers only subscribe to the conversation currently open on screen.
4. **Active Operator Presence & Collision Warning**:
   - Showing *"Marcus is viewing this conversation"* or *"Sarah (AI) is drafting a reply"* in real time.
5. **Accumulating Frame State Machine in RESP Parser**:
   - Robust TCP buffer accumulation handling fragmented frames of any size.
6. **Web Push Notification Integration**:
   - Delivering native browser push notifications for `needs_attention` events when the tab is inactive.
7. **Real-Time Stream Latency Instrumentation**:
   - Stamping `publish_ts` in event headers and logging latency distributions to Langfuse/Prometheus.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Realtime Presence & Stream Storage (`049_realtime_presence_and_streams.sql`)
```sql
-- 1. Table for tracking active operator presence in conversations
CREATE TABLE IF NOT EXISTS conversation_presence (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  is_typing BOOLEAN NOT NULL DEFAULT false,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_presence_heartbeat
  ON conversation_presence (org_id, conversation_id, last_heartbeat_at DESC);

ALTER TABLE conversation_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_presence FORCE ROW LEVEL SECURITY;

CREATE POLICY conv_presence_isolation ON conversation_presence
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

### 2. Durable Redis Stream Publisher & Replay (`apps/dashboard/lib/realtime-hub.ts`)
```typescript
import { getRedisClient } from '@/lib/redis';

export async function publishDurableEvent(orgId: string, eventType: string, payload: Record<string, any>) {
  const redis = getRedisClient();
  const streamKey = `stream:org:${orgId}`;
  const serialized = JSON.stringify({
    type: eventType,
    orgId,
    timestamp: Date.now(),
    payload
  });

  if (redis) {
    try {
      // 1. Add to durable stream with 10k entry cap (~24-48h retention)
      await redis.xadd(streamKey, 'MAXLEN', '~', 10000, '*', 'event', serialized);
      // 2. Also publish to pub/sub for instant delivery to live listeners
      await redis.publish(`org:${orgId}`, serialized);
    } catch (err) {
      console.error('[RealtimeHub] Failed to publish durable event:', err);
    }
  }
}
```

### 3. SSE Route with `Last-Event-ID` Replay & Backpressure Guard (`apps/dashboard/app/api/stream/events/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { getRedisClient } from '@/lib/redis';

export async function GET(req: NextRequest) {
  const { client, orgId } = await getScopedClient();
  client.release(); // Crucial: release immediately before opening long-lived SSE stream

  const redis = getRedisClient();
  if (!redis) {
    return new Response('Realtime service unavailable', { status: 503 });
  }

  const lastEventId = req.headers.get('last-event-id');
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // 1. Replay missed messages from Redis Stream if Last-Event-ID provided
      if (lastEventId) {
        try {
          const streamKey = `stream:org:${orgId}`;
          const missed = await redis.xread('STREAMS', streamKey, lastEventId);
          if (missed && missed[0] && missed[0][1]) {
            for (const [id, fields] of missed[0][1]) {
              const eventData = fields[1];
              controller.enqueue(encoder.encode(`id: ${id}\ndata: ${eventData}\n\n`));
            }
          }
        } catch (err) {
          console.warn('[SSE] Failed to replay missed stream events:', err);
        }
      }

      // 2. Subscribe to live pub/sub
      const subscriber = redis.duplicate();
      await subscriber.connect();

      await subscriber.subscribe(`org:${orgId}`, (message: string) => {
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          console.warn('[SSE] Client buffer full. Dropping non-critical chunk.');
          return;
        }
        controller.enqueue(encoder.encode(`data: ${message}\n\n`));
      });

      // 3. Keep-alive heartbeat every 15s to keep proxy connections alive
      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 15000);

      req.signal.addEventListener('abort', async () => {
        clearInterval(keepAlive);
        await subscriber.unsubscribe(`org:${orgId}`);
        await subscriber.quit();
        controller.close();
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
}
```

### 4. Resilient Frontend Realtime Hook with Polling Fallback (`apps/dashboard/lib/hooks/useRealtimeStream.ts`)
```typescript
'use client';

import { useState, useEffect, useRef } from 'react';

export function useRealtimeStream(onEvent: (event: any) => void) {
  const [isFallback, setIsFallback] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let reconnectAttempts = 0;

    function connect() {
      const es = new EventSource('/api/stream/events');
      eventSourceRef.current = es;

      es.onopen = () => {
        reconnectAttempts = 0;
        setIsFallback(false);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      };

      es.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          onEvent(parsed);
        } catch {}
      };

      es.onerror = () => {
        es.close();
        setIsFallback(true);

        // Immediately start 5s fallback polling if not already running
        if (!pollIntervalRef.current) {
          pollIntervalRef.current = setInterval(() => {
            onEvent({ type: 'poll_sync' });
          }, 5000);
        }

        // Exponential backoff with jitter (max 30s)
        reconnectAttempts++;
        const backoffMs = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 30000);
        const jitter = Math.random() * 2000;

        reconnectTimeoutRef.current = setTimeout(connect, backoffMs + jitter);
      };
    }

    connect();

    return () => {
      eventSourceRef.current?.close();
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, []);

  return { isFallback };
}
```

### 5. Accumulating TCP Buffer State Machine (`apps/dashboard/lib/event-bus.ts`)
```typescript
class RespBufferAccumulator {
  private buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  tryExtractFrame(): string | null {
    const crlfIndex = this.buffer.indexOf('\r\n');
    if (crlfIndex === -1) return null; // Incomplete line

    const prefix = this.buffer[0];
    if (prefix === 36) { // Bulk string '$'
      const lengthStr = this.buffer.subarray(1, crlfIndex).toString('ascii');
      const length = parseInt(lengthStr, 10);
      if (length === -1) {
        this.buffer = this.buffer.subarray(crlfIndex + 2);
        return null; // Null bulk string
      }
      const totalRequired = crlfIndex + 2 + length + 2;
      if (this.buffer.length < totalRequired) return null; // Wait for full frame

      const data = this.buffer.subarray(crlfIndex + 2, crlfIndex + 2 + length).toString('utf-8');
      this.buffer = this.buffer.subarray(totalRequired);
      return data;
    }

    // Simple string or integer
    const line = this.buffer.subarray(1, crlfIndex).toString('utf-8');
    this.buffer = this.buffer.subarray(crlfIndex + 2);
    return line;
  }
}
```

### 6. Operator Presence & Collision Indicator Route (`apps/dashboard/app/api/stream/presence/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { redisClient } from '@/lib/redis';

export async function POST(req: NextRequest) {
  const { orgId, userId } = await getScopedClient();
  const body = await req.json();
  const { conversationId, action } = body; // action: 'viewing' | 'typing' | 'left'

  const presenceKey = `presence:${orgId}:${conversationId}`;
  
  if (action === 'left') {
    await redisClient.hdel(presenceKey, userId);
  } else {
    // Record user presence with 15s TTL
    await redisClient.hset(presenceKey, userId, JSON.stringify({
      userId,
      action,
      updatedAt: Date.now()
    }));
    await redisClient.expire(presenceKey, 30);
  }

  // Publish presence event to conversation channel
  await redisClient.publish(`org:${orgId}:conv:${conversationId}`, JSON.stringify({
    type: 'presence_updated',
    conversationId,
    userId,
    action,
  }));

  return NextResponse.json({ ok: true });
}
```

### 7. Database Migration: `049_realtime_presence_and_streams.sql`
```sql
-- Migration: 049_realtime_presence_and_streams.sql
-- Enables durable event streaming, operator presence, and push subscriptions

CREATE TABLE IF NOT EXISTS user_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_endpoint UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON user_push_subscriptions(org_id, user_id);
```

---

## Fix priority

- **P0**: Implement frontend fallback polling in `useRealtimeStream` so staff never suffer complete communication loss during Redis restarts.
- **P1**: Fix TCP chunk fragmentation in custom RESP parser by maintaining an accumulating socket buffer.
- **P1**: Add client-side exponential backoff and randomized jitter to prevent thundering herd crashes on server reboot.
- **P2**: Deploy Redis Streams (`XADD`) with `Last-Event-ID` replay for zero-message-loss guarantees.
- **P2**: Implement operator presence and collision tracking (`049_realtime_presence_and_streams.sql`).
