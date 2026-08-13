import { proxyActivities, defineQuery, setHandler } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';

const { runAgentTurnActivity, saveMessageActivity, logChannelActivity } = proxyActivities<typeof activities>({
  // 12 min covers multi-tool chains (Gmail + Calendar + HubSpot + WhatsApp).
  // scheduleToClose caps the absolute wall-clock budget including retries.
  startToCloseTimeout: '12 minutes',
  scheduleToCloseTimeout: '20 minutes',
  retry: {
    initialInterval: '5s',
    maximumAttempts: 2,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

export const agentProgressQuery = defineQuery<AgentTaskResult['executedSteps']>('agentProgressQuery');

export async function AutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult> {
  // atomic-agent already runs a complete MCP tool loop per turn. This workflow
  // is the durable wrapper: one primary turn, then at most two retries when
  // the turn timed out or returned no reply after tools. priorToolResults is
  // fed back into the next turn so the model does not blindly re-run work.

  const MAX_TURNS = 3;

  let currentInput: AgentTaskInput = { ...input };
  let finalResult: AgentTaskResult | null = null;
  const allExecutedSteps: AgentTaskResult['executedSteps'] = [];
  const allUsedTools = new Set<string>();
  let finalReplyMessage = '';

  setHandler(agentProgressQuery, () => allExecutedSteps);

  for (let step = 1; step <= MAX_TURNS; step++) {
    const result = await runAgentTurnActivity(currentInput);

    allExecutedSteps.push(...result.executedSteps);
    for (const tool of result.usedTools) {
      allUsedTools.add(tool);
    }

    if (result.replyMessage) {
      finalReplyMessage = result.replyMessage;
    }

    finalResult = {
      ...result,
      replyMessage: finalReplyMessage,
      executedSteps: allExecutedSteps,
      usedTools: Array.from(allUsedTools),
    };

    const shouldContinue =
      result.retryable === true ||
      (result.success && !result.isDone && !result.replyMessage && result.usedTools.length > 0);

    if (!shouldContinue || step === MAX_TURNS) {
      break;
    }

    currentInput = {
      ...currentInput,
      priorToolResults: allExecutedSteps,
    };
  }

  const resultToSave = finalResult!;

  if (input.orgId) {
    await logChannelActivity({
      orgId: input.orgId,
      channelId: input.channelId,
      logType: 'AGENT_EXECUTION',
      payload: {
        employeeName: input.employeeName,
        usedTools: resultToSave.usedTools,
        stepsCount: resultToSave.executedSteps.length,
        engine: 'atomic-agent',
      },
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:log` : undefined,
    });
  }

  if (input.conversationId && input.orgId && resultToSave.replyMessage && !input.skipPersist) {
    await saveMessageActivity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: resultToSave.replyMessage,
      toolCalls: resultToSave.executedSteps,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:save` : undefined,
    });
  }

  return resultToSave;
}
