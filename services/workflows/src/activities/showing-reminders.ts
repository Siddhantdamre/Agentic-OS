/**
 * Showing reminder activities. Re-check DB status before every send —
 * cancelled showings must never receive a reminder.
 */

import { ApplicationFailure } from '@temporalio/activity';
import { executeAutonomousToolAction } from '../tool-executor.js';
import { withOrgScopedClient } from '../tools/shared.js';

export type ShowingReminderKind = '24h' | '2h';

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

function pickContact(payload: Record<string, unknown> | null | undefined): {
  phone: string;
  email: string;
  name: string;
} {
  const p = payload || {};
  const phone = String(
    p.contactPhone || p.contact_phone || p.phone || p.tenant_phone || p.mobile || ''
  ).trim();
  const email = String(
    p.contactEmail || p.contact_email || p.email || p.tenant_email || ''
  ).trim();
  const name = String(p.contactName || p.contact_name || p.name || p.tenant_name || 'there').trim();
  return { phone, email, name: name || 'there' };
}

export async function sendShowingReminderActivity(params: {
  orgId: string;
  showingId: string;
  kind: ShowingReminderKind;
  businessKey: string;
}): Promise<{
  orgId: string;
  showingId: string;
  kind: ShowingReminderKind;
  sent: boolean;
  skippedCancelled: boolean;
  alreadySent: boolean;
  connected?: boolean;
  dispatchedTo?: string | null;
  message: string;
}> {
  const orgId = requireOrgId(params.orgId);
  const showingId = params.showingId;
  const kind = params.kind;

  const row = await withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT s.id, s.status, s.starts_at, s.ends_at, s.listing_id, s.inquiry_id,
              s.reminder_24h_sent, s.reminder_2h_sent, s.payload AS showing_payload,
              i.payload AS inquiry_payload, i.contact_id,
              l.title AS listing_title, l.locality, l.address_line, l.city
         FROM re_showings s
         LEFT JOIN re_inquiries i ON i.id = s.inquiry_id AND i.org_id = s.org_id
         LEFT JOIN re_listings l ON l.id = s.listing_id AND l.org_id = s.org_id
        WHERE s.id = $1 AND s.org_id = $2
        LIMIT 1`,
      [showingId, orgId]
    );
    return res.rows[0] as
      | {
          id: string;
          status: string;
          starts_at: string | Date | null;
          ends_at: string | Date | null;
          listing_id: string | null;
          inquiry_id: string | null;
          reminder_24h_sent: boolean;
          reminder_2h_sent: boolean;
          showing_payload: Record<string, unknown> | null;
          inquiry_payload: Record<string, unknown> | null;
          contact_id: string | null;
          listing_title: string | null;
          locality: string | null;
          address_line: string | null;
          city: string | null;
        }
      | undefined;
  });

  if (!row) {
    return {
      orgId,
      showingId,
      kind,
      sent: false,
      skippedCancelled: false,
      alreadySent: false,
      message: 'Showing not found — reminder not sent',
      connected: false,
      dispatchedTo: null,
    };
  }

  if (row.status === 'cancelled') {
    return {
      orgId,
      showingId,
      kind,
      sent: false,
      skippedCancelled: true,
      alreadySent: false,
      message: 'Showing cancelled — reminder not sent',
      connected: true,
      dispatchedTo: null,
    };
  }

  if (row.status !== 'booked' && row.status !== 'proposed') {
    return {
      orgId,
      showingId,
      kind,
      sent: false,
      skippedCancelled: false,
      alreadySent: false,
      message: `Showing status=${row.status} — reminder not sent`,
      connected: true,
      dispatchedTo: null,
    };
  }

  const already =
    kind === '24h' ? row.reminder_24h_sent === true : row.reminder_2h_sent === true;
  if (already) {
    return {
      orgId,
      showingId,
      kind,
      sent: false,
      skippedCancelled: false,
      alreadySent: true,
      message: `${kind} reminder already marked sent`,
      connected: true,
      dispatchedTo: null,
    };
  }

  const contact = pickContact(row.inquiry_payload || row.showing_payload);
  const when = row.starts_at
    ? new Date(row.starts_at).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'your scheduled time';
  const property =
    row.listing_title ||
    [row.address_line, row.locality, row.city].filter(Boolean).join(', ') ||
    'the property';
  const address =
    [row.address_line, row.locality, row.city].filter(Boolean).join(', ') || property;

  const body =
    kind === '24h'
      ? `Hi ${contact.name}! Reminder: your tour of ${property} is tomorrow (${when}). Reply 1 to confirm or 2 to reschedule.`
      : `Hi ${contact.name}! Your tour of ${property} is in about 2 hours (${when}). Address: ${address}. See you there.`;

  let dispatchedTo: string | null = null;
  let sendDetail = '';
  let connected = true;

  if (contact.phone) {
    const wa = await executeAutonomousToolAction({
      tool: 'whatsapp',
      action: 'send_whatsapp_message',
      payload: { to: contact.phone, body, text: body },
      orgId,
      employeeRole: 'customer',
      source: 'sweep',
    });
    if (wa.status === 'executed') {
      dispatchedTo = contact.phone;
      sendDetail = wa.message;
    } else {
      const sms = await executeAutonomousToolAction({
        tool: 'twilio',
        action: 'send_sms',
        payload: { to: contact.phone, body },
        orgId,
        employeeRole: 'customer',
        source: 'sweep',
      });
      if (sms.status === 'executed') {
        dispatchedTo = contact.phone;
        sendDetail = sms.message;
      } else {
        connected = false;
        sendDetail = `WhatsApp: ${wa.message}; SMS: ${sms.message}`;
      }
    }
  }

  if (!dispatchedTo && contact.email) {
    const mail = await executeAutonomousToolAction({
      tool: 'gmail',
      action: 'send_email',
      payload: {
        to: contact.email,
        subject: kind === '24h' ? `Tour reminder — ${property}` : `Tour in 2 hours — ${property}`,
        body,
      },
      orgId,
      employeeRole: 'customer',
      source: 'sweep',
    });
    if (mail.status === 'executed') {
      dispatchedTo = contact.email;
      sendDetail = mail.message;
      connected = true;
    } else if (!sendDetail) {
      connected = false;
      sendDetail = mail.message;
    }
  }

  if (!contact.phone && !contact.email) {
    return {
      orgId,
      showingId,
      kind,
      sent: false,
      skippedCancelled: false,
      alreadySent: false,
      message:
        'Reminder not sent — inquiry has no contact phone/email. Will not invent a recipient.',
      connected: false,
      dispatchedTo: null,
    };
  }

  if (!dispatchedTo) {
    return {
      orgId,
      showingId,
      kind,
      sent: false,
      skippedCancelled: false,
      alreadySent: false,
      message: `Reminder not delivered — channel not connected. ${sendDetail}`.trim(),
      connected: false,
      dispatchedTo: null,
    };
  }

  // Re-check cancel right before marking sent (race with DELETE/PATCH).
  const marked = await withOrgScopedClient(orgId, async (client) => {
    const res =
      kind === '24h'
        ? await client.query(
            `UPDATE re_showings
                SET reminder_24h_sent = true, updated_at = NOW()
              WHERE id = $1 AND org_id = $2 AND status <> 'cancelled'
              RETURNING id, status`,
            [showingId, orgId]
          )
        : await client.query(
            `UPDATE re_showings
                SET reminder_2h_sent = true, updated_at = NOW()
              WHERE id = $1 AND org_id = $2 AND status <> 'cancelled'
              RETURNING id, status`,
            [showingId, orgId]
          );
    return res.rows[0] as { id: string; status: string } | undefined;
  });

  if (!marked) {
    return {
      orgId,
      showingId,
      kind,
      sent: false,
      skippedCancelled: true,
      alreadySent: false,
      message: 'Showing cancelled after send attempt — flag not set',
      connected: true,
      dispatchedTo,
    };
  }

  return {
    orgId,
    showingId,
    kind,
    sent: true,
    skippedCancelled: false,
    alreadySent: false,
    connected,
    dispatchedTo,
    message: `${kind} reminder sent to ${dispatchedTo}`,
  };
}
