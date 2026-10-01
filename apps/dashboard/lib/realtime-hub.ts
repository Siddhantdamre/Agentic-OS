import { createHash } from 'crypto';
import { isRealtimeEventType, type RealtimeEventType } from '@darex/shared-types';
import { eventBus, orgTopic, parseOrgTopic } from '@/lib/event-bus';
import { notifyNeedsAttentionPush } from '@/lib/web-push-notify';

/**
 * Real-time hub for inbox SSE (Phase 5 + WS-11 Redis bus).
 *
 * `publish` signature is unchanged so webhooks / conversations / inbound-agent
 * keep calling `realtimeHub.publish(orgId, event)` with the org resolved from
 * session or channel config — never from a request body `org_id`.
 *
 * Each dashboard process keeps a bounded in-memory ring of recent events so
 * reconnecting clients can call `recentEvents(orgId, sinceTs)` for gap fill
 * when Redis pub/sub missed messages during a brief disconnect.
 */

/**
 * SSE `event:` name for each bus type. Names equal the type so clients can
 * `addEventListener(type)`; the exhaustive switch forces a decision here
 * whenever a type is added to `REALTIME_EVENT_TYPES`.
 */
export function sseEventName(type: RealtimeEventType): RealtimeEventType {
  switch (type) {
    case 'needs_attention':
    case 'conversation_updated':
    case 'conversation_takeover_updated':
    case 'message_received':
    case 'message_status_updated':
    case 'inquiry_updated':
    case 'inquiry_deleted':
    case 'presence_updated':
    case 'rent_charge_paid':
    case 'work_item_updated':
    case 'plan_updated':
    case 'memory.updated':
    case 'listing_updated':
    case 'billing_updated':
    case 'integration_updated':
    case 'settings_updated':
      return type;
    default: {
      const _never: never = type;
      return _never;
    }
  }
}

const RING_MAX = 500;
/** Orgs whose ring is kept in this process; least recently touched go first. */
const RING_MAX_ORGS = 1000;
/** A ring nobody has published to or read from for this long is dropped. */
const RING_TTL_MS = 15 * 60 * 1000;

type EventPayload = {
  type: RealtimeEventType;
  orgId: string;
  conversationId?: string;
  message?: string;
  contactId?: string | null;
  channelType?: string;
  ts: number;
  eventId: string;
};

type Subscriber = (payload: EventPayload) => void;

type PublishInput = Omit<EventPayload, 'orgId' | 'ts' | 'eventId'>;

type Ring = { events: EventPayload[]; ids: Set<string>; touchedAt: number };

/** Map insertion order doubles as LRU order: touching an org re-inserts it. */
const recentByOrg = new Map<string, Ring>();

function evictRings(now: number): void {
  for (const [orgId, ring] of recentByOrg) {
    const stale = now - ring.touchedAt > RING_TTL_MS;
    if (!stale && recentByOrg.size <= RING_MAX_ORGS) break;
    recentByOrg.delete(orgId);
  }
}

function touchRing(orgId: string, now: number): Ring | undefined {
  const ring = recentByOrg.get(orgId);
  if (!ring) return undefined;
  if (now - ring.touchedAt > RING_TTL_MS) {
    recentByOrg.delete(orgId);
    return undefined;
  }
  ring.touchedAt = now;
  recentByOrg.delete(orgId);
  recentByOrg.set(orgId, ring);
  return ring;
}

/**
 * Add to the org's replay ring once per eventId. A local publish is echoed
 * back by Redis and every subscriber in this process sees it, so without
 * the id check one event would be replayed several times on reconnect.
 */
function pushRecent(orgId: string, payload: EventPayload): void {
  const now = Date.now();
  let ring = touchRing(orgId, now);
  if (!ring) {
    ring = { events: [], ids: new Set(), touchedAt: now };
    recentByOrg.set(orgId, ring);
  }
  if (ring.ids.has(payload.eventId)) return;
  ring.events.push(payload);
  ring.ids.add(payload.eventId);
  if (ring.events.length > RING_MAX) {
    for (const dropped of ring.events.splice(0, ring.events.length - RING_MAX)) {
      ring.ids.delete(dropped.eventId);
    }
  }
  evictRings(now);
}

/** Test hook: number of org rings held by this process. */
export function recentRingCount(): number {
  return recentByOrg.size;
}

