/**
 * @jest-environment node
 *
 * "Import my history" can be pressed twice, or fired by two tabs at once; a new tenant's first load also
 * fans out many calls together. The backfill ends by seeding the default autonomy rules, and it used
 * `WHERE NOT EXISTS (...)` to avoid duplicates. That is check-then-insert: two parallel runs both see "none
 * yet" and the loser violates uq_employee_autonomy_rules_action, so the caller got HTTP 500
 * (12 parallel POSTs: 11 x 200, 1 x 500). A unique-index violation must be a no-op, not a failure.
 */
import type { PoolClient } from 'pg';
import { runConversationBackfill } from '@/lib/onboarding-observation-query';

describe('runConversationBackfill — default autonomy rules', () => {
  it('seeds the rules with an insert that tolerates a concurrent insert of the same rows', async () => {
    const seen: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        seen.push(String(sql));
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as PoolClient;

    await runConversationBackfill(client, '11111111-1111-4111-8111-111111111111', 30);

    const seed = seen.find((s) => /INSERT INTO employee_autonomy_rules/i.test(s));
    expect(seed).toBeDefined();
    expect(seed).toMatch(/ON CONFLICT\s+DO NOTHING/i);
  });

  it('does not fail when the database reports the rows already exist', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (/INSERT INTO employee_autonomy_rules/i.test(String(sql)) && !/ON CONFLICT/i.test(String(sql))) {
          const err = new Error('duplicate key value violates unique constraint "uq_employee_autonomy_rules_action"') as Error & { code: string };
          err.code = '23505';
          throw err;
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as PoolClient;

    await expect(runConversationBackfill(client, '11111111-1111-4111-8111-111111111111', 30)).resolves.toEqual({
      loopsImported: 0,
      wonImported: 0,
    });
  });
});
