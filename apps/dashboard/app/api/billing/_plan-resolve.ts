/**
 * Org plan from all of an org's subscription rows (BIZ-B05 / BIZ-B06).
 *
 * An org can hold one row per provider. Cancelling the Razorpay row used to
 * set orgs.plan='free' even while a Stripe subscription was still active.
 * The plan is now derived from every row together.
 */

export const PLAN_RANK: Record<string, number> = {
  free: 0,
  starter: 1,
  growth: 2,
  scale: 3,
  enterprise: 4,
};

export type PlanRow = { provider: string; plan_key: string; status: string };

const LIVE = new Set(['active', 'trialing']);
/** Still owed money: keep the plan until dunning decides (applyDunningState). */
const HELD = new Set(['past_due', 'incomplete']);

/**
 * `plan`: set orgs.plan to this value. `unchanged`: leave it (a row is in
 * dunning or checkout, so another path owns the decision).
 */
export function resolveOrgPlan(rows: PlanRow[]): { action: 'set'; plan: string } | { action: 'unchanged' } {
  let best: string | null = null;
  for (const r of rows) {
    if (!LIVE.has(r.status) || r.plan_key === 'free' || !(r.plan_key in PLAN_RANK)) continue;
    if (best == null || PLAN_RANK[r.plan_key] > PLAN_RANK[best]) best = r.plan_key;
  }
  if (best) return { action: 'set', plan: best };
  if (rows.some((r) => HELD.has(r.status))) return { action: 'unchanged' };
  return { action: 'set', plan: 'free' };
}

/** A live paid subscription on a provider other than `provider`, if any. */
export function otherLiveProvider(rows: PlanRow[], provider: string): PlanRow | null {
  return (
    rows.find(
      (r) => r.provider !== provider && (LIVE.has(r.status) || r.status === 'past_due') && r.plan_key !== 'free'
    ) ?? null
  );
}
