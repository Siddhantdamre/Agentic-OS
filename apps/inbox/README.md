# apps/inbox — HMAC Chatwoot gateway

Express proxy on `:3004`. It is **not** a Chatwoot fork.

Inbound `POST /webhook/inbound` HMAC-signs the body and forwards to
`POST /api/webhooks/chatwoot`. Outbound `POST /api/inbox/send` forwards to
`POST /api/webhooks/outbound`, which sends on the real channel.

`GET /health` returns `{ status: 'ok', service: 'darex-inbox-chatwoot-gateway' }`.

Set `CHATWOOT_WEBHOOK_SECRET` (same value as the dashboard) and
`DASHBOARD_URL` (compose: `http://dashboard:3000`).
