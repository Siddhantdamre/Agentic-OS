/**
 * Every event type that travels on the per-org realtime bus (`org:{id}`).
 *
 * One list for the publisher allowlist (dashboard realtime hub), the SSE
 * event-name mapping (`/api/stream/events`) and the client listeners
 * (`useRealtimeStream`). Only add a type here when something publishes it.
 */
export const REALTIME_EVENT_TYPES = [
  'needs_attention',
  'conversation_updated',
  'conversation_takeover_updated',
  'message_received',
  'message_status_updated',
  'inquiry_updated',
  'inquiry_deleted',
  'presence_updated',
  'rent_charge_paid',
  // `message` carries the work item / plan id; clients refetch that list.
  'work_item_updated',
  'plan_updated',
  // Published straight to Redis by the workflows memory write-back activity.
  'memory.updated',
  // `message` carries the listing id; clients refetch their listings.
  'listing_updated',
  // Subscription or invoice changed (user action or provider webhook).
  'billing_updated',
  // Connector connected, disconnected or reconfigured; `message` is the provider.
  'integration_updated',
  // Org settings, autonomy rules, suppressions or a pending decision changed.
  'settings_updated',
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

const REALTIME_EVENT_TYPE_SET: ReadonlySet<string> = new Set(REALTIME_EVENT_TYPES);

export function isRealtimeEventType(value: unknown): value is RealtimeEventType {
  return typeof value === 'string' && REALTIME_EVENT_TYPE_SET.has(value);
}
