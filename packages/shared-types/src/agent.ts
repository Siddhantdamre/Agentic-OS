/** Agent task + tool-executor contracts used by Temporal, MCP, and Ask AI. */

export interface AgentStepResult {
  step: number;
  action: string;
  toolUsed?: string;
  result: string;
  selfCorrected?: boolean;
}

export interface AgentTaskInput {
  orgId: string;
  conversationId?: string;
  channelId?: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  connectedChannels?: string[];
  userMessage: string;
  sessionKey?: string;
  idempotencyKey?: string;
  priorToolResults?: AgentStepResult[];
  /** When true, AutonomousAgentWorkflow skips saveMessageActivity. */
  skipPersist?: boolean;
}

export interface AgentTaskResult {
  success: boolean;
  replyMessage: string;
  executedSteps: AgentStepResult[];
  usedTools: string[];
  error?: string;
  partialReply?: string;
  retryable?: boolean;
  isDone?: boolean;
}

export interface ToolExecutionParams {
  tool: string;
  action: string;
  payload: Record<string, any>;
  orgId: string;
  toolAllowlist?: string[];
}

export type ToolExecutionStatus = 'executed' | 'simulated' | 'error';

export interface ToolExecutionResult {
  tool: string;
  action: string;
  status: ToolExecutionStatus;
  message: string;
  data: any;
  timestamp: string;
  connected?: boolean;
  setupUrl?: string;
}

export interface ToolCatalogEntry {
  name: string;
  category: string;
  description: string;
  mcpName?: string;
  oauth: boolean;
}
