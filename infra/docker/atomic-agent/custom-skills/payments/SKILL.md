---
name: payments
description: "Payment link generation through mcp.darex — Stripe payment links and Razorpay payment links. Use when the user asks to charge, bill, invoice, collect payment, or create a payment link."
version: 1.0.0
requires_tools:
  - mcp.darex.stripe_create_payment_link
  - mcp.darex.razorpay_create_payment_link
dangerous: false
---

# Payments Playbook (Stripe / Razorpay)

Payment processing is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| Stripe payment link | `stripe_create_payment_link` | optional `amount`, `currency`, `name` |
| Razorpay payment link | `razorpay_create_payment_link` | optional `amount` (paise), `currency`, `description` |

## Calling convention

```
[{ "tool": "mcp.darex.stripe_create_payment_link", "args": { "org_id": "<ORG_ID>", "amount": 4900, "currency": "usd", "name": "Pro Plan" } }]
[{ "tool": "mcp.darex.razorpay_create_payment_link", "args": { "org_id": "<ORG_ID>", "amount": 499900, "currency": "inr", "description": "Invoice #1042" } }]
```

## Rules

- Stripe amounts are in cents; Razorpay amounts are in paise. Convert user-facing amounts accordingly.
- Share the returned payment link URL with the user.