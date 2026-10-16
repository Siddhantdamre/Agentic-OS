import type { LedgerDecision } from '@/lib/employee-observability';
export interface ExplainMatch {
  id: string; actionConsidered: string; decision: LedgerDecision; reasonCode: string;
  reasonSummary: string; confidence: number; createdAt: string; score: number;
}
export interface LedgerExplainRow {
  id: string; action_considered: string; decision: string; reason_code: string;
  reason_summary: string; confidence_score: number | string; created_at: Date | string;
}
const STOP = new Set(['the','a','an','and','or','of','to','for','in','on','why','did','you','not','didn','didnt','was','were','with','from','that','this','it']);
export function tokenizeExplainQuery(q: string): string[] {
  return q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 1 && !STOP.has(t));
}
export function scoreExplainRow(tokens: string[], row: LedgerExplainRow): number {
  if (!tokens.length) return 0;
  const hay = `${row.action_considered} ${row.reason_code} ${row.reason_summary}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) if (hay.includes(token)) hits += 1;
  if (hits === 0) return 0;
  const ageDays = Math.max(0, (Date.now() - new Date(row.created_at).getTime()) / 86_400_000);
  return hits + Math.max(0, 1 - ageDays / 90) * 0.25;
}
export function rankExplainMatches(query: string, rows: LedgerExplainRow[]): ExplainMatch[] {
  const tokens = tokenizeExplainQuery(query);
  const allowed: LedgerDecision[] = ['executed','deferred','declined','escalated','suppressed'];
  return rows.map((row) => {
    const score = scoreExplainRow(tokens, row);
    const decision = allowed.includes(row.decision as LedgerDecision) ? (row.decision as LedgerDecision) : 'declined';
    return { id: row.id, actionConsidered: row.action_considered, decision, reasonCode: row.reason_code, reasonSummary: row.reason_summary, confidence: Number(row.confidence_score), createdAt: new Date(row.created_at).toISOString(), score };
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score);
}
