import { computeAutomationRate, queryAutomationRate } from '../automation-rate';

describe('automation rate', () => {
  it('returns null with no conversations', () => {
    expect(computeAutomationRate(0, 0)).toBeNull();
  });
  it('rounds to a whole percent and clamps', () => {
    expect(computeAutomationRate(3, 2)).toBe(67);
    expect(computeAutomationRate(2, 5)).toBe(100);
    expect(computeAutomationRate(4, -1)).toBe(0);
  });
  it('queries with org and interval and parses counts', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ with_messages: '10', ai_handled: '7' }] });
    const out = await queryAutomationRate({ query }, 'org-1', '7 days');
    expect(query.mock.calls[0][1]).toEqual(['org-1', '7 days']);
    expect(out).toEqual({ withMessages: 10, aiHandled: 7, rate: 70 });
  });
});
