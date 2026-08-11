import { EventEmitter } from 'events';

/**
 * In-memory real-time event hub for Phase 5 (Real-Time Delivery).
 * Next.js route handlers in this app share one Node process, so an in-process
 * EventEmitter per org is sufficient. Webhooks, message POSTs and status PATCHes
 * publish events; the SSE endpoint (/api/stream/events) subscribes per org.
 */

type EventPayload = {
  type: string;
  orgId: string;
  conversationId?: string;
  message?: string;
  contactId?: string;
  channelType?: string;
  ts: number;
};

type Subscriber = (payload: EventPayload) => void;

class RealtimeHub {
  private emitter = new EventEmitter();
  private readonly channel = 'org-event';

  subscribe(orgId: string, cb: Subscriber): () => void {
    this.emitter.addListener(this.channel, cb);
    return () => this.emitter.removeListener(this.channel, cb);
  }

  publish(orgId: string, event: Omit<EventPayload, 'orgId' | 'ts'>): void {
    const payload: EventPayload = { ...event, orgId, ts: Date.now() };
    this.emitter.emit(this.channel, payload);
  }
}

export const realtimeHub = new RealtimeHub();

export type { EventPayload };
