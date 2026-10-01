# Internal services

These are not frontend APIs. The dashboard calls them from the server. A replacement UI should keep calling the `/api/*` routes in the other files in this folder.

## MCP bridge

Process: `services/workflows/src/mcp-bridge.ts`

Default listen address: `http://0.0.0.0:8790` (`MCP_BRIDGE_PORT`, falling back to `ATOMIC_BRIDGE_PORT`).

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/` | Liveness. `{ ok, server: "darex", tools, sse }`. |
| GET | `/health` | Readiness. Same fields plus `db` (`up` or `down`), session counts, and `uptimeSec`. **503** when the database probe fails. |
| GET | `/sse` | MCP server-sent events. One session per connection. Tenant comes from signed headers (`MCP_BRIDGE_SECRET`). Too many sessions returns **503**. |
| POST | `/messages?sessionId=` | MCP client message for an open SSE session. |

The bridge exposes the `mcp.darex.*` tools to the in-process TrueForge agent. Tool execution still goes through the workflow tool executor, which is what `/api/ask-ai` and `/api/agent/*` call. Do not point a browser at port 8790.

## Connectors

`services/connectors` is a library imported by the dashboard and the worker. It does not listen on a port.

## Inbox gateway

Process: `apps/inbox/src/index.ts`

Express app. Default port `3004` (`PORT`). Forwards Chatwoot traffic into the dashboard webhook routes. Not a browser API.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness. `{ status, service, timestamp, dashboardUrl }`. |
| POST | `/webhook/inbound` | Forwards the JSON body to `{DASHBOARD_URL}/api/webhooks/chatwoot` (optional `?org_id=` / `X-Darex-Org-Id`). Signs with `x-chatwoot-signature` when `CHATWOOT_WEBHOOK_SECRET` or `INBOX_GATEWAY_SECRET` is set. Returns `{ success, inboxGatewayLatencyMs, forwardedTo, dashboardResponse }`. |
| POST | `/api/inbox/send` | Forwards the JSON body to `{DASHBOARD_URL}/api/webhooks/outbound` with the same signature headers. Passes through the dashboard status and body. |

## Code sandbox

Process: `infra/docker/sandbox/server.mjs`

Isolated code-exec HTTP server used by the workflow tool executor (`SANDBOX_API_URL`). Default port `8080` (`SANDBOX_PORT`). Not a browser API.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/` | Liveness. `{ ok, service: "sandbox" }`. |
| GET | `/health` | Same as `/`. |
| POST | `/execute` | Body fields read: `language`, `code`, `timeoutMs`. Response `{ result: { ok, stdout, stderr, exitCode, error } }`. **429** when busy; **400** on missing/invalid payload. |
