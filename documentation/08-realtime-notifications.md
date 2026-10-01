# 08 — Real-Time Notifications (Phase 5)

Phase 5 delivers live inbox updates via **Server-Sent Events (SSE)**. Because the dashboard runs as a single `next start` process, an in-process `EventEmitter` hub is sufficient — no Redis/pub-sub needed yet.

## Components

### `apps/dashboard/lib/realtime-hub.ts` — the hub
- A singleton `RealtimeHub` wrapping a Node `EventEmitter`.
- `subscribe(orgId, cb)` → registers a listener on the shared channel, returns an unsubscribe fn.
- `publish(orgId, event)` → emits `{ ...event, orgId, ts }` on the shared channel.
- Payload shape: `{ type, orgId, conversationId?, message?, contactId?, channelType?, ts }`.

> Note: listeners are not filtered by org inside the hub — the SSE endpoint subscribes with a callback that is wired per org when the connection is established; the `orgId` is carried in the payload for the client.

### `apps/dashboard/app/api/stream/events/route.ts` — the SSE endpoint
- `GET /api/stream/events`, `dynamic = 'force-dynamic'`.
- Auth: `getScopedClient()` (cookie → user → org). Unauthorized → 401.
- On connect, sends `event: connected` with `{ orgId }`.
- Subscribes to the hub for that org; emits `needs_attention` events (payload passed through) or `event` for other types.
- Sends `: keep-alive` comment every 15s.
- Cleans up on `request.signal` abort (clears interval, unsubscribes, closes controller).
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

## Publishers

| Source | Event type | Payload |
|---|---|---|
| `POST /api/webhooks/chatwoot` (inbound message) | `needs_attention` | `{ conversationId, message, contactId, channelType }` |
| `POST /api/webhooks/whatsapp` (inbound message) | `needs_attention` | `{ conversationId, message, contactId, channelType: 'whatsapp' }` |
| `POST /api/conversations/:id/messages` (new message, if `channel_id`) | `needs_attention` | `{ conversationId, message, contactId, channelType }` |
| `PATCH /api/conversations/:id` (status/employee change) | `conversation_updated` | `{ conversationId, channelType }` |

## Inbox UI integration (`apps/dashboard/app/(dashboard)/conversations/page.tsx`)

- Opens an `EventSource` to `/api/stream/events` (with the session cookie — same-origin, so cookies are sent automatically).
- Listens for `connected` (marks the stream live) and `needs_attention` events.
- On `needs_attention`: auto-selects the conversation, refreshes the feed, and shows an amber "Needs Attention" toast/badge.
- On `conversation_updated`: refreshes the conversation list (status pill updates).
- The connection is closed when the component unmounts.

## Limitations & notes (important for future work)

- **Single-process assumption:** the hub is in-memory. If the dashboard is ever scaled to multiple instances, `publish` and `subscribe` will not see each other — move to Redis pub/sub (or similar) with the hub behind an interface.
- **No auth token in the URL:** the SSE endpoint relies on the session cookie. If the session expires mid-stream, the stream just keeps serving the (now-stale) org; there's no mid-stream 401.
- **Firewalls/proxies:** `X-Accel-Buffering: no` prevents nginx buffering; a reverse proxy should not buffer SSE.
- **Check scripts** verify the full flow: register → login → open SSE → send Chatwoot webhook → assert `needs_attention` received. See `09-verification-checks.md`.

## Manual verification

```bash
# From repo root, after `docker compose up -d` (infra/):
# 1. Register/login to get a session cookie (see check-auth-nango.js for pattern)
# 2. Open an SSE client, e.g.:
curl -N -H "Cookie: darex_session=<userId>; darex_org_id=<orgId>" http://localhost:3000/api/stream/events
# 3. POST a signed chatwoot webhook (see check-phase3.js) and watch `needs_attention` arrive
```
