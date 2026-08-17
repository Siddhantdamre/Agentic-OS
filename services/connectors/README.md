# services/connectors — Nango Integration Layer (Phase 2)

OAuth connector functions for all external integrations. Wraps Nango's self-hosted instance.

**Status:** Placeholder. Populated in **Phase 2**.

## What goes here
Each connector is a versioned TypeScript function callable by name from the agent layer.

```
services/connectors/
  src/
    whatsapp/       → WhatsApp Business Cloud API connector
    gmail/          → Gmail OAuth connector
    google-calendar/ → Google Calendar connector
    hubspot/        → HubSpot CRM connector
    razorpay/       → Razorpay payments connector
    meta-ads/       → Meta Ads connector
    google-ads/     → Google Ads connector
  nango.yaml        → Nango integration manifest
  package.json
  tsconfig.json
```

## Design Constraint (from spec Rule 7)
All connectors are invoked by name from the agent tool registry. The connector layer has **zero knowledge** of which AI employee is calling it.

## Why Nango (not Composio)
Nango is open-source and self-hostable — token storage is inspectable and org-isolated. Composio had a May 2026 breach exposing ~10,242 customer credentials.
