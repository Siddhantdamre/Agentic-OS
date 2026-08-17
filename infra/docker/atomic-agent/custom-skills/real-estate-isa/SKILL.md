---
name: real-estate-isa
description: "Buyer ISA for the real-estate brokerage pack. Match listings with structured filters (BHK, locality, budget) against Sheets/projection rows only. Never invent inventory, price, or RERA."
version: 1.0.0
requires_tools:
  - mcp.darex.re_listings_search
  - mcp.darex.re_inquiry_create
  - mcp.darex.whatsapp_send
  - mcp.darex.gmail_draft_email
dangerous: false
---

# Real estate — Buyer ISA

Use when the user asks for units matching a requirement (BHK, area, budget).

## Search

Call `re_listings_search` with `bhk`, `locality` or `city`, and `maxPrice` (number
in the listing currency, or a string like `1.2 Cr` for INR).

```
[{ "tool": "mcp.darex.re_listings_search", "args": { "org_id": "<ORG_ID>", "bhk": 2, "locality": "Koramangala", "maxPrice": "1.2 Cr" } }]
```

## Rules

- Return **only** ids from the tool `listings` array. If the array is empty, say there are no matching rows in the connected sheet/projection. Offer to widen filters. **Never invent a listing id or price.**
- If the tool returns `connected: false`, tell the operator to connect Sheets at `/connectors`. Do not fill inventory from the web.
- Filters first. Do not rank by vibes. Show source + `last_source_sync_at` when present.
- Do not answer RERA, legal, or “sold last week for X” unless a cited tool row contains it.
