/**
 * @jest-environment node
 *
 * BIZ-B03 / B04: seats summed across base + add-on items by price id; plan
 * resolved from the price id, not stale metadata.
 */

const ORG = '00000000-0000-0000-0000-0000000000aa';
const scopedQueries: Array<{ sql: string; params: unknown[] }> = [];

jest.mock('@/lib/db', () => ({
  pool: {
    query: jest.fn(async (sql: string) => {
      if (/billing_lookup_by_provider_subscription/.test(sql)) {
        return { rows: [{ org_id: ORG, subscription_id: 'row-1', plan_key: 'starter', status: 'active', seats: 1 }] };
      }
      return { rows: [] };
    }),
  },
  getOrgScopedClient: jest.fn(async () => ({
    client: {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        scopedQueries.push({ sql, params });
        if (/INSERT INTO billing_subscriptions/.test(sql)) {
          return { rows: [{ id: 'row-1', org_id: ORG, provider: 'stripe', plan_key: params[4], status: params[5], seats: params[6] }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    },
    orgId: ORG,
  })),
  getScopedClient: jest.fn(),
  scopedAuthErrorResponse: () => null,
}));

import { summarizeStripeItems } from '../../app/api/billing/_stripe-items';

const cfg = {
  planByPriceId: { price_starter: 'starter', price_growth: 'growth' },
  addonSeatPriceId: 'price_seat',
};

describe('summarizeStripeItems', () => {
  it('sums base quantity 1 + add-on quantity seats-1', () => {
    const s = summarizeStripeItems(
      { data: [{ price: { id: 'price_growth' }, quantity: 1 }, { price: { id: 'price_seat' }, quantity: 7 }] },
      cfg
    );
    expect(s).toEqual({ planKey: 'growth', seats: 8, basePriceId: 'price_growth' });
  });

  it('uses the base quantity when there is no add-on', () => {
    expect(summarizeStripeItems([{ price: 'price_starter', quantity: 3 }], cfg).seats).toBe(3);
  });

  it('ignores unknown prices and returns null seats when nothing matched', () => {
    expect(summarizeStripeItems([{ price: { id: 'price_metered' }, quantity: 900 }], cfg)).toEqual({
      planKey: null,
      seats: null,
      basePriceId: null,
    });
  });

  it('counts the base seat when only the add-on price is recognised', () => {
    expect(summarizeStripeItems([{ price: { id: 'price_x' } }, { price: { id: 'price_seat' }, quantity: 4 }], cfg).seats).toBe(5);
  });
});

describe('processStripeEvent customer.subscription.updated', () => {
  beforeAll(() => {
    process.env.DAREX_STRIPE_PRICE_STARTER = 'price_starter';
    process.env.DAREX_STRIPE_PRICE_GROWTH = 'price_growth';
    process.env.DAREX_STRIPE_PRICE_ADDON_SEAT = 'price_seat';
  });

  it('writes plan from price id and seats summed across items, ignoring stale metadata', async () => {
    const { processStripeEvent } = await import('../../app/api/billing/_lib');
    scopedQueries.length = 0;
    const res = await processStripeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          metadata: { darex_org_id: ORG, darex_plan: 'starter' },
          items: {
            data: [
              { price: { id: 'price_growth' }, quantity: 1 },
              { price: { id: 'price_seat' }, quantity: 9 },
            ],
          },
        },
      },
    });
    expect(res.status).toBe('processed');
    const upsert = scopedQueries.find((q) => /INSERT INTO billing_subscriptions/.test(q.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.params[4]).toBe('growth');
    expect(upsert!.params[6]).toBe(10);
  });
});

