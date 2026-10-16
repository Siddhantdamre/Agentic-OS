import { ApplicationFailure } from '@temporalio/activity';
import { withOrgClient } from '../db.js';
import { executeAutonomousToolAction } from '../tool-executor.js';
import {
  auditAndPrepareMeetings,
  detectDoubleBookedMeetings,
  findEventsMissingVideoLink,
  findUnconfirmedGuestMeetings,
  type CalendarDeadlockAuditResult,
  type CalendarIntegrityEvent,
  type MeetingPrepAuditResult,
} from '../operations/meeting-prep.js';

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  return orgId;
}

export async function auditMeetingPrepActivity(params: {
  orgId: string;
}): Promise<MeetingPrepAuditResult> {
  const orgId = requireOrgId(params.orgId);
  return withOrgClient(orgId, async (client) => {
    return auditAndPrepareMeetings(client, orgId);
  });
}

/**
 * OE-08 Calendar Deadlock Fixer. Scans the org's live Google Calendar for
 * meetings missing a video link, double-booked (overlapping) meetings, and
 * unconfirmed guest RSVPs — then autonomously injects a Google Meet link,
 * notifies Slack about conflicts, and pings unconfirmed guests by email.
 * Honestly reports `connected: false` rather than fabricating results when
 * Google Calendar isn't connected, matching the convention used throughout
 * (see activities/enrichment.ts, activities/dedup.ts).
 */
export async function auditCalendarDeadlocksActivity(params: {
  orgId: string;
}): Promise<CalendarDeadlockAuditResult> {
  const orgId = requireOrgId(params.orgId);
  const timestamp = new Date().toISOString();

  const listResult = await executeAutonomousToolAction({
    tool: 'google-calendar',
    action: 'list_events',
    payload: {},
    orgId,
    employeeRole: 'executive',
    source: 'sweep',
  }).catch(() => null);

  if (!listResult || listResult.status !== 'executed') {
    return {
      orgId,
      connected: false,
      auditedAt: timestamp,
      totalEvents: 0,
      missingLinkEventIds: [],
      linksInjected: 0,
      linkInjectionFailures: 0,
      conflicts: [],
      conflictsNotified: 0,
      unconfirmedGuestEventIds: [],
      guestsPinged: 0,
      reason: listResult?.message || 'google-calendar not connected',
    };
  }

  const rawEvents = (listResult.data as { events?: Array<Record<string, unknown>> } | null)?.events || [];
  const events: CalendarIntegrityEvent[] = rawEvents
    .filter((e): e is Record<string, unknown> => typeof e.id === 'string' && typeof e.start === 'string')
    .map((e) => ({
      id: e.id as string,
      summary: typeof e.summary === 'string' ? e.summary : 'Untitled meeting',
      start: e.start as string,
      end: typeof e.end === 'string' ? e.end : (e.start as string),
      hangoutLink: typeof e.hangoutLink === 'string' ? e.hangoutLink : null,
      attendees: Array.isArray(e.attendeeDetails)
        ? (e.attendeeDetails as Array<{ email?: string; responseStatus?: string }>)
            .filter((a) => typeof a.email === 'string')
            .map((a) => ({ email: a.email as string, responseStatus: a.responseStatus }))
        : [],
    }));

  const missingLink = findEventsMissingVideoLink(events);
  const conflicts = detectDoubleBookedMeetings(events);
  const unconfirmed = findUnconfirmedGuestMeetings(events);

  let linksInjected = 0;
  let linkInjectionFailures = 0;
  for (const ev of missingLink) {
    const injectResult = await executeAutonomousToolAction({
      tool: 'google-calendar',
      action: 'update_event',
      payload: { eventId: ev.id, injectVideoLink: true },
      orgId,
      employeeRole: 'executive',
      source: 'sweep',
    }).catch(() => null);
    if (injectResult?.status === 'executed') linksInjected += 1;
    else linkInjectionFailures += 1;
  }

  let conflictsNotified = 0;
  const notifiedEventIds = new Set<string>();
  for (const c of conflicts) {
    if (notifiedEventIds.has(c.eventId)) continue;
    notifiedEventIds.add(c.eventId);
    const slackResult = await executeAutonomousToolAction({
      tool: 'slack',
      action: 'send_channel_message',
      payload: {
        channel: '#ops-calendar',
        message: `Calendar conflict: "${c.summary}" overlaps with "${c.conflictsWithSummary}" between ${c.overlapStart} and ${c.overlapEnd}.`,
      },
      orgId,
      employeeRole: 'executive',
      source: 'sweep',
    }).catch(() => null);
    if (slackResult?.status === 'executed') conflictsNotified += 1;
  }

  let guestsPinged = 0;
  for (const ev of unconfirmed) {
    const unresolvedGuest = ev.attendees.find(
      (a) => a.responseStatus === 'needsAction' || a.responseStatus === 'tentative'
    );
    if (!unresolvedGuest) continue;
    const pingResult = await executeAutonomousToolAction({
      tool: 'gmail',
      action: 'send_email',
      payload: {
        to: unresolvedGuest.email,
        subject: `Please confirm: ${ev.summary}`,
        body: `Hi, this is a reminder to confirm your attendance for "${ev.summary}" scheduled at ${ev.start}. Please RSVP at your earliest convenience.`,
      },
      orgId,
      employeeRole: 'executive',
      source: 'sweep',
    }).catch(() => null);
    if (pingResult?.status === 'executed') guestsPinged += 1;
  }

  return {
    orgId,
    connected: true,
    auditedAt: timestamp,
    totalEvents: events.length,
    missingLinkEventIds: missingLink.map((e) => e.id),
    linksInjected,
    linkInjectionFailures,
    conflicts,
    conflictsNotified,
    unconfirmedGuestEventIds: unconfirmed.map((e) => e.id),
    guestsPinged,
  };
}
