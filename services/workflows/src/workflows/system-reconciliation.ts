import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';
import type { ReconciliationReport } from '../operations/reconciliation.js';

export interface SystemReconciliationWorkflowInput {
  orgId: string;
  intervalHours?: number;
  repeat?: boolean;
}

export interface SystemReconciliationWorkflowResult {
  orgId: string;
  report: ReconciliationReport;
}

const { auditReconciliationActivity } = proxyActivities<{
  auditReconciliationActivity: (params: { orgId: string; staleDaysThreshold?: number }) => Promise<ReconciliationReport>;
}>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '5s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['InvalidArgumentError'],
  },
});

/**
 * Daily cross-system reconciliation audit workflow (03 §7, Blueprint pp. 79-80).
 * Scans CRM leads vs website/inbound enquiries for missing records, duplicates, and drift.
 */
export async function SystemReconciliationWorkflow(
  input: SystemReconciliationWorkflowInput
): Promise<SystemReconciliationWorkflowResult> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }

  if (!(await orgSweepAllowed(input.orgId))) {
    return { orgId: input.orgId, report: null } as unknown as SystemReconciliationWorkflowResult;
  }
  const report = await auditReconciliationActivity({ orgId: input.orgId });

  if (input.repeat !== false) {
    const hours = input.intervalHours ?? 24;
    await sleep(hours * 3600_000);
    await continueAsNew<typeof SystemReconciliationWorkflow>({
      orgId: input.orgId,
      intervalHours: hours,
      repeat: true,
    });
  }

  return { orgId: input.orgId, report };
}
