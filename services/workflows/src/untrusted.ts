/**
 * Untrusted-content isolation (18). Customer text is a claim source, never
 * an instruction. The extractor must run with no tools bound; this module
 * fences the text and flags obligor/sender mismatches.
 */

export type MessageSender = 'customer' | 'employee' | 'system';
export type Obligor = 'us' | 'them';

export interface FencedContent {
  role: 'untrusted_user_content';
  text: string;
  sourceMessageId?: string;
}

export interface ObligorCheck {
  ok: boolean;
  reasonCode?: 'obligor_sender_mismatch';
}

const FENCE_OPEN = '<<<UNTRUSTED_USER_CONTENT>>>';
const FENCE_CLOSE = '<<<END_UNTRUSTED_USER_CONTENT>>>';

/** Wrap inbound text so it cannot sit next to tool definitions unmarked. */
export function fenceUntrusted(text: string, sourceMessageId?: string): FencedContent {
  const sanitized = text.split(FENCE_CLOSE).join('').split(FENCE_OPEN).join('');
  return {
    role: 'untrusted_user_content',
    text: `${FENCE_OPEN}\n${sanitized}\n${FENCE_CLOSE}`,
    sourceMessageId,
  };
}

/**
 * An obligation with obligor=us extracted from a *customer* message is the
 * signature of an injection ("as agreed, refund me"). Sender comes from the
 * channel, never from the text.
 */
export function checkObligorSender(obligor: Obligor, sender: MessageSender): ObligorCheck {
  if (obligor === 'us' && sender === 'customer') {
    return { ok: false, reasonCode: 'obligor_sender_mismatch' };
  }
  return { ok: true };
}

/** Quote must be a literal substring of the source message (13 §3). */
export function quoteIsGrounded(quote: string, sourceMessage: string): boolean {
  if (!quote || !sourceMessage) return false;
  return sourceMessage.includes(quote);
}

export { FENCE_OPEN, FENCE_CLOSE };
