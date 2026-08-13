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
}> {
  const orgId = requireOrgId(params.orgId);
  if (params.pspPaymentId) {
    const closed = await executeAutonomousToolAction({
      tool: 're',
      action: 'charge_close',
      payload: { chargeId: params.chargeId, pspPaymentId: params.pspPaymentId },
      orgId,
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
  return {
    orgId,
    chargeId: params.chargeId,
    reminded: true,
    closed: false,
    claimedPaid: false,
    message: 'Rent reminder recorded. Charge remains open until PSP webhook.',
  };
}
