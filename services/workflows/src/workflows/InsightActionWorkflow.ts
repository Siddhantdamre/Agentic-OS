import { ApplicationFailure, proxyActivities, startChild, ParentClosePolicy } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import { insightActionWorkflowId, ownerBriefingWorkflowId, staleChaseWorkflowId } from '../quiet-hours.js';
import { OwnerBriefingWorkflow } from './OwnerBriefingWorkflow.js';
import { StaleChaseWorkflow } from './StaleChaseWorkflow.js';

export const INSIGHT_NAMED_WORKFLOWS = ['StaleChaseWorkflow', 'OwnerBriefingWorkflow'] as const;

export type InsightNamedWorkflow = (typeof INSIGHT_NAMED_WORKFLOWS)[number];

export interface InsightActionWorkflowInput {
  orgId: string;
  metricId: string;
  namedWorkflow: InsightNamedWorkflow;
  cardId?: string;
  timeZone?: string;
  idempotencyKey?: string;
}

export type InsightActionStatus = 'executed' | 'notConnected' | 'error' | 'skipped';

export interface InsightActionWorkflowResult {
  orgId: string;
  metricId: string;
  namedWorkflow: InsightNamedWorkflow;
  metricValue: number | null;
  childWorkflowId: string | null;
  /** False when the child failed or a connector was notConnected. */
  success: boolean;
  status: InsightActionStatus;
  message: string;
}

const { queryInsightMetricActivity, persistInsightActionActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '6 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

function isNamedWorkflow(value: string): value is InsightNamedWorkflow {
  return (INSIGHT_NAMED_WORKFLOWS as readonly string[]).includes(value);
}

/**
 * Review Action from Insight (A3). Re-reads the metric SQL, then starts a
 * **named** child workflow. Never a free-form agent. notConnected is not success.
 */
export async function InsightActionWorkflow(
  input: InsightActionWorkflowInput
): Promise<InsightActionWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  if (!isNamedWorkflow(input.namedWorkflow)) {
    throw ApplicationFailure.nonRetryable(
      `Unsupported named workflow: ${input.namedWorkflow}`,
      'InvalidArgumentError'
    );
  }
  const namedWorkflow = input.namedWorkflow;
  const metricId = input.metricId;
  const businessKey = input.idempotencyKey || insightActionWorkflowId(orgId, metricId);

  const metric = await queryInsightMetricActivity({
    orgId,
    metricId,
    businessKey: `${businessKey}:metric`,
  });

  if (metric.status === 'notConnected') {
    const result: InsightActionWorkflowResult = {
      orgId,
      metricId,
      namedWorkflow,
      metricValue: metric.value,
      childWorkflowId: null,
      success: false,
      status: 'notConnected',
      message: metric.message,
    };
    await persistInsightActionActivity({
      orgId,
      metricId,
      namedWorkflow,
      childWorkflowId: null,
      success: false,
      status: 'notConnected',
      metricValue: metric.value,
      message: metric.message,
      businessKey: `${businessKey}:persist`,
    });
    return result;
  }

  if (metric.status === 'error' || metric.value === null) {
    const result: InsightActionWorkflowResult = {
      orgId,
      metricId,
      namedWorkflow,
      metricValue: metric.value,
      childWorkflowId: null,
      success: false,
      status: 'error',
      message: metric.message,
    };
    await persistInsightActionActivity({
      orgId,
      metricId,
      namedWorkflow,
      childWorkflowId: null,
      success: false,
      status: 'error',
      metricValue: metric.value,
      message: metric.message,
      businessKey: `${businessKey}:persist`,
    });
    return result;
  }

  let childWorkflowId: string | null = null;
  let status: InsightActionStatus = 'executed';
  let success = false;
  let message = '';

  switch (namedWorkflow) {
    case 'StaleChaseWorkflow': {
      childWorkflowId = staleChaseWorkflowId(orgId, businessKey);
      try {
        const child = await startChild(StaleChaseWorkflow, {
          workflowId: childWorkflowId,
          args: [
            {
              orgId,
              timeZone: input.timeZone || 'UTC',
              idempotencyKey: `${businessKey}:stale`,
            },
          ],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
          workflowExecutionTimeout: '30 minutes',
        });
        const childResult = await child.result();
        success = true;
        message = `StaleChaseWorkflow flagged ${childResult.flagged}, chased ${childResult.chased}, skipped ${childResult.skipped}.`;
      } catch (err: unknown) {
        status = 'error';
        success = false;
        message = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case 'OwnerBriefingWorkflow': {
      childWorkflowId = `${ownerBriefingWorkflowId(orgId)}-insight-${businessKey.slice(-12)}`;
      try {
        const child = await startChild(OwnerBriefingWorkflow, {
          workflowId: childWorkflowId,
          args: [
            {
              orgId,
              timeZone: input.timeZone || 'UTC',
              repeatDaily: false,
              idempotencyKey: `${businessKey}:briefing`,
            },
          ],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
          workflowExecutionTimeout: '10 minutes',
        });
        const childResult = await child.result();
        success = true;
        message = `OwnerBriefingWorkflow generated at ${childResult.generatedAt}.`;
      } catch (err: unknown) {
        status = 'error';
        success = false;
        message = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    default: {
      const _exhaustive: never = namedWorkflow;
      throw ApplicationFailure.nonRetryable(
        `Unhandled named workflow: ${_exhaustive}`,
        'InvalidArgumentError'
      );
    }
  }

  const result: InsightActionWorkflowResult = {
    orgId,
    metricId,
    namedWorkflow,
    metricValue: metric.value,
    childWorkflowId,
    success,
    status,
    message,
  };

  await persistInsightActionActivity({
    orgId,
    metricId,
    namedWorkflow,
    childWorkflowId,
    success,
    status,
    metricValue: metric.value,
    message,
    businessKey: `${businessKey}:persist`,
  });

  return result;
}
