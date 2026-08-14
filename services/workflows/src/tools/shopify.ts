import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, getNangoConnection, notConnected } from './shared.js';

const ACTIONS = ['fetch_products', 'fetch_orders'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const shopifyConnId = `${orgId}_shopify`;
  const shopifyConn = await getNangoConnection(shopifyConnId, 'shopify');
  const shopifyToken = shopifyConn?.credentials?.raw?.access_token || shopifyConn?.credentials?.access_token || null;
  if (shopifyToken) {
    try {
      const shopDomain = payload.shopDomain
        || process.env.SHOPIFY_SHOP_DOMAIN
        || shopifyConn?.connection_config?.shop
        || shopifyConn?.metadata?.shop
        || shopifyConn?.metadata?.shopDomain;
      if (!shopDomain) {
        return apiError('shopify', actionName, timestamp, 'shopDomain is required (payload, SHOPIFY_SHOP_DOMAIN, or Nango connection metadata).');
      }
      if (shopDomain) {
        if (actionName.includes('product')) {
          const shopifyRes = await fetch(
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
          const shopifyRes = await fetch(
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
  return notConnected('shopify', actionName, timestamp);
}

export const shopify: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
