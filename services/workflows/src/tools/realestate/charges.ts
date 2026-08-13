/**
 * PM charge close gate. "I paid" without a PSP webhook does not close a charge.
 */

import type { ChargeCloseAttempt, ChargeRecord } from './types.js';

export function applyChargeEvent(charge: ChargeRecord, attempt: ChargeCloseAttempt, nowIso: string): ChargeRecord {
  switch (attempt.kind) {
    case 'tenant_claim':
      return {
        ...charge,
        claimedPaidAt: nowIso,
        status: charge.status,
        closedReason: charge.closedReason,
        pspPaymentId: charge.pspPaymentId,
      };
    case 'psp_webhook': {
      const id = attempt.pspPaymentId.trim();
      if (!id) {
        return { ...charge, claimedPaidAt: charge.claimedPaidAt || nowIso };
      }
      return {
        ...charge,
        status: 'closed',
        closedReason: 'psp_webhook',
        pspPaymentId: id,
        claimedPaidAt: charge.claimedPaidAt,
      };
    }
    case 'human_confirm':
      return {
        ...charge,
        status: 'closed',
        closedReason: 'human_confirm',
        pspPaymentId: charge.pspPaymentId,
        claimedPaidAt: charge.claimedPaidAt,
      };
    default: {
      const _exhaustive: never = attempt;
      return _exhaustive;
    }
  }
}

export function tenantClaimClosesCharge(): false {
  return false;
}
