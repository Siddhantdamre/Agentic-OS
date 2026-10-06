import { ACTION_GROUPS, levelRows, sameAsPreviousLevel, type ActionGroupId, type Outcome } from '../trust-levels';
import table from '../trust-levels.json';

describe('trust levels', () => {
  it('groups every action class exactly once, so nothing is left out of what the page tells a customer', () => {
    const grouped = ACTION_GROUPS.flatMap((g) => g.risks).sort();
    expect(grouped).toEqual([...table.risks].sort());
  });

  it('only groups actions that behave the same at every level, so one word is true for the whole group', () => {
    for (const stage of ['0', '1', '2', '3'] as const) {
      for (const g of ACTION_GROUPS) {
        const outcomes = new Set(g.risks.map((r) => (table.stages[stage] as Record<string, string>)[r]));
        expect({ stage, group: g.id, outcomes: [...outcomes] }).toEqual({ stage, group: g.id, outcomes: [expect.any(String)] });
      }
    }
  });

  it('shows five rows per level, in a fixed order', () => {
    for (const stage of [0, 1, 2, 3] as const) {
      expect(levelRows(stage).map((r) => r.group)).toEqual(['look_up', 'draft', 'send_publish', 'pay_delete', 'sign_execute']);
    }
  });

  it('level 0 only looks things up; everything else is recorded or waits for a person', () => {
    const byGroup = Object.fromEntries(levelRows(0).map((r) => [r.group, r.outcome])) as Record<ActionGroupId, Outcome>;
    expect(byGroup).toEqual({ look_up: 'runs', draft: 'recorded', send_publish: 'recorded', pay_delete: 'asks', sign_execute: 'recorded' });
  });

  it('never lets anything that reaches a customer or moves money run on its own, at any level', () => {
    for (const stage of [0, 1, 2, 3] as const) {
      const rows = Object.fromEntries(levelRows(stage).map((r) => [r.group, r.outcome]));
      expect(rows.send_publish).not.toBe('runs');
      expect(rows.pay_delete).not.toBe('runs');
      expect(rows.sign_execute).not.toBe('runs');
    }
  });

  it('says plainly when a level changes nothing compared with the one below it', () => {
    expect(sameAsPreviousLevel(0)).toBe(false);
    expect(sameAsPreviousLevel(1)).toBe(false);
    // Today levels 2 and 3 allow exactly what level 1 allows. The page has to say so, not imply more.
    expect(sameAsPreviousLevel(2)).toBe(true);
    expect(sameAsPreviousLevel(3)).toBe(true);
  });
});
