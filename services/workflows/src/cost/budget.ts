import { createHash } from 'node:crypto';

export const DEFAULT_MAX_MODEL_CALLS_PER_TRIGGER = 8;
export const DEFAULT_MAX_ACTIONS_PER_SWEEP = 50;
export const DEFAULT_MAX_SPEND_CENTS_PER_DAY = 2500;

export interface OrgCostCeiling {
  maxModelCallsPerTrigger: number;
  maxActionsPerSweep: number;
  maxSpendCentsPerDay: number;
  escalateOnly: boolean;
}

export function defaultCostCeiling(): OrgCostCeiling {
  return {
    maxModelCallsPerTrigger: DEFAULT_MAX_MODEL_CALLS_PER_TRIGGER,
    maxActionsPerSweep: DEFAULT_MAX_ACTIONS_PER_SWEEP,
    maxSpendCentsPerDay: DEFAULT_MAX_SPEND_CENTS_PER_DAY,
    escalateOnly: false,
  };
}

export function shouldAbortTrigger(used: number, ceiling = DEFAULT_MAX_MODEL_CALLS_PER_TRIGGER): boolean {
  return used >= ceiling;
}

export function sweepShare(sweepModelCalls: number, totalModelCalls: number): number {
  if (totalModelCalls <= 0) return 0;
  return sweepModelCalls / totalModelCalls;
}

export function costPerObligation(spendCents: number, obligations: number): number | null {
  if (obligations <= 0) return null;
  return spendCents / obligations;
}

export function orgSweepJitterMs(orgId: string, intervalMs: number): number {
  const digest = createHash('sha256').update(orgId).digest();
  return digest.readUInt32BE(0) % intervalMs;
}

export function dailySpendBreached(spendCents: number, ceiling: OrgCostCeiling): boolean {
  return spendCents >= ceiling.maxSpendCentsPerDay;
}

/** Fallback blended rate when the runtime reports tokens but no cost. */
export const DEFAULT_FALLBACK_USD_PER_MTOK = 0.5;

export interface TurnSpendUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCostInUsd?: number;
}

/**
 * Spend for one agent turn in fractional cents. Prefers the runtime's own
 * cost; otherwise prices reported tokens at a blended fallback rate so a hard
 * cap still fills when a provider returns no cost. No usage → 0.
 */
export function turnSpendCents(
  usage: TurnSpendUsage | undefined,
  usdPerMTok = DEFAULT_FALLBACK_USD_PER_MTOK,
): number {
  if (!usage) return 0;
  const cost = Number(usage.totalCostInUsd);
  if (Number.isFinite(cost) && cost > 0) return round4(cost * 100);
  const total = Number(usage.totalTokens);
  const tokens =
    Number.isFinite(total) && total > 0
      ? total
      : Math.max(0, Number(usage.inputTokens) || 0) + Math.max(0, Number(usage.outputTokens) || 0);
  if (tokens <= 0) return 0;
  const rate = Number.isFinite(usdPerMTok) && usdPerMTok > 0 ? usdPerMTok : DEFAULT_FALLBACK_USD_PER_MTOK;
  return round4((tokens / 1_000_000) * rate * 100);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
