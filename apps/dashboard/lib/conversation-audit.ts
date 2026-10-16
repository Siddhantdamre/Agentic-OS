import type { PoolClient } from 'pg';
import { recordAuditEvent } from '@/lib/audit-events';

export type ConversationAuditKind =
  | 'conversation.reply'
  | 'conversation.takeover'
  | 'conversation.resolve'
  | 'conversation.assign'
  | 'channel.create';

/**
 * Audit a human operator action on the inbox (CH-E07). The action itself has
 * already committed, so an audit insert failure (e.g. the kind CHECK not yet
 * migrated) is logged loudly rather than turning a delivered reply into a 500.
 */
export async function auditConversationAction(
  scoped: { client: PoolClient; orgId: string },
  input: {
    userId: string;
    kind: ConversationAuditKind;
    conversationId?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await recordAuditEvent(
      {
        orgId: scoped.orgId,
        kind: input.kind,
        actor: { actorType: 'user', userId: input.userId },
        resultStatus: 'ok',
        payload: {
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          ...(input.payload || {}),
        },
      },
      scoped
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[conversation-audit] ${input.kind} not recorded:`, message);
  }
}
