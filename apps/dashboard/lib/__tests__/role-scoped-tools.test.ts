import { filterAllowlistForPersona, normalizePersona } from '../role-scoped-tools';
describe('role-scoped-tools', () => {
  it('maps marcus to marketing and growth/sdr to growth', () => {
    expect(normalizePersona('Marcus')).toBe('marketing');
    expect(normalizePersona('Marketing & Analytics')).toBe('marketing');
    expect(normalizePersona('Growth')).toBe('growth');
    expect(normalizePersona('Sarah')).toBe('sales');
    expect(normalizePersona('Sales & Lead Gen')).toBe('sales');
    expect(normalizePersona('Customer Support')).toBe('customer');
    expect(normalizePersona('Finance')).toBe('finance');
  });
  it('drops growth tools from a customer allowlist', () => {
    const filtered = filterAllowlistForPersona(['apollo_search', 'ticket_update', 'web_search'], 'customer');
    expect(filtered).not.toContain('apollo_search');
    expect(filtered).toContain('ticket_update');
  });
});
