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
| Razorpay | Env empty **and** no per-org `channels.meta` keys |
| web_search reliability | `JINA_API_KEY` required (no fake results) |
| Meta production webhook | Must set URL in Meta Developer Console |

## Code / repo holes

| Item | Detail |
|------|--------|
| **Insight page** | Rule templates, not an insight engine (Phase 7). |
| **Realtime scale** | In-process EventEmitter; one Next.js process (Phase 8). |
| **Langfuse persistence** | Ingestion OK; ClickHouse can still be flaky (dedicated Redis now). |
| **Hermes leftover in roadmap** | `documentation/10` still cites deleted hermes route. |
| **Migrations 009–011** | Operator must `pnpm db:migrate` on older DBs. |

## Not started (roadmap Phases 6–9)

- **Phase 6** Memory & RAG — **partial** (tables + retrieve + /brain; inbound parent activity still no-op).
- **Phase 7** Insight engine — **partial** (named-workflow enqueue exists).
- **Phase 8** Redis bus + PgBouncer **done**; Terraform/alerting scripts **partial**.
- **Phase 9** Packs + billing APIs **partial**; Darex PSP keys ops. Wave 2 RFC.

## Stale claims to ignore

| Old claim | Reality |
|-----------|---------|
| Hermes / LangGraph is the agent | Deleted; atomic-agent only |
| Slack/Notion/… “simulated by design” | Executors are real; they `notConnected` |
| 15 Docker services | **19** (added `langfuse-redis`; sandbox context in tree) |
| Migrations 001–006 only | 007–**011** exist (009 invites, 010 webhooks, 011 darex_app) |
| No WITH CHECK | Migration 008 |
| Web search needs `EXA_API_KEY` | Agent tools use **Jina** |
| WhatsApp webhook unwired (atomic Phase 5 ⬜) | Route is live; outbound token is the issue |
| `apps/agents/` exists | Directory gone |

## Security leftovers

- `ALLOW_DEMO_AUTH` auto-provisions OAuth users — keep off in prod.
- Pre-004 users have NULL `password_hash` (Postgres login path).
- SuperTokens works only if `SUPERTOKENS_API_KEY` matches compose `API_KEYS`.
- Rotate keys that live in gitignored `.env` files (OpenRouter, Groq, Gemini, Meta).
