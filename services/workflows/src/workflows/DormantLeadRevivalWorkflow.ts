import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type * as governance from '../activities/sweep-governance.js';
import { orgSweepAllowed } from './sweep-gate.js';
import type * as growthActivities from '../activities/growth.js';
import type { RankedCandidate } from '@darex/shared-types';

export interface DormantLeadRevivalWorkflowInput {
  orgId: string;
  staleDays?: number;
  idempotencyKey?: string;
  /** Periodic mode (registered sweep): weekly pass, then continue-as-new. */
  repeat?: boolean;
}

export interface DormantLeadRevivalWorkflowResult {
  orgId: string;
  revived: number;
}

const { listDormantLeadsActivity, createOpportunityActivity, recordGrowthRoiActivity } = proxyActivities<
  typeof growthActivities
>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '6 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

const { claimSweepRunActivity } = proxyActivities<typeof governance>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '2s', backoffCoefficient: 2, maximumAttempts: 5 },
});

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

export async function DormantLeadRevivalWorkflow(
  input: DormantLeadRevivalWorkflowInput,
): Promise<DormantLeadRevivalWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  if (input.repeat) {
    // OPS-B04: registered as a weekly per-org sweep. One pass per ISO week
    // even across restarts; the org status gate stops it on suspension.
    if (!(await orgSweepAllowed(orgId))) return { orgId, revived: 0 };
    const { claimed } = await claimSweepRunActivity({ orgId, kind: 'dormant-lead-revival', period: 'week' });
    const revived = claimed ? await revivePass(orgId, input) : 0;
    await sleep('7 days');
    await continueAsNew<typeof DormantLeadRevivalWorkflow>(input);
    return { orgId, revived };
  }
  return { orgId, revived: await revivePass(orgId, input) };
}

async function revivePass(orgId: string, input: DormantLeadRevivalWorkflowInput): Promise<number> {
  const listed = await listDormantLeadsActivity({
    orgId,
    staleDays: input.staleDays ?? 180,
    businessKey: input.idempotencyKey || `dormant:${orgId}`,
  });

  let revived = 0;
  for (const lead of listed.leads.slice(0, 20)) {
    const candidate: RankedCandidate = {
      companyName: lead.companyName,
      domain: lead.domain,
      activeSignals: [
        {
          type: 'intent',
          summary: 'Dormant CRM/conversation lead showed a fresh buying signal',
          timestamp: new Date().toISOString(),
        },
      ],
      fit: 0.5,
      now: 0.5,
      score: 70,
    };
    const created = await createOpportunityActivity({
      orgId,
      candidate,
      businessKey: `${input.idempotencyKey || orgId}:revive:${lead.domain}`,
    });
    if (created.created) {
      revived += 1;
      await recordGrowthRoiActivity({
        orgId,
        opportunityWorkItemId: created.workItemId,
        stage: 'created',
        businessKey: `${input.idempotencyKey || orgId}:roi:${created.workItemId}`,
      });
    }
  }

  return revived;
}
