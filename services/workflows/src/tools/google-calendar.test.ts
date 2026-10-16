import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleCalendar } from './google-calendar.js';

const ORG = '00000000-0000-4000-8000-0000000000c6';
const TS = '2026-08-14T00:00:00.000Z';

function ctx(action: string, payload: Record<string, unknown> = {}) {
  return { tool: 'google-calendar', action, actionName: action, payload, orgId: ORG, timestamp: TS };
}

test('update_event never fabricates success when Google Calendar is not connected', async () => {
  const result = await googleCalendar.execute(ctx('update_event', { eventId: 'evt_1', startTime: '2026-08-20T10:00:00Z' }));
  assert.equal(result.status, 'error');
  assert.match(String(result.message || ''), /not connected/i);
});

test('update_event is classified as a send-class mutation, not a read', () => {
  assert.equal(googleCalendar.risk('update_event'), 'send');
  assert.equal(googleCalendar.risk('list_events'), 'read');
});

test('update_event with injectVideoLink never fabricates success when not connected', async () => {
  const result = await googleCalendar.execute(ctx('update_event', { eventId: 'evt_1', injectVideoLink: true }));
  assert.equal(result.status, 'error');
  assert.match(String(result.message || ''), /not connected/i);
});
