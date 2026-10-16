/**
 * Read-only Darex SaaS billing usage for the session org.
 * Reads billing_meters / billing_subscriptions under RLS — never invents totals.
 */
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['usage', 'billing_usage'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, orgId, timestamp } = ctx;
  try {
    return await withOrgScopedClient(orgId, async (client) => {
      let meters: unknown[] = [];
      let subscriptions: unknown[] = [];
      let planKey: string | null = null;

      try {
        const meterRes = await client.query(
          `SELECT meter_kind, quantity::text AS quantity, hard_limit::text AS hard_limit,
                  soft_limit::text AS soft_limit, period_start, period_end, source
             FROM billing_meters
            WHERE org_id = $1
            ORDER BY period_end DESC NULLS LAST, meter_kind ASC
            LIMIT 50`,
          [orgId]
        );
        meters = meterRes.rows;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === '42P01') {
          return apiError(
            'billing',
            actionName,
            timestamp,
            'billing_meters table is missing — run migrations. No usage numbers invented.',
            { connected: false, tableMissing: 'billing_meters' }
          );
        }
        throw err;
      }

      try {
        const subRes = await client.query(
          `SELECT id, provider, plan_key, status, seats, current_period_end, cancel_at_period_end
             FROM billing_subscriptions
            WHERE org_id = $1
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 10`,
          [orgId]
        );
        subscriptions = subRes.rows;
        planKey = typeof subRes.rows[0]?.plan_key === 'string' ? subRes.rows[0].plan_key : null;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === '42P01') {
          // Meters may exist without subscriptions — still return meters honestly.
          subscriptions = [];
        } else {
          throw err;
        }
      }

      try {
        const orgRes = await client.query<{ plan_key?: string | null }>(
          `SELECT plan_key FROM orgs WHERE id = $1 LIMIT 1`,
          [orgId]
        );
        if (!planKey && typeof orgRes.rows[0]?.plan_key === 'string') {
          planKey = orgRes.rows[0].plan_key;
        }
      } catch {
        // plan_key column may not exist — omit, do not invent.
      }

      return {
        tool: 'billing',
        action: 'billing_usage',
        status: 'executed' as const,
        message:
          meters.length === 0 && subscriptions.length === 0
            ? 'No billing meter or subscription rows for this org yet.'
            : `Loaded ${meters.length} meter row(s) and ${subscriptions.length} subscription(s).`,
        data: {
          orgId,
          planKey,
          meters,
          subscriptions,
        },
        timestamp,
      };
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return apiError('billing', actionName, timestamp, `Billing usage read failed: ${message}`);
  }
}

export const billing: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
