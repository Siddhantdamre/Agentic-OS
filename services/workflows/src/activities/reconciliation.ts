import { ApplicationFailure } from '@temporalio/activity';
import { withOrgClient } from '../db.js';
import { auditCrossSystemReconciliation, type ReconciliationReport } from '../operations/reconciliation.js';

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  return orgId;
}

export async function auditReconciliationActivity(params: {
  orgId: string;
  staleDaysThreshold?: number;
}): Promise<ReconciliationReport> {
  const orgId = requireOrgId(params.orgId);
  return withOrgClient(orgId, async (client) => {
    return auditCrossSystemReconciliation(client, orgId, {
      staleDaysThreshold: params.staleDaysThreshold,
    });
  });
}
