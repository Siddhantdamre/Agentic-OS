/**
 * CE-03 / CE-05 shared policy: "refund within 14 days, under $100 settles
 * automatically" (3-employee.md CE-05). Pure and side-effect free so both the
 * RAG answer path (CE-03 — tell the customer the real verdict, don't guess)
 * and the actual Stripe refund action (CE-05 — never execute outside policy)
 * use one source of truth.
 */
export interface RefundEligibilityInput {
  /** ISO timestamp of the original charge. */
  chargeAtIso: string;
  amountMinor: number;
  nowIso?: string;
  /** Defaults to the org's standard 14-day refund window. */
  windowDays?: number;
  /** Defaults to the org's standard $100 (10,000 minor units) auto-refund cap. */
  maxAmountMinor?: number;
}

export type RefundReasonCode =
  | 'within_policy'
  | 'window_expired'
  | 'amount_exceeds_limit'
  | 'invalid_input';

export interface RefundEligibilityVerdict {
  eligible: boolean;
  reasonCode: RefundReasonCode;
  daysSinceCharge: number;
  windowDays: number;
  maxAmountMinor: number;
}

export const DEFAULT_REFUND_WINDOW_DAYS = 14;
export const DEFAULT_REFUND_MAX_AMOUNT_MINOR = 10_000; // $100.00

export function checkRefundEligibility(input: RefundEligibilityInput): RefundEligibilityVerdict {
  const windowDays = input.windowDays ?? DEFAULT_REFUND_WINDOW_DAYS;
  const maxAmountMinor = input.maxAmountMinor ?? DEFAULT_REFUND_MAX_AMOUNT_MINOR;
  const chargedAt = new Date(input.chargeAtIso);
  const now = input.nowIso ? new Date(input.nowIso) : new Date();

  if (Number.isNaN(chargedAt.getTime()) || !Number.isFinite(input.amountMinor)) {
    return { eligible: false, reasonCode: 'invalid_input', daysSinceCharge: NaN, windowDays, maxAmountMinor };
  }

  const daysSinceCharge = Math.floor((now.getTime() - chargedAt.getTime()) / 86_400_000);

  if (daysSinceCharge > windowDays) {
    return { eligible: false, reasonCode: 'window_expired', daysSinceCharge, windowDays, maxAmountMinor };
  }
  if (input.amountMinor > maxAmountMinor) {
    return { eligible: false, reasonCode: 'amount_exceeds_limit', daysSinceCharge, windowDays, maxAmountMinor };
  }
  return { eligible: true, reasonCode: 'within_policy', daysSinceCharge, windowDays, maxAmountMinor };
}

export function isRefundQuery(text: string): boolean {
  return /\brefund|money\s*back|chargeback\b/i.test(String(text || ''));
}

export function describeRefundVerdict(verdict: RefundEligibilityVerdict, amountMinor: number, currency: string | null): string {
  const amount = `${(amountMinor / 100).toFixed(2)} ${(currency || '').toUpperCase()}`.trim();
  switch (verdict.reasonCode) {
    case 'within_policy':
      return `Refund eligible: charge of ${amount} was ${verdict.daysSinceCharge} day(s) ago (within the ${verdict.windowDays}-day window and under the auto-refund limit).`;
    case 'window_expired':
      return `Refund NOT eligible: charge of ${amount} was ${verdict.daysSinceCharge} day(s) ago, past the ${verdict.windowDays}-day refund window.`;
    case 'amount_exceeds_limit':
      return `Refund NOT auto-eligible: charge of ${amount} exceeds the auto-refund limit and needs manager approval.`;
    default:
      return 'Refund eligibility could not be determined from billing data.';
  }
}
