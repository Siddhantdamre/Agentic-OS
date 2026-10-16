import { isUndefinedTable, withOrgClient } from '../db.js';
import {
  assessSweepDueCount,
  DUE_SQL,
  type IdleSweepResult,
  type SweepKind,
} from '../sweeps/idle.js';

/** Wall clock for workflows — never call Date() inside a Temporal workflow. */
export async function nowIsoActivity(): Promise<string> {
  return new Date().toISOString();
}

export async function countDueSweepActivity(input: {
  orgId: string;
  kind: SweepKind;
  before: string;
}): Promise<IdleSweepResult> {
  const sql = DUE_SQL[input.kind];
  try {
    const n = await withOrgClient(input.orgId, async (client) => {
      const res = await client.query<{ n: number }>(sql, [input.orgId, input.before]);
      return Number(res.rows[0]?.n ?? 0);
    });
    return assessSweepDueCount(input.kind, n);
  } catch (err: unknown) {
    if (isUndefinedTable(err)) return assessSweepDueCount(input.kind, 0);
    throw err;
  }
}
