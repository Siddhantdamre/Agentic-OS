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
    maximumAttempts: 2,       // avoid thundering-herd on slow external APIs
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

export const agentProgressQuery = defineQuery<AgentTaskResult['executedSteps']>('agentProgressQuery');

export async function AutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult> {
  // Full agent reasoning + tool dispatch happens inside atomic-agent; this
  // workflow only drives the turn and persists the outcome.

  const MAX_STEPS = 8;
  
  let currentInput = { ...input };
  let finalResult: AgentTaskResult | null = null;
  const allExecutedSteps: AgentTaskResult['executedSteps'] = [];
  const allUsedTools = new Set<string>();
  let finalReplyMessage = '';

  setHandler(agentProgressQuery, () => allExecutedSteps);

  for (let step = 1; step <= MAX_STEPS; step++) {
    const result = await runAgentTurnActivity(currentInput);
    
    // Accumulate results
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

    if (result.usedTools.length === 0 || result.isDone) {
      break;
    }

    // Pass priorToolResults back into the input for the next turn
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
    });
  }

  if (input.conversationId && input.orgId) {
    await saveMessageActivity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: resultToSave.replyMessage,
      toolCalls: resultToSave.executedSteps,
    });
  }

  return resultToSave;
}