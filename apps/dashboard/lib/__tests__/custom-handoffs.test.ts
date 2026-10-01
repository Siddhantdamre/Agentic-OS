/**
 * @jest-environment node
 */
import { resolveCustomHandoff } from '../handoffs/index';

const analyst = { role: 'Data Analyst', name: 'Dana', allowlist: ['database_query'] };

describe('custom employee hand-off', () => {
  it('offers Finance when a custom employee without billing tools is asked for a payment link', () => {
    expect(resolveCustomHandoff([analyst], 'Create a Stripe payment link')?.toRole).toBe('Finance');
  });
  it('keeps the turn when the card already has the tool', () => {
    expect(
      resolveCustomHandoff([{ ...analyst, allowlist: ['stripe'] }], 'Create a Stripe payment link'),
    ).toBeNull();
  });
  it('does not fire when a built-in role is in the selection', () => {
    expect(
      resolveCustomHandoff([analyst, { role: 'Finance', allowlist: [] }], 'Create a Stripe payment link'),
    ).toBeNull();
  });
  it('does not fire on unrelated asks', () => {
    expect(resolveCustomHandoff([analyst], 'Summarise last week orders')).toBeNull();
  });
});
