export const ROLLOUT_STAGES = [0, 1, 2, 3] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];
export type EmployeeGateVerdict = 'shadow' | 'allow' | 'escalate' | 'deny_role';
export interface EmployeeGateInput {
  killSwitch: boolean;
  rolloutStage: RolloutStage;
  employeeRole: string;
  actionType: string;
  reversibility: 'reversible' | 'visible' | 'irreversible';
}
export function parseRolloutStage(value: unknown): RolloutStage {
  const n = typeof value === 'string' ? Number(value) : value;
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  return 0;
}
export function classifyActionSurface(actionType: string): 'internal' | 'external' | 'irreversible' {
  const normalized = actionType.replace(/_/g, ' ').toLowerCase();
  if (/\b(refund|delete|wire)\b/.test(normalized)) return 'irreversible';
  if (/\b(send|email|whatsapp|sms|publish|outbound)\b/.test(normalized)) return 'external';
  return 'internal';
}
export function gateEmployeeAction(input: EmployeeGateInput): EmployeeGateVerdict {
  if (input.killSwitch) return 'shadow';
  const stage = parseRolloutStage(input.rolloutStage);
  if (input.reversibility === 'irreversible') return 'escalate';
  switch (stage) {
    case 0: return 'shadow';
    case 1: return classifyActionSurface(input.actionType) === 'internal' ? 'allow' : 'escalate';
    case 2: return classifyActionSurface(input.actionType) === 'external' ? 'escalate' : 'allow';
    case 3: return input.reversibility === 'visible' ? 'escalate' : 'allow';
    default: { const _exhaustive: never = stage; return _exhaustive; }
  }
}
export function canAdvanceStage(args: {
  from: RolloutStage; shadowReviewed: number; shadowAgreed: number; weeksInStage: number;
  stateDivergences: number; approvalRate: number | null; decisionsInStage: number;
}): { ok: boolean; reason: string } {
  const from = parseRolloutStage(args.from);
  switch (from) {
    case 0:
      if (args.shadowReviewed < 50) return { ok: false, reason: 'Need 50 shadow decisions reviewed by an operator' };
      if (args.shadowReviewed === 0 || args.shadowAgreed / args.shadowReviewed < 0.9) {
        return { ok: false, reason: 'Operator agreement must be at least 90% of reviewed shadows' };
      }
      return { ok: true, reason: 'Shadow exit met' };
    case 1:
      if (args.weeksInStage < 2) return { ok: false, reason: 'Internal stage needs two weeks' };
      if (args.stateDivergences > 0) return { ok: false, reason: 'State divergences must be zero' };
      if (args.approvalRate == null || args.approvalRate < 0.6 || args.approvalRate > 0.9) {
        return { ok: false, reason: 'Approval rate must sit in the 60–90% band' };
      }
      return { ok: true, reason: 'Internal exit met' };
    case 2:
      if (args.decisionsInStage < 100) return { ok: false, reason: 'Need 100+ gated external decisions' };
      if (args.approvalRate == null || args.approvalRate < 0.8) {
        return { ok: false, reason: 'Approval rate must be at least 80% over those decisions' };
      }
      return { ok: true, reason: 'External gated exit met' };
    case 3:
      return { ok: false, reason: 'Stage 3 is the steady state' };
    default: { const _exhaustive: never = from; return _exhaustive; }
  }
}
