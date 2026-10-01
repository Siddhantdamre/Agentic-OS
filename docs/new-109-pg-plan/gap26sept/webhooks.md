# Webhooks Audit

## Status: working (HMAC + OIDC JWT, outbound Gmail/IG/SMS, single-org removed, media metadata, ai_paused, delivery statuses, DLQ, dual-secret)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Outbound stubs for Gmail / Instagram / SMS | P0 | `apps/dashboard/lib/channel-outbound.ts` | 🟢 Done | Real Gmail/Twilio/IG Graph sends; missing creds → `attempted:false`. Retry on 429/5xx. IG 24h window enforced. |
| 2 | Single-org tenant fallback | P0 | whatsapp + channel-normalize + sms/ig/gmail/chatwoot/owner | 🟢 Done | Removed / hard-null; unresolved channel → skip. |
| 3 | Ignore `ai_paused_until` | P0 | whatsapp + persistInboundMessage | 🟢 Done | Skip agent when pause active. |
| 4 | Arbitrary LIMIT 1 employee | P0 | whatsapp / chatwoot / persist | 🟢 Done | Prefer conversation.employee_id. |
| 5 | WhatsApp media not parsed | P0 | whatsapp `parseInboundMessage` | 🟢 Done | media id/mime in content + tool_calls; no fake transcript. |
| 6 | Gmail push shared-secret vs OIDC JWT | P1 | `webhook-crypto.ts` `assertGmailPushToken` | 🟢 Done | Google JWKS RS256 verify; shared token fallback for rotation. |
| 7 | Outbound retry / DLQ / delivery statuses | P1–P2 | `093_webhooks_dlq_and_delivery.sql`, `failed-webhooks.ts`, whatsapp statuses | 🟢 Done | failed_webhooks table; delivery_status updates; outbound retry + DLQ log. |
| 8 | Dual-secret rotation | P2 | webhook-crypto HMAC helpers | 🟢 Done | `*_PREVIOUS` env secrets accepted. |
| 9 | Unchecked body size | P2 | `assertWebhookBodySize` | 🟢 Done | Default 1 MiB; wired on gmail/whatsapp/rent-payment. |
| 10 | Instagram 24h window | P1 | channel-outbound sendInstagram | 🟢 Done | Requires inbound customer message in last 24h. |
| 11 | Rent PSP webhook | P0 | `webhooks/rent-payment/route.ts` | 🟢 Done | Stripe/Razorpay sig → close charge with psp_payment_id. |
| 12 | Outbound webhook body `channel`/`recipient` override (CH-S01) | P0 | `webhooks/outbound/route.ts` | 🟢 Done | Per-org secret (constant-time); channel + recipient only from the conversation row; generic 500 + errorId. |
| 13 | Slack interactions trust button `orgId` (CH-S02) | P1 | `lib/slack-interact.ts`, `webhooks/slack/interactions` | 🟢 Done | `team.id` must match the org's Slack connection team; fails closed. Jest test. |
| 14 | WhatsApp receipts never match; human send failure stays "sent" (CH-B01, CH-B12) | P1 | `channel-outbound.ts`, `failed-webhooks.ts` `recordOutboundDelivery` | 🟢 Done | wamid stored on outbound row; failed sends marked `failed`. Row 7 overclaimed until now. Jest test; no live receipt. |
| 15 | DLQ rows NULL org; outbound failure logs recipient + preview (CH-S07) | P1 | `lib/failed-webhooks.ts`, `channel-outbound.ts` | 🟡 Tree | org_id set when known (org-scoped insert); recipient masked, no preview. Retention: worker `DlqRetentionWorkflow` runs daily and calls `failed_webhooks_purge` (migration 202, SECURITY DEFINER; `DAREX_DLQ_RETENTION_DAYS`, default 30). Migration not applied to a live DB; worker not run live. |

The webhook subsystem (`apps/dashboard/app/api/webhooks/*`) coordinates external event ingestion across WhatsApp Cloud API, Chatwoot, Twilio SMS, Instagram Graph API, Google Pub/Sub (Gmail), Slack interactions, Nango lifecycle events, Stripe/Razorpay billing, and tenant rent payments.
