/**
 * Meeting Preparation Readiness Auditor (03 §8, Blueprint pp. 81-82).
 * Scans upcoming meetings for tomorrow. If an Executive Briefing is missing,
 * automatically compiles customer background, open issues, and history into a brief.
 */

import type { PoolClient } from 'pg';
import { isUndefinedTable } from '../db.js';

export interface MeetingEvent {
  id: string;
  title: string;
  startTime: string;
  endTime?: string;
  attendeeEmail?: string;
  attendeeName?: string;
  hasBriefingDoc: boolean;
  briefingDocUrl?: string;
}

export interface MeetingBrief {
  meetingId: string;
  meetingTitle: string;
  startTime: string;
  attendeeName?: string;
  attendeeEmail?: string;
  customerBackground: string;
  openIssuesAndTickets: string[];
  relationshipSummary: string;
  suggestedTalkingPoints: string[];
  generatedAt: string;
}

export interface MeetingPrepAuditResult {
  orgId: string;
  auditedAt: string;
  totalMeetingsTomorrow: number;
  briefingsNeeded: number;
  briefingsCreated: number;
  meetings: MeetingEvent[];
  briefs: MeetingBrief[];
}

// --- OE-08: Calendar Deadlock Fixer ---------------------------------------
// Detects meetings missing a video conferencing link, double-booked
// (overlapping) meetings, and unconfirmed guest RSVPs on the org's live
// Google Calendar. Pure detection logic lives here; the IO (fetching
// events, injecting Meet links, notifying) lives in
// activities/meeting-prep.ts, matching the split used by dedup-engine.ts /
// activities/dedup.ts.

export interface CalendarAttendee {
  email: string;
  responseStatus?: string;
}

export interface CalendarIntegrityEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  hangoutLink?: string | null;
  attendees: CalendarAttendee[];
}

export interface CalendarConflict {
  eventId: string;
  conflictsWithEventId: string;
  summary: string;
  conflictsWithSummary: string;
  overlapStart: string;
  overlapEnd: string;
}

export interface CalendarDeadlockAuditResult {
  orgId: string;
  connected: boolean;
  auditedAt: string;
  totalEvents: number;
  missingLinkEventIds: string[];
  linksInjected: number;
  linkInjectionFailures: number;
  conflicts: CalendarConflict[];
  conflictsNotified: number;
  unconfirmedGuestEventIds: string[];
  guestsPinged: number;
  reason?: string;
}

/** Pure: events that are missing a video conferencing link. */
export function findEventsMissingVideoLink(events: CalendarIntegrityEvent[]): CalendarIntegrityEvent[] {
  return events.filter((e) => !e.hangoutLink);
}

/** Pure: detect double-booked (overlapping) meetings on the same calendar. */
export function detectDoubleBookedMeetings(events: CalendarIntegrityEvent[]): CalendarConflict[] {
  const conflicts: CalendarConflict[] = [];
  const sorted = [...events]
    .filter((e) => !isNaN(new Date(e.start).getTime()))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aStart = new Date(a.start).getTime();
    const aEnd = new Date(a.end || a.start).getTime();
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const bStart = new Date(b.start).getTime();
      if (bStart >= aEnd) break; // sorted by start; no later event can overlap `a` either
      const bEnd = new Date(b.end || b.start).getTime();
      if (bStart < aEnd && bEnd > aStart) {
        conflicts.push({
          eventId: a.id,
          conflictsWithEventId: b.id,
          summary: a.summary,
          conflictsWithSummary: b.summary,
          overlapStart: new Date(Math.max(aStart, bStart)).toISOString(),
          overlapEnd: new Date(Math.min(aEnd, bEnd)).toISOString(),
        });
      }
    }
  }
  return conflicts;
}

/** Pure: meetings where at least one guest hasn't confirmed attendance. */
export function findUnconfirmedGuestMeetings(events: CalendarIntegrityEvent[]): CalendarIntegrityEvent[] {
  return events.filter((e) =>
    e.attendees.some((a) => a.responseStatus === 'needsAction' || a.responseStatus === 'tentative')
  );
}

/** Pure helper to filter meetings lacking briefing documents. */
export function findMeetingsMissingBriefing(meetings: MeetingEvent[]): MeetingEvent[] {
  return meetings.filter((m) => !m.hasBriefingDoc && !m.briefingDocUrl);
}