describe('resolveOrgPlan / otherLiveProvider (BIZ-B05/B06)', () => {
  const { resolveOrgPlan, otherLiveProvider } = jest.requireActual('../../app/api/billing/_plan-resolve');

  it('keeps the Stripe plan when the Razorpay row is cancelled', () => {
    expect(
      resolveOrgPlan([
        { provider: 'stripe', plan_key: 'growth', status: 'active' },
        { provider: 'razorpay', plan_key: 'starter', status: 'canceled' },
      ])
    ).toEqual({ action: 'set', plan: 'growth' });
  });

  it('drops to free only when no row is live or held', () => {
    expect(resolveOrgPlan([{ provider: 'stripe', plan_key: 'growth', status: 'canceled' }])).toEqual({
      action: 'set',
      plan: 'free',
    });
    expect(
      resolveOrgPlan([
        { provider: 'stripe', plan_key: 'growth', status: 'canceled' },
        { provider: 'razorpay', plan_key: 'starter', status: 'past_due' },
      ])
    ).toEqual({ action: 'unchanged' });
  });

  it('picks the highest live plan across providers', () => {
    expect(
      resolveOrgPlan([
        { provider: 'stripe', plan_key: 'starter', status: 'active' },
        { provider: 'razorpay', plan_key: 'enterprise', status: 'trialing' },
      ])
    ).toEqual({ action: 'set', plan: 'enterprise' });
  });

  it('flags a live subscription on the other provider before a new checkout', () => {
    const rows = [{ provider: 'razorpay', plan_key: 'starter', status: 'active' }];
    expect(otherLiveProvider(rows, 'stripe')?.provider).toBe('razorpay');
    expect(otherLiveProvider(rows, 'razorpay')).toBeNull();
    expect(otherLiveProvider([{ provider: 'razorpay', plan_key: 'starter', status: 'canceled' }], 'stripe')).toBeNull();
  });
});

describe('reserveInviteSeat (BIZ-B08)', () => {
  function fakeClient(opts: { used: number; purchased: number | null; pendingInviteForEmail?: boolean }) {
    const sqls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        sqls.push(sql);
        if (/lower\(email\) = \$2/.test(sql)) return { rows: opts.pendingInviteForEmail ? [{ id: 'inv' }] : [] };
        if (/organization_memberships/.test(sql)) return { rows: [{ count: String(opts.used) }] };
        if (/org_plan_overrides/.test(sql)) return { rows: [] };
        if (/FROM billing_subscriptions/.test(sql)) {
          return { rows: opts.purchased == null ? [] : [{ seats: opts.purchased }] };
        }
        return { rows: [] };
      }),
    };
    return { client, sqls };
  }

  it('blocks the invite and rolls back when members + open invites fill the purchased seats', async () => {
    const { reserveInviteSeat } = await import('../../app/api/billing/_lib');
    const { client, sqls } = fakeClient({ used: 3, purchased: 3 });
    const write = jest.fn();
    const res = await reserveInviteSeat(client as never, ORG, 'new@x.com', write);
    expect(res?.allowed).toBe(false);
    expect(res?.seatLimit).toBe(3);
    expect(write).not.toHaveBeenCalled();
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some((s) => /pg_advisory_xact_lock/.test(s))).toBe(true);
  });

  it('writes and commits when a seat is free', async () => {
    const { reserveInviteSeat } = await import('../../app/api/billing/_lib');
    const { client, sqls } = fakeClient({ used: 2, purchased: 3 });
    const write = jest.fn(async () => undefined);
    expect(await reserveInviteSeat(client as never, ORG, 'new@x.com', write)).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  it('does not consume a seat when resending a pending invite', async () => {
    const { reserveInviteSeat } = await import('../../app/api/billing/_lib');
    const { client } = fakeClient({ used: 3, purchased: 3, pendingInviteForEmail: true });
    const write = jest.fn(async () => undefined);
    expect(await reserveInviteSeat(client as never, ORG, 'old@x.com', write)).toBeNull();
    expect(write).toHaveBeenCalled();
  });

  it('counts open invites in seats in use', async () => {
    const { SEATS_IN_USE_SQL } = await import('../../app/api/billing/_lib');
    expect(SEATS_IN_USE_SQL).toMatch(/FROM org_invites/);
    expect(SEATS_IN_USE_SQL).toMatch(/organization_memberships/);
  });
});
