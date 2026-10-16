/**
 * @jest-environment node
 *
 * Billing role matrix — pure RBAC helpers after HumanRole gained `billing`.
 */

import {
  canApproveActions,
  canApproveRefunds,
  canCallPayTools,
  canDeleteDsr,
  canDisableEmployee,
  canExportDsr,
  canManageOrgSettings,
  canReadAudit,
  HUMAN_ROLES,
  parseHumanRole,
  type HumanRole,
} from '../rbac';

/** Mirrors billing/_lib canManageBilling — kept local so this test stays pure. */
function canManageBilling(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'billing':
      return true;
    case 'member':
    case 'auditor':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

describe('billing HumanRole', () => {
  it('is part of HUMAN_ROLES and parseable', () => {
    expect(HUMAN_ROLES).toContain('billing');
    expect(parseHumanRole('billing')).toBe('billing');
  });

  it('can manage billing but not settings, employees, DSR delete, or pay tools', () => {
    const role: HumanRole = 'billing';
    expect(canManageBilling(role)).toBe(true);
    expect(canManageOrgSettings(role)).toBe(false);
    expect(canDisableEmployee(role)).toBe(false);
    expect(canReadAudit(role)).toBe(false);
    expect(canExportDsr(role)).toBe(false);
    expect(canDeleteDsr(role)).toBe(false);
    expect(canCallPayTools(role)).toBe(false);
    expect(canApproveActions(role)).toBe(false);
    expect(canApproveRefunds(role)).toBe(false);
  });

  it('auditor cannot call pay tools or approve actions or refunds', () => {
    const role: HumanRole = 'auditor';
    expect(canCallPayTools(role)).toBe(false);
    expect(canApproveActions(role)).toBe(false);
    expect(canApproveRefunds(role)).toBe(false);
  });

  it('member can approve actions and call pay tools, but cannot approve refunds', () => {
    const role: HumanRole = 'member';
    expect(canApproveActions(role)).toBe(true);
    expect(canCallPayTools(role)).toBe(true);
    expect(canApproveRefunds(role)).toBe(false);
  });

  it('owner and admin can approve all actions, pay tools, and refunds', () => {
    for (const role of ['owner', 'admin'] as HumanRole[]) {
      expect(canApproveActions(role)).toBe(true);
      expect(canCallPayTools(role)).toBe(true);
      expect(canApproveRefunds(role)).toBe(true);
    }
  });

  it('owners and admins still manage billing; member and auditor do not', () => {
    expect(canManageBilling('owner')).toBe(true);
    expect(canManageBilling('admin')).toBe(true);
    expect(canManageBilling('member')).toBe(false);
    expect(canManageBilling('auditor')).toBe(false);
  });
});