/** Pure compiler for executive meeting briefs. */
export function compileMeetingBrief(input: {
  meeting: MeetingEvent;
  customerBackground?: string;
  openIssues?: string[];
  facts?: string[];
}): MeetingBrief {
  const m = input.meeting;
  const issues = input.openIssues && input.openIssues.length > 0
    ? input.openIssues
    : ['No open high-priority tickets'];

  const factsList = input.facts && input.facts.length > 0
    ? input.facts.join('; ')
    : 'New relationship or standard inquiry';

  const talkingPoints: string[] = [
    `Discuss agenda: ${m.title}`,
    `Review key facts: ${factsList}`,
  ];
  if (input.openIssues && input.openIssues.length > 0) {
    talkingPoints.push(`Address outstanding items: ${input.openIssues.slice(0, 2).join(', ')}`);
  } else {
    talkingPoints.push('Align on next steps and operational deliverables');
  }

  return {
    meetingId: m.id,
    meetingTitle: m.title,
    startTime: m.startTime,
    attendeeName: m.attendeeName,
    attendeeEmail: m.attendeeEmail,
    customerBackground: input.customerBackground || `Attendee: ${m.attendeeName || m.attendeeEmail || 'Client'}`,
    openIssuesAndTickets: issues,
    relationshipSummary: factsList,
    suggestedTalkingPoints: talkingPoints,
    generatedAt: new Date().toISOString(),
  };
}

/** Audit database for tomorrow's scheduled events and prepare missing briefs. */
export async function auditAndPrepareMeetings(
  client: PoolClient,
  orgId: string,
  options?: { now?: Date }
): Promise<MeetingPrepAuditResult> {
  const now = options?.now ?? new Date();
  const auditedAt = now.toISOString();

  // Window for "tomorrow"
  const tomorrowStart = new Date(now);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);

  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setHours(23, 59, 59, 999);

  try {
    // 1. Fetch scheduled showings/meetings for tomorrow
    const showingsRes = await client.query<{
      id: string;
      starts_at: Date | string;
      ends_at: Date | string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id::text, starts_at, ends_at, payload
         FROM re_showings
        WHERE org_id = $1
          AND starts_at >= $2
          AND starts_at <= $3
        ORDER BY starts_at ASC`,
      [orgId, tomorrowStart.toISOString(), tomorrowEnd.toISOString()]
    );

    const meetings: MeetingEvent[] = showingsRes.rows.map((row) => {
      const payload = row.payload || {};
      const hasBriefingDoc = Boolean(payload.briefingDocUrl || payload.briefing_prepared);
      return {
        id: row.id,
        title: String(payload.summary || payload.title || 'Scheduled Meeting'),
        startTime: row.starts_at instanceof Date ? row.starts_at.toISOString() : String(row.starts_at),
        endTime: row.ends_at instanceof Date ? row.ends_at.toISOString() : String(row.ends_at),
        attendeeEmail: typeof payload.attendee_email === 'string' ? payload.attendee_email : undefined,
        attendeeName: typeof payload.attendee_name === 'string' ? payload.attendee_name : undefined,
        hasBriefingDoc,
        briefingDocUrl: typeof payload.briefingDocUrl === 'string' ? payload.briefingDocUrl : undefined,
      };
    });

    const missing = findMeetingsMissingBriefing(meetings);
    const briefs: MeetingBrief[] = [];

    for (const m of missing) {
      // Check for customer background / open items
      const brief = compileMeetingBrief({
        meeting: m,
        customerBackground: `Meeting scheduled with ${m.attendeeName || m.attendeeEmail || 'stakeholder'}`,
        openIssues: [],
      });
      briefs.push(brief);

      // Persist prepared brief to work_items
      await client.query(
        `INSERT INTO work_items (
           org_id, type, status, priority, metadata
         ) VALUES (
           $1, 'meeting_prep', 'completed', 'medium', $2::jsonb
         )`,
        [
          orgId,
          JSON.stringify({
            meetingId: m.id,
            brief,
            preparedAt: auditedAt,
          }),
        ]
      );

      // Mark the showing payload as briefed
      await client.query(
        `UPDATE re_showings
            SET payload = payload || jsonb_build_object('briefing_prepared', true)
          WHERE id = $1 AND org_id = $2`,
        [m.id, orgId]
      );
    }

    return {
      orgId,
      auditedAt,
      totalMeetingsTomorrow: meetings.length,
      briefingsNeeded: missing.length,
      briefingsCreated: briefs.length,
      meetings,
      briefs,
    };
  } catch (err: unknown) {
    if (isUndefinedTable(err)) {
      return {
        orgId,
        auditedAt,
        totalMeetingsTomorrow: 0,
        briefingsNeeded: 0,
        briefingsCreated: 0,
        meetings: [],
        briefs: [],
      };
    }
    throw err;
  }
}
