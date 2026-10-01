/**
 * Cheap pre-gate before the stage-1 classifier (13 §2).
 * Never the only gate — it misses indirect phrasing and fires on signatures.
 */
const COMMITMENT_HINT =
  /\b(i['’]ll|we['’]ll|i will|we will|i can send|we can send|get back|let you know|send you|follow(?:ing)? up|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|eod|eow)|check (?:the|with|on|warehouse|stock|order|status))\b/i;

export function keywordSuggestsCommitment(text: string): boolean {
  return COMMITMENT_HINT.test(String(text || ''));
}
