/**
 * @jest-environment node
 */
import { rules as customerRules } from '../handoffs/customer';
import { matchLockedHandoff, resolveLockedHandoff } from '../handoffs/index';

describe('customer hand-offs', () => {
  it('Emma hands refunds to Customer Resolution', () => {
    const hit = resolveLockedHandoff(['Customer Support'], 'Please refund charge ch_123');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Customer Resolution');
    expect(hit!.reason).toMatch(/refund/i);
  });

  it('Emma hands Zendesk tickets to Customer Resolution', () => {
    const hit = resolveLockedHandoff(['Customer Support'], 'Open a Zendesk ticket for Jane');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Customer Resolution');
  });

  it('Customer hands payment links to Finance', () => {
    const hit = resolveLockedHandoff(['Customer Resolution'], 'Create a payment link for $50');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Finance');
  });

  it('Customer hands sheets reconcile to Operations', () => {
    const hit = resolveLockedHandoff(
      ['Customer Resolution'],
      'Reconcile the Google Sheet against HubSpot',
    );
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Operations');
  });

  it('no hand-off when team already includes the target role', () => {
    const hit = matchLockedHandoff(
      ['Customer Support', 'Customer Resolution'],
      'Please process a refund',
      customerRules,
    );
    expect(hit).toBeNull();
  });

  it('auto/unlocked empty roles never hand off', () => {
    expect(resolveLockedHandoff([], 'refund please')).toBeNull();
  });
});
