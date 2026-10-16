/**
 * Morning triage brief (P3-BRIEF-1). Exceptions only.
 * A quiet day is one line — a dump of healthy work is a bug.
 */
import { HEALTHY_BRIEF_LINE } from './types.js';

export type BriefSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface BriefException {
  severity: BriefSeverity;
  title: string;
  detail: string;
  objectId?: string;
}

export interface TriageBrief {
  headline: string;
  exceptions: BriefException[];
  healthyLine: string | null;
  counts: { critical: number; high: number; medium: number; low: number; dropped: number };
}

const RANK: Record<BriefSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function buildTriageBrief(exceptions: BriefException[]): TriageBrief {
  const sorted = [...exceptions].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const shown = sorted.slice(0, 3);
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    dropped: Math.max(0, sorted.length - shown.length),
  };
  for (const e of exceptions) counts[e.severity] += 1;
  if (shown.length === 0) {
    return {
      headline: HEALTHY_BRIEF_LINE,
      exceptions: [],
      healthyLine: HEALTHY_BRIEF_LINE,
      counts,
    };
  }
  return {
    headline: `${shown.length} item${shown.length === 1 ? '' : 's'} require attention.`,
    exceptions: shown,
    healthyLine: HEALTHY_BRIEF_LINE,
    counts,
  };
}
