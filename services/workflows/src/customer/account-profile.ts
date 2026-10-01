/**
 * CE-02 VIP & Account Profiler. Replaces keyword-only state inference with
 * real CRM (HubSpot) + billing (Stripe) + support (Zendesk) lookups so the
 * customer employee has actual MRR, open ticket count, and VIP tags instead
 * of guessing from message text. Every source fails closed to "unavailable"
 * (never invented) when a connector isn't configured for the org.
 */
import { executeProvider } from '../tools/index.js';
import { resolveNangoAuth } from '../tools/shared.js';

export type ProfileSourceState = 'live' | 'unavailable';

export interface AccountProfile {
  vip: boolean;
  vipTags: string[];
  lifecycleStage: string | null;
  mrrMinor: number | null;
  currency: string | null;
  openTickets: number | null;
  sources: {
    crm: ProfileSourceState;
    billing: ProfileSourceState;
    support: ProfileSourceState;
  };
}

// VIP heuristics: an org can also tag contacts explicitly via HubSpot custom
// properties (vip_status / vip_tier); those always win over the MRR floor.
const VIP_LIFECYCLE_STAGES = new Set(['customer', 'evangelist', 'opportunity']);
const VIP_MRR_FLOOR_MINOR = 50_000; // $500/mo or local-currency equivalent minor units

export function emptyAccountProfile(): AccountProfile {
  return {
    vip: false,
    vipTags: [],
    lifecycleStage: null,
    mrrMinor: null,
    currency: null,
    openTickets: null,
    sources: { crm: 'unavailable', billing: 'unavailable', support: 'unavailable' },
  };
}

async function fetchStripeMrr(
  orgId: string,
  stripeCustomerId: string,
): Promise<{ mrrMinor: number; currency: string | null } | null> {
  const auth = await resolveNangoAuth(`${orgId}_stripe`, 'stripe');
  if (auth.kind !== 'connected') return null;
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=active&limit=10`,
      { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    let mrrMinor = 0;
    let currency: string | null = null;
    for (const sub of data.data || []) {
      for (const item of sub.items?.data || []) {
        const price = item.price;
        if (!price) continue;
        currency = currency || price.currency || null;
        const amount = (price.unit_amount || 0) * (item.quantity || 1);
        const interval = price.recurring?.interval;
        const intervalCount = price.recurring?.interval_count || 1;
        if (interval === 'year') mrrMinor += amount / (12 * intervalCount);
        else if (interval === 'week') mrrMinor += (amount * 52) / (12 * intervalCount);
        else if (interval === 'day') mrrMinor += (amount * 365) / (12 * intervalCount);
        else mrrMinor += amount / intervalCount; // month (Stripe default)
      }
    }
    return { mrrMinor: Math.round(mrrMinor), currency };
  } catch {
    return null;
  }
}

export interface LastCharge {
  chargeId: string;
  chargeAtIso: string;
  amountMinor: number;
  currency: string | null;
}

/**
 * CE-03 refund-eligibility grounding: the customer's most recent Stripe
 * charge, used to answer "am I eligible for a refund" with real numbers
 * instead of a generic policy paraphrase. Returns null (never invented) when
 * Stripe isn't connected or the customer has no charge history.
 */
export async function fetchLastCharge(orgId: string, customerEmail: string): Promise<LastCharge | null> {
  const email = String(customerEmail || '').trim();
  if (!orgId || !email || !email.includes('@')) return null;
  const auth = await resolveNangoAuth(`${orgId}_stripe`, 'stripe');
  if (auth.kind !== 'connected') return null;
  try {
    const custRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    );
    if (!custRes.ok) return null;
    const custData = await custRes.json().catch(() => ({}));
    const customerId = custData?.data?.[0]?.id;
    if (!customerId) return null;

    const chargeRes = await fetch(
      `https://api.stripe.com/v1/charges?customer=${encodeURIComponent(customerId)}&limit=1`,
      { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    );
    if (!chargeRes.ok) return null;
    const chargeData = await chargeRes.json().catch(() => ({}));
    const charge = chargeData?.data?.[0];
    if (!charge || !charge.id) return null;
    return {
      chargeId: charge.id,
      chargeAtIso: new Date((charge.created || 0) * 1000).toISOString(),
      amountMinor: Number(charge.amount ?? 0),
      currency: charge.currency || null,
    };
  } catch {
    return null;
  }
}

/**
 * Looks up the real account picture for a customer identifier (email
 * preferred; phone/handle falls back to CRM search only — Stripe lookups
 * require an email). Never throws: a connector that isn't configured for
 * this org just contributes "unavailable" for that source.
 */
export async function fetchAccountProfile(orgId: string, customerIdentifier: string): Promise<AccountProfile> {
  const identifier = String(customerIdentifier || '').trim();
  if (!orgId || !identifier) return emptyAccountProfile();
  const isEmail = identifier.includes('@');
  const timestamp = new Date().toISOString();

  const [crmResult, billingResult, supportResult] = await Promise.all([
    executeProvider({
      tool: 'hubspot',
      action: 'search_contacts',
      actionName: 'search_contacts',
      payload: isEmail ? { email: identifier, query: identifier } : { query: identifier },
      orgId,
      timestamp,
    }).catch(() => null),
    isEmail
      ? executeProvider({
          tool: 'stripe',
          action: 'get_customer',
          actionName: 'get_customer',
          payload: { email: identifier },
          orgId,
          timestamp,
        }).catch(() => null)
      : Promise.resolve(null),
    executeProvider({
      tool: 'zendesk',
      action: 'fetch_tickets',
      actionName: 'fetch_tickets',
      payload: { email: identifier, status: 'open' },
      orgId,
      timestamp,
    }).catch(() => null),
  ]);

  const contact = crmResult?.status === 'executed' ? (crmResult.data as any)?.contacts?.[0] : null;
  const lifecycleStage: string | null = contact?.properties?.lifecyclestage || null;
  const vipTagRaw = contact?.properties?.vip_status || contact?.properties?.vip_tier;
  const vipTags = vipTagRaw ? [String(vipTagRaw)] : [];

  const stripeData = billingResult?.status === 'executed' ? (billingResult.data as any) : null;
  const stripeCustomer = Array.isArray(stripeData?.data) ? stripeData.data[0] : stripeData;

  let mrrMinor: number | null = null;
  let currency: string | null = null;
  if (stripeCustomer?.id) {
    const mrr = await fetchStripeMrr(orgId, stripeCustomer.id);
    if (mrr) {
      mrrMinor = mrr.mrrMinor;
      currency = mrr.currency;
    }
  }

  const ticketsData = supportResult?.status === 'executed' ? (supportResult.data as any) : null;
  const openTickets = Array.isArray(ticketsData?.tickets)
    ? ticketsData.tickets.filter((t: any) => !t?.status || t.status === 'open' || t.status === 'new').length
    : null;

  const vip =
    vipTags.length > 0 ||
    VIP_LIFECYCLE_STAGES.has(String(lifecycleStage || '').toLowerCase()) ||
    (mrrMinor !== null && mrrMinor >= VIP_MRR_FLOOR_MINOR);

  return {
    vip,
    vipTags,
    lifecycleStage,
    mrrMinor,
    currency,
    openTickets,
    sources: {
      crm: crmResult?.status === 'executed' ? 'live' : 'unavailable',
      billing: billingResult?.status === 'executed' ? 'live' : 'unavailable',
      support: supportResult?.status === 'executed' ? 'live' : 'unavailable',
    },
  };
}
