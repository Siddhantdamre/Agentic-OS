/**
 * @jest-environment node
 *
 * Pausing a team drops it back to level 0. That is a change of level, so "why is my team back at
 * level 0?" must have an answer in the same history as every other change.
 */
import { writeKillSwitch } from '../employee-metrics-query';

const ORG = '11111111-1111-4111-8111-111111111111';

function clientWith(previousStage: number | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params });
      if (/SELECT autonomy_stage FROM org_runtime_controls/i.test(String(sql))) {
        return { rows: previousStage === null ? [] : [{ autonomy_stage: previousStage }] };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { client, calls };
}

const events = (calls: Array<{ sql: string; params: unknown[] }>) => calls.filter((c) => /INSERT INTO org_autonomy_stage_events/i.test(c.sql));

describe('writeKillSwitch history', () => {
  it('records the drop to level 0 when a team that had earned level 2 is paused', async () => {
    const { client, calls } = clientWith(2);
    await writeKillSwitch(client as never, ORG, true, 'u-1');
    const [e] = events(calls);
    expect(e.sql).toMatch(/VALUES \(\$1, \$2, 0, 'pause'/);
    expect(e.params).toEqual([ORG, 2, 'The team was paused, which returns it to level 0.', 'u-1']);
  });

  it('records nothing when the team was already at level 0', async () => {
    const { client, calls } = clientWith(0);
    await writeKillSwitch(client as never, ORG, true, 'u-1');
    expect(events(calls)).toHaveLength(0);
  });

  it('records nothing when there was no row yet', async () => {
    const { client, calls } = clientWith(null);
    await writeKillSwitch(client as never, ORG, true, 'u-1');
    expect(events(calls)).toHaveLength(0);
  });

  it('records nothing when resuming: the level stays where it was', async () => {
    const { client, calls } = clientWith(2);
    await writeKillSwitch(client as never, ORG, false, 'u-1');
    expect(events(calls)).toHaveLength(0);
  });

  it('still works for callers that do not say who paused it', async () => {
    const { client, calls } = clientWith(3);
    await writeKillSwitch(client as never, ORG, true);
    expect(events(calls)[0].params[3]).toBeNull();
  });
});