function validatePublishInput(
  orgId: string,
  event: PublishInput
): EventPayload | null {
  if (typeof orgId !== 'string' || !orgId) return null;
  if (!event || typeof event !== 'object') return null;
  if (!isRealtimeEventType(event.type)) {
    console.error(`[realtime-hub] dropping unknown event type: ${String(event.type)}`);
    return null;
  }
  if (event.conversationId !== undefined && typeof event.conversationId !== 'string') return null;
  if (event.message !== undefined && typeof event.message !== 'string') return null;
  if (event.channelType !== undefined && typeof event.channelType !== 'string') return null;
  return {
    type: event.type,
    orgId,
    conversationId: event.conversationId,
    message: typeof event.message === 'string' ? event.message.slice(0, 2000) : undefined,
    contactId: event.contactId === undefined ? undefined : event.contactId,
    channelType: event.channelType,
    ts: Date.now(),
    eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

function parsePayload(channel: string, raw: string): EventPayload | null {
  const topicOrgId = parseOrgTopic(channel);
  if (!topicOrgId) {
    console.error(`[realtime-hub] ignoring non-org channel ${channel}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[realtime-hub] ignoring non-JSON Redis payload on', channel);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as Partial<EventPayload>;
  if (!isRealtimeEventType(body.type)) {
    console.error(`[realtime-hub] ignoring unknown event type on ${channel}: ${String(body.type)}`);
    return null;
  }
  if (typeof body.orgId === 'string' && body.orgId !== topicOrgId) {
    console.error(
      `[realtime-hub] dropping payload: orgId ${body.orgId} does not match topic ${channel}`
    );
    return null;
  }
  const ts = typeof body.ts === 'number' && Number.isFinite(body.ts) ? body.ts : Date.now();
  const latencyMs = Date.now() - ts;
  if (latencyMs > 5000) {
    console.warn(
      `[realtime-hub] high delivery latency ${latencyMs}ms type=${body.type} org=${topicOrgId}`
    );
  }
  return {
    type: body.type,
    orgId: topicOrgId,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    contactId: body.contactId === undefined ? undefined : body.contactId,
    channelType: typeof body.channelType === 'string' ? body.channelType : undefined,
    ts,
    // Producers outside this hub (workflows memory write-back) may omit the
    // id; derive a stable one from the raw payload so every subscriber in
    // this process agrees and the ring dedupes it.
    eventId:
      typeof body.eventId === 'string' && body.eventId
        ? body.eventId
        : `${ts}-${createHash('sha1').update(raw).digest('hex').slice(0, 12)}`,
  };
}

function envCap(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const openStreams = new Map<string, number>();

/**
 * Per-process cap on open SSE streams, per user and per org. Returns a
 * release function, or null when the caller is over either cap. Counts are
 * per replica; they bound one process, not the fleet.
 */
export function acquireStreamSlot(orgId: string, userId: string): (() => void) | null {
  const userKey = `u:${orgId}:${userId}`;
  const orgKey = `o:${orgId}`;
  const userCount = openStreams.get(userKey) ?? 0;
  const orgCount = openStreams.get(orgKey) ?? 0;
  if (userCount >= envCap('REALTIME_SSE_MAX_PER_USER', 6)) return null;
  if (orgCount >= envCap('REALTIME_SSE_MAX_PER_ORG', 200)) return null;
  openStreams.set(userKey, userCount + 1);
  openStreams.set(orgKey, orgCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of [userKey, orgKey]) {
      const next = (openStreams.get(key) ?? 1) - 1;
      if (next <= 0) openStreams.delete(key);
      else openStreams.set(key, next);
    }
  };
}

const REDIS_RING_KEY = (orgId: string) => `org:${orgId}:events`;
const REDIS_RING_CAP = 100;
const REDIS_RING_TTL = 3600;

class RealtimeHub {
  async ensureReady(): Promise<void> {
    await eventBus.ensureReady();
  }

  /** Recent events for this process (gap fill after reconnect). */
  recentEvents(orgId: string, sinceTs?: number): EventPayload[] {
    const list = touchRing(orgId, Date.now())?.events ?? [];
    if (sinceTs == null) return list.slice();
    return list.filter((e) => e.ts > sinceTs);
  }

  /** Gap fill from the Redis sorted set (cross-replica); falls back to this process's ring. */
  async replayEvents(orgId: string, sinceTs?: number): Promise<EventPayload[]> {
    try {
      const key = REDIS_RING_KEY(orgId);
      const min = sinceTs != null ? String(sinceTs + 1) : '-inf';
      const raw = await eventBus.command(['ZRANGEBYSCORE', key, min, '+inf']);
      if (Array.isArray(raw)) {
        const events: EventPayload[] = [];
        for (const item of raw) {
          if (typeof item !== 'string') continue;
          try {
            events.push(JSON.parse(item) as EventPayload);
          } catch {
            /* skip malformed */
          }
        }
        return events;
      }
    } catch (err) {
      console.error('[realtime-hub] Redis recentEvents fallback to in-memory:', err);
    }
    return this.recentEvents(orgId, sinceTs);
  }

  subscribe(orgId: string, cb: Subscriber): Promise<() => void> {
    const channel = orgTopic(orgId);
    return eventBus.subscribe(channel, (incomingChannel, raw) => {
      const payload = parsePayload(incomingChannel, raw);
      if (!payload) return;
      if (payload.orgId !== orgId) return;
      pushRecent(orgId, payload);
      cb(payload);
    });
  }

  publish(orgId: string, event: PublishInput): void {
    const payload = validatePublishInput(orgId, event);
    if (!payload) return;
    pushRecent(orgId, payload);
    const channel = orgTopic(orgId);
    const serialised = JSON.stringify(payload);
    void eventBus.publish(channel, serialised).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[realtime-hub] Redis publish failed for ${channel}:`, message);
    });
    // Persist to cross-replica replay ring (fire-and-forget)
    const key = REDIS_RING_KEY(orgId);
    void eventBus
      .command(['ZADD', key, String(payload.ts), serialised])
      .then(() => eventBus.command(['ZREMRANGEBYRANK', key, '0', String(-(REDIS_RING_CAP + 1))]))
      .then(() => eventBus.command(['EXPIRE', key, String(REDIS_RING_TTL)]))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[realtime-hub] Redis ring write failed for ${key}:`, message);
      });
    if (payload.type === 'needs_attention') {
      void notifyNeedsAttentionPush(orgId, {
        conversationId: payload.conversationId,
        message: payload.message,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[realtime-hub] web push notify failed:', message);
      });
    }
  }
}

export const realtimeHub = new RealtimeHub();

export type { EventPayload };
