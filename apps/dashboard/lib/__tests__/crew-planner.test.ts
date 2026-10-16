import {
  enforceRefundCrewOwnership,
  filterValidEmployeeRows,
  heuristicCrewPlan,
  isActiveCrewMember,
  resolveCrewAssignments,
} from '../crew-planner';
import type { CrewPlan, CrewRosterMember, CrewSpecialistAssignment } from '@darex/shared-types';

function emp(partial: Partial<CrewRosterMember> & Pick<CrewRosterMember, 'id' | 'name'>): CrewRosterMember {
  return {
    role: partial.role || 'Ops',
    persona: partial.persona || 'helper',
    tool_allowlist: partial.tool_allowlist || [],
    status: partial.status,
    id: partial.id,
    name: partial.name,
  };
}

describe('filterValidEmployeeRows', () => {
  it('drops rows missing id or name and reports droppedCount', () => {
    const { valid, droppedCount } = filterValidEmployeeRows([
      { id: 'a', name: 'Alice' },
      { id: '', name: 'NoId' },
      { id: 'b', name: '' },
      { name: 'NoIdField' },
      { id: 'c', name: 'Carol' },
    ]);
    expect(droppedCount).toBe(3);
    expect(valid.map((r) => r.id)).toEqual(['a', 'c']);
    expect(valid.length).not.toBe(5);
  });
});

describe('isActiveCrewMember / resolveCrewAssignments', () => {
  const roster: CrewRosterMember[] = [
    emp({ id: 'active-1', name: 'Marcus', role: 'Marketing', tool_allowlist: ['meta-ads'], status: 'active' }),
    emp({ id: 'paused-1', name: 'Idle', role: 'Sales', tool_allowlist: ['gmail'], status: 'paused' }),
    emp({ id: 'legacy-1', name: 'Legacy', role: 'Ops', tool_allowlist: ['google-sheets'] }),
  ];

  it('treats missing status as active and rejects paused', () => {
    expect(isActiveCrewMember(roster[0])).toBe(true);
    expect(isActiveCrewMember(roster[1])).toBe(false);
    expect(isActiveCrewMember(roster[2])).toBe(true);
  });

  it('surfaces unmatched employeeIds instead of silent drop', () => {
    const assignments: CrewSpecialistAssignment[] = [
      { employeeId: 'active-1', employeeName: 'Marcus', employeeRole: 'Marketing', task: 'ads' },
      { employeeId: 'missing-x', employeeName: 'Ghost', employeeRole: 'None', task: 'noop' },
    ];
    const result = resolveCrewAssignments(assignments, roster);
    expect(result.resolved.map((r) => r.employee.id)).toEqual(['active-1']);
    expect(result.unmatchedEmployeeIds).toEqual(['missing-x']);
    expect(result.inactiveEmployeeIds).toEqual([]);
  });

  it('excludes inactive employees before dispatch', () => {
    const assignments: CrewSpecialistAssignment[] = [
      { employeeId: 'paused-1', employeeName: 'Idle', employeeRole: 'Sales', task: 'email' },
      { employeeId: 'legacy-1', employeeName: 'Legacy', employeeRole: 'Ops', task: 'sheets' },
    ];
    const result = resolveCrewAssignments(assignments, roster);
    expect(result.resolved.map((r) => r.employee.id)).toEqual(['legacy-1']);
    expect(result.inactiveEmployeeIds).toEqual(['paused-1']);
    expect(result.unmatchedEmployeeIds).toEqual([]);
  });
});

