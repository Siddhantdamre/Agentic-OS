import { eventBus, orgTopic, parseOrgTopic } from '@/lib/event-bus';

/**
 * Real-time hub for inbox SSE (Phase 5 + WS-11 Redis bus).
 *
 * `publish` signature is unchanged so webhooks / conversations / inbound-agent
 * keep calling `realtimeHub.publish(orgId, event)` with the org resolved from
 * session or channel config — never from a request body `org_id`.
 *
 * Each dashboard process subscribes to Redis `org:{id}`. Two replicas both
 * toast because Redis fans the PUBLISH out. Local callbacks fan out to SSE
 * clients on this process only.
 */

type EventPayload = {
  type: string;
  orgId: string;
  conversationId?: string;
  message?: string;
  contactId?: string | null;
  channelType?: string;
  ts: number;
};

type Subscriber = (payload: EventPayload) => void;

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
  if (typeof body.type !== 'string' || !body.type) return null;
  if (typeof body.orgId === 'string' && body.orgId !== topicOrgId) {
    console.error(
      `[realtime-hub] dropping payload: orgId ${body.orgId} does not match topic ${channel}`
    );
    return null;
  }
  return {
    type: body.type,
    orgId: topicOrgId,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    contactId: body.contactId === undefined ? undefined : body.contactId,
    channelType: typeof body.channelType === 'string' ? body.channelType : undefined,
    ts: typeof body.ts === 'number' ? body.ts : Date.now(),
  };
}

class RealtimeHub {
  async ensureReady(): Promise<void> {
    await eventBus.ensureReady();
  }

  subscribe(orgId: string, cb: Subscriber): Promise<() => void> {
    const channel = orgTopic(orgId);
    return eventBus.subscribe(channel, (incomingChannel, raw) => {
      const payload = parsePayload(incomingChannel, raw);
      if (!payload) return;
      if (payload.orgId !== orgId) return;
      cb(payload);
    });
  }

  publish(orgId: string, event: Omit<EventPayload, 'orgId' | 'ts'>): void {
    const payload: EventPayload = { ...event, orgId, ts: Date.now() };
    const channel = orgTopic(orgId);
    void eventBus.publish(channel, JSON.stringify(payload)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[realtime-hub] Redis publish failed for ${channel}:`, message);
    });
  }
}

export const realtimeHub = new RealtimeHub();

export type { EventPayload };
