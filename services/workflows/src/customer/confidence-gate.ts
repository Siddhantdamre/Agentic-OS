export const RAG_CONFIDENCE_THRESHOLD = 0.72;
export const ESCALATION_HOLDING_REPLY =
  'I want to get this right rather than guess. A teammate is reviewing and will follow up shortly.';
export function evaluateConfidenceGate(input: { topSimilarity: number | null | undefined; toolHit: boolean }) {
  const top = Number.isFinite(input.topSimilarity) ? Number(input.topSimilarity) : 0;
  if (top < RAG_CONFIDENCE_THRESHOLD && !input.toolHit) {
    return { allow: false as const, reason: 'low_rag_no_tool' as const, topSimilarity: top };
  }
  return { allow: true as const, reason: 'ok' as const, topSimilarity: top };
}
export function shouldForceEscalation(input: { topSimilarity: number; toolHit: boolean }): boolean {
  return !evaluateConfidenceGate(input).allow;
}
