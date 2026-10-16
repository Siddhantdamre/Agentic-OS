import { NangoConnectorClient } from './client';
import { CONNECTORS_RECONNECT_URL, CreateCalendarEventPayload, notConnectedResult } from './types';

export async function createGoogleCalendarEvent(
  client: NangoConnectorClient,
  orgId: string,
  payload: CreateCalendarEventPayload
) {
  return client.proxyRequest(orgId, 'google-calendar', '/calendar/v3/calendars/primary/events', 'POST', {
    summary: payload.title,
    description: payload.description || '',
    start: { dateTime: payload.startTime },
    end: { dateTime: payload.endTime },
    attendees: payload.attendeeEmails.map((email) => ({ email })),
  });
}

export interface CalendarBusyInterval {
  start: string;
  end: string;
}

export type CalendarFreeBusyResult =
  | {
      connected: true;
      busy: CalendarBusyInterval[];
      calendarId: string;
    }
  | {
      connected: false;
      busy: [];
      reconnectUrl: typeof CONNECTORS_RECONNECT_URL;
      setupUrl: typeof CONNECTORS_RECONNECT_URL;
      reason: 'not_connected' | 'expired' | 'revoked' | 'nango_unconfigured';
      message: string;
    };

/**
 * Query Google Calendar free/busy for the org's primary calendar via Nango.
 * Never fabricates availability — missing/expired OAuth returns connected:false + reconnectUrl.
 */
export async function queryGoogleCalendarFreeBusy(
  client: NangoConnectorClient,
  orgId: string,
  timeMin: string,
  timeMax: string
): Promise<CalendarFreeBusyResult> {
  if (!client.isConfigured()) {
    const honest = notConnectedResult(
      'nango_unconfigured',
      'NANGO_SECRET_KEY is not set — cannot check calendar conflicts.',
      'google-calendar'
    );
    return {
      connected: false,
      busy: [],
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
      reason: honest.reason,
      message: honest.message,
    };
  }

  const live = await client.resolveLiveConnection(orgId, 'google-calendar');
  if (!live) {
    const honest = notConnectedResult(
      'not_connected',
      `Google Calendar is not connected. Reconnect at ${CONNECTORS_RECONNECT_URL} before booking — Darex will not book over unknown conflicts.`,
      'google-calendar'
    );
    return {
      connected: false,
      busy: [],
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
      reason: honest.reason,
      message: honest.message,
    };
  }

  try {
    const data = await client.proxyRequest(
      orgId,
      'google-calendar',
      '/calendar/v3/freeBusy',
      'POST',
      {
        timeMin,
        timeMax,
        items: [{ id: 'primary' }],
      }
    );
    const calendars = data?.calendars || {};
    const primary = calendars.primary || calendars.Primary || Object.values(calendars)[0];
    const rawBusy = Array.isArray((primary as { busy?: unknown })?.busy)
      ? ((primary as { busy: Array<{ start?: string; end?: string }> }).busy)
      : [];
    const busy: CalendarBusyInterval[] = rawBusy
      .map((slot) => ({
        start: String(slot.start || ''),
        end: String(slot.end || ''),
      }))
      .filter((slot) => slot.start && slot.end);
    return { connected: true, busy, calendarId: 'primary' };
  } catch (err: any) {
    const reason =
      err?.reason === 'expired' || err?.reason === 'revoked' || err?.reason === 'nango_unconfigured'
        ? err.reason
        : 'expired';
    const honest = notConnectedResult(
      reason,
      err?.message ||
        `Google Calendar free/busy failed. Reconnect at ${CONNECTORS_RECONNECT_URL} — will not book over unknown conflicts.`,
      'google-calendar'
    );
    return {
      connected: false,
      busy: [],
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
      reason: honest.reason,
      message: honest.message,
    };
  }
}

/** True when [start, end) overlaps any busy interval. */
export function intervalOverlapsBusy(
  startIso: string,
  endIso: string,
  busy: CalendarBusyInterval[]
): boolean {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  return busy.some((slot) => {
    const bStart = new Date(slot.start).getTime();
    const bEnd = new Date(slot.end).getTime();
    if (!Number.isFinite(bStart) || !Number.isFinite(bEnd)) return false;
    return start < bEnd && end > bStart;
  });
}

