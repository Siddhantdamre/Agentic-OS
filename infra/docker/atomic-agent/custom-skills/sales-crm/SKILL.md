---
name: sales-crm
description: "CRM operations through mcp.darex — create and update HubSpot contacts. Use when the user mentions a lead, prospect, contact, customer record, CRM, or pipeline entry."
version: 1.0.0
requires_tools:
  - mcp.darex.hubspot_create_contact
  - mcp.darex.hubspot_update_contact
dangerous: false
---

# CRM (HubSpot) Playbook

The org-connected HubSpot CRM is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| Create a contact | `hubspot_create_contact` | `email` (required), optional `firstname`, `lastname` |
| Update an existing contact | `hubspot_update_contact` | `email` (required), optional `firstname`, `lastname`, `phone`, `jobtitle`, `lifecyclestage`, `company` |

## Calling convention

```
[{ "tool": "mcp.darex.hubspot_create_contact", "args": { "org_id": "<ORG_ID>", "email": "new@lead.com", "firstname": "Jane", "lastname": "Doe" } }]
[{ "tool": "mcp.darex.hubspot_update_contact", "args": { "org_id": "<ORG_ID>", "email": "new@lead.com", "phone": "+1 555 0100", "lifecyclestage": "customer" } }]
```

## Rules

- Look up by email — HubSpot de-duplicates on email.
- Only include fields the user actually provided or referenced.