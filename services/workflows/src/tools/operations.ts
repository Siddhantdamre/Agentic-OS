/**
 * Operations employee chat tools — wrap existing engines/APIs for Ask AI.
 * Never invents sheet rows, calendar events, or rent charges.
 * Work-item reassign/priority updates do not side-effect email/Slack.
 * Calendar deadlock audit may inject Meet links via google-calendar only;
 * it does not auto-email guests or Slack (those need explicit user ask + approval).
 */
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';
import { googleCalendar } from './google-calendar.js';
import { auditCrossSystemReconciliation } from '../operations/reconciliation.js';
import { pickDedup, type DedupCandidate } from '../operations/dedup-engine.js';
import {
  compileMeetingBrief,
  detectDoubleBookedMeetings,
  findEventsMissingVideoLink,
  findUnconfirmedGuestMeetings,
  type CalendarIntegrityEvent,
  type MeetingEvent,
} from '../operations/meeting-prep.js';
import { scanOpenExpectations } from '../operations/expected-vs-actual-engine.js';
import { isUndefinedTable } from '../db.js';

const ACTIONS = [
  'reconcile_audit',
  'dedup_contacts',
  'calendar_deadlocks',
  'meeting_prep',
  'work_item_create',
  'work_item_reassign',
  'work_item_set_priority',
  'list_discrepancies',
  'rent_reminders_list',
  'dues_list',
] as const;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

