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
  /** Optional caller-supplied session key used to build the atomic-agent session id
   *  when no conversationId/employeeId is available. Lets stateless callers (e.g.
   *  Ask AI) scope + rotate their own sessions instead of sharing the fallback
   *  `darex:{org}:chat` bucket forever. */
  sessionKey?: string;
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
  /** Human-readable failure reason when success=false (was previously swallowed). */
  error?: string;
  /** Streaming text captured before the failure, if the turn partially produced output. */
  partialReply?: string;
  /** True when the failure was a timeout/abort the caller may safely retry. */
  retryable?: boolean;
}