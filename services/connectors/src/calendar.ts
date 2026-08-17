import { NangoConnectorClient } from './client';
import { CreateCalendarEventPayload } from './types';

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
