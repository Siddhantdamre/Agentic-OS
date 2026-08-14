import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['create_payment_link', 'create_customer', 'get_customer'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('customer') && (a.includes('get') || a.includes('fetch') || a.includes('retrieve'))) return 'read';
  if (a.includes('customer')) return 'draft';
  return 'pay';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const stripeConnId = `${orgId}_stripe`;
  const stripeToken = await getNangoAccessToken(stripeConnId, 'stripe');
  if (!stripeToken) return notConnected('stripe', actionName, timestamp);
  const stripeHeaders = {
    Authorization: `Bearer ${stripeToken}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  try {
    if (actionName.includes('customer') && (actionName.includes('get') || actionName.includes('fetch') || actionName.includes('retrieve'))) {
      const customerId = payload.customerId || payload.id;
      const email = payload.email;
      const url = customerId
        ? `https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`
        : `https://api.stripe.com/v1/customers${email ? `?email=${encodeURIComponent(email)}&limit=1` : '?limit=10'}`;
      const stripeRes = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${stripeToken}` } });
      const customerData = await stripeRes.json().catch(() => ({}));
      if (!stripeRes.ok) {
        return apiError('stripe', 'get_customer', timestamp, `Stripe get customer failed: ${stripeRes.status}`, customerData);
      }
      return { tool: 'stripe', action: 'get_customer', status: 'executed' as const, message: 'Fetched Stripe customer(s)', data: customerData, timestamp };
    }
    if (actionName.includes('customer')) {
      const email = payload.email;
      if (!email) return apiError('stripe', 'create_customer', timestamp, 'email is required to create a Stripe customer');
      const stripeRes = await fetchWithTimeout('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: stripeHeaders,
        body: new URLSearchParams({ email, name: payload.name || '' }),
      });
      const customerData = await stripeRes.json().catch(() => ({}));
      if (!stripeRes.ok) {
        return apiError('stripe', 'create_customer', timestamp, `Stripe create customer failed: ${stripeRes.status}`, customerData);
      }
      return { tool: 'stripe', action: 'create_customer', status: 'executed' as const, message: `Created Stripe customer ${email}`, data: customerData, timestamp };
    }
    const amount = payload.amount || 5000;
    const currency = payload.currency || 'usd';
    const productName = payload.name || 'DareX AI Service';
    const stripeRes = await fetchWithTimeout('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: stripeHeaders,
      body: new URLSearchParams({
        'line_items[0][price_data][currency]': currency,
        'line_items[0][price_data][product_data][name]': productName,
        'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][quantity]': '1',
      }),
    });
    const stripeData = await stripeRes.json().catch(() => ({}));
    if (!stripeRes.ok) {
      return apiError('stripe', 'create_payment_link', timestamp, `Stripe payment link failed: ${stripeRes.status}`, stripeData);
    }
    return {
      tool: 'stripe',
      action: 'create_payment_link',
      status: 'executed' as const,
      message: `Created Stripe payment link for ${productName}`,
      data: { checkoutUrl: stripeData.url, paymentLinkId: stripeData.id, active: stripeData.active },
      timestamp,
    };
  } catch (e: any) {
    return apiError('stripe', actionName, timestamp, `Stripe API error: ${e.message}`);
  }
}

export const stripe: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
