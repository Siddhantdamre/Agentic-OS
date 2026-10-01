import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';

export interface MeetingDossierWorkflowInput {
  orgId: string;
}

const { nowIsoActivity, compileMeetingDossiersActivity } = proxyActivities<{
  nowIsoActivity: () => Promise<string>;
  compileMeetingDossiersActivity: (input: {
    orgId: string;
    businessKey: string;
  }) => Promise<{ scanned: number; compiled: number; posted: number }>;
}>({ startToCloseTimeout: '8 minutes', retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 } });

/**
 * GE-07 Pre-Meeting Account Dossier — polls upcoming Google Calendar
 * meetings every 30 minutes, compiles a 1-page brief for any meeting with a
 * new external attendee domain, and posts it to Slack. Cheap and honest
 * when calendar/web-search/Slack are not connected for the org.
 */
export async function MeetingDossierWorkflow(input: MeetingDossierWorkflowInput): Promise<void> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  for (let i = 0; i < 48; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return;
    const now = await nowIsoActivity();
    await compileMeetingDossiersActivity({
      orgId: input.orgId,
      businessKey: `meeting-dossier:${input.orgId}:${now}`,
    });
    await sleep('30 minutes');
  }
  await continueAsNew<typeof MeetingDossierWorkflow>(input);
}