function riskFor(action: string): ToolRisk {
  const a = (action || '').toLowerCase();
  if (
    a.includes('work_item_create') ||
    a.includes('work_item_reassign') ||
    a.includes('work_item_set_priority') ||
    a.includes('calendar_deadlocks')
  ) {
    // Internal DB writes / optional Meet inject. Outbound email/Slack is never a side effect here.
    return 'draft';
  }
  return 'read';
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function loadCalendarEvents(orgId: string, timestamp: string): Promise<{
  connected: boolean;
  events: CalendarIntegrityEvent[];
  reason?: string;
}> {
  const listResult = await googleCalendar
    .execute({
      tool: 'google-calendar',
      action: 'list_events',
      actionName: 'list_events',
      payload: {},
      orgId,
      timestamp,
    })
    .catch(() => null);

  if (!listResult || listResult.status !== 'executed') {
    return {
      connected: false,
      events: [],
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

  return { connected: true, events };
}

async function execute(ctx: ToolActionContext) {
  const { action, payload, orgId, timestamp } = ctx;
  const normalized = (action || '').toLowerCase().replace(/-/g, '_');

  if (normalized === 'reconcile_audit') {
    const staleDays =
      typeof payload.staleDaysThreshold === 'number'
        ? payload.staleDaysThreshold
        : typeof payload.stale_days_threshold === 'number'
          ? payload.stale_days_threshold
          : undefined;
    const report = await withOrgScopedClient(orgId, async (client) =>
      auditCrossSystemReconciliation(client, orgId, { staleDaysThreshold: staleDays })
    );
    return {
      tool: 'operations',
      action: 'reconcile_audit',
      status: 'executed' as const,
      message: report.healthy
        ? 'Reconciliation healthy — no discrepancies.'
        : `Found ${report.discrepancyCount} reconciliation discrepancies.`,
      data: report,
      timestamp,
    };
  }

  if (normalized === 'dedup_contacts') {
    const name = asString(payload.name) || asString(payload.company) || asString(payload.query);
    const domain = asString(payload.domain);
    const phone = asString(payload.phone);
    const email = asString(payload.email);

    return withOrgScopedClient(orgId, async (client) => {
      try {
        const existing = await client.query<{ id: string; display_name: string; metadata: Record<string, unknown> }>(
          `SELECT id::text, display_name, metadata
             FROM entities
            WHERE org_id = $1 AND entity_type = 'account' AND status = 'active'
            ORDER BY updated_at DESC LIMIT 200`,
          [orgId]
        );
        const candidates: DedupCandidate[] = existing.rows.map((row) => ({
          id: row.id,
          name: row.display_name,
          domain: (row.metadata?.domain as string) || null,
          phone: (row.metadata?.phone as string) || null,
        }));

        if (name) {
          const incoming: DedupCandidate = {
            name,
            domain: domain || (email ? email.split('@')[1] : null),
            phone,
          };
          const match = pickDedup(incoming, candidates);
          return {
            tool: 'operations',
            action: 'dedup_contacts',
            status: 'executed' as const,
            message:
              match.decision === 'create'
                ? 'No strong duplicate found for that contact.'
                : `Dedup decision: ${match.decision} (score ${match.total.toFixed(2)}).`,
            data: {
              mode: 'check',
              incoming,
              decision: match.decision,
              score: match.total,
              candidateId: match.candidate?.id || null,
              candidateName: match.candidate?.name || null,
              merged: false,
              note: 'Chat dedup reports only — does not merge HubSpot or send outbound mail.',
            },
            timestamp,
          };
        }

        // Pairwise scan for likely duplicates among existing active accounts.
        const pairs: Array<{
          leftId: string;
          leftName: string;
          rightId: string;
          rightName: string;
          score: number;
          decision: string;
        }> = [];
        for (let i = 0; i < candidates.length; i += 1) {
          for (let j = i + 1; j < candidates.length; j += 1) {
            const scored = pickDedup(candidates[i], [candidates[j]]);
            if (scored.decision === 'merge' || scored.decision === 'quarantine') {
              pairs.push({
                leftId: candidates[i].id || '',
                leftName: candidates[i].name,
                rightId: candidates[j].id || '',
                rightName: candidates[j].name,
                score: scored.total,
                decision: scored.decision,
              });
            }
          }
        }
        pairs.sort((a, b) => b.score - a.score);

        return {
          tool: 'operations',
          action: 'dedup_contacts',
          status: 'executed' as const,
          message:
            pairs.length === 0
              ? 'No duplicate account pairs found in active entities.'
              : `Found ${pairs.length} potential duplicate pair(s).`,
          data: {
            mode: 'scan',
            pairCount: pairs.length,
            pairs: pairs.slice(0, 25),
            merged: false,
            note: 'Chat dedup reports only — does not merge HubSpot or send outbound mail.',
          },
          timestamp,
        };
      } catch (err) {
        if (isUndefinedTable(err)) {
          return {
            tool: 'operations',
            action: 'dedup_contacts',
            status: 'executed' as const,
            message: 'Entity tables not available — no duplicates to report.',
            data: { pairs: [], pairCount: 0, merged: false },
            timestamp,
          };
        }
        throw err;
      }
    });
  }

  if (normalized === 'calendar_deadlocks') {
    const injectMeetLinks = payload.injectMeetLinks === true || payload.inject_meet_links === true;
    const loaded = await loadCalendarEvents(orgId, timestamp);
    if (!loaded.connected) {
      return {
        tool: 'operations',
        action: 'calendar_deadlocks',
        status: 'error' as const,
        message: loaded.reason || 'google-calendar not connected',
        data: {
          connected: false,
          setupUrl: '/connectors?connect=google-calendar',
          missingLinkEventIds: [],
          conflicts: [],
          unconfirmedGuestEventIds: [],
          linksInjected: 0,
        },
        timestamp,
      };
    }

    const missingLink = findEventsMissingVideoLink(loaded.events);
    const conflicts = detectDoubleBookedMeetings(loaded.events);
    const unconfirmed = findUnconfirmedGuestMeetings(loaded.events);

    let linksInjected = 0;
    let linkInjectionFailures = 0;
    if (injectMeetLinks) {
      for (const ev of missingLink) {
        const injectResult = await googleCalendar
          .execute({
            tool: 'google-calendar',
            action: 'update_event',
            actionName: 'update_event',
            payload: { eventId: ev.id, injectVideoLink: true },
            orgId,
            timestamp,
          })
          .catch(() => null);
        if (injectResult?.status === 'executed') linksInjected += 1;
        else linkInjectionFailures += 1;
      }
    }

    return {
      tool: 'operations',
      action: 'calendar_deadlocks',
      status: 'executed' as const,
      message: `Calendar audit: ${missingLink.length} missing Meet link(s), ${conflicts.length} overlap(s), ${unconfirmed.length} unconfirmed-guest meeting(s).`,
      data: {
        connected: true,
        totalEvents: loaded.events.length,
        missingLinkEventIds: missingLink.map((e) => e.id),
        conflicts,
        unconfirmedGuestEventIds: unconfirmed.map((e) => e.id),
        linksInjected,
        linkInjectionFailures,
        guestsPinged: 0,
        conflictsNotified: 0,
        note: 'Chat path does not email guests or Slack about conflicts — ask explicitly (approval required for outbound).',
      },
      timestamp,
    };
  }

  if (normalized === 'meeting_prep') {
    const meetingId = asString(payload.meetingId) || asString(payload.meeting_id) || asString(payload.eventId);
    const title = asString(payload.title) || asString(payload.summary) || 'Scheduled meeting';
    const startTime = asString(payload.startTime) || asString(payload.start_time) || new Date().toISOString();
    const attendeeEmail = asString(payload.attendeeEmail) || asString(payload.attendee_email) || undefined;
    const attendeeName = asString(payload.attendeeName) || asString(payload.attendee_name) || undefined;
    const customerBackground = asString(payload.customerBackground) || asString(payload.customer_background) || undefined;
    const openIssues = Array.isArray(payload.openIssues)
      ? payload.openIssues.map(String)
      : Array.isArray(payload.open_issues)
        ? payload.open_issues.map(String)
        : undefined;
    const facts = Array.isArray(payload.facts) ? payload.facts.map(String) : undefined;

    if (meetingId || asString(payload.title) || asString(payload.summary)) {
      const meeting: MeetingEvent = {
        id: meetingId || `adhoc:${startTime}`,
        title,
        startTime,
        attendeeEmail,
        attendeeName,
        hasBriefingDoc: false,
      };
      const brief = compileMeetingBrief({ meeting, customerBackground, openIssues, facts });
      return {
        tool: 'operations',
        action: 'meeting_prep',
        status: 'executed' as const,
        message: `Prepared brief for "${brief.meetingTitle}".`,
        data: { brief, briefs: [brief] },
        timestamp,
      };
    }

    // No specific meeting — compile briefs for calendar events missing hangout/context.
    const loaded = await loadCalendarEvents(orgId, timestamp);
    if (!loaded.connected) {
      return {
        tool: 'operations',
        action: 'meeting_prep',
        status: 'error' as const,
        message: loaded.reason || 'google-calendar not connected',
        data: { connected: false, setupUrl: '/connectors?connect=google-calendar', briefs: [] },
        timestamp,
      };
    }

    const briefs = loaded.events.slice(0, 10).map((ev) =>
      compileMeetingBrief({
        meeting: {
          id: ev.id,
          title: ev.summary,
          startTime: ev.start,
          attendeeEmail: ev.attendees[0]?.email,
          hasBriefingDoc: false,
        },
      })
    );

    return {
      tool: 'operations',
      action: 'meeting_prep',
      status: 'executed' as const,
      message: `Prepared ${briefs.length} meeting brief(s) from calendar.`,
      data: { connected: true, briefs },
      timestamp,
    };
  }

  if (normalized === 'work_item_create') {
    const title =
      asString(payload.title) || asString(payload.summary) || asString(payload.description);
    if (!title) {
      return {
        tool: 'operations',
        action: 'work_item_create',
        status: 'error' as const,
        message: 'title is required',
        data: null,
        timestamp,
      };
    }
    const type = asString(payload.type) || 'task';
    const priorityRaw = asString(payload.priority) || 'normal';
    const priority = (PRIORITIES as readonly string[]).includes(priorityRaw) ? priorityRaw : 'normal';
    const assigneeEmployeeId = asString(payload.assigneeEmployeeId) || asString(payload.assignee_employee_id);
    const dueAt = asString(payload.dueAt) || asString(payload.due_at);

    return withOrgScopedClient(orgId, async (client) => {
      const res = await client.query(
        `INSERT INTO work_items (
           org_id, type, status, priority, assignee_employee_id, due_at, metadata, payload
         ) VALUES ($1, $2, 'open', $3, $4, $5, $6::jsonb, '{}'::jsonb)
         RETURNING id::text, type, status, priority, assignee_employee_id, due_at, created_at`,
        [
          orgId,
          type,
          priority,
          assigneeEmployeeId,
          dueAt,
          JSON.stringify({ title, summary: title }),
        ]
      );
      const row = res.rows[0];
      return {
        tool: 'operations',
        action: 'work_item_create',
        status: 'executed' as const,
        message: `Created work item ${row.id}.`,
        data: {
          id: row.id,
          type: row.type,
          status: row.status,
          priority: row.priority,
          assigneeEmployeeId: row.assignee_employee_id,
          dueAt: row.due_at,
          createdAt: row.created_at,
          notified: false,
        },
        timestamp,
      };
    });
  }

  if (normalized === 'work_item_reassign') {
    const id = asString(payload.id) || asString(payload.workItemId) || asString(payload.work_item_id);
    const assigneeEmployeeId =
      payload.assigneeEmployeeId === null
        ? null
        : asString(payload.assigneeEmployeeId) || asString(payload.assignee_employee_id);
    if (!id) {
      return {
        tool: 'operations',
        action: 'work_item_reassign',
        status: 'error' as const,
        message: 'work item id is required',
        data: null,
        timestamp,
      };
    }
    if (assigneeEmployeeId === undefined) {
      return {
        tool: 'operations',
        action: 'work_item_reassign',
        status: 'error' as const,
        message: 'assigneeEmployeeId is required (string or null to unassign)',
        data: null,
        timestamp,
      };
    }

    return withOrgScopedClient(orgId, async (client) => {
      const res = await client.query(
        `UPDATE work_items
            SET assignee_employee_id = $3, updated_at = NOW()
          WHERE id = $1 AND org_id = $2
          RETURNING id::text, type, status, priority, assignee_employee_id, updated_at`,
        [id, orgId, assigneeEmployeeId]
      );
      if (!res.rows[0]) {
        return {
          tool: 'operations',
          action: 'work_item_reassign',
          status: 'error' as const,
          message: 'Work item not found in this org',
          data: { found: false },
          timestamp,
        };
      }
      const row = res.rows[0];
      return {
        tool: 'operations',
        action: 'work_item_reassign',
        status: 'executed' as const,
        message: `Reassigned work item ${row.id}.`,
        data: {
          id: row.id,
          assigneeEmployeeId: row.assignee_employee_id,
          priority: row.priority,
          status: row.status,
          notified: false,
          note: 'Internal reassign only — no email/Slack side effect.',
        },
        timestamp,
      };
    });
  }

  if (normalized === 'work_item_set_priority') {
    const id = asString(payload.id) || asString(payload.workItemId) || asString(payload.work_item_id);
    const priorityRaw = asString(payload.priority);
    if (!id || !priorityRaw) {
      return {
        tool: 'operations',
        action: 'work_item_set_priority',
        status: 'error' as const,
        message: 'id and priority are required',
        data: null,
        timestamp,
      };
    }
    if (!(PRIORITIES as readonly string[]).includes(priorityRaw)) {
      return {
        tool: 'operations',
        action: 'work_item_set_priority',
        status: 'error' as const,
        message: `Invalid priority. Use one of: ${PRIORITIES.join(', ')}`,
        data: null,
        timestamp,
      };
    }

    return withOrgScopedClient(orgId, async (client) => {
      const res = await client.query(
        `UPDATE work_items
            SET priority = $3, updated_at = NOW()
          WHERE id = $1 AND org_id = $2
          RETURNING id::text, type, status, priority, assignee_employee_id, updated_at`,
        [id, orgId, priorityRaw]
      );
      if (!res.rows[0]) {
        return {
          tool: 'operations',
          action: 'work_item_set_priority',
          status: 'error' as const,
          message: 'Work item not found in this org',
          data: { found: false },
          timestamp,
        };
      }
      const row = res.rows[0];
      return {
        tool: 'operations',
        action: 'work_item_set_priority',
        status: 'executed' as const,
        message: `Set work item ${row.id} priority to ${row.priority}.`,
        data: {
          id: row.id,
          priority: row.priority,
          assigneeEmployeeId: row.assignee_employee_id,
          notified: false,
          note: 'Internal priority change only — no email/Slack side effect.',
        },
        timestamp,
      };
    });
  }

  if (normalized === 'list_discrepancies') {
    const rows = await withOrgScopedClient(orgId, async (client) => scanOpenExpectations(client, orgId));
    return {
      tool: 'operations',
      action: 'list_discrepancies',
      status: 'executed' as const,
      message:
        rows.length === 0
          ? 'No open operational discrepancies.'
          : `Found ${rows.length} open operational discrepancy(ies).`,
      data: {
        count: rows.length,
        discrepancies: rows.map((r) => ({
          id: r.id,
          objectType: r.objectType,
          objectId: r.objectId,
          basis: r.basis,
          expected: r.comparison.expectedState,
          actual: r.comparison.actualState,
          magnitude: r.comparison.magnitude,
          overdueMs: r.comparison.overdueMs,
        })),
      },
      timestamp,
    };
  }

  if (normalized === 'dues_list') {
    const limit = Math.min(Math.max(typeof payload.limit === 'number' ? Math.floor(payload.limit) : 20, 1), 50);
    return withOrgScopedClient(orgId, async (client) => {
      try {
        const res = await client.query(
          `SELECT buyer_name, invoice_no, amount::float8 AS amount, currency, due_date::text AS due_date, status,
                  GREATEST(0, (CURRENT_DATE - due_date))::int AS days_late
             FROM org_dues
            WHERE org_id = $1 AND status <> 'paid'
            ORDER BY due_date ASC, created_at ASC
            LIMIT $2`,
          [orgId, limit]
        );
        const totals = await client.query(
          `SELECT COALESCE(SUM(amount), 0)::float8 AS owed,
                  COALESCE(SUM(amount) FILTER (WHERE due_date < CURRENT_DATE), 0)::float8 AS overdue,
                  COUNT(*)::int AS open_count,
                  COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS overdue_count
             FROM org_dues WHERE org_id = $1 AND status <> 'paid'`,
          [orgId]
        );
        const t = totals.rows[0] || { owed: 0, overdue: 0, open_count: 0, overdue_count: 0 };
        return {
          tool: 'operations',
          action: 'dues_list',
          status: 'executed' as const,
          message:
            t.open_count === 0
              ? 'Nothing is recorded as owed to this business. The owner can add a list on the Money owed page.'
              : `${t.open_count} open, ${t.overdue_count} past the due date.`,
          data: {
            dues: res.rows.map((r) => ({
              buyer: r.buyer_name,
              invoiceNo: r.invoice_no,
              amount: r.amount,
              currency: r.currency,
              dueDate: r.due_date,
              daysLate: r.days_late,
              status: r.status,
            })),
            totalOwed: t.owed,
            totalOverdue: t.overdue,
            openCount: t.open_count,
            overdueCount: t.overdue_count,
            page: 'Money owed',
          },
          timestamp,
        };
      } catch (err) {
        if (isUndefinedTable(err)) {
          return { tool: 'operations', action: 'dues_list', status: 'executed' as const, message: 'Nothing is recorded as owed to this business.', data: { dues: [], page: 'Money owed' }, timestamp };
        }
        throw err;
      }
    });
  }

  if (normalized === 'rent_reminders_list') {
    const daysAhead =
      typeof payload.daysAhead === 'number'
        ? payload.daysAhead
        : typeof payload.days_ahead === 'number'
          ? payload.days_ahead
          : 7;

    return withOrgScopedClient(orgId, async (client) => {
      try {
        const res = await client.query(
          `SELECT c.id::text, c.lease_id::text, c.kind, c.amount, c.currency, c.status, c.due_at,
                  c.payload AS charge_payload, l.payload AS lease_payload, l.tenant_ref
             FROM pm_charges c
             LEFT JOIN pm_leases l ON l.id = c.lease_id AND l.org_id = c.org_id
            WHERE c.org_id = $1
              AND c.status = 'open'
              AND c.due_at IS NOT NULL
              AND c.due_at <= NOW() + ($2::int || ' days')::interval
            ORDER BY c.due_at ASC
            LIMIT 50`,
          [orgId, daysAhead]
        );

        const drafts = res.rows.map((row) => {
          const leasePayload = (row.lease_payload || {}) as Record<string, unknown>;
          const tenantName =
            (typeof leasePayload.tenant_name === 'string' && leasePayload.tenant_name) ||
            (typeof row.tenant_ref === 'string' && row.tenant_ref) ||
            'tenant';
          const property =
            (typeof leasePayload.property === 'string' && leasePayload.property) ||
            (typeof leasePayload.address === 'string' && leasePayload.address) ||
            'your unit';
          const due = row.due_at ? new Date(row.due_at).toLocaleDateString() : 'the due date';
          const draftBody = `Hello ${tenantName}, this is a reminder that rent of ${row.currency} ${row.amount} for ${property} is due on ${due}. Charge remains open until payment is confirmed.`;
          return {
            chargeId: row.id,
            leaseId: row.lease_id,
            kind: row.kind,
            amount: row.amount,
            currency: row.currency,
            status: row.status,
            dueAt: row.due_at,
            draftSubject: `Rent reminder — ${property}`,
            draftBody,
            sent: false,
          };
        });

        return {
          tool: 'operations',
          action: 'rent_reminders_list',
          status: 'executed' as const,
          message:
            drafts.length === 0
              ? `No open rent charges due within ${daysAhead} day(s).`
              : `Drafted ${drafts.length} rent reminder(s) — not sent.`,
          data: {
            invented: false,
            sent: false,
            daysAhead,
            drafts,
            note: 'Drafts only. Outbound gmail/slack send still requires approval.',
          },
          timestamp,
        };
      } catch (err) {
        if (isUndefinedTable(err)) {
          return {
            tool: 'operations',
            action: 'rent_reminders_list',
            status: 'executed' as const,
            message: 'Rent charge tables not available — nothing to draft.',
            data: { invented: false, sent: false, drafts: [] },
            timestamp,
          };
        }
        throw err;
      }
    });
  }

  return {
    tool: 'operations',
    action: normalized || 'unknown',
    status: 'error' as const,
    message: `Unknown operations action "${action}".`,
    data: null,
    timestamp,
  };
}

export const operations: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
