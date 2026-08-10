import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';

const { executeToolActivity, saveMessageActivity, logChannelActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
  },
});

export async function AutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult> {
  // The workflow orchestrates activities — agent reasoning happens in executeToolActivity
  // which calls executeAutonomousToolAction (which internally calls HermesAgentAdapter)
  
  // Step 1: Execute the full agent reasoning + tool dispatch loop via activity
  const steps: AgentTaskResult['executedSteps'] = [];
  const usedTools: string[] = [];

  // Planning step — use the tool executor activity to invoke Hermes for planning
  let targetTool: string | null = null;
  let actionRequired = 'reply';
  let toolParams: Record<string, any> = {};

  try {
    const planResult = await executeToolActivity('hermes_plan', 'plan_tool_selection', {
      userMessage: input.userMessage,
      employeeName: input.employeeName,
      employeeRole: input.employeeRole,
      employeePersona: input.employeePersona,
      toolAllowlist: input.toolAllowlist,
    }, input.orgId);

    if (planResult.data?.targetTool && input.toolAllowlist.includes(planResult.data.targetTool)) {
      targetTool = planResult.data.targetTool;
      actionRequired = planResult.data.actionRequired || 'execute';
      toolParams = planResult.data.toolParams || {};
    }

    steps.push({
      step: 1,
      action: 'Goal Analysis & Tool Selection',
      result: `Analyzed: tool=${targetTool || 'none'}, action=${actionRequired}`,
    });
  } catch (err: any) {
    steps.push({ step: 1, action: 'Goal Analysis', result: `Planning failed: ${err.message}` });
  }

  // Step 2: Execute selected tool (if any)
  if (targetTool) {
    usedTools.push(targetTool);
    const toolResult = await executeToolActivity(targetTool, actionRequired, toolParams, input.orgId);
    steps.push({
      step: 2,
      action: `Execute Tool: ${targetTool}`,
      toolUsed: targetTool,
      result: JSON.stringify(toolResult.data || {}).slice(0, 200),
    });
  }

  // Step 3: Synthesize final reply via Hermes
  const replyResult = await executeToolActivity('hermes_reply', 'synthesize_reply', {
    userMessage: input.userMessage,
    employeeName: input.employeeName,
    employeeRole: input.employeeRole,
    employeePersona: input.employeePersona,
    executedSteps: steps,
  }, input.orgId);

  const replyMessage = replyResult.data?.reply || `Hello! I am ${input.employeeName}. I have processed your request: "${input.userMessage}".'`;

  steps.push({
    step: steps.length + 1,
    action: 'Final Response Synthesis',
    result: `Generated reply: "${replyMessage.slice(0, 60)}..."`,
  });

  // Log execution
  if (input.orgId) {
    await logChannelActivity({
      orgId: input.orgId,
      channelId: input.channelId,
      logType: 'AGENT_EXECUTION',
      payload: { employeeName: input.employeeName, usedTools, stepsCount: steps.length },
    });
  }

  // Save message
  if (input.conversationId && input.orgId) {
    await saveMessageActivity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: replyMessage,
      toolCalls: steps,
    });
  }

  return { success: true, replyMessage, executedSteps: steps, usedTools };
}
