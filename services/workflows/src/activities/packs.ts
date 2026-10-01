/**
 * Pack + RE activities. SQL goes through session RLS. Never trust caller org
 * beyond the workflow input that the worker already scoped.
 */

import { ApplicationFailure } from '@temporalio/activity';
import type { InstallPackWorkflowResult } from '@darex/shared-types';
import { executeAutonomousToolAction } from '../tool-executor.js';
import { withOrgScopedClient } from '../tools/shared.js';
import { installPackForOrg, uninstallPackForOrg } from '../packs/install-pack.js';

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

export async function installPackActivity(params: {
  orgId: string;
  packId: string;
  idempotencyKey?: string;
}): Promise<InstallPackWorkflowResult> {
  const orgId = requireOrgId(params.orgId);
  return withOrgScopedClient(orgId, (client) => installPackForOrg(client, orgId, params.packId));
}

export async function uninstallPackActivity(params: {
  orgId: string;
  packId: string;
}): Promise<{ orgId: string; packId: string; status: 'uninstalled'; conversationsDeleted: false }> {
  const orgId = requireOrgId(params.orgId);
  const result = await withOrgScopedClient(orgId, (client) =>
    uninstallPackForOrg(client, orgId, params.packId)
  );
  return {
    orgId: result.orgId,
    packId: result.packId,
    status: 'uninstalled',
    conversationsDeleted: false,
  };
}

export async function bookShowingActivity(params: {
  orgId: string;
  listingId?: string;
  inquiryId?: string;
  startTime: string;
  endTime?: string;
  summary?: string;
  businessKey: string;
}): Promise<{
  orgId: string;
  booked: boolean;
  connected: boolean;
  setupUrl?: string;
  showingId?: string;
  conflict?: boolean;
  message: string;
}> {
  const orgId = requireOrgId(params.orgId);
  const result = await executeAutonomousToolAction({
    tool: 're',
    action: 'showing_book',
    payload: {
      listingId: params.listingId,
      inquiryId: params.inquiryId,
      startTime: params.startTime,
      endTime: params.endTime,
      summary: params.summary,
    },
    orgId,
    employeeRole: 'operations',
    source: 'sweep',
  });
  const data = (result.data || {}) as {
    booked?: boolean;
    connected?: boolean;
    setupUrl?: string;
    showing?: { id?: string };
    conflict?: boolean;
  };
  return {
    orgId,
    booked: data.booked === true && result.status === 'executed',
    connected: data.connected !== false,
    setupUrl: data.setupUrl,
    showingId: data.showing?.id,
    conflict: data.conflict === true,
    message: result.message,
  };
}

