/**
 * @jest-environment node
 *
 * Inbox mutations: only owner/admin/member may act (CH-S05); human actions
 * emit audit_events without failing the request if the insert fails (CH-E07).
 */
jest.mock('@/lib/db', () => ({ getOrgScopedClient: jest.fn() }));

import { AUDIT_EVENT_INSERT_SQL } from '@/lib/audit-events';
import { auditConversationAction } from '@/lib/conversation-audit';
import { canActOnConversations, HUMAN_ROLES } from '@/lib/rbac';

describe('canActOnConversations', () => {
  it('allows operators and denies read-only roles', () => {
    const allowed = HUMAN_ROLES.filter((r) => canActOnConversations(r));
    expect(allowed).toEqual(['owner', 'admin', 'member']);
  });
});

describe('auditConversationAction', () => {
  it('inserts a user-actor audit row with the conversation id', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query } as any;
    await auditConversationAction(
      { client, orgId: 'org-1' },
      { userId: 'u-1', kind: 'conversation.takeover', conversationId: 'c-1', payload: { aiPaused: true } }
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe(AUDIT_EVENT_INSERT_SQL);
    expect(params[0]).toBe('org-1');
    expect(params[1]).toBe('conversation.takeover');
    expect(params[2]).toBe('user');
    expect(params[3]).toBe('u-1');
    expect(JSON.parse(params[18])).toEqual({ conversationId: 'c-1', aiPaused: true });
  });

  it('logs and does not throw when the insert fails', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = { query: jest.fn().mockRejectedValue(new Error('violates check constraint')) } as any;
    await expect(
      auditConversationAction({ client, orgId: 'org-1' }, { userId: 'u-1', kind: 'conversation.resolve' })
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      '[conversation-audit] conversation.resolve not recorded:',
      'violates check constraint'
    );
    err.mockRestore();
  });
});
