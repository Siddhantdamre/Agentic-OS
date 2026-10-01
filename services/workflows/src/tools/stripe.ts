import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, nangoAuthError, notConnected, resolveNangoAuth } from './shared.js';
import { checkRefundEligibility, describeRefundVerdict } from '../customer/refund-eligibility.js';

const ACTIONS = ['create_payment_link', 'create_customer', 'get_customer', 'create_refund', 'create_charge'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('refund') || a.includes('charge') || a.includes('payout') || a.includes('payment')) return 'pay';
  if (a.includes('customer') && (a.includes('get') || a.includes('fetch') || a.includes('retrieve'))) return 'read';
  if (a.includes('customer')) return 'draft';
  return 'pay';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const stripeConnId = `${orgId}_stripe`;
  const _stripeAuth = await resolveNangoAuth(stripeConnId, 'stripe');
  const stripeToken = _stripeAuth.kind === 'connected' ? _stripeAuth.accessToken : null;
  const _stripeAuthErr = _stripeAuth.kind === 'connected' ? null : nangoAuthError('stripe', actionName, timestamp, _stripeAuth);
  if (!stripeToken) return _stripeAuthErr ?? notConnected('stripe', actionName, timestamp);
  const stripeHeaders = {
    Authorization: `Bearer ${stripeToken}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  try {
    if (actionName.includes('charge') && !actionName.includes('refund')) {
      // Never auto-charge: autonomy gate must park create_charge for approval first.
      // When skipAutonomy resumes after approval, create a PaymentIntent (confirm=false).
      const amount = payload.amount ?? payload.amount_cents;
      const currency = String(payload.currency || 'usd').toLowerCase();
      const customerId = payload.customerId || payload.customer;
      const paymentMethod = payload.paymentMethodId || payload.payment_method;
      if (amount == null || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        return apiError('stripe', 'create_charge', timestamp, 'amount (positive minor units) is required to create a charge');
      }
      const body: Record<string, string> = {
        amount: String(Math.trunc(Number(amount))),
        currency,
        confirm: 'false',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
      };
      if (customerId) body.customer = String(customerId);
      if (paymentMethod) {
        body.payment_method = String(paymentMethod);
        delete body['automatic_payment_methods[enabled]'];
        delete body['automatic_payment_methods[allow_redirects]'];
      }
      if (payload.description) body.description = String(payload.description);
      const intentRes = await fetchWithTimeout('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: stripeHeaders,
        body: new URLSearchParams(body),
      });
      const intentData = await intentRes.json().catch(() => ({}));
      if (!intentRes.ok) {
        return apiError('stripe', 'create_charge', timestamp, `Stripe create charge failed: ${intentRes.status}`, intentData);
      }
      return {
        tool: 'stripe',
        action: 'create_charge',
        status: 'executed' as const,
        message: `Created Stripe PaymentIntent ${intentData.id} (unconfirmed — capture requires a further approved step)`,
        data: {
          paymentIntentId: intentData.id,
          status: intentData.status,
          amount: intentData.amount,
          currency: intentData.currency,
          clientSecret: intentData.client_secret ?? null,
          autoCharged: false,
        },
        timestamp,
      };
    }
    if (actionName.includes('refund')) {
      const chargeId = payload.chargeId || payload.charge;
      const paymentIntentId = payload.paymentIntentId || payload.payment_intent;
      if (!chargeId && !paymentIntentId) {
        return apiError('stripe', 'create_refund', timestamp, 'chargeId or paymentIntentId is required to create a refund');
      }

      // Defense-in-depth: re-derive amount/age from Stripe's own record of the
      // charge — never trust a caller-supplied amount or date — and enforce the
      // 14-day / $100 auto-refund policy (16 §CE-05) before any money moves.
      const lookupUrl = chargeId
        ? `https://api.stripe.com/v1/charges/${encodeURIComponent(String(chargeId))}`
        : `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(String(paymentIntentId))}`;
      const lookupRes = await fetchWithTimeout(lookupUrl, { headers: { Authorization: `Bearer ${stripeToken}` } });
      const lookupData = await lookupRes.json().catch(() => ({}));
      if (!lookupRes.ok) {
        return apiError('stripe', 'create_refund', timestamp, `Stripe charge lookup failed: ${lookupRes.status}`, lookupData);
      }
      const amountMinor = Number(lookupData.amount ?? lookupData.amount_received ?? 0);
      const chargedAtIso = new Date((Number(lookupData.created) || 0) * 1000).toISOString();
      const currency: string | null = lookupData.currency || null;
      const verdict = checkRefundEligibility({ chargeAtIso: chargedAtIso, amountMinor });
      if (!verdict.eligible) {
        return {
          tool: 'stripe',
          action: 'create_refund',
          status: 'error' as const,
          message: `Refund blocked by policy: ${describeRefundVerdict(verdict, amountMinor, currency)}`,
          data: { verdict, amountMinor, currency },
          timestamp,
        };
      }

      const refundBody: Record<string, string> = chargeId
        ? { charge: String(chargeId) }
        : { payment_intent: String(paymentIntentId) };
      if (payload.amount) refundBody.amount = String(payload.amount);
      if (payload.reason) refundBody.reason = String(payload.reason);

      const refundRes = await fetchWithTimeout('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: stripeHeaders,
        body: new URLSearchParams(refundBody),
      });
      const refundData = await refundRes.json().catch(() => ({}));
      if (!refundRes.ok) {
        return apiError('stripe', 'create_refund', timestamp, `Stripe refund failed: ${refundRes.status}`, refundData);
      }
      return {
        tool: 'stripe',
        action: 'create_refund',
        status: 'executed' as const,
        message: `Refunded ${((refundData.amount ?? amountMinor) / 100).toFixed(2)} ${(refundData.currency || currency || '').toUpperCase()}`,
        data: { refundId: refundData.id, status: refundData.status, amount: refundData.amount, currency: refundData.currency },
        timestamp,
      };
    }
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
    // No default amount: a garbled call must not create a $50 link (RT-B06).
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return apiError('stripe', 'create_payment_link', timestamp, 'amount (positive minor units) is required to create a payment link');
    }
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
