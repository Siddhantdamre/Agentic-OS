/**
 * @jest-environment node
 */
import { resolveLockedHandoff } from '../handoffs/index';

describe('marketing-finance locked hand-offs', () => {
  it('Finance refund is out of scope and hands off to Customer', () => {
    const hit = resolveLockedHandoff(['Finance'], 'Please refund charge ch_123');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Customer');
    expect(hit!.reason).toMatch(/refund/i);
  });

  it('Customer payment link is out of scope and hands off to Finance', () => {
    const hit = resolveLockedHandoff(
      ['Customer Resolution'],
      'Create a payment link for invoice 1042',
    );
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Finance');
    expect(hit!.reason).toMatch(/payment|finance/i);
  });

  it('Finance stays on payment links (no hand-off)', () => {
    expect(
      resolveLockedHandoff(['Finance'], 'Create a payment link for invoice 1042'),
    ).toBeNull();
  });
});
