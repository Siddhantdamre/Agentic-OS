import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, nangoAuthError, notConnected, resolveNangoAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = ['fetch_products', 'fetch_orders', 'update_order_address'] as const;

function riskFor(action: string): ToolRisk {
  return action.toLowerCase().includes('update') ? 'draft' : 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const shopifyConnId = `${orgId}_shopify`;
  const _shAuth = await resolveNangoAuth(shopifyConnId, 'shopify');
  const shopifyConn = _shAuth.kind === 'connected' ? _shAuth.connection : null;
  const _shAuthErr = _shAuth.kind === 'connected' ? null : nangoAuthError('shopify', actionName, timestamp, _shAuth);
  const shopifyToken = (shopifyConn as any)?.credentials?.raw?.access_token || (shopifyConn as any)?.credentials?.access_token || null;
  if (shopifyToken) {
    try {
      const shopDomain = payload.shopDomain
        || process.env.SHOPIFY_SHOP_DOMAIN
        || (shopifyConn as any)?.connection_config?.shop
        || (shopifyConn as any)?.metadata?.shop
        || (shopifyConn as any)?.metadata?.shopDomain;
      if (!shopDomain) {
        return apiError('shopify', actionName, timestamp, 'shopDomain is required (payload, SHOPIFY_SHOP_DOMAIN, or Nango connection metadata).');
      }
      if (shopDomain) {
        if (actionName.includes('update') && actionName.includes('address')) {
          const orderId = payload.orderId || payload.order_id || payload.id;
          const shippingAddress = payload.shippingAddress || payload.shipping_address || payload.address;
          if (!orderId) {
            return apiError('shopify', 'update_order_address', timestamp, 'orderId is required to update a shipping address.');
          }
          if (!shippingAddress || typeof shippingAddress !== 'object') {
            return apiError('shopify', 'update_order_address', timestamp, 'shippingAddress (address1, city, zip, country, etc.) is required.');
          }

          // Gate: never move an address once the warehouse has started fulfilling
          // the order — a mid-fulfillment address change ships to the old address
          // anyway and just corrupts the record.
          const orderRes = await fetchWithTimeout(
            `https://${shopDomain}/admin/api/2024-01/orders/${encodeURIComponent(String(orderId))}.json`,
            { headers: { 'X-Shopify-Access-Token': shopifyToken } },
          );
          const orderBody = await orderRes.json().catch(() => ({}));
          if (!orderRes.ok) {
            return apiError('shopify', 'update_order_address', timestamp, `Shopify order lookup failed: ${orderRes.status}`, orderBody);
          }
          const order = orderBody.order;
          const fulfillmentStatus = order?.fulfillment_status || null;
          if (fulfillmentStatus && fulfillmentStatus !== 'unfulfilled') {
            return {
              tool: 'shopify',
              action: 'update_order_address',
              status: 'error' as const,
              message: `Order #${order?.order_number ?? orderId} is already ${fulfillmentStatus} — address can no longer be changed.`,
              data: { orderId, fulfillmentStatus },
              timestamp,
            };
          }

          const updateRes = await fetchWithTimeout(
            `https://${shopDomain}/admin/api/2024-01/orders/${encodeURIComponent(String(orderId))}.json`,
            {
              method: 'PUT',
              headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: { id: orderId, shipping_address: shippingAddress } }),
            },
          );
          const updateBody = await updateRes.json().catch(() => ({}));
          if (!updateRes.ok) {
            return apiError('shopify', 'update_order_address', timestamp, `Shopify order update failed: ${updateRes.status}`, updateBody);
          }
          return {
            tool: 'shopify',
            action: 'update_order_address',
            status: 'executed' as const,
            message: `Updated shipping address on order #${updateBody.order?.order_number ?? orderId}`,
            data: { orderId, shippingAddress: updateBody.order?.shipping_address || shippingAddress },
            timestamp,
          };
        }
        if (actionName.includes('product')) {
          const shopifyRes = await fetchWithTimeout(
            `https://${shopDomain}/admin/api/2024-01/products.json?limit=10`,
            { headers: { 'X-Shopify-Access-Token': shopifyToken } }
          );
          if (shopifyRes.ok) {
            const data = await shopifyRes.json();
            return {
              tool: 'shopify',
              action: 'fetch_products',
              status: 'executed' as const,
              message: `Fetched ${data.products?.length || 0} products from Shopify`,
              data: { products: data.products || [] },
              timestamp,
            };
          }
        } else {
          const shopifyRes = await fetchWithTimeout(
            `https://${shopDomain}/admin/api/2024-01/orders.json?status=open&limit=50`,
            { headers: { 'X-Shopify-Access-Token': shopifyToken } }
          );
          if (shopifyRes.ok) {
            const shopifyData = await shopifyRes.json();
            const orders = shopifyData.orders || [];
            const totalVolume = orders.reduce((sum: number, o: any) => sum + parseFloat(o.total_price || 0), 0);
            return {
              tool: 'shopify',
              action: 'fetch_orders',
              status: 'executed' as const,
              message: `Fetched ${orders.length} live orders from Shopify`,
              data: { openOrders: orders.length, totalVolume: `$${totalVolume.toFixed(2)}`, orders: orders.slice(0, 5) },
              timestamp,
            };
          }
        }
      }
    } catch (e: any) {
      console.error('[Shopify] API error:', e.message);
    }
  }
  return _shAuthErr ?? notConnected('shopify', actionName, timestamp);
}

export const shopify: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
