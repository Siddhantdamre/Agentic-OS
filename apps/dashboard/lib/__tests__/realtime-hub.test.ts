/**
 * @jest-environment node
 */
import { REALTIME_EVENT_TYPES } from '@darex/shared-types';

type BusHandler = (channel: string, raw: string) => void;
const busHandlers: BusHandler[] = [];
const published: Array<{ channel: string; raw: string }> = [];

jest.mock('@/lib/web-push-notify', () => ({
  notifyNeedsAttentionPush: jest.fn(async () => undefined),
}));

jest.mock('@/lib/event-bus', () => ({
  orgTopic: (orgId: string) => `org:${orgId}`,
  parseOrgTopic: (channel: string) => (channel.startsWith('org:') ? channel.slice(4) : null),
  eventBus: {
    ensureReady: jest.fn(async () => undefined),
    command: jest.fn(async () => null),
    publish: jest.fn(async (channel: string, raw: string) => {
      published.push({ channel, raw });
    }),
    subscribe: jest.fn(async (_channel: string, handler: BusHandler) => {
      busHandlers.push(handler);
      return () => {
        const i = busHandlers.indexOf(handler);
        if (i >= 0) busHandlers.splice(i, 1);
      };
    }),
  },
}));

// eslint-disable-next-line import/first
import { acquireStreamSlot, realtimeHub, recentRingCount, sseEventName } from '../realtime-hub';

beforeEach(() => {
  busHandlers.length = 0;
  published.length = 0;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('realtime event union', () => {
  it('maps every published type to an SSE event of the same name', () => {
    for (const type of REALTIME_EVENT_TYPES) {
      expect(sseEventName(type)).toBe(type);
    }
  });

  it('publishes the previously dropped types', () => {
    realtimeHub.publish('org-a', { type: 'message_status_updated', message: 'delivered' });
    realtimeHub.publish('org-a', { type: 'rent_charge_paid', message: 'ch_1' });
    expect(published.map((p) => JSON.parse(p.raw).type)).toEqual([
      'message_status_updated',
      'rent_charge_paid',
    ]);
  });

  it('publishes the listing, billing, integration and settings events for the org', () => {
    realtimeHub.publish('org-a', { type: 'listing_updated', message: 'l1' });
    realtimeHub.publish('org-a', { type: 'billing_updated', message: 'subscription' });
    realtimeHub.publish('org-a', { type: 'integration_updated', message: 'slack' });
    realtimeHub.publish('org-a', { type: 'settings_updated', message: 'org' });
    expect(published.map((p) => JSON.parse(p.raw).type)).toEqual([
      'listing_updated',
      'billing_updated',
      'integration_updated',
      'settings_updated',
    ]);
  });

  it('drops unknown types on publish and on Redis receive', async () => {
    realtimeHub.publish('org-a', { type: 'poll_sync' as never });
    expect(published).toHaveLength(0);

    const seen: string[] = [];
    await realtimeHub.subscribe('org-a', (p) => seen.push(p.type));
    for (const h of busHandlers) {
      h('org:org-a', JSON.stringify({ type: 'work_item.updated', orgId: 'org-a', ts: Date.now() }));
      h('org:org-a', JSON.stringify({ type: 'memory.updated', orgId: 'org-a', ts: Date.now() }));
    }
    expect(seen).toEqual(['memory.updated']);
  });
});

describe('replay ring', () => {
  it('stores a locally published event once even after the Redis echo', async () => {
    const seen: string[] = [];
    await realtimeHub.subscribe('org-ring', (p) => seen.push(p.eventId));
    await realtimeHub.subscribe('org-ring', () => undefined);
    const since = Date.now() - 1;
    realtimeHub.publish('org-ring', { type: 'conversation_updated', conversationId: 'c1' });
    const echo = published[published.length - 1];
    for (const h of [...busHandlers]) h(echo.channel, echo.raw);

    const replay = realtimeHub.recentEvents('org-ring', since);
    expect(replay).toHaveLength(1);
    expect(seen).toEqual([replay[0].eventId]);
  });

  it('gives id-less external payloads a stable id so they dedupe too', async () => {
    await realtimeHub.subscribe('org-ext', () => undefined);
    await realtimeHub.subscribe('org-ext', () => undefined);
    const raw = JSON.stringify({ type: 'memory.updated', orgId: 'org-ext', ts: 1000 });
    for (const h of [...busHandlers]) h('org:org-ext', raw);
    expect(realtimeHub.recentEvents('org-ext')).toHaveLength(1);
  });

  it('drops rings idle past the TTL', () => {
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    realtimeHub.publish('org-idle', { type: 'conversation_updated' });
    expect(realtimeHub.recentEvents('org-idle')).toHaveLength(1);
    now.mockReturnValue(t0 + 16 * 60 * 1000);
    expect(realtimeHub.recentEvents('org-idle')).toHaveLength(0);
  });

  it('caps the number of org rings held in memory', () => {
    for (let i = 0; i < 1100; i += 1) {
      realtimeHub.publish(`org-many-${i}`, { type: 'conversation_updated' });
    }
    expect(recentRingCount()).toBeLessThanOrEqual(1000);
    expect(realtimeHub.recentEvents('org-many-0')).toHaveLength(0);
    expect(realtimeHub.recentEvents('org-many-1099')).toHaveLength(1);
  });
});

describe('stream slots', () => {
  it('caps open streams per user and frees the slot on release', () => {
    const releases = [];
    for (let i = 0; i < 6; i += 1) {
      const r = acquireStreamSlot('org-slot', 'user-1');
      expect(r).not.toBeNull();
      releases.push(r as () => void);
    }
    expect(acquireStreamSlot('org-slot', 'user-1')).toBeNull();
    const other = acquireStreamSlot('org-slot', 'user-2');
    expect(other).not.toBeNull();
    releases[0]();
    releases[0]();
    const again = acquireStreamSlot('org-slot', 'user-1');
    expect(again).not.toBeNull();
    expect(acquireStreamSlot('org-slot', 'user-1')).toBeNull();
    for (const r of [...releases.slice(1), other, again]) (r as () => void)();
  });
});
