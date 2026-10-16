/**
 * Pure Stripe subscription-item reading (BIZ-B03 / BIZ-B04).
 *
 * Checkout sends the base plan price at quantity 1 plus the seat add-on at
 * quantity seats-1. The webhook used to read `data.quantity` (absent) or
 * `items.data[0].quantity` (the base item, always 1), so purchased seats
 * collapsed to 1. The plan also came from `metadata.darex_plan`, which a
 * portal plan switch leaves stale. Both now come from the items' price ids.
 */

export type StripePriceConfig = {
  /** price id → Darex plan key, one entry per configured plan price. */
  planByPriceId: Record<string, string>;
  addonSeatPriceId?: string | null;
};

export type StripeItemSummary = {
  /** Plan resolved from a known base-plan price id; null when none matched. */
  planKey: string | null;
  /** Base-plan quantity + seat add-on quantity; null when no known item was found. */
  seats: number | null;
  basePriceId: string | null;
};

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function priceIdOf(item: Record<string, unknown>): string | null {
  const price = item.price;
  if (typeof price === 'string') return price;
  const id = rec(price).id;
  if (typeof id === 'string' && id) return id;
  const plan = rec(item.plan).id;
  return typeof plan === 'string' && plan ? plan : null;
}

function quantityOf(item: Record<string, unknown>): number {
  const n = Number(item.quantity);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** Accepts `subscription.items` (list object) or a bare array of items. */
export function stripeItemsArray(items: unknown): Record<string, unknown>[] {
  if (Array.isArray(items)) return items.map(rec);
  const data = rec(items).data;
  return Array.isArray(data) ? data.map(rec) : [];
}

export function summarizeStripeItems(items: unknown, cfg: StripePriceConfig): StripeItemSummary {
  let planKey: string | null = null;
  let basePriceId: string | null = null;
  let seats = 0;
  let matched = false;
  for (const item of stripeItemsArray(items)) {
    const priceId = priceIdOf(item);
    if (!priceId) continue;
    const plan = cfg.planByPriceId[priceId];
    if (plan) {
      if (!planKey) {
        planKey = plan;
        basePriceId = priceId;
      }
      seats += quantityOf(item);
      matched = true;
      continue;
    }
    if (cfg.addonSeatPriceId && priceId === cfg.addonSeatPriceId) {
      seats += quantityOf(item);
      matched = true;
    }
  }
  // Add-on seen but base price unknown (rotated price id): the base still carries one seat.
  if (matched && !planKey) seats += 1;
  return { planKey, seats: matched ? Math.max(1, seats) : null, basePriceId };
}
