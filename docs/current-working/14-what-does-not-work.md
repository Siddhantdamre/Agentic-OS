# 14 — What does not work

Gaps in the **current tree**, not the original wish-list.

## Blocked by credentials / ops (code is ready)

| Item | Why |
|------|-----|
| WhatsApp **outbound** | `META_ACCESS_TOKEN` expired 2026-06-12 (Graph 401) |
| Gmail draft/send on old tokens | Need browser re-connect for `gmail.compose` |
| Google Drive (some orgs) | Still needs `/connectors` OAuth |
| HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Meta Ads | Placeholder OAuth client IDs in Nango UI `:3003` |
| Google Ads metrics | Needs `GOOGLE_ADS_DEVELOPER_TOKEN` + customer id |
| Razorpay | Env keys empty; not per-org Nango |
| web_search reliability | `JINA_API_KEY` required (no fake results) |
| Meta production webhook | Must set URL in Meta Developer Console |

## Code / repo holes

| Item | Detail |
|------|--------|
| **Sandbox Docker context missing** | Compose builds `infra/docker/sandbox`; directory **not in git**. Code-exec tools fail until restored. |
| **Custom skills not mounted** | 11 SKILL.md playbooks exist; Dockerfile does not COPY them. |
| **Google Analytics MCP** | `analytics_report` registered; executor `"Unhandled Google tool"`. |
| **Google Chat / Meet / Search Console / Business / Cloud** | In `/integrations` catalog; no executor. |
| **Intercom write** | Fetch only; no reply/create. |
| **Chatwoot → AI** | Ingest + SSE only. No `triggerAutonomousAgentWorkflow`. |
| **Inbox outbound** | `POST /api/inbox/send` returns success without sending. |
| **`/api/agent/stream`** | No direct fallback if Temporal is down. |
| **Temporal loop** | `priorToolResults` / `isDone` unused; 8-step loop inert. |
| **`idempotency_keys`** | Table exists; activities do not use it. |
| **Insight page** | Rule templates, not an insight engine. |
| **Settings invite** | Inserts user row; no email. |
| **Settings Meta webhook URL** | Points at `/api/webhooks/chatwoot` instead of WhatsApp. |
| **GET `/api/agent/tools`** | Unauthenticated catalog. |
| **Ask AI history** | localStorage, not `messages`. |
| **Realtime scale** | In-process EventEmitter; one Next.js process. |
| **DB user** | Still `darex` superuser; `darex_app` unused. |
| **Langfuse persistence** | Ingestion OK; ClickHouse via shared Redis is flaky. |
| **`packages/shared-types`** | Placeholder README. |
| **`apps/inbox` README** | Claims Chatwoot fork; code is a 70-line proxy. |
| **Hermes leftover in roadmap** | `documentation/10` still cites deleted hermes route. |

## Not started (roadmap Phases 6–9)

- **Phase 6** Memory & RAG — pgvector on, no embeddings pipeline.
- **Phase 7** Insight/analytics **engine** — pages exist with simpler SQL.
- **Phase 8** Redis pub/sub realtime, Terraform, HTTPS, alerting.
- **Phase 9** Mobile, a11y, billing. (Onboarding wizard already exists.)

## Stale claims to ignore

| Old claim | Reality |
|-----------|---------|
| Hermes / LangGraph is the agent | Deleted; atomic-agent only |
| Slack/Notion/… “simulated by design” | Executors are real; they `notConnected` |
| 15 Docker services | 18 |
| Migrations 001–006 only | 007 + 008 exist |
| No WITH CHECK | Migration 008 |
| Web search needs `EXA_API_KEY` | Agent tools use **Jina** |
| WhatsApp webhook unwired (atomic Phase 5 ⬜) | Route is live; outbound token is the issue |
| `apps/agents/` exists | Directory gone |

## Security leftovers

- `ALLOW_DEMO_AUTH` auto-provisions OAuth users — keep off in prod.
- Pre-004 users have NULL `password_hash` (Postgres login path).
- SuperTokens works only if `SUPERTOKENS_API_KEY` matches compose `API_KEYS`.
- Rotate keys that live in gitignored `.env` files (OpenRouter, Groq, Gemini, Meta).
