# Split ingest host (I7) — documentation only

Wave 3 does **not** stand up Traefik or a second Next.js process. Webhooks
still terminate on the dashboard (`/api/webhooks/whatsapp`,
`/api/webhooks/chatwoot`) behind Caddy on the same host.

## Goal

Webhook p99 must not wait on Ask AI / LLM latency. That means a dedicated
ingest origin later (Caddy site or Traefik router) pointing at a process
that only persists + 200 + Temporal, never the agent loop.

## When to enable

1. A dedicated ingest worker or a dashboard route that cannot call the
   model (already true for webhook handlers — persist then fire-and-forget).
2. Then uncomment the `ingest.example.com` site in `deploy/Caddyfile.example`.
3. Point Meta / Chatwoot webhook URLs at `https://ingest.example.com/...`.

Until that process exists, leaving webhooks on `app.example.com` is correct.
Do not add a second MCP server or a second compose kernel to “split” ingest.
