import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findMeetingsMissingBriefing,
  compileMeetingBrief,
  findEventsMissingVideoLink,
  detectDoubleBookedMeetings,
  findUnconfirmedGuestMeetings,
  type MeetingEvent,
  type CalendarIntegrityEvent,
} from './meeting-prep.js';

test('findMeetingsMissingBriefing separates meetings with vs without briefing docs', () => {
  const meetings: MeetingEvent[] = [
    {
      id: 'm-1',
      title: 'VIP Client Review',
      startTime: '2026-09-21T10:00:00.000Z',
      attendeeName: 'Priya Sharma',
      attendeeEmail: 'priya@acme.com',
      hasBriefingDoc: false,
    },
    {
      id: 'm-2',
      title: 'Quarterly Check-in',
      startTime: '2026-09-21T14:00:00.000Z',
      attendeeName: 'Rohan Verma',
      attendeeEmail: 'rohan@globex.com',
      hasBriefingDoc: true,
      briefingDocUrl: 'https://docs.google.com/d/123',
    },
  ];

  const missing = findMeetingsMissingBriefing(meetings);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'm-1');
});

test('compileMeetingBrief formats structured brief with customer background and talking points', () => {
  const meeting: MeetingEvent = {
    id: 'm-100',
    title: 'Enterprise Architecture Demo',
    startTime: '2026-09-21T11:00:00.000Z',
    attendeeName: 'John Doe',
    attendeeEmail: 'john@enterprise.com',
    hasBriefingDoc: false,
  };

  const brief = compileMeetingBrief({
    meeting,
    customerBackground: 'Enterprise buyer evaluating Q4 migration',
    openIssues: ['Pending security questionnaire approval'],
    facts: ['ACV $50k tier', 'SLA 4h required'],
  });

  assert.equal(brief.meetingId, 'm-100');
  assert.equal(brief.attendeeName, 'John Doe');
  assert.match(brief.customerBackground, /evaluating Q4/);
  assert.equal(brief.openIssuesAndTickets[0], 'Pending security questionnaire approval');
  assert.ok(brief.suggestedTalkingPoints.some((p) => p.includes('Enterprise Architecture Demo')));
  assert.ok(brief.suggestedTalkingPoints.some((p) => p.includes('Pending security questionnaire')));
});

// --- OE-08: Calendar Deadlock Fixer ---------------------------------------

test('findEventsMissingVideoLink flags events without a hangout link', () => {
  const events: CalendarIntegrityEvent[] = [
    { id: 'e1', summary: 'No link', start: '2026-09-25T10:00:00.000Z', end: '2026-09-25T10:30:00.000Z', hangoutLink: null, attendees: [] },
    { id: 'e2', summary: 'Has link', start: '2026-09-25T11:00:00.000Z', end: '2026-09-25T11:30:00.000Z', hangoutLink: 'https://meet.google.com/abc-defg-hij', attendees: [] },
  ];
  const missing = findEventsMissingVideoLink(events);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'e1');
});

test('detectDoubleBookedMeetings finds overlapping events and ignores back-to-back ones', () => {
  const events: CalendarIntegrityEvent[] = [
    { id: 'a', summary: 'Standup', start: '2026-09-25T10:00:00.000Z', end: '2026-09-25T10:30:00.000Z', attendees: [] },
    { id: 'b', summary: 'Client Call', start: '2026-09-25T10:15:00.000Z', end: '2026-09-25T11:00:00.000Z', attendees: [] },
    { id: 'c', summary: 'Back-to-back', start: '2026-09-25T11:00:00.000Z', end: '2026-09-25T11:30:00.000Z', attendees: [] },
  ];
  const conflicts = detectDoubleBookedMeetings(events);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].eventId, 'a');
  assert.equal(conflicts[0].conflictsWithEventId, 'b');
});

test('findUnconfirmedGuestMeetings flags meetings with needsAction or tentative attendees', () => {
  const events: CalendarIntegrityEvent[] = [
    {
      id: 'e1', summary: 'Confirmed', start: '2026-09-25T10:00:00.000Z', end: '2026-09-25T10:30:00.000Z',
      attendees: [{ email: 'a@acme.com', responseStatus: 'accepted' }],
    },
    {
      id: 'e2', summary: 'Pending RSVP', start: '2026-09-25T11:00:00.000Z', end: '2026-09-25T11:30:00.000Z',
      attendees: [{ email: 'b@acme.com', responseStatus: 'needsAction' }],
    },
  ];
  const unconfirmed = findUnconfirmedGuestMeetings(events);
  assert.equal(unconfirmed.length, 1);
  assert.equal(unconfirmed[0].id, 'e2');
});
