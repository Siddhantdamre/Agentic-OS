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
  /**
   * WHO THE AGENT ACTUALLY WORKS FOR.
   *
   * The system prompt's opening line was "an AI employee of the DarEX
   * organisation ${orgId}" — a UUID. Every agent in every workspace believed it
   * worked for "the DarEX organisation 00dc55bd-4063-47e2-...", and nothing
   * anywhere told it the business was a furniture retailer, or an estate agent,
   * or what it was called.
   *
   * The workspace knows all of this: `orgs.name` and `org_onboarding` hold the
   * business name and type from the setup wizard. It was collected, stored, and
   * never shown to the thing answering the customers.
   *
   * That is the cause behind a symptom already measured in the multi-turn
   * suite, where the agent asked a CUSTOMER for the business's own showroom
   * address. It was not being evasive. It genuinely did not know where it
   * worked.
   *
   * Optional on purpose: a workspace that skipped the wizard has no business
   * type, and the prompt says nothing rather than inventing one.
   */
  businessName?: string;
  businessType?: string;
  toolAllowlist: string[];
  connectedChannels?: string[];
  userMessage: string;
  sessionKey?: string;
  idempotencyKey?: string;
  priorToolResults?: AgentStepResult[];
  /** When true, AutonomousAgentWorkflow skips saveMessageActivity. */
  skipPersist?: boolean;
  /**
   * Pin this turn to a specific LiteLLM model alias instead of the default.
   *
   * Set by the per-tenant budget gate (migration 036) to route a workspace
   * that is over its token budget to the zero-cost tier, so it keeps
   * answering instead of going silent. Absent means normal routing with the
   * usual failover chain.
   */
  modelOverride?: string;
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
  /**
   * Facts the agent was GIVEN rather than retrieved — today's date and the
   * resolved relative dates injected into its prompt.
   *
   * These are evidence. The grounding gate blocked a correct reply for stating
   * "22 Aug" because that date appeared in no tool result and no memory row —
   * but the system had computed it and put it in the prompt, so the agent was
   * repeating a supplied fact, not inventing one. Anything the platform tells
   * the agent is as grounded as anything the agent looks up.
   */
  groundingContext?: string[];
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