export type GoogleCalendarWatchRequestResult =
  | {
      configured: true;
      connected: true;
      channelId: string;
      resourceId: string;
      expiration: string | null;
      webhookAddress: string;
    }
  | {
      configured: false;
      connected?: boolean;
      reason: 'not_configured' | 'not_connected' | 'expired' | 'nango_unconfigured' | 'api_error';
      message: string;
      reconnectUrl?: typeof CONNECTORS_RECONNECT_URL;
      setupUrl?: typeof CONNECTORS_RECONNECT_URL;
    };

/**
 * Resolve the public push URL Google Calendar must POST to.
 * Without a public HTTPS base, watches cannot be verified — callers must
 * persist not_configured rather than pretend two-way sync works.
 */
export function resolveGoogleCalendarWebhookAddress(): string | null {
  const explicit = process.env.GOOGLE_CALENDAR_WEBHOOK_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const base =
    process.env.DAREX_PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    '';
  if (!base) return null;
  if (!/^https:\/\//i.test(base) && process.env.NODE_ENV === 'production') {
    return null;
  }
  return `${base.replace(/\/$/, '')}/api/webhooks/google-calendar`;
}

/**
 * Register a Google Calendar events.watch channel for the org primary calendar.
 * Never invents a successful watch when OAuth or webhook URL is missing.
 */
export async function requestGoogleCalendarWatch(
  client: NangoConnectorClient,
  orgId: string,
  opts: { channelId: string; channelToken: string; calendarId?: string }
): Promise<GoogleCalendarWatchRequestResult> {
  const address = resolveGoogleCalendarWebhookAddress();
  if (!address) {
    return {
      configured: false,
      reason: 'not_configured',
      message:
        'GOOGLE_CALENDAR_WEBHOOK_URL (or DAREX_PUBLIC_BASE_URL) is not set — cannot register a verifiable push channel. Watch request persisted as not_configured; no fake sync.',
    };
  }

  if (!client.isConfigured()) {
    const honest = notConnectedResult(
      'nango_unconfigured',
      'NANGO_SECRET_KEY is not set — cannot register calendar watch.',
      'google-calendar'
    );
    return {
      configured: false,
      connected: false,
      reason: 'nango_unconfigured',
      message: honest.message,
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
    };
  }

  const live = await client.resolveLiveConnection(orgId, 'google-calendar');
  if (!live) {
    const honest = notConnectedResult(
      'not_connected',
      `Google Calendar is not connected. Reconnect at ${CONNECTORS_RECONNECT_URL} before enabling push sync.`,
      'google-calendar'
    );
    return {
      configured: false,
      connected: false,
      reason: 'not_connected',
      message: honest.message,
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
    };
  }

  const calendarId = opts.calendarId || 'primary';
  // Google channels expire; request ~7 days (ms epoch).
  const expirationMs = Date.now() + 7 * 24 * 60 * 60 * 1000;

  try {
    const data = await client.proxyRequest(
      orgId,
      'google-calendar',
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      'POST',
      {
        id: opts.channelId,
        type: 'web_hook',
        address,
        token: opts.channelToken,
        expiration: String(expirationMs),
      }
    );
    const resourceId = typeof data?.resourceId === 'string' ? data.resourceId : '';
    if (!resourceId) {
      return {
        configured: false,
        connected: true,
        reason: 'api_error',
        message: 'Google Calendar watch response missing resourceId — no fake sync.',
      };
    }
    const expirationRaw = data?.expiration != null ? String(data.expiration) : String(expirationMs);
    const expirationIso = Number.isFinite(Number(expirationRaw))
      ? new Date(Number(expirationRaw)).toISOString()
      : null;
    return {
      configured: true,
      connected: true,
      channelId: opts.channelId,
      resourceId,
      expiration: expirationIso,
      webhookAddress: address,
    };
  } catch (err: any) {
    const reason =
      err?.reason === 'expired' || err?.reason === 'revoked' || err?.reason === 'nango_unconfigured'
        ? err.reason === 'revoked'
          ? 'expired'
          : err.reason
        : 'api_error';
    if (reason === 'expired' || reason === 'nango_unconfigured') {
      const honest = notConnectedResult(
        reason === 'nango_unconfigured' ? 'nango_unconfigured' : 'expired',
        err?.message || `Calendar watch failed. Reconnect at ${CONNECTORS_RECONNECT_URL}.`,
        'google-calendar'
      );
      return {
        configured: false,
        connected: false,
        reason,
        message: honest.message,
        reconnectUrl: honest.reconnectUrl,
        setupUrl: honest.setupUrl,
      };
    }
    return {
      configured: false,
      connected: true,
      reason: 'api_error',
      message: err?.message || 'Google Calendar events.watch failed — no fake sync.',
    };
  }
}

