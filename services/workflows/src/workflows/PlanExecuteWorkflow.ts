/**
 * SUPERVISION: GAP — executes a plan a human confirmed. The confirmation is
 * a gate before the work, not supervision of how it went - a step that
 * half-succeeded is judged by nothing.
 */
import {
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export type PlanConfirmDecision = 'approved' | 'rejected';

export type PlanExecuteStatus =
  | 'waiting_approval'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled';

export interface PlanExecuteWorkflowInput {
  orgId: string;
  planId: string;
  /** When true, block until PlanCard approve/reject signal (O7). */
  waitForApproval?: boolean;
  idempotencyKey?: string;
}

export interface PlanExecuteEvent {
  seq: number;
  event: string;
  data: Record<string, unknown>;
}

export interface PlanExecuteProgress {
  status: PlanExecuteStatus;
  events: PlanExecuteEvent[];
  results: Array<Record<string, unknown>>;
  done: boolean;
}

export interface PlanExecuteWorkflowResult {
  planId: string;
  status: PlanExecuteStatus;
  results: Array<Record<string, unknown>>;
}

export const approvePlanSignal = defineSignal<[PlanConfirmDecision?]>('approvePlan');
export const rejectPlanSignal = defineSignal('rejectPlan');
export const planProgressQuery = defineQuery<PlanExecuteProgress>('planProgressQuery');

const {
  loadApprovedPlanActivity,
  updateAgentPlanActivity,
  executePlanStepActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 minutes',
  scheduleToCloseTimeout: '8 minutes',
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
 * Durable Ask AI plan execute (O4). Irreversible steps (send/pay/sign/publish/delete)
 * run here so a dashboard restart cannot drop a live send. HITL is a Temporal
 * signal — same PlanCard, no LangGraph interrupt.
 */
export async function PlanExecuteWorkflow(
  input: PlanExecuteWorkflowInput
): Promise<PlanExecuteWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  const planId = input.planId;
  if (!planId) {
    throw ApplicationFailure.nonRetryable('planId is required', 'InvalidArgumentError');
  }

  let decision: PlanConfirmDecision | undefined;
  const events: PlanExecuteEvent[] = [];
  const results: Array<Record<string, unknown>> = [];
  let status: PlanExecuteStatus = input.waitForApproval ? 'waiting_approval' : 'running';
  let seq = 0;

  const push = (event: string, data: Record<string, unknown>) => {
    seq += 1;
    events.push({ seq, event, data });
  };

  setHandler(approvePlanSignal, (incoming) => {
    decision = incoming === 'rejected' ? 'rejected' : 'approved';
  });
  setHandler(rejectPlanSignal, () => {
    decision = 'rejected';
  });
  setHandler(planProgressQuery, () => ({
    status,
    events: events.slice(),
    results: results.filter(Boolean),
    done: status === 'completed' || status === 'completed_with_errors' || status === 'cancelled',
  }));

  if (input.waitForApproval) {
    await condition(() => decision !== undefined);
    if (decision === 'rejected') {
      status = 'cancelled';
      await updateAgentPlanActivity({
        orgId,
        planId,
        status: 'cancelled',
        businessKey: `${planId}:cancelled`,
      });
      push('execution_done', { planId, status: 'cancelled', results: [] });
      return { planId, status, results: [] };
    }
  }

  status = 'running';
  await updateAgentPlanActivity({
    orgId,
    planId,
    status: 'running',
    businessKey: `${planId}:running`,
  });

  const loaded = await loadApprovedPlanActivity({
    orgId,
    planId,
    businessKey: `${planId}:load`,
  });

  const noteTools = new Set(['user_instruction', 'note', 'agent.user_instruction']);
  push('execution_start', { planId, totalSteps: loaded.enabledCount });

  for (const stage of loaded.stages) {
    const stageOutcomes = await Promise.all(
      stage.map(async (item) => {
        const i = item.i;
        const step = item.s;
        if (step.enabled === false) {
          return { i, outcome: { status: 'skipped', message: step.description || 'skipped', data: null } };
        }
        if (noteTools.has(String(step.tool || ''))) {
          push('step_done', {
            stepIndex: i,
            status: 'skipped',
            message: 'Instruction noted — not an executable tool.',
            data: null,
          });
          return { i, outcome: { status: 'skipped', message: 'Instruction noted — not an executable tool.', data: null } };
        }
        push('step_start', {
          stepIndex: i,
          description: step.description || '',
          tool: step.tool || '',
          action: step.action || '',
        });
        const outcome = await executePlanStepActivity({
          orgId,
          planId,
          stepIndex: i,
          step,
          previousResults: results,
          toolAllowlist: loaded.planTools,
          businessKey: `${planId}:step:${i}`,
        });
        if (outcome.status === 'error') {
          push('step_error', { stepIndex: i, message: String(outcome.message || 'step execution failed') });
        } else {
          push('step_done', {
            stepIndex: i,
            status: outcome.status,
            message: outcome.message,
            data: outcome.data ?? null,
          });
        }
        return { i, outcome };
      })
    );

    stageOutcomes.sort((a, b) => a.i - b.i);
    let failed = false;
    for (const { i, outcome } of stageOutcomes) {
      results[i] = { stepIndex: i, ...outcome };
      await updateAgentPlanActivity({
        orgId,
        planId,
        currentStep: i + 1,
        businessKey: `${planId}:cursor:${i + 1}`,
      });
      if (outcome.status === 'error') failed = true;
    }
    if (failed) {
      status = 'completed_with_errors';
      await updateAgentPlanActivity({
        orgId,
        planId,
        status: 'completed_with_errors',
        businessKey: `${planId}:done_errors`,
      });
      push('execution_done', { planId, status, results: results.filter(Boolean) });
      return { planId, status, results: results.filter(Boolean) };
    }
  }

  const done = results.filter(Boolean);
  const failed = done.filter((r) => r.status === 'error').length;
  status = failed > 0 ? 'completed_with_errors' : 'completed';
  await updateAgentPlanActivity({
    orgId,
    planId,
    status,
    businessKey: `${planId}:done`,
  });
  push('execution_done', { planId, status, results: done });
  return { planId, status, results: done };
}
