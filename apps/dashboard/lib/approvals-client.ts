/**
 * The browser's side of approving: send one decision, say plainly what became of it, and tell the rest of the page
 * (the sidebar count) that the list changed. Every request is caught, so a dropped connection is a sentence on the
 * card, never a stuck button or an unhandled error.
 */
import { networkErrorMessage } from '@/lib/client-error';
import { publicErrorMessage } from '@/lib/public-error';
import type { ApprovalKind } from '@/lib/approval-view';

export const APPROVALS_CHANGED_EVENT = 'darex:approvals-changed';

export type Outcome = { tone: 'done' | 'waiting' | 'failed'; text: string };

type DecisionBody = {
  status?: string;
  error?: string;
  awaitingApprovals?: number;
};

export function outcomeFor(decision: 'approved' | 'rejected', body: DecisionBody, kind: ApprovalKind): Outcome {
  if (body.status === 'execution_failed') {
    return { tone: 'failed', text: `Approved, but it did not run: ${body.error || 'The action did not run.'}` };
  }
  if (body.status === 'pending') {
    const n = body.awaitingApprovals && body.awaitingApprovals > 0 ? body.awaitingApprovals : 1;
    return { tone: 'waiting', text: `Your approval is recorded. It needs ${n} more ${n === 1 ? 'person' : 'people'} before it runs.` };
  }
  if (decision === 'rejected' || body.status === 'rejected') {
    return { tone: 'done', text: 'Rejected. Nothing was sent.' };
  }
  return { tone: 'done', text: kind === 'email' || kind === 'message' ? 'Approved and sent.' : 'Approved and done.' };
}

export function notifyApprovalsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
}

export async function decideOne(input: {
  id: string;
  decision: 'approved' | 'rejected';
  kind: ApprovalKind;
  /** The whole replacement for the call's arguments (an edited message), never a fragment. */
  modifiedPayload?: Record<string, unknown>;
}): Promise<Outcome> {
  try {
    const res = await fetch('/api/decisions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: input.id, status: input.decision, ...(input.modifiedPayload ? { modifiedPayload: input.modifiedPayload } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as DecisionBody;
    if (!res.ok && body.status !== 'execution_failed') {
      const fallback = 'That did not work. Please try again.';
      if (res.status === 403 && /^forbidden$/i.test(String(body.error || '').trim())) return { tone: 'failed', text: 'Your role is not allowed to approve this.' };
      return { tone: 'failed', text: publicErrorMessage(typeof body.error === 'string' ? body.error : '', fallback) };
    }
    return outcomeFor(input.decision, body, input.kind);
  } catch (err) {
    return { tone: 'failed', text: networkErrorMessage(err, 'That did not work. Please try again.') };
  } finally {
    notifyApprovalsChanged();
  }
}
