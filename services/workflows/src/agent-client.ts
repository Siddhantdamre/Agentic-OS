/**
 * Agent Client — pure TrueForge harness integration.
 * Canonical entrypoint for all agent turns. All turns run through TrueForge.
 */

import type { RetrieveMemoryResult } from '@darex/shared-types';
import type { AgentTaskInput, AgentTaskResult } from './agent-engine.js';
import {
  emptyMemoryResult,
  formatRetrievedFactsBlock,
  retrieveMemory,
} from './memory/retrieve.js';
import {
  runTrueForgeTurn,
  runAutonomousAgentDirect as runTrueForgeDirect,
  resumeTrueForgeTurn,
  type AgentToolStep,
  type AgentTurnResult,
  type RunAgentOptions,
  type ResumeTurnInput,
  sanitizeAgentReply,
} from './trueforge-client.js';
import { replyForPausedTurn, replyForTurn } from './reply-from-tools.js';

export type { AgentToolStep, AgentTurnResult, RunAgentOptions, ResumeTurnInput };
export { sanitizeAgentReply, resumeTrueForgeTurn, resumeTrueForgeTurn as resumeAgentTurn };

/**
 * Standard agent turn entrypoint: delegates entirely to TrueForge.
 */
export async function runAgentTurn(
  input: AgentTaskInput,
  opts?: RunAgentOptions
): Promise<AgentTurnResult> {
  return runTrueForgeTurn(input, opts);
}

/**
 * Maps turn result into executed steps and user-facing structure.
 */
export function mapTurnToResult(turn: AgentTurnResult): AgentTaskResult {
  const modelReply = sanitizeAgentReply(turn.reply);
  const pausedReply = turn.approvals.length > 0
    ? replyForPausedTurn(modelReply, turn.approvals.map((a) => a.toolName))
    : null;
  const replyMessage = pausedReply || replyForTurn(
    modelReply,
    turn.tools.map((t) => ({ tool: t.tool, result: t.result, argsLabel: t.argsLabel })),
  ) || 'The search finished, but there was nothing readable to show. Try asking again with a shorter question.';
  const executedSteps = turn.tools.map((t, idx) => ({
    step: idx + 1,
    action: t.tool,
    toolUsed: t.tool,
    result: t.result || t.argsLabel,
    ...(t.threadId ? { threadId: t.threadId } : {}),
  }));
  const usedTools = Array.from(new Set(turn.tools.map((t) => t.tool)));

  return {
    success: true,
    replyMessage,
    executedSteps,
    usedTools,
    isDone: turn.approvals.length === 0,
    sessionId: turn.sessionId,
    approvals: turn.approvals.length > 0 ? turn.approvals : undefined,
    subagents: turn.subagents.length > 0 ? turn.subagents : undefined,
    usage: turn.usage,
  };
}

/**
 * Direct autonomous execution of an agent turn.
 */
export async function runAutonomousAgentDirect(
  input: AgentTaskInput,
  opts?: RunAgentOptions
): Promise<AgentTaskResult> {
  return runTrueForgeDirect(input, opts);
}
