/**
 * @jest-environment node
 *
 * Who may read operational queues (work items, pending approvals, autonomy rules).
 */

import { canReadOperations, HUMAN_ROLES } from '../rbac';

describe('canReadOperations', () => {
  it.each(['owner', 'admin', 'member', 'auditor'] as const)('%s can read', (role) => {
    expect(canReadOperations(role)).toBe(true);
  });

  it('billing cannot read', () => {
    expect(canReadOperations('billing')).toBe(false);
  });

  it('covers every role', () => {
    expect(HUMAN_ROLES.length).toBe(5);
  });
});
