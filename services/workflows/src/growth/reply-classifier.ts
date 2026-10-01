export const REPLY_CLASSIFICATIONS = ['interested', 'objection', 'ooo', 'unsubscribe', 'neutral'] as const;
export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number];

const UNSUBSCRIBE_RE = /\b(unsubscribe|remove me|stop emailing|take me off|do not contact)\b/i;
const OOO_RE = /\b(out of office|ooo|on leave|on vacation|returning on|back in the office|auto[- ]?reply)\b/i;
const OBJECTION_RE = /\b(not interested|no budget|not the right time|already (have|use) a (tool|solution|vendor)|please remove|not a fit)\b/i;
const INTERESTED_RE = /\b(interested|let'?s talk|book a (call|time|demo)|sounds good|tell me more|schedule a|works for me|happy to chat)\b/i;

/**
 * GE-09 Smart Reply Sorter — deterministic keyword classifier for inbound
 * outreach replies. Matches the same regex-heuristic style already used by
 * classifyEmail() in tools/gmail.ts. Order matters: unsubscribe/OOO are
 * checked before interest so an auto-reply never reads as a hot lead.
 */
export function classifyReply(text: string): ReplyClassification {
  const body = String(text || '').toLowerCase();
  if (UNSUBSCRIBE_RE.test(body)) return 'unsubscribe';
  if (OOO_RE.test(body)) return 'ooo';
  if (OBJECTION_RE.test(body)) return 'objection';
  if (INTERESTED_RE.test(body)) return 'interested';
  return 'neutral';
}
