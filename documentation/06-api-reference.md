# 06 — API Reference

All API routes live in `apps/dashboard/app/api/**/route.ts` unless noted. Authenticated routes use the `darex_session` cookie via `getScopedClient()` and return 401 when unauthorized. Webhook routes have their own auth (see `05-authentication-authz.md`).

## Auth (`/api/auth/*`)

Catch-all in `app/api/auth/[[...path]]/route.ts`.

| Route | Method | Auth | Body / Query | Returns |
|---|---|---|---|---|
| `/api/auth/signup` (or `register`) | POST | none | `{ email, password }` | `{ status:'OK', userId, email, orgId }` + sets `darex_session`, `darex_org_id` cookies |
| `/api/auth/login` (or `signin`) | POST | none | `{ email, password }` | same as above |
| `/api/auth/session` | GET | cookie | — | `{ authenticated, userId, email, role, orgId }` (401 if no/invalid session) |
| `/api/auth/signout` (or `logout`) | GET | cookie | — | 302 to `/login`, clears cookies |

## Conversations

| Route | Method | Auth | Body / Query | Returns |
|---|---|---|---|---|
| `/api/conversations` | GET | cookie | — | `{ conversations: [...], stats: {...} }` (thread list + live stats) |
| `/api/conversations/:id` | GET | cookie | — | single conversation (with messages?) |
| `/api/conversations/:id` | PATCH | cookie | `{ status, summary, ... }` | updated conversation; publishes `conversation_updated` to realtime |
| `/api/conversations/:id/messages` | POST | cookie | `{ content, role }` | `{ success, message }`; saves message, publishes `message_received` realtime event |

## Webhooks

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/webhooks/chatwoot` | POST | HMAC `x-chatwoot-signature` when secret set | Ingest channel messages (`message_created`), upsert conversation + message + `channel_logs`, publish `needs_attention` |
| `/api/webhooks/whatsapp` | GET | `hub.verify_token` == `VERIFY_TOKEN` | Meta challenge verification |
| `/api/webhooks/whatsapp` | POST | none (always 200) | Real Meta inbound: resolve org by channel meta, upsert conversation, run AI, send reply, log |

## Agent

| Route | Method | Auth | Body | Returns |
|---|---|---|---|---|
| `/api/agent/run` | POST | cookie | `{ userMessage, employeeId?, conversationId?, channelId? }` | `{ success, replyMessage, executedSteps, usedTools }` — tries Temporal, falls back to direct atomic-agent |
| `/api/agent/tools` | GET | cookie | — | list of available agent tools |
| `/api/ask-ai` | POST | cookie | `{ prompt }` | `{ answer, provider, usedTools, executedSteps, trajectory, proposedAction }` — direct atomic-agent, per-user daily session |
| `/api/agent/hermes/...` | — | — | **LEGACY/broken**: imports `@/lib/hermes-agent` which doesn't exist. Do not use. |

## Integrations / Connectors

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/integrations` | GET | cookie | list all integrations + per-org connection status/stats |
| `/api/integrations/whatsapp` | POST | cookie | connect WhatsApp (body `{ accessToken, phoneNumberId, wabaId }`), writes `channels` meta |
| `/api/integrations/test` | POST | cookie | proxy a connector action (whatsapp/gmail/calendar/hubspot/razorpay/meta-ads/google-ads); logs to `channel_logs` |
| `/api/integrations/webhooks` | POST | cookie | webhook ingestion into `channel_logs` |
| `/api/integrations/nango-token` | GET | cookie | get Nango token for a connection |
| `/api/auth/oauth/:provider` | GET | cookie | start Nango OAuth flow |
| `/api/auth/oauth/callback/:provider` | GET | cookie | OAuth callback |

## Employees

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/employees` | GET/POST | cookie | list / create AI employees |
| `/api/employees/:id` | GET/PATCH | cookie | get / update employee |
| `/api/employees/stats` | GET | cookie | per-employee stats |

## Dashboard / Insight / Analytics / Settings

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/dashboard/stats` | GET | cookie | home snapshot stats |
| `/api/insight` | GET | cookie | insight/diagnostics data |
| `/api/analytics` | GET | cookie | analytics data |
| `/api/settings` | GET/PATCH | cookie | org settings |
| `/api/org/create` | POST | cookie | create org |

## Realtime stream

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/stream/events` | GET (SSE) | cookie (`getScopedClient`) | Server-Sent Events: `connected` on open; then `needs_attention` / `event` events per org. 15s keep-alives. See `08-realtime-notifications.md`. |

## Inbox gateway (`apps/inbox`, Express, port 3004)

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | `{ status:'ok', service:'darex-inbox-chatwoot-gateway' }` |
| `/webhook/inbound` | POST | proxied → `http://localhost:3000/api/webhooks/chatwoot`; returns dashboard response + latency |
| `/api/inbox/send` | POST | stub outbound sender (`{ conversationId, channel, recipient, content }` → `{ success, status:'sent' }`; does not actually send) |

## atomic-agent (`http://localhost:8787`, OpenAI-compatible)

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | Streaming agent turn. Auth: `Authorization: Bearer $ATOMIC_AGENT_API_KEY`, header `X-Atomic-Extensions: on`. Body: `{ model, stream:true, session_id, messages:[system, user] }`. SSE events: `data:` chat deltas, `tool_progress` (tool + label), `session_id`, `error`, `[DONE]`. |

## atomic-bridge (`http://localhost:8790`)

| Endpoint | Purpose |
|---|---|
| `GET /sse` | MCP SSE server entrypoint (transport). |
| `POST /messages?sessionId=...` | MCP JSON-RPC messages for a connected session. |

Exposes 24 MCP tools under the `darex` server (see `07-agent-engine.md` for the full list).
