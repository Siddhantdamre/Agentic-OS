import {
  allowlistForEmployeeTurn,
  allowlistForLockedEmployeeTurn,
} from '../ask-employee';

describe('allowlistForLockedEmployeeTurn', () => {
  it('empty custom allowlist does not include stripe/gmail just because the org connected them', () => {
    const tools = allowlistForLockedEmployeeTurn(
      [],
      ['stripe', 'gmail', 'hubspot'],
      'Custom Analyst',
    );
    const lower = tools.map((t) => t.toLowerCase().replace(/_/g, '-'));
    expect(lower).not.toContain('stripe');
    expect(lower).not.toContain('gmail');
    expect(lower).not.toContain('hubspot');
    // Core tools remain available
    expect(lower.some((t) => t === 'web-search' || t === 'web_search')).toBe(true);
  });

  it('card allowlist keeps matching connected channels only', () => {
    const tools = allowlistForLockedEmployeeTurn(
      ['gmail', 'web_search'],
      ['gmail', 'stripe', 'notion'],
      'Maya',
    );
    const lower = tools.map((t) => t.toLowerCase().replace(/_/g, '-'));
    expect(lower).toContain('gmail');
    expect(lower).not.toContain('stripe');
    expect(lower).not.toContain('notion');
  });

  it('selected employee does not receive tools that exist only on another employee card (no org-union)', () => {
    const financeCard = ['stripe'];
    const salesOnlyTools = ['gmail', 'hubspot'];
    const orgConnected = [...financeCard, ...salesOnlyTools, 'notion'];

    const lockedFinance = allowlistForLockedEmployeeTurn(financeCard, orgConnected, 'Finance');
    const lockedKeys = lockedFinance.map((t) => t.toLowerCase().replace(/_/g, '-'));
    expect(lockedKeys).toContain('stripe');
    expect(lockedKeys).not.toContain('gmail');
    expect(lockedKeys).not.toContain('hubspot');
    expect(lockedKeys).not.toContain('notion');

    // Org-union path (legacy auto peer merge) would surface peer card tools for an unscoped role.
    const orgUnion = allowlistForEmployeeTurn(
      financeCard,
      [...financeCard, ...salesOnlyTools],
      orgConnected,
      'Custom Analyst',
    );
    const unionKeys = orgUnion.map((t) => t.toLowerCase().replace(/_/g, '-'));
    expect(unionKeys).toContain('gmail');
    expect(unionKeys).toContain('hubspot');
  });
});
