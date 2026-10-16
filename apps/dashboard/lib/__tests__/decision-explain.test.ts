import { rankExplainMatches, tokenizeExplainQuery } from '../decision-explain';
describe('decision-explain', () => {
  it('keeps merge as a query token', () => {
    expect(tokenizeExplainQuery("Why didn't you merge Acme")).toContain('merge');
  });
  it('does not recency-boost unmatched rows', () => {
    const matches = rankExplainMatches('merge acme', [
      { id: '1', action_considered: 'reschedule meeting', decision: 'executed', reason_code: 'ok', reason_summary: 'calendar free', confidence_score: 0.9, created_at: new Date().toISOString() },
      { id: '2', action_considered: 'merge acme technologies', decision: 'declined', reason_code: 'below_threshold', reason_summary: 'Domain match was uncertain; confidence 0.58 below 0.85 threshold.', confidence_score: 0.58, created_at: new Date(Date.now() - 86400000 * 20).toISOString() },
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('2');
  });
});
