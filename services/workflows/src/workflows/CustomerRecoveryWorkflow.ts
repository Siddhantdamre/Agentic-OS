import { ApplicationFailure, proxyActivities, sleep } from '@temporalio/workflow';

export interface CustomerRecoveryWorkflowInput {
  orgId: string;
  conversationId: string;
  customerIdentifier?: string;
  workItemId?: string;
  sinceIso?: string;
}

const acts = proxyActivities<{
  nowIsoActivity: () => Promise<string>;
  checkCustomerHealthActivity: (input: {
    orgId: string;
    sinceIso: string;
    customerIdentifier: string;
  }) => Promise<{ atRisk: boolean; reason: string }>;
  sendCheckInActivity: (input: {
    orgId: string;
    customerIdentifier: string;
    conversationId?: string;
    workflowId: string;
    businessKey: string;
  }) => Promise<{ sent: boolean; reason: string }>;
  persistOperationalStateActivity: (input: {
    orgId: string;
    conversationId: string;
    userMessage: string;
    forceEscalate?: boolean;
  }) => Promise<{ state: string }>;
}>({ startToCloseTimeout: '2 minutes' });

export async function CustomerRecoveryWorkflow(
  input: CustomerRecoveryWorkflowInput,
): Promise<{ atRisk: boolean; sent: boolean; reason: string }> {
  const customerIdentifier = input.customerIdentifier || input.conversationId;
  if (!input.orgId || !customerIdentifier) {
    throw ApplicationFailure.nonRetryable('orgId and customerIdentifier are required', 'InvalidArgumentError');
  }

  await sleep('24 hours');

  const nowIso = await acts.nowIsoActivity();
  const sinceIso = input.sinceIso || nowIso;
  const health = await acts.checkCustomerHealthActivity({
    orgId: input.orgId,
    sinceIso,
    customerIdentifier,
  });
  if (!health.atRisk) {
    if (input.conversationId) {
      await acts.persistOperationalStateActivity({
        orgId: input.orgId,
        conversationId: input.conversationId,
        userMessage: 'resolved',
      });
    }
    return { atRisk: false, sent: false, reason: health.reason };
  }

  const send = await acts.sendCheckInActivity({
    orgId: input.orgId,
    customerIdentifier,
    conversationId: input.conversationId,
    workflowId: `recovery:${input.conversationId}`,
    businessKey: `recovery:${input.conversationId}:${sinceIso}`,
  });
  return { atRisk: true, sent: send.sent, reason: send.reason };
}
