/**
 * Server-side usage circuit breaker for Darex hard meter caps.
 *
 * Pure meter checks live in `@darex/workflows` so the Temporal tool executor
 * and the dashboard share one implementation. Org identity must come from the
 * session (`getScopedClient`) or a trusted server-resolved id — never from a
 * client body/query `org_id`.
 *
 * Optional `refresh: true` runs Langfuse meter refresh (dashboard-only).
 */

import { NextResponse } from 'next/server';
import { refreshOrgMeters } from '@/app/api/billing/_lib';
import {
  USAGE_BLOCKED_CODE,
  USAGE_BLOCKED_MESSAGE,
  assertUsageAllowed as assertUsageAllowedCore,
  isUsageBlocked as isUsageBlockedCore,
  type UsageBlockReason,
  type UsageGateResult,
} from '@darex/workflows/dist/usage-gate';

export {
  USAGE_BLOCKED_CODE,
  USAGE_BLOCKED_MESSAGE,
  type UsageBlockReason,
  type UsageGateResult,
};

/**
 * Returns whether the org is over a hard usage cap.
 *
 * @param orgId Trusted org id (session or webhook-resolved). Never from client body.
 * @param opts.refresh When true, runs `refreshOrgMeters` first (hits Langfuse).
 *   Prefer false on hot agent paths; meters are refreshed by GET /api/billing.
 */
export async function isUsageBlocked(
  orgId: string,
  opts?: { refresh?: boolean }
): Promise<UsageGateResult> {
  if (opts?.refresh) {
    const meters = await refreshOrgMeters(orgId);
    const reasons: UsageBlockReason[] = [];
    for (const m of meters.meters) {
      if (m.kind !== 'llm_tokens' && m.kind !== 'whatsapp_conversations') continue;
      if (!m.overHard || m.hardLimit == null) continue;
      reasons.push({
        kind: m.kind,
        quantity: m.quantity,
        hardLimit: m.hardLimit,
        periodStart: m.periodStart,
        periodEnd: m.periodEnd,
      });
    }
    return {
      blocked: meters.usageBlocked || reasons.length > 0,
      orgId,
      reasons,
      refreshed: true,
    };
  }

  return isUsageBlockedCore(orgId);
}

/**
 * Circuit-breaker helper for execution paths. Returns null when allowed;
 * returns a structured block payload when over hard cap (does not throw).
 */
export async function assertUsageAllowed(
  orgId: string,
  opts?: { refresh?: boolean }
): Promise<null | {
  error: typeof USAGE_BLOCKED_CODE;
  message: string;
  gate: UsageGateResult;
}> {
  if (opts?.refresh) {
    const gate = await isUsageBlocked(orgId, opts);
    if (!gate.blocked) return null;
    return {
      error: USAGE_BLOCKED_CODE,
      message: USAGE_BLOCKED_MESSAGE,
      gate,
    };
  }
  return assertUsageAllowedCore(orgId);
}

/**
 * 402 response for execution routes when the org is over a hard cap (or the
 * gate failed closed). Null when allowed. Org must be session-resolved.
 */
export async function usageBlockedResponse(orgId: string): Promise<NextResponse | null> {
  const block = await assertUsageAllowed(orgId);
  if (!block) return null;
  return NextResponse.json(
    { error: block.error, message: block.message, reasons: block.gate.reasons },
    { status: 402 }
  );
}

/** Re-export seat helper so invite agents have one import surface with usage gate. */
export { checkSeatAvailability, reserveInviteSeat } from '@/app/api/billing/_lib';
