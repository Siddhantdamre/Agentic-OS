import type { CustomerOperationalState } from '@darex/shared-types';
import type { AccountProfile } from './account-profile.js';

export function inferOperationalState(input: {
  userMessage: string; forceEscalate?: boolean;
}): CustomerOperationalState {
  if (input.forceEscalate) return 'escalated';
  const text = String(input.userMessage || '').toLowerCase();
  if (/\b(angry|furious|lawsuit|legal|refund)\b/.test(text)) return 'frustrated';
  if (/\b(still waiting|unresolved)\b/.test(text)) return 'unresolved';
  if (/\b(cancel|churn|leaving)\b/.test(text)) return 'at_risk';
  return text.trim() ? 'existing' : 'new';
}

/**
 * CE-02: the keyword state above is a cheap first pass on message text only.
 * A VIP account (real MRR/lifecycle/tag data, not a guess) with any negative
 * signal gets escalated rather than left at "frustrated" / "at_risk", since
 * losing a high-value account is materially worse than losing a routine one.
 */
export function applyAccountProfileToState(
  state: CustomerOperationalState,
  profile: AccountProfile | null | undefined,
): CustomerOperationalState {
  if (!profile?.vip) return state;
  if (state === 'frustrated' || state === 'at_risk' || state === 'unresolved') return 'escalated';
  return state;
}

/**
 * CE-09: severity weight per operational state, used to score a turn for the
 * sentiment history log and to detect a negative *trend* across turns rather
 * than reacting to (or missing) one keyword hit in isolation.
 */
export function sentimentSeverity(state: CustomerOperationalState): number {
  switch (state) {
    case 'escalated':
      return 4;
    case 'frustrated':
      return 3;
    case 'at_risk':
    case 'unresolved':
      return 2;
    case 'waiting':
      return 1;
    default:
      return 0;
  }
}

export const SENTIMENT_TREND_NEGATIVE_THRESHOLD = 2;
export const SENTIMENT_TREND_WINDOW = 3;

export interface SentimentTrendPoint {
  severity: number;
}

export interface SentimentTrendResult {
  negativeCount: number;
  windowSize: number;
  escalate: boolean;
}

/**
 * Looks at the most recent `SENTIMENT_TREND_WINDOW` turns (newest first) and
 * flags a trend once at least `SENTIMENT_TREND_NEGATIVE_THRESHOLD` of them
 * were negative (severity >= 2 — at_risk/unresolved/frustrated/escalated).
 * A single angry message no longer needs to fire an alert on its own; a
 * *pattern* of negativity does.
 */
export function evaluateSentimentTrend(history: SentimentTrendPoint[]): SentimentTrendResult {
  const window = history.slice(0, SENTIMENT_TREND_WINDOW);
  const negativeCount = window.filter((point) => point.severity >= 2).length;
  return {
    negativeCount,
    windowSize: window.length,
    escalate: negativeCount >= SENTIMENT_TREND_NEGATIVE_THRESHOLD,
  };
}
