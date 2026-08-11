/**
 * Shared type definitions for agent task execution.
 *
 * The runtime agent loop now lives in atomic-agent (external process, own
 * reasoning + tool surface + memory fabric). LangGraph was removed; this
 * module only defines the task contract used by Temporal activities, the
 * streaming client and the API routes.
 */

export interface AgentTaskInput {
  orgId: string;
  conversationId?: string;
  channelId?: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  userMessage: string;
}

export interface AgentTaskResult {
  success: boolean;
  replyMessage: string;
  executedSteps: {
    step: number;
    action: string;
    toolUsed?: string;
    result: string;
    selfCorrected?: boolean;
  }[];
  usedTools: string[];
}