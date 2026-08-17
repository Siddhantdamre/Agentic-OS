import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, CrewSpawnResult, CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';
import {
  buildCrewSynthesisPrompt,
  capCrewSpecialists,
  crewChildWorkflowId,
} from '../crew-contract.js';
import { AutonomousAgentWorkflow } from './AutonomousAgentWorkflow.js';

const { runAgentTurnActivity, saveMessageActivity, logChannelActivity, planCrewActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '12 minutes',
  scheduleToCloseTimeout: '20 minutes',
  retry: {
    initialInterval: '5s',
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

export async function CrewWorkflow(input: CrewWorkflowInput): Promise<CrewWorkflowResult> {
  const parentId = workflowInfo().workflowId;

  // Caller-supplied specialists win. When none are given, ask the planner to
  // pick from the org's real roster — this is what turns a fixed fan-out into
  // actual composition. Planning is an activity (DB + model = non-deterministic,
  // forbidden in workflow code) and fails soft to solo, so a planner outage
  // degrades to one agent rather than a failed request.
  let resolved = input.specialists || [];
  let planReason = input.reason;

  if (resolved.length === 0 && input.userMessage) {
    const plan = await planCrewActivity({ orgId: input.orgId, userMessage: input.userMessage });
    if (plan.mode === 'crew') {
      resolved = plan.assignments.map((a) => ({
        ...input.manager,
        employeeId: a.employeeId,
        employeeName: a.name,
        employeeRole: a.role,
        employeePersona: a.persona,
        // Authoritative allowlist from the employee record — never the model's.
        toolAllowlist: a.toolAllowlist,
        // Each specialist works its own slice, not the whole request.
        userMessage: a.subtask,
      }));
      planReason = plan.reason;
    }
  }

  const specialists = capCrewSpecialists(resolved);

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
      reason: planReason,
      spawned,
      synthesis: result,
      usedTools: result.usedTools || [],
    };
  }

  const spawned: CrewSpawnResult[] = await Promise.all(
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
      };
    })
  );

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
      }))
    ),
    priorToolResults: spawned.flatMap((s) =>
      (s.result.executedSteps || []).map((step) => ({
        ...step,
        action: `${s.employeeName}: ${step.action}`,
      }))
    ),
    idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:synth` : `${parentId}:synth`,
  };

  const synthesis = await runAgentTurnActivity(synthesisInput);

  if (input.orgId) {
    await logChannelActivity({
      orgId: input.orgId,
      channelId: input.channelId,
      logType: 'CREW_EXECUTION',
      payload: {
        mode: 'crew',
        specialists: spawned.map((s) => s.employeeName),
        usedTools: collectUsedTools(spawned, synthesis),
        engine: 'atomic-agent',
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
    reason: planReason,
    spawned,
    synthesis,
    usedTools: collectUsedTools(spawned, synthesis),
  };
}
