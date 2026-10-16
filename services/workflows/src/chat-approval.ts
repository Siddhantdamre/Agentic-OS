/**
 * A person who allows a call in the chat card has approved it. The gate still holds a send, payment, signature,
 * publish or delete as a database approval, so what the person allowed becomes that approval here, once: it goes
 * through the same decision path as Decisions (role checks, dual approval, audit, execute), as that person.
 *
 * The decision path lives in the dashboard, which depends on this package, so it is handed in rather than imported.
 */

export interface ParkedApprovalRequest {
  orgId: string;
  pendingActionId: string;
  /** The authenticated person who allowed the call. Never a value from a request body. */
  approverUserId: string;
}

/** What approving the held call came to. `message` is plain wording for the person, never a raw error. */
export type ParkedApprovalOutcome =
  | { status: 'executed'; message: string; data?: unknown }
  | { status: 'failed'; message: string }
  | { status: 'waiting'; message: string };

export type ParkedApprover = (request: ParkedApprovalRequest) => Promise<ParkedApprovalOutcome>;

/**
 * Shared by a chat session and the tool set it runs. Filled in only while a resume is carrying a person's
 * decision, so a turn that no one is approving can never approve anything.
 */
export interface ChatApprovalContext {
  approverUserId?: string;
  approveParked?: ParkedApprover;
}

/** What the SDK hands a tool with the person's answer to its card. */
export interface ToolDecision {
  status?: string;
  reason?: string;
}

export function toolResultFromApproval(outcome: ParkedApprovalOutcome): { text: string; isError: boolean } {
  switch (outcome.status) {
    case 'executed':
      return { text: JSON.stringify({ status: 'executed', message: outcome.message, data: outcome.data ?? null }), isError: false };
    case 'waiting':
      return { text: JSON.stringify({ status: 'pending_approval', message: outcome.message }), isError: false };
    default:
      return { text: JSON.stringify({ status: 'error', message: outcome.message }), isError: true };
  }
}
