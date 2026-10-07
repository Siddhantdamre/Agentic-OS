/**
 * The approval requests a chat turn sends: where the card says what is being approved. Keeps the sentence and the call
 * the server sent, drops anything that is not shaped like them, and never lets an odd value reach the screen.
 */
import type { ApprovalCallInfo } from '@/components/chat/AgentTrajectory';

export type ChatApproval = { threadId: string; toolCallId: string; toolName: string } & ApprovalCallInfo;

export function normalizeApprovals(raw: unknown): ChatApproval[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatApproval[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (!a.threadId || !a.toolCallId) continue;
    const entry: ChatApproval = { threadId: String(a.threadId), toolCallId: String(a.toolCallId), toolName: String(a.toolName || 'tool') };
    if (typeof a.summary === 'string' && a.summary.trim()) entry.summary = a.summary;
    const c = a.call as Record<string, unknown> | undefined;
    if (c && typeof c.tool === 'string' && typeof c.action === 'string' && c.args && typeof c.args === 'object' && !Array.isArray(c.args)) {
      entry.call = { tool: c.tool, action: c.action, args: c.args as Record<string, unknown> };
    }
    out.push(entry);
  }
  return out;
}
