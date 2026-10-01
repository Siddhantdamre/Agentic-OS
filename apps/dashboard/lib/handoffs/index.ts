import { rules as customerRules } from './customer';
import { rules as operationsRules } from './operations';
import { rules as growthSalesRules } from './growth-sales';
import { rules as marketingFinanceRules } from './marketing-finance';
import { rules as researchExecutiveRules } from './research-executive';
import { matchCustomHandoff, type CustomEmployeeForHandoff } from './custom';
import {
  matchLockedHandoff,
  type HandoffOffer,
  type HandoffRule,
} from './types';

export type { HandoffOffer, HandoffRule };
export { matchHandoffRule, matchLockedHandoff, roleMatchesRule, roleOwnsTarget } from './types';

export const ALL_HANDOFF_RULES: HandoffRule[] = [
  ...customerRules,
  ...operationsRules,
  ...growthSalesRules,
  ...marketingFinanceRules,
  ...researchExecutiveRules,
];

/** Evaluate locked-turn hand-off against the full rule catalog. */
export function resolveLockedHandoff(
  lockedRoles: string[],
  message: string,
): HandoffOffer | null {
  return matchLockedHandoff(lockedRoles, message, ALL_HANDOFF_RULES);
}

/** Locked-turn hand-off for custom employees (request-keyed, tool-card aware). */
export function resolveCustomHandoff(
  employees: CustomEmployeeForHandoff[],
  message: string,
): HandoffOffer | null {
  return matchCustomHandoff(employees, message, ALL_HANDOFF_RULES);
}
