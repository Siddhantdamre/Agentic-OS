import { isUndefinedTable, withOrgClient } from '../db.js';
import { dailySpendBreached } from '../cost/budget.js';
import { loadCostCeiling } from '../cost/track.js';

/**
 * Pre-flight spend check before spawning a multi-agent crew.
 * Blocks when escalate_only is set or today's spend already hits the ceiling.
 */
export async function assertCrewSpendAllowed(orgId: string): Promise<{
  allowed: boolean;
  reason?: string;
  spendCents?: number;
  maxSpendCents?: number;
}> {
  try {
    const ceiling = await loadCostCeiling(orgId);
    if (ceiling.escalateOnly) {
      return {
        allowed: false,
        reason: 'Daily AI spend ceiling breached (escalate_only). Crew spawn blocked.',
        maxSpendCents: ceiling.maxSpendCentsPerDay,
      };
    }

    let spendCents = 0;
    try {
      await withOrgClient(orgId, async (client) => {
        const res = await client.query<{ spend_cents: number }>(
          `SELECT spend_cents FROM org_model_spend WHERE org_id = $1 AND spend_date = CURRENT_DATE`,
          [orgId]
        );
        spendCents = Number(res.rows[0]?.spend_cents ?? 0);
      });
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
      spendCents = 0;
    }

    if (dailySpendBreached(spendCents, ceiling)) {
      return {
        allowed: false,
        reason: 'Daily AI spend quota exceeded. Multi-agent crew execution blocked.',
        spendCents,
        maxSpendCents: ceiling.maxSpendCentsPerDay,
      };
    }

    return { allowed: true, spendCents, maxSpendCents: ceiling.maxSpendCentsPerDay };
  } catch (err) {
    // Fail open on infra errors so a missing cost table does not brick crews.
    console.warn(
      `[crew-budget] spend check failed for ${orgId}; allowing crew:`,
      err instanceof Error ? err.message : err
    );
    return { allowed: true };
  }
}

/** Temporal activity wrapper. */
export async function assertCrewSpendAllowedActivity(params: {
  orgId: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  return assertCrewSpendAllowed(params.orgId);
}
