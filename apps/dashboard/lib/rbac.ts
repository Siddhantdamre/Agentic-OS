import type { PoolClient } from 'pg';
import { canCallPayTools as sharedCanCallPayTools, ORG_HUMAN_ROLES } from '@darex/shared-types';

export const HUMAN_ROLES = ORG_HUMAN_ROLES;

export type HumanRole = (typeof HUMAN_ROLES)[number];

const PAY_TOOL_KEYS = new Set([
  'razorpay',
  'stripe',
  'razorpay-create-payment-link',
  'razorpay_create_payment_link',
  'stripe-create-payment-link',
  'stripe_create_payment_link',
]);

const PAY_ACTION_RE = /\b(pay|payout|payment[_\s-]?link|charge|capture|refund)\b/i;

function normalizeToolKey(value: string): string {
  return String(value || '').toLowerCase().replace(/_/g, '-');
}

export function isHumanRole(value: string): value is HumanRole {
  return (HUMAN_ROLES as readonly string[]).includes(value);
}

export function parseHumanRole(value: unknown): HumanRole {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (raw === 'agent') return 'member';
  if (isHumanRole(raw)) return raw;
  return 'member';
}

export function canDisableEmployee(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export const canCallPayTools = sharedCanCallPayTools;

export function canApproveActions(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
      return true;
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function canApproveRefunds(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/**
 * Customer-facing conversation actions: human reply, pause/resume AI,
 * resolve, assign, create conversation or channel. Auditor and billing
 * are read-only on the inbox (CH-S05).
 */
export function canActOnConversations(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
      return true;
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/**
 * Read access to operational queues (work items, pending approvals,
 * autonomy rules, suppressions). Billing has no need for them.
 */
export function canReadOperations(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
    case 'auditor':
      return true;
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function canReadAudit(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'auditor':
      return true;
    case 'member':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function canManageOrgSettings(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function canExportDsr(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function canDeleteDsr(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
      return true;
    case 'admin':
    case 'member':
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function isPayTool(tool: string, action?: string): boolean {
  const key = normalizeToolKey(tool);
  if (PAY_TOOL_KEYS.has(key) || PAY_TOOL_KEYS.has(tool.toLowerCase())) return true;
  if (key.includes('razorpay') || key.includes('stripe')) {
    if (!action) return true;
    return PAY_ACTION_RE.test(action) || /create_payment_link|payment_link/i.test(action);
  }
  if (action && PAY_ACTION_RE.test(action)) return true;
  return false;
}

export async function loadHumanRole(client: PoolClient, userId: string): Promise<HumanRole> {
  const res = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1 LIMIT 1`, [userId]);
  return parseHumanRole(res.rows[0]?.role);
}
