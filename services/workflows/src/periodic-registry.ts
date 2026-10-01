import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { workerPool } from './db.js';

export const EMPLOYEE_SWEEP_TASK_QUEUE = 'darex-agent-tasks';

export function openLoopsWorkflowId(orgId: string): string { return `open-loops:${orgId}`; }
export function morningCheckWorkflowId(orgId: string): string { return `morning-check:${orgId}`; }
export function stuckWorkWorkflowId(orgId: string): string { return `stuck-work:${orgId}`; }
export function repFollowUpSlaWorkflowId(orgId: string): string { return `rep-followup-sla:${orgId}`; }
export function workloadBalancerWorkflowId(orgId: string): string { return `workload-balancer:${orgId}`; }
export function growthWatchWorkflowId(orgId: string): string { return `growth-watch:${orgId}`; }
export function marketScoutWorkflowId(orgId: string): string { return `market-scout:${orgId}`; }
export function meetingDossierWorkflowId(orgId: string): string { return `meeting-dossier:${orgId}`; }
export function replySorterWorkflowId(orgId: string): string { return `reply-sorter:${orgId}`; }
export function conversationalInsightWorkflowId(orgId: string): string {
  return `customer-insights:${orgId}`;
}
export function meetingPrepWorkflowId(orgId: string): string { return `meeting-prep:${orgId}`; }
export function systemReconciliationWorkflowId(orgId: string): string { return `system-reconciliation:${orgId}`; }
export function governanceSweepWorkflowId(orgId: string): string { return `governance-sweep:${orgId}`; }
export function dormantLeadRevivalWorkflowId(orgId: string): string { return `dormant-lead-revival:${orgId}`; }

type SweepDef = {
  workflowType: string;
  id: (orgId: string) => string;
  /** Extra workflow input beyond { orgId }. */
  extraArgs?: Record<string, unknown>;
};

/**
 * The one list of per-org periodic sweeps. Worker boot (bootstrapPeriodicSweeps)
 * and org provisioning (dashboard kickPeriodicSweeps → startSweepsForOrg) both
 * read it, so a new org gets exactly the sweeps a restarted worker would start.
 */
export const PERIODIC_SWEEPS: readonly SweepDef[] = [
  { workflowType: 'OpenLoopMonitorWorkflow', id: openLoopsWorkflowId },
  { workflowType: 'MorningCheckWorkflow', id: morningCheckWorkflowId },
  { workflowType: 'StuckWorkDetectorWorkflow', id: stuckWorkWorkflowId },
  { workflowType: 'RepFollowUpSlaWorkflow', id: repFollowUpSlaWorkflowId },
  { workflowType: 'WorkloadBalancerWorkflow', id: workloadBalancerWorkflowId },
  { workflowType: 'GrowthWatcherWorkflow', id: growthWatchWorkflowId },
  { workflowType: 'MarketScoutWorkflow', id: marketScoutWorkflowId },
  { workflowType: 'MeetingDossierWorkflow', id: meetingDossierWorkflowId },
  { workflowType: 'ReplySorterWorkflow', id: replySorterWorkflowId },
  { workflowType: 'ConversationalInsightWorkflow', id: conversationalInsightWorkflowId },
  { workflowType: 'MeetingPrepWorkflow', id: meetingPrepWorkflowId },
  { workflowType: 'SystemReconciliationWorkflow', id: systemReconciliationWorkflowId },
  { workflowType: 'GovernanceSweepWorkflow', id: governanceSweepWorkflowId },
  {
    workflowType: 'DormantLeadRevivalWorkflow',
    id: dormantLeadRevivalWorkflowId,
    extraArgs: { repeat: true },
  },
];

export type SweepStartClient = {
  workflow: {
    start: (
      workflowType: string,
      options: {
        workflowId: string;
        taskQueue: string;
        args: unknown[];
        workflowIdReusePolicy: 'ALLOW_DUPLICATE';
      }
    ) => Promise<unknown>;
  };
};

function isAlreadyStarted(err: unknown): boolean {
  if (err instanceof WorkflowExecutionAlreadyStartedError) return true;
  return (err as { name?: string })?.name === 'WorkflowExecutionAlreadyStartedError';
}

/**
 * Start every sweep for one org. ALLOW_DUPLICATE: a sweep that ended (org
 * suspended, then reactivated; or completed) is started again, while a
 * running one is left alone (WorkflowExecutionAlreadyStarted).
 */
export async function startSweepsForOrg(client: SweepStartClient | Client, orgId: string): Promise<{ started: number; already: number }> {
  let started = 0;
  let already = 0;
  for (const p of PERIODIC_SWEEPS) {
    try {
      await (client as SweepStartClient).workflow.start(p.workflowType, {
        workflowId: p.id(orgId),
        taskQueue: EMPLOYEE_SWEEP_TASK_QUEUE,
        args: [{ orgId, ...(p.extraArgs || {}) }],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      });
      started += 1;
    } catch (err) {
      if (isAlreadyStarted(err)) { already += 1; continue; }
      throw err;
    }
  }
  return { started, already };
}

export async function bootstrapPeriodicSweeps(client: Client): Promise<{ started: number; already: number }> {
  const db = await workerPool.connect();
  let orgs: string[] = [];
  try {
    const res = await db.query<{ id: string }>(`SELECT id FROM orgs WHERE status IN ('active', 'provisioning')`);
    orgs = res.rows.map((r) => r.id);
  } finally {
    db.release();
  }
  let started = 0;
  let already = 0;
  for (const orgId of orgs) {
    const counts = await startSweepsForOrg(client, orgId);
    started += counts.started;
    already += counts.already;
  }
  return { started, already };
}
