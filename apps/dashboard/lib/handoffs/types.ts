/** Shared hand-off rule shape for Ask AI locked turns. */

export interface HandoffRule {
  /** Role substrings that identify the locked employee this rule applies to. */
  fromRoleIncludes: string[];
  /** Message must match at least one of these. */
  patterns: RegExp[];
  /** Target roster role (exact match preferred; UI matches by role). */
  toRole: string;
  reason: string;
}

export interface HandoffOffer {
  toRole: string;
  reason: string;
}

export function roleMatchesRule(employeeRole: string, rule: HandoffRule): boolean {
  const role = employeeRole.toLowerCase();
  return rule.fromRoleIncludes.some((frag) => role.includes(frag.toLowerCase()));
}

export function roleOwnsTarget(employeeRole: string, toRole: string): boolean {
  const role = employeeRole.toLowerCase();
  const target = toRole.toLowerCase();
  if (role === target) return true;
  // Customer Resolution owns "Customer Resolution"; Finance owns "Finance"; etc.
  if (target.includes('customer resolution') && role.includes('customer resolution')) return true;
  if (target === 'finance' && role.includes('finance')) return true;
  if (target === 'operations' && role.includes('operation')) return true;
  if ((target === 'growth' || target.includes('sales')) && (role.includes('growth') || role.includes('sales'))) {
    return true;
  }
  return role.includes(target);
}

export function matchHandoffRule(
  employeeRole: string,
  message: string,
  rules: HandoffRule[],
): HandoffOffer | null {
  const text = String(message || '');
  for (const rule of rules) {
    if (!roleMatchesRule(employeeRole, rule)) continue;
    if (!rule.patterns.some((p) => p.test(text))) continue;
    return { toRole: rule.toRole, reason: rule.reason };
  }
  return null;
}

/**
 * Locked single/team turn: offer a hand-off when every selected employee would
 * need to pass the request on, and none already owns the target role.
 */
export function matchLockedHandoff(
  lockedRoles: string[],
  message: string,
  rules: HandoffRule[],
): HandoffOffer | null {
  if (lockedRoles.length === 0) return null;
  let offer: HandoffOffer | null = null;
  for (const role of lockedRoles) {
    const hit = matchHandoffRule(role, message, rules);
    if (!hit) {
      // At least one locked employee owns (or doesn't need to hand off) this ask.
      return null;
    }
    if (lockedRoles.some((r) => roleOwnsTarget(r, hit.toRole))) {
      return null;
    }
    offer = hit;
  }
  return offer;
}
