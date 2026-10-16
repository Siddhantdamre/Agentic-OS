import { ApplicationFailure, continueAsNew, patched, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';
import type * as activities from '../activities/index.js';

export interface MorningCheckWorkflowInput {
  orgId: string;
  intervalMinutes?: number;
  repeat?: boolean;
  /** Local hour (0-23) the triage should run at. Default 9 (9:00 AM). */
  hour?: number;
}

export interface MorningCheckWorkflowResult {
  orgId: string;
  due: number;
  idle: boolean;
  processed: number;
}

const {
  countDueSweepActivity,
  getOrgTimeZoneActivity,
  msUntilNextHourActivity,
  runMorningCheckActivity,
  deliverBriefActivity,
  claimSweepRunActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/**
 * Daily org-wide morning check (OE-01). Waits until 9:00 AM in the org's
 * configured local timezone, runs overnight triage, then continues-as-new
 * to wait for the next day. First pass runs immediately so a freshly
 * started workflow does not wait a full day for its initial triage, but the
 * brief is claimed once per org-local day, so a worker restart or a re-start
 * of the workflow never delivers a second brief the same day (OPS-B06).
 */
export async function MorningCheckWorkflow(
  input: MorningCheckWorkflowInput
): Promise<MorningCheckWorkflowResult> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  const hour = typeof input.hour === 'number' ? input.hour : 9;

  if (!(await orgSweepAllowed(input.orgId))) {
    return { orgId: input.orgId, due: 0, idle: true, processed: 0 };
  }
  let alreadyDelivered = false;
  if (patched('morning-brief-daily-claim-v1')) {
    const { timeZone } = await getOrgTimeZoneActivity({ orgId: input.orgId });
    const claim = await claimSweepRunActivity({
      orgId: input.orgId,
      kind: 'morning-brief',
      period: 'day',
      timeZone,
    });
    alreadyDelivered = !claim.claimed;
  }

  let dueCount = 0;
  let idle = true;
  let processed = 0;
  if (!alreadyDelivered) {
    const assessed = await countDueSweepActivity({
      orgId: input.orgId,
      kind: 'morning_check',
      before: new Date().toISOString(),
    });
    const triage = await runMorningCheckActivity({
      orgId: input.orgId,
      before: new Date().toISOString(),
    });
    await deliverBriefActivity({ orgId: input.orgId, brief: triage.brief });
    dueCount = assessed.dueCount;
    idle = assessed.idle;
    processed = triage.processed;
  }

  if (input.repeat !== false) {
    const { timeZone } = await getOrgTimeZoneActivity({ orgId: input.orgId });
    const waitMs = await msUntilNextHourActivity({ timeZone, hour });
    await sleep(Math.max(waitMs, (input.intervalMinutes ?? 0) * 60_000));
    await continueAsNew<typeof MorningCheckWorkflow>({
      orgId: input.orgId,
      intervalMinutes: input.intervalMinutes,
      repeat: true,
      hour,
    });
  }
  return { orgId: input.orgId, due: dueCount, idle, processed };
}
