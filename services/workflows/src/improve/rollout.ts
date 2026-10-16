/**
 * Rollout: draft -> shadow -> canary (10% of traffic) -> active. Humans approve; metrics can pull a change back.
 */
import { MIN_DECIDED_TO_JUDGE } from './thresholds.js';
import type { VersionStatus } from './registry.js';

export const CANARY_SHARE = 0.1;
const ORDER: VersionStatus[] = ['draft', 'shadow', 'canary', 'active'];

export function canAdvance(from: VersionStatus, to: VersionStatus): boolean {
  const i = ORDER.indexOf(from);
  return i >= 0 && ORDER[i + 1] === to;
}

export interface AdvanceInput { from: VersionStatus; to: VersionStatus; approvedBy?: string; gatePassed: boolean }
export function advance(i: AdvanceInput): { ok: boolean; reason?: string } {
  if (!canAdvance(i.from, i.to)) return { ok: false, reason: `Cannot go from ${i.from} to ${i.to}; stages go one at a time.` };
  if (i.to === 'shadow' && !i.gatePassed) return { ok: false, reason: 'The held-out test has not passed.' };
  if ((i.to === 'canary' || i.to === 'active') && !i.approvedBy) return { ok: false, reason: 'A person must approve before this goes live.' };
  return { ok: true };
}

export interface Metrics {
  decided: number; // approved + rejected
  approved: number;
  failedToRun: number;
  complaints: number;
}
export const ROLLBACK = { approvalDrop: 0.15, failedMin: 3, failedShare: 0.2, complaintRise: 0.05, complaintMin: 2 } as const;

export function shouldRollback(input: { baseline: Metrics; current: Metrics }): { rollback: boolean; enough: boolean; reasons: string[] } {
  const { baseline: b, current: c } = input;
  if (c.decided < MIN_DECIDED_TO_JUDGE || b.decided < MIN_DECIDED_TO_JUDGE) {
    return { rollback: false, enough: false, reasons: [`Too few decisions to judge (need ${MIN_DECIDED_TO_JUDGE} now and before).`] };
  }
  const reasons: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const ar = (m: Metrics) => m.approved / m.decided;
  if (ar(b) - ar(c) >= ROLLBACK.approvalDrop) reasons.push(`Approvals fell from ${pct(ar(b))} to ${pct(ar(c))}.`);
  if (c.failedToRun >= ROLLBACK.failedMin && c.failedToRun / c.decided >= ROLLBACK.failedShare) reasons.push(`${c.failedToRun} of ${c.decided} approved actions failed to run.`);
  const cr = (m: Metrics) => m.complaints / m.decided;
  if (cr(c) - cr(b) >= ROLLBACK.complaintRise && c.complaints - b.complaints >= ROLLBACK.complaintMin) reasons.push(`Complaints rose from ${pct(cr(b))} to ${pct(cr(c))}.`);
  return { rollback: reasons.length > 0, enough: true, reasons };
}

export type ChangeKind = 'instruction' | 'knowledge';
export function needsHuman(change: { kind: ChangeKind }): { required: true; approver: 'admin' | 'owner'; autoApplyAllowed: false } {
  return { required: true, approver: change.kind === 'instruction' ? 'admin' : 'owner', autoApplyAllowed: false };
}
