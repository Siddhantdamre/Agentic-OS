import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';

const { runAgentTurnActivity, saveMessageActivity, logChannelActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
  },
});

export async function AutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult> {
  // Full agent reasoning + tool dispatch happens inside atomic-agent; this
  // workflow only drives the turn and persists the outcome.

  const result = await runAgentTurnActivity(input);

  if (input.orgId) {
    await logChannelActivity({
      orgId: input.orgId,
      channelId: input.channelId,
      logType: 'AGENT_EXECUTION',
      payload: {
        employeeName: input.employeeName,
        usedTools: result.usedTools,
        stepsCount: result.executedSteps.length,
        engine: 'atomic-agent',
      },
    });
  }

  if (input.conversationId && input.orgId) {
    await saveMessageActivity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: result.replyMessage,
      toolCalls: result.executedSteps,
    });
  }

  return result;
}