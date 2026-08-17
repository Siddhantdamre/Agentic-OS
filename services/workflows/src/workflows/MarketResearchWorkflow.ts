import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

/**
 * Market research — durable, optionally recurring.
 *
 * Runs a sourced research pass on a topic and logs the result. Recurrence uses
 * `continueAsNew` (the same pattern as OwnerBriefingWorkflow) rather than an
 * external scheduler, so the cadence survives worker restarts without extra
 * infrastructure.
 *
 * NOTE ON EMPTY RESULTS: a run with zero findings is a SUCCESS, not a failure.
 * If no search provider is configured, or the sources genuinely do not support
 * a claim, the correct output is an empty report carrying its reason. Retrying
 * that would burn quota to reach the same honest answer, so it is not retried.
 */

export interface MarketResearchWorkflowInput {
  orgId: string;
  topic: string;
  /** Additional queries to broaden coverage. */
  queries?: string[];
  maxSources?: number;
  /** Re-run on an interval. Omit or 0 for a single pass. */
  repeatEveryHours?: number;
  idempotencyKey?: string;
}

export interface MarketResearchWorkflowResult {
  orgId: string;
  topic: string;
  findingCount: number;
  /** Findings backed by two or more independent publishers. */
  corroboratedCount: number;
  domainsConsulted: string[];
  openQuestions: string[];
  rendered: string;
  reason?: string;
}

const { researchTopicActivity, logChannelActivity } = proxyActivities<typeof activities>({
  // Search + extract + synthesis across several queries.
  startToCloseTimeout: '5 minutes',
  scheduleToCloseTimeout: '12 minutes',
  retry: {
    initialInterval: '10s',
    maximumAttempts: 2,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

/** Bound the cadence: hourly is the floor, monthly the ceiling. */
const MIN_REPEAT_HOURS = 1;
const MAX_REPEAT_HOURS = 24 * 30;

export async function MarketResearchWorkflow(
  input: MarketResearchWorkflowInput
): Promise<MarketResearchWorkflowResult> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  if (!input.topic || !input.topic.trim()) {
    throw ApplicationFailure.nonRetryable('topic is required', 'InvalidArgumentError');
  }

  const outcome = await researchTopicActivity({
    orgId: input.orgId,
    topic: input.topic,
    queries: input.queries,
    maxSources: input.maxSources,
  });

  const corroboratedCount = outcome.report.findings.filter(
    (f) => f.independentSourceCount >= 2
  ).length;

  await logChannelActivity({
    orgId: input.orgId,
    logType: 'MARKET_RESEARCH',
    payload: {
      topic: input.topic,
      findingCount: outcome.report.findings.length,
      // Recorded separately because it is the number worth trusting: a report
      // of 9 single-source findings is far weaker than 3 corroborated ones,
      // and a raw total hides that.
      corroboratedCount,
      rejectedCount: outcome.report.rejected.length,
      domainsConsulted: outcome.report.domainsConsulted,
      reason: outcome.reason,
    },
    idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:research-log` : undefined,
  });

  const result: MarketResearchWorkflowResult = {
    orgId: input.orgId,
    topic: input.topic,
    findingCount: outcome.report.findings.length,
    corroboratedCount,
    domainsConsulted: outcome.report.domainsConsulted,
    openQuestions: outcome.report.openQuestions,
    rendered: outcome.rendered,
    reason: outcome.reason,
  };

  const repeat = input.repeatEveryHours ?? 0;
  if (repeat > 0) {
    const hours = Math.max(MIN_REPEAT_HOURS, Math.min(MAX_REPEAT_HOURS, repeat));
    await sleep(hours * 60 * 60 * 1000);
    // continueAsNew resets workflow history, so a long-lived schedule does not
    // grow an unbounded event log.
    await continueAsNew<typeof MarketResearchWorkflow>({
      ...input,
      repeatEveryHours: hours,
      // New idempotency scope per cycle, or every run after the first would
      // return the first run's cached log entry.
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:next` : undefined,
    });
  }

  return result;
}
