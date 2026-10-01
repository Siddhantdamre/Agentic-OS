/**
 * Pure hard-cap usage gate for agent/tool execution.
 * Reads `billing_meters` under org RLS. Never trusts a body `org_id`.
 * Applies `org_plan_overrides.meter_caps` hard ceilings when the table exists.
 *
 * Dashboard may wrap this with Langfuse meter refresh; hot tool paths
 * should call without refresh (opts.refresh omitted / false).
 */

import { withOrgScopedClient } from './tools/shared.js';

export const USAGE_BLOCKED_CODE = 'USAGE_CAP_REACHED' as const;

export const USAGE_BLOCKED_MESSAGE =
  'Hard usage cap reached for this organization (LLM cost or WhatsApp conversations). Upgrade the plan or contact billing before continuing.';

export const USAGE_GATE_UNAVAILABLE_MESSAGE =
  'Usage limits could not be checked right now, so this action was held. Try again in a minute.';

export type UsageBlockReason = {
  /** `gate_unavailable`: the meter read failed and the gate failed closed. */
  kind: 'llm_tokens' | 'whatsapp_conversations' | 'gate_unavailable';
  quantity: number;
  hardLimit: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export type UsageGateResult = {
  blocked: boolean;
  orgId: string;
  reasons: UsageBlockReason[];
  /** True when a refresh pass ran before deciding (dashboard wrapper only). */
  refreshed: boolean;
};

export type MeterCapOverride = { soft: number | null; hard: number | null };

/** Platform plan override row (migration 120). Null when no row or table missing. */
export type OrgPlanOverride = {
  seatCap: number | null;
  meterCaps: Record<string, MeterCapOverride>;
};

type MeterRow = {
  meter_kind: string;
  quantity: string;
  hard_limit: string | null;
  period_start: Date | string | null;
  period_end: Date | string | null;
};

function toIsoDate(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function parseQuantity(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

function parseMeterCapEntry(raw: unknown): MeterCapOverride | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const softRaw = (raw as { soft?: unknown }).soft;
  const hardRaw = (raw as { hard?: unknown }).hard;
  const soft =
    softRaw == null || softRaw === ''
      ? null
      : Number.isFinite(Number(softRaw))
        ? Number(softRaw)
        : null;
  const hard =
    hardRaw == null || hardRaw === ''
      ? null
      : Number.isFinite(Number(hardRaw))
        ? Number(hardRaw)
        : null;
  return { soft, hard };
}

/**
 * Read org_plan_overrides for the scoped org. Missing table (42P01) → null
 * (current env / meter behavior). Never invents usage quantities.
 */
export async function readOrgPlanOverride(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  orgId: string
): Promise<OrgPlanOverride | null> {
  try {
    const res = await client.query(
      `SELECT seat_cap, meter_caps
         FROM org_plan_overrides
        WHERE org_id = $1`,
      [orgId]
    );
    const row = res.rows[0] as
      | { seat_cap: number | null; meter_caps: unknown }
      | undefined;
    if (!row) return null;

    const meterCaps: Record<string, MeterCapOverride> = {};
    const rawCaps = row.meter_caps;
    if (rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps)) {
      for (const [kind, value] of Object.entries(rawCaps as Record<string, unknown>)) {
        const parsed = parseMeterCapEntry(value);
        if (parsed) meterCaps[kind] = parsed;
      }
    }

    const seatCap =
      row.seat_cap == null
        ? null
        : Number.isFinite(Number(row.seat_cap)) && Number(row.seat_cap) >= 1
          ? Math.floor(Number(row.seat_cap))
          : null;

    return { seatCap, meterCaps };
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

/** Effective hard limit: override hard when set, else meter row hard_limit. */
export function effectiveMeterHardLimit(
  kind: string,
  meterHardLimit: number | null,
  override: OrgPlanOverride | null
): number | null {
  const fromOverride = override?.meterCaps?.[kind]?.hard;
  if (fromOverride != null && Number.isFinite(fromOverride) && fromOverride > 0) {
    return fromOverride;
  }
  if (meterHardLimit != null && Number.isFinite(meterHardLimit) && meterHardLimit > 0) {
    return meterHardLimit;
  }
  return null;
}

/**
 * Read latest hard-capped meters for the org (RLS-scoped). No fabricated totals.
 * Missing meter rows do not block. Override hard caps replace meter hard_limit.
 */
export async function readHardCapBlockReasons(orgId: string): Promise<UsageBlockReason[]> {
  return withOrgScopedClient(orgId, async (client) => {
    const override = await readOrgPlanOverride(client, orgId);
    const res = await client.query<MeterRow>(
      `SELECT DISTINCT ON (meter_kind)
         meter_kind, quantity::text AS quantity, hard_limit::text AS hard_limit,
         period_start, period_end
       FROM billing_meters
       WHERE org_id = $1
         AND meter_kind IN ('llm_tokens', 'whatsapp_conversations')
       ORDER BY meter_kind, period_end DESC NULLS LAST, period_start DESC NULLS LAST`,
      [orgId]
    );
    const reasons: UsageBlockReason[] = [];
    for (const row of res.rows) {
      const kind = row.meter_kind;
      if (kind !== 'llm_tokens' && kind !== 'whatsapp_conversations') continue;
      const meterHard =
        row.hard_limit == null || row.hard_limit === ''
          ? null
          : parseQuantity(row.hard_limit);
      const hard = effectiveMeterHardLimit(kind, meterHard, override);
      if (hard == null || !(hard > 0)) continue;
      const quantity = parseQuantity(row.quantity);
      if (quantity < hard) continue;
      reasons.push({
        kind,
        quantity,
        hardLimit: hard,
        periodStart: toIsoDate(row.period_start),
        periodEnd: toIsoDate(row.period_end),
      });
    }
    return reasons;
  });
}

/**
 * Whether the org is over a hard usage cap (session/workflow orgId only).
 */
export async function isUsageBlocked(
  orgId: string,
  deps: { readReasons?: (orgId: string) => Promise<UsageBlockReason[]> } = {}
): Promise<UsageGateResult> {
  if (!orgId || typeof orgId !== 'string') {
    return { blocked: false, orgId: String(orgId || ''), reasons: [], refreshed: false };
  }
  try {
    const reasons = await (deps.readReasons ?? readHardCapBlockReasons)(orgId);
    return {
      blocked: reasons.length > 0,
      orgId,
      reasons,
      refreshed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Partial migrations: no billing_meters table means nothing is metered yet.
    if (isUndefinedTable(err)) {
      return { blocked: false, orgId, reasons: [], refreshed: false };
    }
    if (usageGateFailOpen()) {
      console.warn(`[usage-gate] meter read failed for org ${orgId} (fail-open by env): ${message}`);
      return { blocked: false, orgId, reasons: [], refreshed: false };
    }
    // BIZ-B01: fail closed. A DB blip holds billable work instead of letting
    // an org past its hard cap for as long as the outage lasts.
    console.error(`[usage-gate] meter read failed for org ${orgId}; failing closed: ${message}`);
    return {
      blocked: true,
      orgId,
      reasons: [
        { kind: 'gate_unavailable', quantity: 0, hardLimit: 0, periodStart: null, periodEnd: null },
      ],
      refreshed: false,
    };
  }
}

/** Escape hatch for local dev only: DAREX_USAGE_GATE_FAIL_OPEN=true. */
export function usageGateFailOpen(): boolean {
  return String(process.env.DAREX_USAGE_GATE_FAIL_OPEN || '').toLowerCase() === 'true';
}

/**
 * Returns null when allowed; structured block payload when over hard cap.
 */
export async function assertUsageAllowed(orgId: string): Promise<null | {
  error: typeof USAGE_BLOCKED_CODE;
  message: string;
  gate: UsageGateResult;
}> {
  const gate = await isUsageBlocked(orgId);
  if (!gate.blocked) return null;
  const unavailable = gate.reasons.some((r) => r.kind === 'gate_unavailable');
  return {
    error: USAGE_BLOCKED_CODE,
    message: unavailable ? USAGE_GATE_UNAVAILABLE_MESSAGE : USAGE_BLOCKED_MESSAGE,
    gate,
  };
}
