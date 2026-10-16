import type { AgentTaskInput, AgentTaskResult, CrewSpawnResult, CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';
import { runAutonomousAgentDirect } from './agent-client.js';
import { assertCrewSpendAllowed } from './activities/crew-budget.js';
import {
  buildCrewSynthesisPrompt,
  capCrewSpecialists,
  fallbackCrewReply,
  MANAGER_SYNTHESIS_TIMEOUT_MS,
  prepareFixedMemberSpecialists,
} from './crew-contract.js';

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

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type RunCrewDirectOptions = {
  /** Propagate client disconnect / Stop so specialist + manager turns abort. */
  signal?: AbortSignal;
  /**
   * Optional override for Team mode. When true (or when `input.fixedMembers`
   * is true), specialists are the user-selected roster — not planCrew picks.
   * Defaults to `input.fixedMembers` so callers can leave today's behavior.
   */
  fixedMembers?: boolean;
};

function abortedResult(label: string): AgentTaskResult {
  return {
    success: false,
    replyMessage: '',
    executedSteps: [],
    usedTools: [],
    error: `${label} aborted`,
    retryable: true,
  };
}

/**
 * Direct (non-Temporal) crew: parallel specialist loops, then manager synthesis.
 * Same fan-out cap as CrewWorkflow. Used when Temporal is down.
 *
 * Pass `fixedMembers: true` (on input or opts) for Ask AI Team mode: spawn the
 * provided specialists only (after cap 3), with "nothing for me" instructions,
 * and never fall back to a solo executive when the list is empty.
 */
export async function runCrewDirect(
  input: CrewWorkflowInput,
  opts?: RunCrewDirectOptions,
): Promise<CrewWorkflowResult> {
  const stamp = input.idempotencyKey || `direct-${Date.now()}`;
  const fixedMembers = opts?.fixedMembers ?? input.fixedMembers === true;
  let specialists = capCrewSpecialists(input.specialists || []);
  if (fixedMembers) {
    specialists = prepareFixedMemberSpecialists(specialists, input.userMessage);
  }
  const signal = opts?.signal;

  if (signal?.aborted) {
    const msg = 'Crew aborted before specialists started.';
    return {
      mode: 'crew',
      success: false,
      replyMessage: msg,
      reason: input.reason,
      spawned: [],
      synthesis: abortedResult('Crew'),
      usedTools: [],
    };
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
    const spend = await assertCrewSpendAllowed(input.orgId);
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
          sessionKey: specialists[0].sessionKey || `crew:${stamp}:solo`,
        }
      : {
          ...input.manager,
          conversationId: input.conversationId,
          skipPersist: false,
          sessionKey: input.manager.sessionKey || `crew:${stamp}:solo`,
        };
    const result = await runAutonomousAgentDirect(spec, { signal });
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

  const settled = await Promise.allSettled(
    specialists.map(async (spec, index) => {
      const result = await runAutonomousAgentDirect(
        {
          ...spec,
          conversationId: undefined,
          skipPersist: true,
          sessionKey: spec.sessionKey || `crew:${stamp}:${spec.employeeId || index}`,
        },
        { signal },
      );
      return {
        employeeId: spec.employeeId,
        employeeName: spec.employeeName,
        employeeRole: spec.employeeRole,
        task: spec.userMessage,
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

  if (signal?.aborted) {
    return {
      mode: 'crew',
      success: false,
      replyMessage: 'Crew stopped before manager synthesis.',
      reason: input.reason,
      spawned,
      synthesis: abortedResult('Manager synthesis'),
      usedTools: collectUsedTools(spawned, abortedResult('Manager synthesis')),
    };
  }

  // Isolated synthesis session (mirrors CrewWorkflow): never the main
  // conversation session, so the fan-in prompt doesn't pollute memory.
  let synthesis: AgentTaskResult;
  try {
    synthesis = await runWithTimeout(
      runAutonomousAgentDirect(
        {
          ...input.manager,
          conversationId: undefined,
          skipPersist: true,
          sessionKey: input.manager.sessionKey || `crew:${stamp}:manager`,
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
        },
        { signal },
      ),
      MANAGER_SYNTHESIS_TIMEOUT_MS,
      'Manager synthesis'
    );
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

  const replyMessage = synthesis.replyMessage?.trim() ? synthesis.replyMessage : fallbackCrewReply(spawned);

  return {
    mode: 'crew',
    success: spawned.every((s) => s.result.success !== false) && synthesis.success !== false,
    replyMessage,
    reason: input.reason,
    spawned,
    synthesis,
    usedTools: collectUsedTools(spawned, synthesis),
  };
}