/** Fetch a single calendar event by id. Returns null when missing — never fabricates. */
export async function getGoogleCalendarEvent(
  client: NangoConnectorClient,
  orgId: string,
  eventId: string
): Promise<
  | { connected: true; event: Record<string, unknown> }
  | { connected: false; reason: string; message: string; reconnectUrl: typeof CONNECTORS_RECONNECT_URL }
  | { connected: true; event: null; message: string }
> {
  if (!client.isConfigured()) {
    const honest = notConnectedResult(
      'nango_unconfigured',
      'NANGO_SECRET_KEY is not set',
      'google-calendar'
    );
    return {
      connected: false,
      reason: honest.reason,
      message: honest.message,
      reconnectUrl: honest.reconnectUrl,
    };
  }
  try {
    const data = await client.proxyRequest(
      orgId,
      'google-calendar',
      `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      'GET'
    );
    if (!data || typeof data !== 'object') {
      return { connected: true, event: null, message: 'Event not found' };
    }
    return { connected: true, event: data as Record<string, unknown> };
  } catch (err: any) {
    const status = Number(err?.status || err?.response?.status || 0);
    if (status === 404) {
      return { connected: true, event: null, message: 'Event not found (404)' };
    }
    const reason =
      err?.reason === 'expired' || err?.reason === 'revoked' || err?.reason === 'nango_unconfigured'
        ? err.reason
        : 'expired';
    const honest = notConnectedResult(
      reason === 'nango_unconfigured' ? 'nango_unconfigured' : reason === 'revoked' ? 'revoked' : 'expired',
      err?.message || 'Failed to fetch calendar event',
      'google-calendar'
    );
    return {
      connected: false,
      reason: honest.reason,
      message: honest.message,
      reconnectUrl: honest.reconnectUrl,
    };
  }
}

/**
 * Incremental events.list using a sync token. Returns nextSyncToken when present.
 * On 410 (token expired) returns needsFullSync — caller must not invent events.
 */
export async function listGoogleCalendarEventChanges(
  client: NangoConnectorClient,
  orgId: string,
  opts: { syncToken?: string | null; calendarId?: string }
): Promise<
  | {
      connected: true;
      events: Array<Record<string, unknown>>;
      nextSyncToken: string | null;
      needsFullSync: boolean;
    }
  | {
      connected: false;
      reason: string;
      message: string;
      reconnectUrl: typeof CONNECTORS_RECONNECT_URL;
    }
> {
  if (!client.isConfigured()) {
    const honest = notConnectedResult(
      'nango_unconfigured',
      'NANGO_SECRET_KEY is not set',
      'google-calendar'
    );
    return {
      connected: false,
      reason: honest.reason,
      message: honest.message,
      reconnectUrl: honest.reconnectUrl,
    };
  }
  const calendarId = opts.calendarId || 'primary';
  const qs = opts.syncToken
    ? `?syncToken=${encodeURIComponent(opts.syncToken)}`
    : '?maxResults=50&singleEvents=true&orderBy=updated';
  try {
    const data = await client.proxyRequest(
      orgId,
      'google-calendar',
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${qs}`,
      'GET'
    );
    const items = Array.isArray(data?.items) ? (data.items as Array<Record<string, unknown>>) : [];
    return {
      connected: true,
      events: items,
      nextSyncToken: typeof data?.nextSyncToken === 'string' ? data.nextSyncToken : null,
      needsFullSync: false,
    };
  } catch (err: any) {
    const status = Number(err?.status || err?.response?.status || 0);
    const msg = String(err?.message || '');
    if (status === 410 || /sync.?token|410/i.test(msg)) {
      return { connected: true, events: [], nextSyncToken: null, needsFullSync: true };
    }
    const reason =
      err?.reason === 'expired' || err?.reason === 'revoked' || err?.reason === 'nango_unconfigured'
        ? err.reason
        : 'expired';
    const honest = notConnectedResult(
      reason === 'nango_unconfigured' ? 'nango_unconfigured' : reason === 'revoked' ? 'revoked' : 'expired',
      err?.message || 'Failed to list calendar changes',
      'google-calendar'
    );
    return {
      connected: false,
      reason: honest.reason,
      message: honest.message,
      reconnectUrl: honest.reconnectUrl,
    };
  }
}
