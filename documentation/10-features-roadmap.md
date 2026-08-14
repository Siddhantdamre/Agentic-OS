# 10 — Features & Phase Roadmap

Status mirrors `BUILD_STATE.md` (the authoritative log). Phase numbering follows `darex-ai-employee-platform-build-spec.md`.

## Phase status

| Phase | Description | Status |
|---|---|---|
| 0 | Foundations — infra scaffold (Postgres/pgvector, Temporal, Redis, Nango, Langfuse, LiteLLM, SuperTokens, inbox, atomic-agent, bridge, worker, dashboard) | ✅ **Complete** (Phase 0 check 17/17) |
| 1 | Multi-tenant core (SuperTokens auth + per-user org provisioning + RLS) | ✅ **Complete** (auth 3/3) |
| 2 | Connector layer (Nango OAuth, 7 integrations + test proxy + webhook ingestion) | ✅ **Complete** (Phase 2 check 17/17) |
| 3 | Conversation ingestion (chatwoot/whatsapp webhooks → conversations/messages, inbox gateway, human reply, feed + stats) | ✅ **Complete** (Phase 3 check 6/6) |
| 4 | Agent harness (atomic-agent replaces LangGraph; MCP bridge 24 tools; Ask AI; per-employee run; memory fabric) | ✅ **Complete** (direct + Temporal E2E verified) |
| 4.5 | Security audit (RLS forced, HMAC webhook signatures, tool allowlists, read-only DB tool) | ✅ **Complete** |
| 5 | Durability + Real-Time Delivery (Temporal workflows + SSE realtime hub + inbox UI live updates) | ✅ **Complete** (SSE E2E verified) |
| 6 | Memory & RAG (pgvector-backed org memory, embeddings) | 🔜 **Not started** |
| 7 | Insight & Analytics engine (aggregations, insight cards, analytics page) | 🔜 **Not started** |
| 8 | Observability, security, scale hardening (multi-instance realtime, prod Terraform, alerting) | 🔜 **Not started** |
| 9 | Polish & launch readiness (onboarding wizard polish, mobile, a11y, billing) | 🔜 **Not started** |

## What is already implemented (so you don't rebuild it)

- **Multi-tenant auth** with SuperTokens + Postgres fallback, per-user org auto-provisioning, RLS-forced isolation on every tenant table.
- **Channel ingestion** for Chatwoot-format webhooks and real Meta WhatsApp webhooks (org resolution by channel meta, conversation upsert, message insert, `channel_logs` audit, HMAC signature enforcement).
- **Inbox gateway** container (:3004) proxying inbound webhooks to the dashboard.
- **Atomic agent runtime**: pinned atomic-agent v0.1.72 with 3 LLM providers (OpenRouter active), MCP tool bridge (:8790) exposing 24 org-scoped tools (WhatsApp, Gmail, Calendar, GitHub, HubSpot, Meta/Google Ads, Slack, Notion, Stripe, Shopify, Zendesk, Intercom, Razorpay, web search/extract, read-only DB query, file ops), memory fabric (notes/reflection/profile) enabled.
- **Agent invocation** three ways: Ask AI (direct, per-user daily session), Agent Run (Temporal → direct fallback), WhatsApp webhook auto-reply (Temporal → direct fallback + real Meta send).
- **Durability**: Temporal server + worker + `AutonomousAgentWorkflow` (run turn, log activity, save assistant message) with 3× retry.
- **Real-time**: SSE endpoint `/api/stream/events`, in-process hub, `needs_attention`/`conversation_updated` publishers in webhooks + message POST + conversation PATCH, inbox UI EventSource + toast.
- **Observability**: Langfuse tracing for Ask AI + agent runs; `channel_logs` for every connector/webhook/send action.
- **Verification**: Phase 0/2/3 + auth + E2E check scripts, all green.

## Features to be implemented

### Phase 6 — Memory & RAG
- Org-scoped memory backed by `pgvector` (the `vector` extension is already enabled; `ai_employees` persona + atomic-agent memory exist but are agent-side, not cross-session RAG over business data).
- Embeddings pipeline (OpenRouter/Groq embeddings or a local embedder) to index conversations/documents; retrieval-grounded answers in Ask AI / agent runs.
- Long-term customer memory per contact/conversation.

### Phase 7 — Insight & Analytics engine
- Aggregation service over `conversations`/`messages`/`channel_logs` for: total conversations, avg response time, % needing human review, CSAT, per-employee stats (conversations today, qualified leads, meetings booked).
- Insight cards pairing diagnosed problems with recommended actions; "Review Action →" triggering real Temporal workflows (spec: enqueue automated follow-up).
- Analytics page (Tremor/Recharts trend charts, filter by employee/channel/date range).

### Phase 8 — Observability, security, scale hardening
- **Multi-instance realtime**: replace in-process `realtimeHub` with Redis pub/sub so multiple dashboard instances share events (today it works only for a single `next start` process).
- Production Terraform (`infra/terraform/` is an empty placeholder), secrets management (real keys, not dev defaults), HTTPS/TLS, DB backups.
- Rate limiting on webhooks, CSP, audit logging, alerting on Langfuse/Temporal.

### Phase 9 — Polish & launch readiness
- Onboarding wizard (/onboarding/*: name → team size → business type → channels) per the Figma + frontend-architecture doc.
- Mobile/responsive (sidebar → bottom tab bar, panels → drawers, 2x2 stat grids).
- Accessibility (aria-labels on icon sidebar, `aria-live` for SSE streams, non-color status indicators).
- Billing/payments (Razorpay/Stripe), org settings polish, employee provisioning UI.

## Open items / known limitations

1. **`META_ACCESS_TOKEN` expired** (session ended 2026-06-12). Must be rotated for real outbound WhatsApp sends and for `e2e-live-llm.js` to pass steps 2–5.
2. **`apps/dashboard/app/api/agent/hermes/route.ts` is broken** — it imports `@/lib/db`, `@/lib/hermes-agent`, `@/lib/langfuse-trace`; `@/lib/hermes-agent` doesn't exist (LangGraph removed). Either delete it or rewire it to the atomic-agent client.
3. **`apps/agents/` is a legacy placeholder** (LangGraph plan) and `packages/shared-types` is mostly placeholder. Do not build on either without a plan.
4. **Connector real accounts:** Google Ads/Shopify/Zendesk/Razorpay env values are empty; integrations connect + stats show, but live tool calls for those return `not_connected` until real OAuth accounts are wired.
5. **Web search** needs `EXA_API_KEY` for the Exa provider; without it atomic-agent's web search falls back to DuckDuckGo (per `render-config.mjs`).
6. **RLS `WITH CHECK` policies** are not defined on tenant tables (FORCE RLS + USING only). Inserts work because the session passes the USING org_id comparison, but adding explicit `WITH CHECK` is a hardening item.
7. **SSE mid-stream session expiry** isn't handled (no 401 push on session loss).

## Design rules to preserve (from spec Rule 7 / decisions)

- **An employee is a config + an agent graph + a tool allowlist.** Adding a new employee role requires zero changes to connector/durability/memory layers.
- Every table has `org_id` + RLS policy; every external side-effect is an idempotent Temporal activity (or logged).
- Clone, don't rebuild: Chatwoot, Nango, Temporal, Langfuse. Build fresh: agent harness, dashboard, insight engine.
- atomic-agent drops the `system` role — keep org grounding in the **user** message (`buildGroundedUserMessage`).
- Never fabricate IDs/random IDs for `chatwoot_conv_id`/`chatwoot_msg_id`; keep them null or use real values (migration 006 made `chatwoot_msg_id` text to fit Meta's `wamid.*`).
