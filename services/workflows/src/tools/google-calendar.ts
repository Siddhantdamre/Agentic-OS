import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['list_events', 'check_availability', 'create_event'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('fetch') || a.includes('availability') || a.includes('free')) return 'read';
  return 'send';
}

function computeFreeSlots(
  busyEvents: Array<{ start: Date; end: Date }>,
  start: Date,
  end: Date,
  dayStartMin: number,
  dayEndMin: number,
  durationMin: number
): Array<{ start: string; end: string }> {
  const slots: Array<{ start: string; end: string }> = [];
  const dayMs = 86400000;
  const maxDays = 14;
  let cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  let days = 0;
  while (cursor <= end && days < maxDays) {
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

async function execute(ctx: ToolActionContext) {
  const { action, payload, orgId, timestamp } = ctx;
  const summary = payload.summary || payload.title;
  const startIso = payload.startTime;
  const calAction = action || payload.calAction || 'create_event';
  const connId = `${orgId}_google-calendar`;

  let accessToken: string | null = null;
  for (const providerKey of ['google-calendar', 'google-calendar-v2', 'google']) {
    accessToken = await getNangoAccessToken(connId, providerKey);
    if (accessToken) break;
  }

  if (accessToken) {
    try {
      if (calAction === 'list_events' || calAction === 'fetch_events') {
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + 7 * 86400000).toISOString();
        const listRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=10`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (listRes.ok) {
          const listData = await listRes.json();
          const events = listData.items || [];
          return {
            tool: 'google-calendar',
            action: 'list_events',
            status: 'executed' as const,
            message: `✅ Fetched ${events.length} upcoming events from your Google Calendar`,
            data: {
              totalEvents: events.length,
              events: events.map((e: any) => ({
                id: e.id,
                summary: e.summary,
                start: e.start?.dateTime || e.start?.date,
                end: e.end?.dateTime || e.end?.date,
                hangoutLink: e.hangoutLink,
                htmlLink: e.htmlLink,
              })),
            },
            timestamp,
          };
        } else {
          const errBody = await listRes.json().catch(() => ({}));
          console.error('[Google Calendar] list_events error:', listRes.status, errBody);
        }
      }

      if (calAction === 'check_availability' || calAction === 'find_free_slots') {
        const winStart = payload.startTime || payload.start || new Date().toISOString();
        const winEnd = payload.endTime || payload.end || new Date(new Date(winStart).getTime() + 7 * 86400000).toISOString();
        const durationMin = parseInt(payload.durationMinutes || payload.duration || '60', 10);
        const parseHhmm = (val: any, fallback: number): number => {
          if (val === undefined || val === null || val === '') return fallback;
          const [h, m] = String(val).split(':').map(Number);
          return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
        };
        const dayStartMin = parseHhmm(payload.dayStart, 540);
        const dayEndMin = parseHhmm(payload.dayEnd, 1080);

        const availRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(winStart)}&timeMax=${encodeURIComponent(winEnd)}&singleEvents=true&orderBy=startTime&maxResults=100`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!availRes.ok) {
          return { tool: 'google-calendar', action: 'check_availability', status: 'error' as const, message: `Google Calendar API error ${availRes.status}`, data: null, timestamp };
        }
        const availData = await availRes.json();
        const events = (availData.items || []) as any[];
        const busy = events
          .map((e) => ({ start: new Date(e.start?.dateTime || e.start?.date), end: new Date(e.end?.dateTime || e.end?.date) }))
          .filter((e) => !isNaN(e.start.getTime()) && !isNaN(e.end.getTime()));
        const freeSlots = computeFreeSlots(busy, new Date(winStart), new Date(winEnd), dayStartMin, dayEndMin, durationMin);
        return {
          tool: 'google-calendar',
          action: 'check_availability',
          status: 'executed' as const,
          message: `Found ${freeSlots.length} free slot${freeSlots.length === 1 ? '' : 's'} of ${durationMin}min between ${winStart} and ${winEnd}`,
          data: {
            windowStart: winStart,
            windowEnd: winEnd,
            durationMinutes: durationMin,
            freeSlots,
            busyEvents: busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
          },
          timestamp,
        };
      }

      if (!summary) {
        return {
          tool: 'google-calendar',
          action: 'create_event',
          status: 'error' as const,
          message: 'Event summary/title parameter is required.',
          data: null,
          timestamp,
        };
      }
      if (!startIso) {
        return {
          tool: 'google-calendar',
          action: 'create_event',
          status: 'error' as const,
          message: 'Event startTime parameter (ISO string) is required.',
          data: null,
          timestamp,
        };
      }

      const eventBody = {
        summary,
        description: payload.description || '',
        location: payload.location || '',
        start: { dateTime: startIso, timeZone: payload.timeZone || 'UTC' },
        end: {
          dateTime: payload.endTime || new Date(new Date(startIso).getTime() + 3600000).toISOString(),
          timeZone: payload.timeZone || 'UTC',
        },
        attendees: payload.attendees?.map((email: string) => ({ email })) || [],
        conferenceData: { createRequest: { requestId: `drx-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      };

      const calRes = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody),
        }
      );

      if (calRes.ok) {
        const calData = await calRes.json();
        return {
          tool: 'google-calendar',
          action: 'create_event',
          status: 'executed' as const,
          message: `✅ Scheduled "${calData.summary}" on Google Calendar`,
          data: {
            eventId: calData.id,
            summary: calData.summary,
            startTime: calData.start?.dateTime,
            endTime: calData.end?.dateTime,
            hangoutLink: calData.hangoutLink || calData.conferenceData?.entryPoints?.[0]?.uri || null,
            htmlLink: calData.htmlLink,
            attendees: calData.attendees?.map((a: any) => a.email) || [],
          },
          timestamp,
        };
      } else {
        const errBody = await calRes.json().catch(() => ({}));
        console.error('[Google Calendar] create_event error:', calRes.status, errBody);
        return {
          tool: 'google-calendar',
          action: 'create_event',
          status: 'error' as const,
          message: `Google Calendar API error ${calRes.status}: ${errBody?.error?.message || 'Unknown error'}`,
          data: { statusCode: calRes.status, error: errBody },
          timestamp,
        };
      }
    } catch (e: any) {
      console.error('[Google Calendar] Exception:', e.message);
      return {
        tool: 'google-calendar',
        action: calAction,
        status: 'error' as const,
        message: `Google Calendar request failed: ${e.message}`,
        data: null,
        timestamp,
      };
    }
  }

  return notConnected('google-calendar', calAction, timestamp);
}

export const googleCalendar: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
