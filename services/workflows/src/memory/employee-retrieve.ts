import { retrieveMemory, type RetrieveMemoryParams, filterCitationsForPersona, PERSONA_TOKEN_BUDGET } from './retrieve.js';
import type { MemoryCitation, RetrieveMemoryResult } from '@darex/shared-types';
import { normalizeEmployeePersona } from '../tools/role-capability.js';
import { fetchLastCharge } from '../customer/account-profile.js';
import { checkRefundEligibility, describeRefundVerdict, isRefundQuery } from '../customer/refund-eligibility.js';

export interface EmployeeRetrieveParams extends RetrieveMemoryParams {
  employeeRole?: string;
  /** Customer email — used only to ground a refund-eligibility citation (CE-03). Never persisted here. */
  customerIdentifier?: string;
}

export { filterCitationsForPersona, PERSONA_TOKEN_BUDGET };

/**
 * CE-03: on top of the org-wide RAG lookup, a customer-employee turn that
 * looks like a refund/policy question gets a grounded refund-eligibility
 * citation computed from the customer's real last Stripe charge — never a
 * hallucinated "yes you're eligible". Silently skipped (not an error) when
 * billing isn't connected or the account has no charge history.
 */
export async function retrieveForEmployee(params: EmployeeRetrieveParams): Promise<RetrieveMemoryResult> {
  const base = await retrieveMemory(params);
  const persona = normalizeEmployeePersona(params.employeeRole);
  if (persona !== 'customer' || !params.customerIdentifier || !isRefundQuery(params.query)) {
    return base;
  }
  try {
    const charge = await fetchLastCharge(params.orgId, params.customerIdentifier);
    if (!charge) return base;
    const verdict = checkRefundEligibility({ chargeAtIso: charge.chargeAtIso, amountMinor: charge.amountMinor });
    const citation: MemoryCitation = {
      id: 'refund-eligibility',
      tier: 'entity',
      snippet: describeRefundVerdict(verdict, charge.amountMinor, charge.currency),
      source: 'tool',
      sourceRef: `stripe:${charge.chargeId}`,
      stale: false,
      updatedAt: new Date().toISOString(),
    };
    return { orgId: base.orgId, citations: [citation, ...base.citations], emptyIndex: false };
  } catch {
    return base;
  }
}
