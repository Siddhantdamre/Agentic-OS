/**
 * Allowing a call in the Ask AI chat card is an approval. The gate holds a send, payment, signature, publish or
 * delete as an approval row; this turns the person's Allow into that approval, through the same decision path as
 * Decisions (role checks, dual approval, audit that fails loudly, execute), so there is one approval, not two.
 *
 * The person is the authenticated user the route resolved, never anything from a request body.
 */
import { AuditWriteError, decideApproval } from '@/lib/decide-approval';
import type { ParkedApprovalOutcome, ParkedApprovalRequest } from '@darex/workflows/dist/chat-approval';

const MAX_RESULT_CHARS = 15_000;
const IN_DECISIONS = 'It is waiting in Decisions for someone who can approve it.';

function shown(data: unknown): unknown {
  try {
    return JSON.stringify(data ?? null).length > MAX_RESULT_CHARS ? { truncated: true } : data ?? null;
  } catch {
    return null;
  }
}

export async function approveHeldCall(request: ParkedApprovalRequest): Promise<ParkedApprovalOutcome> {
  let res;
  try {
    res = await decideApproval({
      pendingActionId: request.pendingActionId,
      decision: 'approved',
      actorUserId: request.approverUserId,
      orgId: request.orgId,
      via: 'chat',
    });
  } catch (err) {
    if (err instanceof AuditWriteError && err.afterExecution) {
      return { status: 'executed', message: 'It ran, but its audit entry could not be saved. Please tell an administrator.' };
    }
    throw err;
  }

  if (!res.ok) {
    if (res.httpStatus === 403) {
      const why = res.error === 'Forbidden' ? 'Your role cannot approve actions.' : res.error;
      return { status: 'waiting', message: `${why} ${IN_DECISIONS}` };
    }
    if (res.httpStatus === 409) {
      return { status: 'failed', message: 'That approval was already decided, so nothing more was run. Check Decisions.' };
    }
    return { status: 'failed', message: 'I could not confirm that approval. Check Decisions before asking again, so nothing is sent twice.' };
  }

  switch (res.status) {
    case 'executed': {
      const result = res.result as { message?: unknown; data?: unknown; status?: unknown } | null | undefined;
      const message = result && typeof result.message === 'string' && result.message ? result.message : 'Approved and done.';
      const data = result && typeof result === 'object' && 'status' in result ? result.data : result;
      return { status: 'executed', message, data: shown(data) };
    }
    case 'execution_failed':
      return { status: 'failed', message: res.error || 'The action did not run.' };
    case 'pending': {
      const n = res.awaitingApprovals && res.awaitingApprovals > 0 ? res.awaitingApprovals : 1;
      return {
        status: 'waiting',
        message: `You approved it. It needs ${n} more approval${n === 1 ? '' : 's'} from someone else before it runs. ${IN_DECISIONS}`,
      };
    }
    default:
      return { status: 'failed', message: 'The action did not run.' };
  }
}
