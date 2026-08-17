---
name: ecommerce
description: "E-commerce operations through mcp.darex — fetch Shopify products and orders. Use when the user asks about store inventory, products, orders, or Shopify data."
version: 1.0.0
requires_tools:
  - mcp.darex.shopify_fetch_products
  - mcp.darex.shopify_fetch_orders
dangerous: false
---

# E-commerce Playbook (Shopify)

The org-connected Shopify store is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| List products | `shopify_fetch_products` | none required |
| List open orders | `shopify_fetch_orders` | none required |

## Calling convention

```
[{ "tool": "mcp.darex.shopify_fetch_products", "args": { "org_id": "<ORG_ID>" } }]
[{ "tool": "mcp.darex.shopify_fetch_orders", "args": { "org_id": "<ORG_ID>" } }]
```

## Rules

- Summarize product/order counts and highlight anything notable (low stock, pending fulfillment).