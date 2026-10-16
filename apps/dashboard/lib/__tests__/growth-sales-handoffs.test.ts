/**
 * @jest-environment node
 */
import { matchHandoff, rules } from '../handoffs/growth-sales';

describe('growth-sales hand-off rules', () => {
  it('exports rules for growth and sales', () => {
    expect(rules.some((r) => r.fromRoleIncludes.includes('growth'))).toBe(true);
    expect(rules.some((r) => r.fromRoleIncludes.includes('sales'))).toBe(true);
  });

  it('growth hands company/founder research to Research', () => {
    const hit = matchHandoff('growth', 'Who founded Acme? Please research the company.');
    expect(hit?.to).toBe('Research');
  });

  it('growth hands invoices to Finance', () => {
    expect(matchHandoff('growth', 'Send a payment link for this deal')?.to).toBe('Finance');
  });

  it('sales hands payment links and invoices to Finance, not refunds', () => {
    expect(matchHandoff('sales', 'Create a payment link for Acme')?.to).toBe('Finance');
    expect(matchHandoff('sales', 'Send an invoice for the closed deal')?.to).toBe('Finance');
    expect(matchHandoff('sales', 'Charge the customer for onboarding')?.to).toBe('Finance');
    expect(matchHandoff('sales', 'Refund order 88')?.to).toBe('Customer');
  });

  it('sales still hands lookalikes to Growth and ads to Marketing', () => {
    expect(matchHandoff('sales', 'Find lookalike accounts for our ICP')?.to).toBe('Growth');
    expect(matchHandoff('sales', 'Boost the Meta ads campaign')?.to).toBe('Marketing');
  });
});
