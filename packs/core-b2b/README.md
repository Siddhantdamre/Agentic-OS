# Core B2B pack

Installed once for every new org. Re-install is a no-op. Uninstall disables
schedules and hides pack UI; it does **not** delete conversations.

## Employees (distinct allowlists)

| Name | Role | Allowlist |
|------|------|-----------|
| Sarah | Sales / front-of-house | gmail, whatsapp, hubspot, google-calendar, web_search |
| Emma | Support / success | gmail, whatsapp, google-calendar |
| Marcus | Ops / analyst | google-sheets, google-drive, metrics, web_search |

Owner can rename. Research and Finance assistants may also be seeded by the
dashboard roster; they are not required for this pack’s quality bar.

## Connectors

Recommended: Gmail, WhatsApp, Calendar. Optional: HubSpot, Sheets, Drive,
Slack, Stripe, Razorpay, web_search.

**Never marked connected** by pack install. Disconnected tools return
`status: error`, `connected: false`, `setupUrl: /connectors`.

## Workflows

1. `OwnerBriefingWorkflow` — daily owner briefing from semantic metrics.
2. `StaleChaseWorkflow` — flag stale open conversations.

## What we never invent

- CRM deals, invoice amounts, or “payment received”
- Connector data when Nango is disconnected
- Memory facts for an empty org

## Compliance

`compliance.yaml` bans guaranteed-return language. Confirm classes: send,
pay, sign.
