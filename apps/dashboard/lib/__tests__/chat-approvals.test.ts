/**
 * @jest-environment node
 */
import { normalizeApprovals } from '../chat-approvals';

const call = { tool: 'gmail', action: 'send_email', args: { to: 'priya@example.test', subject: 'Hi', body: 'Hello' } };

describe('normalizeApprovals', () => {
  it('keeps what the server says the call would do, and the call, so the card can show them', () => {
    const out = normalizeApprovals([{ threadId: 't1', toolCallId: 'c1', toolName: 'gmail_send', summary: 'Send email "Hi" to priya@example.test', call }]);
    expect(out).toEqual([{ threadId: 't1', toolCallId: 'c1', toolName: 'gmail_send', summary: 'Send email "Hi" to priya@example.test', call }]);
  });

  it('still accepts the plain form, without a summary or call', () => {
    expect(normalizeApprovals([{ threadId: 't1', toolCallId: 'c1' }])).toEqual([{ threadId: 't1', toolCallId: 'c1', toolName: 'tool' }]);
  });

  it('drops requests with no thread or call id, and anything that is not a list', () => {
    expect(normalizeApprovals([{ threadId: 't1' }, null, 'x', { toolCallId: 'c2' }])).toEqual([]);
    expect(normalizeApprovals(undefined)).toEqual([]);
    expect(normalizeApprovals({ threadId: 't', toolCallId: 'c' })).toEqual([]);
  });

  it('ignores a call that is not shaped like one, rather than rendering it', () => {
    const out = normalizeApprovals([{ threadId: 't1', toolCallId: 'c1', toolName: 'x', summary: 42, call: { tool: 'gmail', args: 'nope' } }]);
    expect(out).toEqual([{ threadId: 't1', toolCallId: 'c1', toolName: 'x' }]);
  });
});
