/**
 * SUPERVISION: GAP — writes the briefing an owner reads first thing. A wrong
 * briefing is acted on before anyone checks it.
 */
import {
  ApplicationFailure,
  continueAsNew,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface OwnerBriefingWorkflowInput {
  orgId: string;
  timeZone?: string;
  hour?: number;
  /** Durable daily cron via continueAsNew. Default true. */
  repeatDaily?: boolean;
  idempotencyKey?: string;
}

export interface OwnerBriefingWorkflowResult {
  orgId: string;
  generatedAt: string;
  points: Array<{ metricId: string; value: number }>;
  gaps: string[];
  narrative: string;
  needsAttention: number;
}

const {
  queryBriefingMetricsActivity,
  listNeedsAttentionActivity,
  narrateBriefingActivity,
  persistBriefingActivity,
  msUntilNextHourActivity,
} = proxyActivities<typeof activities>({
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

/**
 * Daily owner briefing (O5). Aggregates semantic metrics + needs_attention.
 * LiteLLM sees pre-aggregated numbers only — never raw `messages` rows.
 */
export async function OwnerBriefingWorkflow(
  input: OwnerBriefingWorkflowInput
): Promise<OwnerBriefingWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  const timeZone = input.timeZone || 'UTC';
  const hour = typeof input.hour === 'number' ? input.hour : 8;
  const repeatDaily = input.repeatDaily !== false;

  const metrics = await queryBriefingMetricsActivity({
    orgId,
    businessKey: input.idempotencyKey || `briefing:${orgId}`,
  });
  const attention = await listNeedsAttentionActivity({
    orgId,
    businessKey: `${input.idempotencyKey || orgId}:attention`,
  });
  const attentionMetric = metrics.points.find((p) => p.metricId === 'core.needs_attention');
  const needsAttentionCount =
    typeof attentionMetric?.value === 'number' ? attentionMetric.value : attention.count;
  const narrated = await narrateBriefingActivity({
    orgId,
    points: metrics.points,
    gaps: metrics.gaps,
    needsAttentionCount,
    businessKey: `${input.idempotencyKey || orgId}:narrative`,
  });
  const persisted = await persistBriefingActivity({
    orgId,
    points: metrics.points,
    gaps: metrics.gaps,
    narrative: narrated.narrative,
    needsAttentionCount,
    businessKey: `${input.idempotencyKey || orgId}:persist`,
  });

  const result: OwnerBriefingWorkflowResult = {
    orgId,
    generatedAt: persisted.generatedAt,
    points: metrics.points.map((p) => ({ metricId: p.metricId, value: p.value })),
    gaps: metrics.gaps,
    narrative: narrated.narrative,
    needsAttention: needsAttentionCount,
  };

  if (repeatDaily) {
    const waitMs = await msUntilNextHourActivity({ timeZone, hour });
    if (waitMs > 0) await sleep(waitMs);
    await continueAsNew<typeof OwnerBriefingWorkflow>({
      orgId,
      timeZone,
      hour,
      repeatDaily: true,
    });
  }

  return result;
}
