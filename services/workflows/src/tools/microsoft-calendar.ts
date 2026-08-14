import type { ToolRisk } from './risk.js';
import type { NangoAuthState, ToolActionContext, ToolModule } from './shared.js';
import {
  apiError,
  confirmFromRisk,
  fetchWithTimeout,
  isProviderUnauthorized,
  notConnected,
  resolveNangoAuth,
  revoked,
} from './shared.js';

const ACTIONS = ['list_events', 'check_availability', 'create_event'] as const;
const GRAPH = 'https://graph.microsoft.com/v1.0';

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('fetch') || a.includes('availability') || a.includes('free')) return 'read';
  return 'send';
}

async function calendarAuth(orgId: string): Promise<NangoAuthState> {
  const specific = await resolveNangoAuth(`${orgId}_microsoft-calendar`, ['microsoft-calendar', 'microsoft']);
  if (specific.kind === 'connected') return specific;
  const umbrella = await resolveNangoAuth(`${orgId}_microsoft`, ['microsoft', 'microsoft-calendar']);
  if (umbrella.kind === 'connected') return umbrella;
  if (specific.kind === 'revoked') return specific;
  if (umbrella.kind === 'revoked') return umbrella;
  return { kind: 'never-configured' };
}

function graphHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function computeFreeSlots(
  busyEvents: Array<{ start: Date; end: Date }>,
  start: Date,
  end: Date,
  dayStartMin: number,
  dayEndMin: number,
  durationMin: number,
): Array<{ start: string; end: string }> {
  const slots: Array<{ start: string; end: string }> = [];
  const dayMs = 86400000;
  let cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  let days = 0;
  while (cursor <= end && days < 14) {
    const workStart = new Date(cursor.getTime() + dayStartMin * 60000);
    const workEnd = new Date(cursor.getTime() + dayEndMin * 60000);
    const dayEvents = busyEvents
      .filter((e) => e.end > workStart && e.start < workEnd)
      .map((e) => ({
        start: e.start < workStart ? workStart : e.start,
        end: e.end > workEnd ? workEnd : e.end,
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    let freeFrom = workStart;
    for (const ev of dayEvents) {
      if (ev.start.getTime() - freeFrom.getTime() >= durationMin * 60000) {
        slots.push({ start: freeFrom.toISOString(), end: ev.start.toISOString() });
      }
      if (ev.end > freeFrom) freeFrom = ev.end;
    }
    if (workEnd.getTime() - freeFrom.getTime() >= durationMin * 60000) {
      slots.push({ start: freeFrom.toISOString(), end: workEnd.toISOString() });
    }
    cursor = new Date(cursor.getTime() + dayMs);
    days += 1;
  }
  return slots;
}

function mapEvent(e: any) {
  return {
    id: e.id,
    subject: e.subject,
    start: e.start?.dateTime || e.start,
    end: e.end?.dateTime || e.end,
    location: e.location?.displayName || null,
    webLink: e.webLink || null,
    isOnlineMeeting: Boolean(e.isOnlineMeeting),
    onlineMeetingUrl: e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || null,
  };
}

async function execute(ctx: ToolActionContext) {
  const { action, actionName, payload, orgId, timestamp } = ctx;
  const calAction = action || payload.calAction || actionName || 'list_events';
  const auth = await calendarAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('microsoft-calendar', calAction, timestamp);
  if (auth.kind === 'revoked') return revoked('microsoft-calendar', calAction, timestamp, auth.detail);

  const token = auth.accessToken;
  try {
    if (calAction.includes('list') || calAction.includes('fetch')) {
      const start = payload.startTime || new Date().toISOString();
      const end = payload.endTime || new Date(Date.now() + 7 * 86400000).toISOString();
      const res = await fetchWithTimeout(
        `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=25&$orderby=start/dateTime`,
        { headers: graphHeaders(token) },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('microsoft-calendar', 'list_events', timestamp, `Graph HTTP ${res.status}`);
      if (!res.ok) return apiError('microsoft-calendar', 'list_events', timestamp, `Outlook calendar list failed: HTTP ${res.status}`, data);
      const events = Array.isArray(data.value) ? data.value : [];
      return {
        tool: 'microsoft-calendar',
        action: 'list_events',
        status: 'executed' as const,
        message: `Fetched ${events.length} upcoming events from Outlook Calendar`,
        data: { totalEvents: events.length, events: events.map(mapEvent), httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (calAction.includes('availability') || calAction.includes('free')) {
      const winStart = payload.startTime || payload.start || new Date().toISOString();
      const winEnd = payload.endTime || payload.end || new Date(new Date(winStart).getTime() + 7 * 86400000).toISOString();
      const durationMin = parseInt(String(payload.durationMinutes || payload.duration || '60'), 10);
      const parseHhmm = (val: unknown, fallback: number): number => {
        if (val === undefined || val === null || val === '') return fallback;
        const [h, m] = String(val).split(':').map(Number);
        return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
      };
      const res = await fetchWithTimeout(
        `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(winStart)}&endDateTime=${encodeURIComponent(winEnd)}&$top=100&$orderby=start/dateTime`,
        { headers: graphHeaders(token) },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('microsoft-calendar', 'check_availability', timestamp, `Graph HTTP ${res.status}`);
      if (!res.ok) return apiError('microsoft-calendar', 'check_availability', timestamp, `Outlook availability failed: HTTP ${res.status}`, data);
      const events = Array.isArray(data.value) ? data.value : [];
      const busy = events
        .map((e: any) => ({ start: new Date(e.start?.dateTime || e.start), end: new Date(e.end?.dateTime || e.end) }))
        .filter((e: { start: Date; end: Date }) => !Number.isNaN(e.start.getTime()) && !Number.isNaN(e.end.getTime()));
      const freeSlots = computeFreeSlots(
        busy,
        new Date(winStart),
        new Date(winEnd),
        parseHhmm(payload.dayStart, 540),
        parseHhmm(payload.dayEnd, 1080),
        durationMin,
      );
      return {
        tool: 'microsoft-calendar',
        action: 'check_availability',
        status: 'executed' as const,
        message: `Found ${freeSlots.length} free slot${freeSlots.length === 1 ? '' : 's'} of ${durationMin}min`,
        data: {
          windowStart: winStart,
          windowEnd: winEnd,
          durationMinutes: durationMin,
          freeSlots,
          busyEvents: busy.map((b: { start: Date; end: Date }) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
          httpStatus: res.status,
          connected: true,
        },
        timestamp,
      };
    }

    const summary = payload.summary || payload.title || payload.subject;
    const startIso = payload.startTime || payload.start;
    if (!summary) return apiError('microsoft-calendar', 'create_event', timestamp, 'Event summary/title is required.');
    if (!startIso) return apiError('microsoft-calendar', 'create_event', timestamp, 'Event startTime (ISO string) is required.');
    const endIso = payload.endTime || payload.end || new Date(new Date(startIso).getTime() + 3600000).toISOString();
    const tz = payload.timeZone || 'UTC';
    const attendees = Array.isArray(payload.attendees)
      ? payload.attendees.map((email: string) => ({ emailAddress: { address: email }, type: 'required' }))
      : [];
    const res = await fetchWithTimeout(`${GRAPH}/me/events`, {
      method: 'POST',
      headers: graphHeaders(token),
      body: JSON.stringify({
        subject: summary,
        body: { contentType: 'Text', content: payload.description || '' },
        start: { dateTime: startIso, timeZone: tz },
        end: { dateTime: endIso, timeZone: tz },
        location: payload.location ? { displayName: payload.location } : undefined,
        attendees,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (isProviderUnauthorized(res.status)) return revoked('microsoft-calendar', 'create_event', timestamp, `Graph HTTP ${res.status}`);
    if (!res.ok) return apiError('microsoft-calendar', 'create_event', timestamp, `Outlook create event failed: HTTP ${res.status}`, data);
    return {
      tool: 'microsoft-calendar',
      action: 'create_event',
      status: 'executed' as const,
      message: `Scheduled "${data.subject || summary}" on Outlook Calendar`,
      data: { ...mapEvent(data), httpStatus: res.status, connected: true },
      timestamp,
    };
  } catch (e: any) {
    return apiError('microsoft-calendar', calAction, timestamp, `Outlook Calendar API error: ${e.message}`);
  }
}

export const microsoftCalendar: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
