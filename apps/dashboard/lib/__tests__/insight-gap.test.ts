/**
 * @jest-environment node
 */
import { plainGapNarrative } from '../insight-engine';

describe('insight gap card', () => {
  it('explains a missing connection without naming the metric id', () => {
    const t = plainGapNarrative('core.revenue_collected_7d: stripe not connected');
    expect(t).toMatch(/connect/i);
    expect(t).not.toMatch(/core\.|_|stripe not connected/i);
  });

  it('says plainly that no number is made up', () => {
    expect(plainGapNarrative('core.something: no data')).toMatch(/only when it is real/i);
  });
});
