export const WRITEBACK_EVENTS = [
  'human_correction',
  'decision_card_resolved',
  'conversation_closed',
  'durable_fact_confirmed',
  'obligation_resolved',
] as const;

export type WriteBackEvent = (typeof WRITEBACK_EVENTS)[number];

const ALLOWED = new Set<string>(WRITEBACK_EVENTS);

export function isWriteBackEvent(value: string | null | undefined): value is WriteBackEvent {
  return typeof value === 'string' && ALLOWED.has(value);
}

export function isAllowedWriteBack(event: string | null | undefined): boolean {
  return isWriteBackEvent(event);
}

export function classifyWriteBackEvent(input: {
  humanCorrected?: boolean;
  decisionResolved?: boolean;
  conversationClosed?: boolean;
  durableFactConfirmed?: boolean;
  obligationResolved?: boolean;
  generated?: boolean;
}): WriteBackEvent | null {
  if (input.generated) return null;
  if (input.humanCorrected) return 'human_correction';
  if (input.decisionResolved) return 'decision_card_resolved';
  if (input.conversationClosed) return 'conversation_closed';
  if (input.durableFactConfirmed) return 'durable_fact_confirmed';
  if (input.obligationResolved) return 'obligation_resolved';
  return null;
}