describe('heuristicCrewPlan inactive exclusion', () => {
  it('does not assign tasks when only inactive employees exist', () => {
    const roster = [emp({ id: 'p1', name: 'Paused', role: 'Sales', status: 'paused', tool_allowlist: ['gmail'] })];
    const plan = heuristicCrewPlan('reconcile the google sheets and stripe invoices please', roster);
    expect(plan.specialists).toEqual([]);
    expect(plan.reason).toMatch(/no active employees/i);
  });

  it('fans out to active specialists only on multi-domain prompts', () => {
    const roster = [
      emp({ id: 'm1', name: 'Marcus', role: 'Marketing', tool_allowlist: ['meta-ads', 'google-ads'], status: 'active' }),
      emp({ id: 'f1', name: 'Finance', role: 'Finance', tool_allowlist: ['stripe'], status: 'active' }),
      emp({ id: 'p1', name: 'Paused Ops', role: 'Operations', tool_allowlist: ['google-sheets'], status: 'paused' }),
    ];
    const plan = heuristicCrewPlan(
      'Check google ads campaign ROAS and also list stripe invoices for reconciliation',
      roster,
    );
    expect(plan.mode).toBe('crew');
    expect(plan.specialists.map((s) => s.employeeId).sort()).toEqual(['f1', 'm1']);
    expect(plan.specialists.every((s) => s.employeeId !== 'p1')).toBe(true);
  });

  it('keeps refund crews on Customer and never assigns Finance', () => {
    const roster = [
      emp({
        id: 'c1',
        name: 'Customer',
        role: 'Customer Resolution',
        tool_allowlist: ['gmail', 'stripe', 'hubspot'],
        status: 'active',
      }),
      emp({ id: 'f1', name: 'Finance', role: 'Finance', tool_allowlist: ['stripe', 'razorpay'], status: 'active' }),
      emp({
        id: 'e1',
        name: 'Emma',
        role: 'Customer Support',
        tool_allowlist: ['gmail', 'whatsapp'],
        status: 'active',
      }),
    ];
    const plan = heuristicCrewPlan('refund this Stripe payment', roster);
    expect(plan.specialists.some((s) => s.employeeId === 'c1')).toBe(true);
    expect(plan.specialists.some((s) => s.employeeId === 'f1')).toBe(false);
    expect(plan.specialists.every((s) => !/finance/i.test(s.employeeRole || ''))).toBe(true);
    // Solo Customer is fine; if crew, still no Finance refund step.
    expect(plan.specialists.some((s) => /refund/i.test(s.task) && /finance/i.test(s.employeeRole || ''))).toBe(
      false,
    );
  });

  it('still routes payment links to Finance when there is no refund', () => {
    const roster = [
      emp({
        id: 'c1',
        name: 'Customer',
        role: 'Customer Resolution',
        tool_allowlist: ['gmail', 'stripe'],
        status: 'active',
      }),
      emp({ id: 'f1', name: 'Finance', role: 'Finance', tool_allowlist: ['stripe'], status: 'active' }),
    ];
    const plan = heuristicCrewPlan('Create a Stripe payment link for invoice 1042', roster);
    expect(plan.specialists.map((s) => s.employeeId)).toEqual(['f1']);
  });
});

describe('enforceRefundCrewOwnership', () => {
  const roster = [
    emp({
      id: 'c1',
      name: 'Customer',
      role: 'Customer Resolution',
      tool_allowlist: ['gmail', 'stripe', 'hubspot'],
      status: 'active',
    }),
    emp({ id: 'f1', name: 'Finance', role: 'Finance', tool_allowlist: ['stripe', 'razorpay'], status: 'active' }),
    emp({
      id: 'm1',
      name: 'Marcus',
      role: 'Marketing',
      tool_allowlist: ['meta-ads'],
      status: 'active',
    }),
  ];

  it('rewrites a fake model plan that assigned Finance for a refund to Customer', () => {
    const fakeModelPlan: CrewPlan = {
      mode: 'solo',
      reason: 'LiteLLM assigned Finance for Stripe',
      specialists: [
        {
          employeeId: 'f1',
          employeeName: 'Finance',
          employeeRole: 'Finance',
          task: 'refund this Stripe payment',
        },
      ],
    };
    const fixed = enforceRefundCrewOwnership(fakeModelPlan, 'refund this Stripe payment', roster);
    expect(fixed.specialists.map((s) => s.employeeId)).toEqual(['c1']);
    expect(fixed.specialists.some((s) => s.employeeId === 'f1')).toBe(false);
    expect(fixed.specialists[0].employeeRole).toMatch(/Customer Resolution/i);
  });

  it('drops Finance from a multi-member refund crew and keeps Customer', () => {
    const fakeModelPlan: CrewPlan = {
      mode: 'crew',
      reason: 'LiteLLM crew',
      specialists: [
        {
          employeeId: 'f1',
          employeeName: 'Finance',
          employeeRole: 'Finance',
          task: 'refund the charge',
        },
        {
          employeeId: 'm1',
          employeeName: 'Marcus',
          employeeRole: 'Marketing',
          task: 'note the ads impact',
        },
      ],
    };
    const fixed = enforceRefundCrewOwnership(fakeModelPlan, 'refund this Stripe payment and check ads', roster);
    expect(fixed.specialists.some((s) => s.employeeId === 'c1')).toBe(true);
    expect(fixed.specialists.some((s) => s.employeeId === 'f1')).toBe(false);
    expect(fixed.specialists.some((s) => s.employeeId === 'm1')).toBe(true);
  });

  it('leaves Finance on payment-link plans with no refund words', () => {
    const plan: CrewPlan = {
      mode: 'solo',
      reason: 'pay link',
      specialists: [
        {
          employeeId: 'f1',
          employeeName: 'Finance',
          employeeRole: 'Finance',
          task: 'Create a Stripe payment link for invoice 1042',
        },
      ],
    };
    const fixed = enforceRefundCrewOwnership(
      plan,
      'Create a Stripe payment link for invoice 1042',
      roster,
    );
    expect(fixed.specialists.map((s) => s.employeeId)).toEqual(['f1']);
  });
});
