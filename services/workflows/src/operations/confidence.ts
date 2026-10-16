/**
 * Composite confidence (11 §3). Self-report is 15% and never the majority.
 * Cold start (no precedent) is capped at 0.75.
 */
import { COLD_START_CAP } from './types.js';

export const CONFIDENCE_WEIGHTS = {
  grounding: 0.35,
  stateCompleteness: 0.25,
  precedent: 0.25,
  selfReport: 0.15,
} as const;

export interface ConfidenceTerms {
  grounding: number;
  stateCompleteness: number;
  precedent: number;
  selfReport: number;
}

export interface CompositeConfidence {
  score: number;
  breakdown: ConfidenceTerms;
  coldStart: boolean;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function compositeConfidence(terms: ConfidenceTerms): CompositeConfidence {
  const grounding = clamp01(terms.grounding);
  const stateCompleteness = clamp01(terms.stateCompleteness);
  const precedent = clamp01(terms.precedent);
  const selfReport = clamp01(terms.selfReport);
  const coldStart = precedent <= 0;
  const raw =
    CONFIDENCE_WEIGHTS.grounding * grounding +
    CONFIDENCE_WEIGHTS.stateCompleteness * stateCompleteness +
    CONFIDENCE_WEIGHTS.precedent * precedent +
    CONFIDENCE_WEIGHTS.selfReport * selfReport;
  return {
    score: coldStart ? Math.min(COLD_START_CAP, raw) : clamp01(raw),
    breakdown: { grounding, stateCompleteness, precedent, selfReport },
    coldStart,
  };
}
