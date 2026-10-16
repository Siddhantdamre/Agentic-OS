import type { HandoffOffer, HandoffRule } from './types';
import { roleOwnsTarget } from './types';

/**
 * Hand-off offers for custom (hired) employees in Pick one / Team mode.
 *
 * Built-in roles have their own rule files keyed by role. A custom employee has
 * an arbitrary role, so these rules key off the request instead and only fire
 * when the custom employee's own tool card cannot do the work: if the card
 * already holds one of `ownedTools`, the employee keeps the turn.
 */
interface CustomHandoffRule {
  patterns: RegExp[];
  toRole: string;
  reason: string;
  /** Normalised tool keys that mean the custom employee can already do this. */
  ownedTools: string[];
}

export interface CustomEmployeeForHandoff {
  role?: string | null;
  name?: string | null;
  allowlist: string[];
}

const RULES: CustomHandoffRule[] = [
  {
    patterns: [/\b(refund|chargeback)\b/i],
    toRole: 'Customer',
    reason: 'Refunds are owned by Customer Resolution.',
    ownedTools: ['zendesk', 'intercom'],
  },
  {
    patterns: [/\b(payment link|payout|stripe|razorpay|quickbooks)\b/i],
    toRole: 'Finance',
    reason: 'Payment links, charges, and invoices hand off to Finance.',
    ownedTools: ['stripe', 'razorpay', 'quickbooks'],
  },
  {
    patterns: [/\b(roas|meta[- ]?ads|google[- ]?ads|ad campaign)\b/i],
    toRole: 'Marketing & Analytics',
    reason: 'Ad campaigns and ROAS hand off to Marketing & Analytics.',
    ownedTools: ['google-ads', 'meta-ads'],
  },
  {
    patterns: [/\b(apollo|cold outreach|lookalike|lead gen)\b/i],
    toRole: 'Sales & Lead Gen',
    reason: 'Prospecting and cold outreach hand off to Sales & Lead Gen.',
    ownedTools: ['apollo', 'linkedin'],
  },
  {
    patterns: [/\b(founder|who founded|company (overview|background))\b/i],
    toRole: 'Research',
    reason: 'Company and founder questions hand off to Research.',
    ownedTools: ['web-search', 'web_search'],
  },
];

const key = (s: string) => s.toLowerCase().replace(/_/g, '-');

/** True when the role matches any built-in rule file (those have their own rules). */
export function isBuiltInRole(role: string, builtIn: HandoffRule[]): boolean {
  const r = role.toLowerCase();
  return builtIn.some((rule) => rule.fromRoleIncludes.some((f) => r.includes(f.toLowerCase())));
}

export function matchCustomHandoff(
  employees: CustomEmployeeForHandoff[],
  message: string,
  builtIn: HandoffRule[],
): HandoffOffer | null {
  if (employees.length === 0) return null;
  const roles = employees.map((e) => String(e.role || e.name || ''));
  // Any built-in employee in the selection owns its own rules; do not second-guess.
  if (roles.some((r) => isBuiltInRole(r, builtIn))) return null;
  const text = String(message || '');
  for (const rule of RULES) {
    if (!rule.patterns.some((p) => p.test(text))) continue;
    if (roles.some((r) => roleOwnsTarget(r, rule.toRole))) return null;
    const owns = employees.some((e) =>
      e.allowlist.map(key).some((t) => rule.ownedTools.map(key).includes(t)),
    );
    if (owns) return null;
    return { toRole: rule.toRole, reason: rule.reason };
  }
  return null;
}