export async function rentReminderActivity(params: {
  orgId: string;
  chargeId: string;
  tenantClaimedPaid?: boolean;
  pspPaymentId?: string;
  businessKey: string;
}): Promise<{
  orgId: string;
  chargeId: string;
  reminded: boolean;
  closed: boolean;
  claimedPaid: boolean;
  message: string;
  dispatchedTo?: string | null;
  connected?: boolean;
}> {
  const orgId = requireOrgId(params.orgId);
  if (params.pspPaymentId) {
    const closed = await executeAutonomousToolAction({
      tool: 're',
      action: 'charge_close',
      payload: { chargeId: params.chargeId, pspPaymentId: params.pspPaymentId },
      orgId,
      employeeRole: 'operations',
      source: 'sweep',
    });
    const data = (closed.data || {}) as { closed?: boolean };
    return {
      orgId,
      chargeId: params.chargeId,
      reminded: true,
      closed: data.closed === true,
      claimedPaid: false,
      message: closed.message,
    };
  }
  if (params.tenantClaimedPaid) {
    const claimed = await executeAutonomousToolAction({
      tool: 're',
      action: 'charge_claim_paid',
      payload: { chargeId: params.chargeId },
      orgId,
      employeeRole: 'operations',
      source: 'sweep',
    });
    const data = (claimed.data || {}) as { closed?: boolean; charge?: { claimedPaidAt?: string } };
    return {
      orgId,
      chargeId: params.chargeId,
      reminded: true,
      closed: data.closed === true,
      claimedPaid: Boolean(data.charge?.claimedPaidAt),
      message: claimed.message,
    };
  }

  // Real outbound reminder — never pretend success when channel is disconnected.
  const row = await withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT c.id, c.amount, c.currency, c.due_at, c.payload AS charge_payload,
              l.payload AS lease_payload, l.tenant_ref
         FROM pm_charges c
         LEFT JOIN pm_leases l ON l.id = c.lease_id AND l.org_id = c.org_id
        WHERE c.id = $1 AND c.org_id = $2
        LIMIT 1`,
      [params.chargeId, orgId]
    );
    return res.rows[0] as
      | {
          id: string;
          amount: string | number;
          currency: string;
          due_at: string | null;
          charge_payload: Record<string, unknown> | null;
          lease_payload: Record<string, unknown> | null;
          tenant_ref: string | null;
        }
      | undefined;
  });

  if (!row) {
    return {
      orgId,
      chargeId: params.chargeId,
      reminded: false,
      closed: false,
      claimedPaid: false,
      message: 'Charge not found for org — reminder not sent',
      connected: false,
    };
  }

  const lease = (row.lease_payload || {}) as Record<string, unknown>;
  const chargePayload = (row.charge_payload || {}) as Record<string, unknown>;
  const tenantName =
    (typeof lease.tenant_name === 'string' && lease.tenant_name) || row.tenant_ref || 'tenant';
  const phone = typeof lease.tenant_phone === 'string' ? lease.tenant_phone.trim() : '';
  const email = typeof lease.tenant_email === 'string' ? lease.tenant_email.trim() : '';
  const property =
    (typeof lease.property_address === 'string' && lease.property_address) || 'your unit';
  const payUrl =
    (typeof chargePayload.payment_url === 'string' && chargePayload.payment_url) ||
    null;
  const due = row.due_at ? new Date(row.due_at).toLocaleDateString() : 'the due date';
  const body = `Hello ${tenantName}, this is a reminder that rent of ${row.currency} ${row.amount} for ${property} is due on ${due}.${payUrl ? ` Pay here: ${payUrl}` : ''} Charge remains open until payment is confirmed.`;

  let dispatchedTo: string | null = null;
  let sendDetail = '';

  if (phone) {
    const wa = await executeAutonomousToolAction({
      tool: 'whatsapp',
      action: 'send_whatsapp_message',
      payload: { to: phone, body, text: body },
      orgId,
      employeeRole: 'customer',
      source: 'sweep',
    });
    if (wa.status === 'executed') {
      dispatchedTo = phone;
      sendDetail = wa.message;
    } else {
      const sms = await executeAutonomousToolAction({
        tool: 'twilio',
        action: 'send_sms',
        payload: { to: phone, body },
        orgId,
        employeeRole: 'customer',
        source: 'sweep',
      });
      if (sms.status === 'executed') {
        dispatchedTo = phone;
        sendDetail = sms.message;
      } else {
        sendDetail = `WhatsApp: ${wa.message}; SMS: ${sms.message}`;
      }
    }
  }

  if (!dispatchedTo && email) {
    const mail = await executeAutonomousToolAction({
      tool: 'gmail',
      action: 'send_email',
      payload: {
        to: email,
        subject: `Rent reminder — ${property}`,
        body,
      },
      orgId,
      employeeRole: 'customer',
      source: 'sweep',
    });
    if (mail.status === 'executed') {
      dispatchedTo = email;
      sendDetail = mail.message;
    } else if (!sendDetail) {
      sendDetail = mail.message;
    }
  }

  if (!phone && !email) {
    return {
      orgId,
      chargeId: params.chargeId,
      reminded: false,
      closed: false,
      claimedPaid: false,
      message:
        'Rent reminder not sent — lease has no tenant_phone or tenant_email. Charge remains open until PSP webhook.',
      connected: false,
      dispatchedTo: null,
    };
  }

  if (!dispatchedTo) {
    return {
      orgId,
      chargeId: params.chargeId,
      reminded: false,
      closed: false,
      claimedPaid: false,
      message: `Rent reminder not delivered — channel not connected. ${sendDetail}`.trim(),
      connected: false,
      dispatchedTo: null,
    };
  }

  return {
    orgId,
    chargeId: params.chargeId,
    reminded: true,
    closed: false,
    claimedPaid: false,
    message: `Rent reminder sent to ${dispatchedTo}. Charge remains open until PSP webhook. ${sendDetail}`.trim(),
    connected: true,
    dispatchedTo,
  };
}
