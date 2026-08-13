# 10 — API reference (from code)

All under `apps/dashboard/app/api`. Org comes from session except public
webhooks. **Never** trust body `org_id`.

## Auth and org

| Method | Path | Real? | Notes |
|--------|------|-------|-------|
| GET | `/api/auth/session` | Yes | `{ authenticated, userId, email, role, orgId }` |
| GET | `/api/auth/logout`, `/signout` | Yes | Clear cookies |
| POST | `/api/auth/login` | Yes | SuperTokens then Postgres scrypt |
| POST | `/api/auth/register` | Yes | Creates org |
| GET | `/api/auth/oauth/[provider]` | Partial | Real if client IDs; demo if `ALLOW_DEMO_AUTH` |
| GET | `/api/auth/oauth/callback/[provider]` | Yes | Token exchange + upsert |
| POST | `/api/org/create` | Yes | Onboarding; rejects body `org_id` |
| GET/POST | `/api/org/onboarding` | Yes | Wizard state; rejects body `org_id` |
| POST | `/api/auth/forgot-password` | Yes | Creates hashed reset token |
| POST | `/api/auth/reset-password` | Yes | Consumes token |
| GET/POST | `/api/auth/invite/[token]` | Yes | Lookup / accept |

## Ask AI

| Method | Path | Real? | Notes |
|--------|------|-------|-------|
| POST | `/api/ask-ai` | Yes | Classify → complex JSON plan or simple NDJSON |
| GET | `/api/ask-ai` | Yes | Hydrate thread from `messages` + plans |
| GET | `/api/ask-ai/plan` | Yes | `?planId=` |
| PATCH | `/api/ask-ai/plan` | Yes | approve / cancel / toggle steps |
| POST | `/api/ask-ai/revise` | Yes | `reviseDraft` |
| GET SSE | `/api/ask-ai/execute` | Yes | Parallel steps via tool-executor |

## Agent

| Method | Path | Real? | Notes |
|--------|------|-------|-------|
| POST | `/api/agent/run` | Yes | Temporal then direct; may save messages |
| POST | `/api/agent/crew` | Yes | LiteLLM crew plan → Temporal `CrewWorkflow` (cap 3) or direct; inbound webhooks never call this |
| POST SSE | `/api/agent/stream` | Yes | Temporal then direct fallback |
| GET | `/api/agent/tools` | Yes | Session required |
| POST | `/api/agent/tools` | Yes | One `executeAutonomousToolAction` |

## Integrations

| Method | Path | Real? | Notes |
|--------|------|-------|-------|
| GET | `/api/integrations` | Yes | 27 apps; Nango-verified |
| POST | `/api/integrations` | Yes | connect requires real Nango; disconnect |
| GET | `/api/integrations/nango-token` | Yes | publicKey + connectionId |
| POST | `/api/integrations/nango-token` | Yes | Confirm after OAuth |
| POST | `/api/integrations/test` | Yes | 7 providers via `@darex/connectors` |
| POST | `/api/integrations/whatsapp` | Yes | BYOK Graph-verified into `channels.meta` |
| POST | `/api/integrations/razorpay` | Yes | Per-org verified keys |
| POST | `/api/integrations/webhooks` | Logger | Authenticated log only |

## Webhooks (public)

| Method | Path | Real? | Notes |
|--------|------|-------|-------|
| GET | `/api/webhooks/whatsapp` | Yes | Meta verify |
| POST | `/api/webhooks/whatsapp` | Partial | Inbound+agent yes; outbound Graph 401 if token expired |
| POST | `/api/webhooks/chatwoot` | Yes | HMAC ingest **and** starts agent |
| POST | `/api/webhooks/outbound` | Yes | Inbox human send-back; org from conversation |

## Realtime

| Method | Path | Real? | Notes |
|--------|------|-------|-------|
| GET SSE | `/api/stream/events` | Yes | In-process hub, one Node process |

## Domain

| Method | Path | Real? | Notes |
|--------|------|-------|-------|
| GET/POST | `/api/conversations` | Yes | POST can start agent |
| PATCH | `/api/conversations/[id]` | Yes | Session scoped |
| GET/POST | `/api/conversations/[id]/messages` | Yes | POST user/customer → agent |
| GET/POST | `/api/employees` | Yes | GET auto-seeds roster |
| PATCH/DELETE | `/api/employees/[id]` | Yes | |
| GET | `/api/employees/stats` | Yes | |
| GET/POST | `/api/settings` | Yes | Invite = `org_invites` + copyable URL; webhook URLs correct |
| GET | `/api/analytics` | Yes | Real aggregates + CSAT proxy |
| GET | `/api/dashboard/stats` | Yes | `getScopedClient` |
| GET | `/api/insight` | Partial | Rule templates parameterized by counts |
| GET | `/api/health` | Yes | `{ ok: true }` — no session |

## Deleted / do not use

- `app/api/agent/hermes/route.ts` — **gone**. Roadmap still mentions it.
- LangGraph / Hermes libraries — **gone**.
