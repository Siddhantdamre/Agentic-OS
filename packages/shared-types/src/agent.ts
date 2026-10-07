/** Agent task + tool-executor contracts used by Temporal, MCP, and Ask AI. */

export interface AgentStepResult {
  step: number;
  action: string;
  toolUsed?: string;
  result: string;
  selfCorrected?: boolean;
  /** Child agent thread. Root steps omit it. */
  threadId?: string;
}

export interface AgentTaskInput {
  orgId: string;
  /** Authenticated user initiating the turn (signed into tenant HMAC, never trusted from LLM). */
  userId?: string;
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
  forceEscalate?: boolean;
  customerIdentifier?: string;
}

/** One paused tool call awaiting a human decision (TrueForge user-input-required). */
export interface ApprovalRequest {
  threadId: string;
  toolCallId: string;
  toolName: string;
  /** One plain sentence about what the call would do ("Send email ... to ..."). */
  summary?: string;
  /** The call a person is being asked to allow, so the card can show it: who it goes to and what it says. */
  call?: { tool: string; action: string; args: Record<string, unknown> };
}

/** One dynamic-subagent lifecycle event (TrueForge thread.created/done). */
export interface SubagentEvent {
  threadId: string;
  title: string;
  name: string;
  /** Input prompt handed to the subagent (its task). */
  instruction: string;
  model?: string;
  status: 'started' | 'done';
  /** Wall-clock ms between created/done; present on done (and on started once paired). */
  durationMs?: number;
  createdAt: string;
}

/** Token/cost/duration footer for a finished turn (when the harness reports it). */
export interface TurnUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalCostInUsd?: number;
  durationMs?: number;
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
  forceEscalate?: boolean;
  confidenceScore?: number;
  /** TrueForge session UUID — returned so the dashboard can resume a paused
   *  turn. Opaque id only; every resume re-signs tenant headers server-side. */
  sessionId?: string;
  /** Non-empty when the turn paused for approvals instead of completing. */
  approvals?: ApprovalRequest[];
  /** Dynamic-subagent lifecycle (started/done, paired by threadId). */
  subagents?: SubagentEvent[];
  /** Token/cost/duration footer when reported. */
  usage?: TurnUsage;
}

export interface ToolBlastRadius {
  amount?: number;
  recordCount?: number;
  externalParties?: number;
  customerTier?: 'routine' | 'key' | 'strategic';
}

export interface ToolExecutionParams {
  tool: string;
  action: string;
  payload: Record<string, any>;
  orgId: string;
  toolAllowlist?: string[];
  employeeRole?: string;
  /** The employee this call runs as (plan steps pass the stamped id). */
  employeeId?: string;
  /** Human who approved / triggered the call, for audit attribution. */
  actorUserId?: string;
  /** Which entry point made the call. */
  source?: 'chat' | 'plan' | 'crew' | 'webhook' | 'sweep' | 'approval';
  confidence?: number;
  blastRadius?: ToolBlastRadius;
  skipAutonomy?: boolean;
  workflowId?: string;
}

export type ToolExecutionStatus = 'executed' | 'simulated' | 'error' | 'pending_approval';

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
