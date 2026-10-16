import { isUndefinedTable, withOrgClient } from '../db.js';
import {
  dailySpendBreached,
  defaultCostCeiling,
  turnSpendCents,
  type OrgCostCeiling,
  type TurnSpendUsage,
} from './budget.js';

export async function loadCostCeiling(orgId: string): Promise<OrgCostCeiling> {
  try {
    return await withOrgClient(orgId, async (client) => {
      const res = await client.query<{
        max_model_calls_per_trigger: number;
        max_actions_per_sweep: number;
        max_spend_cents_per_day: number;
        escalate_only: boolean;
      }>(
        `SELECT max_model_calls_per_trigger, max_actions_per_sweep,
                max_spend_cents_per_day, escalate_only
           FROM org_cost_ceilings WHERE org_id = $1`,
        [orgId]
      );
      const row = res.rows[0];
      if (!row) return defaultCostCeiling();
      return {
        maxModelCallsPerTrigger: Number(row.max_model_calls_per_trigger),
        maxActionsPerSweep: Number(row.max_actions_per_sweep),
        maxSpendCentsPerDay: Number(row.max_spend_cents_per_day),
        escalateOnly: Boolean(row.escalate_only),
      };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return defaultCostCeiling();
    throw err;
  }
}

export async function recordModelSpend(input: {
  orgId: string;
  modelCalls: number;
  spendCents: number;
  sweepCalls?: number;
  extractionCalls?: number;
  obligations?: number;
  idleSweep?: boolean;
  busySweep?: boolean;
}): Promise<void> {
  try {
    await withOrgClient(input.orgId, async (client) => {
      await client.query(
        `INSERT INTO org_model_spend
           (org_id, spend_date, model_calls, spend_cents, sweep_model_calls,
            extraction_model_calls, obligations_extracted, idle_sweep_passes, busy_sweep_passes)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (org_id, spend_date) DO UPDATE SET
           model_calls = org_model_spend.model_calls + EXCLUDED.model_calls,
           spend_cents = org_model_spend.spend_cents + EXCLUDED.spend_cents,
           sweep_model_calls = org_model_spend.sweep_model_calls + EXCLUDED.sweep_model_calls,
           extraction_model_calls = org_model_spend.extraction_model_calls + EXCLUDED.extraction_model_calls,
           obligations_extracted = org_model_spend.obligations_extracted + EXCLUDED.obligations_extracted,
           idle_sweep_passes = org_model_spend.idle_sweep_passes + EXCLUDED.idle_sweep_passes,
           busy_sweep_passes = org_model_spend.busy_sweep_passes + EXCLUDED.busy_sweep_passes`,
        [
          input.orgId,
          input.modelCalls,
          input.spendCents,
          input.sweepCalls ?? 0,
          input.extractionCalls ?? 0,
          input.obligations ?? 0,
          input.idleSweep ? 1 : 0,
          input.busySweep ? 1 : 0,
        ]
      );
      const today = await client.query<{ spend_cents: number }>(
        `SELECT spend_cents FROM org_model_spend WHERE org_id = $1 AND spend_date = CURRENT_DATE`,
        [input.orgId]
      );
      const ceiling = await client.query<{ max_spend_cents_per_day: number }>(
        `SELECT max_spend_cents_per_day FROM org_cost_ceilings WHERE org_id = $1`,
        [input.orgId]
      );
      const spend = Number(today.rows[0]?.spend_cents ?? 0);
      const max = Number(ceiling.rows[0]?.max_spend_cents_per_day ?? defaultCostCeiling().maxSpendCentsPerDay);
      if (dailySpendBreached(spend, { ...defaultCostCeiling(), maxSpendCentsPerDay: max })) {
        await client.query(
          `UPDATE org_cost_ceilings SET escalate_only = TRUE, updated_at = NOW() WHERE org_id = $1`,
          [input.orgId]
        );
      }
    });
  } catch (err) {
    if (isUndefinedTable(err)) return;
    throw err;
  }
}

/**
 * Meter one completed agent turn (in-process or sidecar) into org_model_spend.
 * Best-effort: a meter write failure is logged and never fails the turn.
 */
export async function recordTurnSpend(input: {
  orgId: string;
  employeeId?: string;
  usage?: TurnSpendUsage;
}): Promise<void> {
  if (!input.orgId) return;
  const rate = Number(process.env.DAREX_LLM_FALLBACK_USD_PER_MTOK);
  const spendCents = turnSpendCents(input.usage, Number.isFinite(rate) && rate > 0 ? rate : undefined);
  try {
    await recordModelSpend({ orgId: input.orgId, modelCalls: 1, spendCents });
  } catch (err) {
    console.warn(
      `[cost] turn spend not recorded org=${input.orgId} employee=${input.employeeId || '-'} cents=${spendCents}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export async function recordIdleSweepPass(orgId: string): Promise<void> {
  await recordModelSpend({ orgId, modelCalls: 0, spendCents: 0, idleSweep: true });
}

export async function seedOrgCostCeiling(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  orgId: string
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO org_cost_ceilings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
      [orgId]
    );
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return;
    throw err;
  }
}
