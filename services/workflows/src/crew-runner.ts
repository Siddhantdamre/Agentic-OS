import type { AgentTaskInput, CrewSpawnResult, CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';
import { runAutonomousAgentDirect } from './atomic-agent-client.js';
import { buildCrewSynthesisPrompt, capCrewSpecialists } from './crew-contract.js';

function collectUsedTools(spawned: CrewSpawnResult[], synthesis: CrewWorkflowResult['synthesis']): string[] {
  const tools = new Set<string>();
  for (const spawn of spawned) {
    for (const tool of spawn.result.usedTools || []) tools.add(tool);
  }
  for (const tool of synthesis.usedTools || []) tools.add(tool);
  return Array.from(tools);
}

/**
 * Direct (non-Temporal) crew: parallel specialist loops, then manager synthesis.
 * Same fan-out cap as CrewWorkflow. Used when Temporal is down.
 */
export async function runCrewDirect(input: CrewWorkflowInput): Promise<CrewWorkflowResult> {
  const stamp = input.idempotencyKey || `direct-${Date.now()}`;
  const specialists = capCrewSpecialists(input.specialists || []);

  if (specialists.length <= 1) {
    const spec: AgentTaskInput = specialists[0]
      ? { ...specialists[0], conversationId: input.conversationId, skipPersist: false }
      : { ...input.manager, conversationId: input.conversationId, skipPersist: false };
    const result = await runAutonomousAgentDirect(spec);
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

  const spawned: CrewSpawnResult[] = await Promise.all(
    specialists.map(async (spec, index) => {
      const result = await runAutonomousAgentDirect({
        ...spec,
        conversationId: undefined,
        skipPersist: true,
        sessionKey: spec.sessionKey || `crew:${stamp}:${spec.employeeId || index}`,
      });
      return {
        employeeId: spec.employeeId,
        employeeName: spec.employeeName,
        employeeRole: spec.employeeRole,
        task: spec.userMessage,
        result,
      };
    })
  );

  const synthesis = await runAutonomousAgentDirect({
    ...input.manager,
    conversationId: input.conversationId,
    skipPersist: false,
    sessionKey: input.manager.sessionKey || `crew:${stamp}:manager`,
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
  });

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
