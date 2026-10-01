import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, AgentTaskResult, CrewSpawnResult, CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';
import {
  buildCrewSynthesisPrompt,
  capCrewSpecialists,
  crewChildWorkflowId,
  MANAGER_SYNTHESIS_TIMEOUT,
  prepareFixedMemberSpecialists,
} from '../crew-contract.js';
import { AutonomousAgentWorkflow } from './AutonomousAgentWorkflow.js';

const { saveMessageActivity, logChannelActivity, assertCrewSpendAllowedActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '12 minutes',
  scheduleToCloseTimeout: '20 minutes',
  retry: {
    initialInterval: '5s',
    maximumAttempts: 2,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

/** Dedicated short timeout so manager synthesis cannot runaway after specialists finish. */
const { runAgentTurnActivity: runManagerSynthesisActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: MANAGER_SYNTHESIS_TIMEOUT,
  scheduleToCloseTimeout: MANAGER_SYNTHESIS_TIMEOUT,
  retry: {
    initialInterval: '2s',
    maximumAttempts: 2,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

function collectUsedTools(spawned: CrewSpawnResult[], synthesis: CrewWorkflowResult['synthesis']): string[] {
  const tools = new Set<string>();
  for (const spawn of spawned) {
    for (const tool of spawn.result.usedTools || []) tools.add(tool);
  }
  for (const tool of synthesis.usedTools || []) tools.add(tool);
  return Array.from(tools);
}

function failedSpecialistResult(reason: unknown): AgentTaskResult {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Specialist execution failed';
  return {
    success: false,
    replyMessage: '',
    executedSteps: [],
    usedTools: [],
    error: message,
  };
}

export async function CrewWorkflow(input: CrewWorkflowInput): Promise<CrewWorkflowResult> {
  const parentId = workflowInfo().workflowId;
  const fixedMembers = input.fixedMembers === true;
  let specialists = capCrewSpecialists(input.specialists || []);
  if (fixedMembers) {
    specialists = prepareFixedMemberSpecialists(specialists, input.userMessage);
  }

  if (fixedMembers && specialists.length === 0) {
    const msg = 'No fixed team members to run.';
    return {
      mode: 'crew',
      success: false,
      replyMessage: msg,
      reason: input.reason,
      spawned: [],
      synthesis: {
        success: false,
        replyMessage: msg,
        executedSteps: [],
        usedTools: [],
        error: msg,
      },
      usedTools: [],
    };
  }

  if (input.orgId && specialists.length > 1) {
    const spend = await assertCrewSpendAllowedActivity({ orgId: input.orgId });
    if (!spend.allowed) {
      const msg = spend.reason || 'Crew spawn blocked by org spend ceiling.';
      return {
        mode: 'crew',
        success: false,
        replyMessage: msg,
        reason: input.reason,
        spawned: [],
        synthesis: {
          success: false,
          replyMessage: msg,
          executedSteps: [],
          usedTools: [],
          error: msg,
        },
        usedTools: [],
      };
    }
  }

  // Auto mode: empty specialists fall back to the manager. Fixed Team never
  // collapses to a solo executive when the user selected the roster.
  if (specialists.length <= 1) {
    const spec: AgentTaskInput = specialists[0]
      ? {
          ...specialists[0],
          conversationId: input.conversationId,
          skipPersist: false,
          sessionKey: specialists[0].sessionKey || `crew:${parentId}:solo`,
        }
      : {
          ...input.manager,
          conversationId: input.conversationId,
          skipPersist: false,
          sessionKey: input.manager.sessionKey || `crew:${parentId}:solo`,
        };

    const result = await executeChild(AutonomousAgentWorkflow, {
      workflowId: crewChildWorkflowId(parentId, 0, spec.employeeId || 'solo', spec.employeeName),
      args: [spec],
      workflowExecutionTimeout: '20 minutes',
    });

    const spawned: CrewSpawnResult[] = [
      {
        employeeId: spec.employeeId,
        employeeName: spec.employeeName,
        employeeRole: spec.employeeRole,
        task: spec.userMessage,
        result,
      },
    ];

    return {
      mode: 'solo',
      success: result.success !== false,
      replyMessage: result.replyMessage,
      reason: input.reason,
      spawned,
      synthesis: result,
      usedTools: result.usedTools || [],
    };
  }

  // Isolate specialist failures so one timeout/crash does not discard sibling results.
  const settled = await Promise.allSettled(
    specialists.map(async (spec, index) => {
      const specialistInput: AgentTaskInput = {
        ...spec,
        conversationId: undefined,
        skipPersist: true,
        sessionKey: spec.sessionKey || `crew:${parentId}:${spec.employeeId || index}`,
        idempotencyKey: spec.idempotencyKey || `${parentId}:spawn:${index}`,
      };
      const result = await executeChild(AutonomousAgentWorkflow, {
        workflowId: crewChildWorkflowId(
          parentId,
          index,
          specialistInput.employeeId || String(index),
          specialistInput.employeeName
        ),
        args: [specialistInput],
        workflowExecutionTimeout: '20 minutes',
      });
      return {
        employeeId: specialistInput.employeeId,
        employeeName: specialistInput.employeeName,
        employeeRole: specialistInput.employeeRole,
        task: specialistInput.userMessage,
        result,
      } satisfies CrewSpawnResult;
    })
  );

  const spawned: CrewSpawnResult[] = settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    const spec = specialists[index];
    return {
      employeeId: spec.employeeId,
      employeeName: spec.employeeName,
      employeeRole: spec.employeeRole,
      task: spec.userMessage,
      result: failedSpecialistResult(outcome.reason),
    };
  });

  const synthesisInput: AgentTaskInput = {
    ...input.manager,
    conversationId: undefined,
    skipPersist: true,
    sessionKey: input.manager.sessionKey || `crew:${parentId}:manager`,
    userMessage: buildCrewSynthesisPrompt(
      input.userMessage,
      spawned.map((s) => ({
        employeeName: s.employeeName,
        employeeRole: s.employeeRole,
        task: s.task,
        reply: s.result.replyMessage || s.result.error || '',
      })),
      { fixedMembers },
    ),
    priorToolResults: spawned.flatMap((s) =>
      (s.result.executedSteps || []).map((step) => ({
        ...step,
        action: `${s.employeeName}: ${step.action}`,
      }))
    ),
    idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:synth` : `${parentId}:synth`,
  };

  let synthesis: AgentTaskResult;
  try {
    synthesis = await runManagerSynthesisActivity(synthesisInput);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    synthesis = {
      success: false,
      replyMessage:
        'Crew specialists finished, but manager synthesis timed out or failed. Partial specialist reports are available.',
      executedSteps: [],
      usedTools: [],
      error: message,
    };
  }

  if (input.orgId) {
    await logChannelActivity({
      orgId: input.orgId,
      channelId: input.channelId,
      logType: 'CREW_EXECUTION',
      payload: {
        mode: 'crew',
        specialists: spawned.map((s) => s.employeeName),
        usedTools: collectUsedTools(spawned, synthesis),
        engine: 'trueforge',
      },
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:crew-log` : undefined,
    });
  }

  if (input.conversationId && input.orgId && synthesis.replyMessage) {
    await saveMessageActivity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: synthesis.replyMessage,
      toolCalls: spawned.flatMap((s) => s.result.executedSteps || []).concat(synthesis.executedSteps || []),
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:crew-save` : undefined,
    });
  }

  return {
    mode: 'crew',
    success: spawned.every((s) => s.result.success !== false) && synthesis.success !== false,
    replyMessage: synthesis.replyMessage,
    reason: input.reason,
    spawned,
    synthesis,
    usedTools: collectUsedTools(spawned, synthesis),
  };
}
