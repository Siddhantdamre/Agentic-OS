import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, notConnected, withOrgScopedClient } from './shared.js';

const ACTIONS = ['create_payment_link'] as const;

function riskFor(_action: string): ToolRisk {
  return 'pay';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  let razorpayKeyId = '';
  let razorpayKeySecret = '';
  await withOrgScopedClient(orgId, async (rzpClient) => {
    const rzpChan = await rzpClient.query(
      `SELECT meta FROM channels WHERE org_id = $1 AND channel_type = 'razorpay' AND status IN ('connected', 'active')`,
      [orgId]
    );
    const meta = rzpChan.rows[0]?.meta || {};
    razorpayKeyId = String(meta.keyId || meta.key_id || '');
    razorpayKeySecret = String(meta.keySecret || meta.key_secret || '');
  });
  if (!razorpayKeyId || !razorpayKeySecret) {
    razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
    razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
  }
  if (!razorpayKeyId || !razorpayKeySecret) {
    return notConnected('razorpay', actionName, timestamp);
  }
  try {
    const amount = payload.amount || 50000; // paise (₹500)
    const currency = payload.currency || 'INR';
    const description = payload.description || 'DareX AI Invoice';
    const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
    const rzpRes = await fetchWithTimeout('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, currency, description, accept_partial: false }),
    });
    const rzpData = await rzpRes.json().catch(() => ({}));
    if (!rzpRes.ok) {
      return apiError(
        'razorpay',
        'create_payment_link',
        timestamp,
        `Razorpay payment link failed: ${rzpRes.status} ${rzpData?.error?.description || ''}`.trim(),
        rzpData,
      );
    }
    return {
      tool: 'razorpay',
      action: 'create_payment_link',
      status: 'executed' as const,
      message: `Created Razorpay payment link for ₹${(amount / 100).toFixed(2)}`,
      data: { paymentLinkId: rzpData.id, shortUrl: rzpData.short_url, status: rzpData.status },
      timestamp,
    };
  } catch (e: any) {
    return apiError('razorpay', actionName, timestamp, `Razorpay API error: ${e.message}`);
  }
}

export const razorpay: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
