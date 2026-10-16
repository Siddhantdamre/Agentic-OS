/**
 * @jest-environment node
 */
import { resolveLockedHandoff } from '../handoffs/index';

describe('Operations hand-off rules', () => {
  it('routes refunds, payments, ads, prospecting, and research', () => {
    expect(resolveLockedHandoff(['Operations'], 'Please process this refund')?.toRole).toBe(
      'Customer',
    );
    expect(
      resolveLockedHandoff(['Operations'], 'Create a payment link for the invoice')?.toRole,
    ).toBe('Finance');
    expect(resolveLockedHandoff(['Operations'], 'What is our Meta ads ROAS?')?.toRole).toBe(
      'Marketing & Analytics',
    );
    expect(
      resolveLockedHandoff(['Operations'], 'Prospect lookalike companies via Apollo')?.toRole,
    ).toBe('Sales & Lead Gen');
    expect(resolveLockedHandoff(['Operations'], 'Research who founded Acme Corp')?.toRole).toBe(
      'Research',
    );
    expect(resolveLockedHandoff(['Operations'], 'Reconcile this sheet against HubSpot')).toBeNull();
  });
});
