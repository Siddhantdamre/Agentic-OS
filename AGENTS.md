# Darex — Agent Context

> Read this file first. It is the map of the whole repo. Darex is the "brain of
> the organization": a multi-tenant AI-employee SaaS where AI employees answer
> business questions, act on connected tools (Gmail, Calendar, HubSpot, WhatsApp,
> SQL, etc.) and confirm before running multi-step plans.

---

## 1. Command Cheat-Sheet

```bash
pnpm install            # install all workspace deps
pnpm infra:up           # boot Postgres/Temporal/Nango/Langfuse/LiteLLM/atomic-agent via docker
pnpm db:migrate         # apply infra/db/migrations/*.sql in order
pnpm dev                # dashboard (Next.js) only
pnpm dev:all            # turbo run dev (all workspaces)
pnpm build              # turbo run build
pnpm lint / pnpm test   # turbo run lint / test
```

Quick per-workspace commands:
- `pnpm --filter @darex/dashboard exec tsc --noEmit`
- `pnpm --filter @darex/workflows exec tsc --noEmit`

## 2. Architecture Map

```
apps/dashboard        Next.js app server (API routes in app/api, lib/, components/)
  app/api/ask-ai/     Classify → plan-confirm-execute flow (streaming NDJSON)
  app/api/agent/      Direct atomic-agent run/stream/tools + crew spawn
  app/api/webhooks/   WhatsApp + Chatwoot inbound webhooks → Temporal agent
  app/api/conversations|integrations|employees|settings|analytics|dashboard
  lib/                db.ts (pool + getScopedClient RLS), classify.ts, plan-generator.ts,
                      crew-planner.ts, litellm-client.ts, nango-*.ts, supertokens.ts,
                      realtime-hub.ts, langfuse-trace.ts
services/workflows    Temporal worker + shared agent runtime (imported by dashboard via dist/)
  src/atomic-agent-client.ts   OpenAI-compatible SSE client → atomic-agent :8787
  src/tool-executor.ts         62 real connector+DB+web tool executors (+ per-org allowlist)
  src/mcp-bridge.ts            SSE MCP server :8790 exposing 62 mcp.darex.* tools to atomic-agent
  src/workflows/               AutonomousAgentWorkflow + CrewWorkflow (child spawns, cap 3)
services/connectors   Nango-based connector SDK (mostly used by /integrations/test diagnostic)
packages/shared-types Shared TS types
infra/                docker-compose.yml, db/migrations + init, litellm config, scripts
```

### Data flow (Ask AI)
`ask-ai/page.tsx` → `POST /api/ask-ai` → `classifyRequest` (LiteLLM or heuristics) →
- **simple**: SSE stream → `runAutonomousAgentDirect` → atomic-agent loop → MCP bridge `mcp.darex.*` → `executeAutonomousToolAction` → real API / honest `notConnected` → chunks + `tool` events stream to the page.
- **complex**: `generatePlan` → `agent_plans` row → page shows PlanCard → `PATCH approve` → `GET /api/ask-ai/execute` SSE runs steps (independent steps run in **parallel** via stageSteps), then `execution_done`.

### Data flow (Webhook)
WhatsApp inbound → persist message + conversation (fast) → return 200 immediately → fire-and-forget Temporal `AutonomousAgentWorkflow` (or direct) → AI reply saved + sent back. Inbound is **always solo** — never auto-spawns a crew.

### Data flow (Crew spawn)
`employees/page.tsx` CrewSpawnPanel → `POST /api/agent/crew` → `planCrew` (LiteLLM JSON, heuristic fallback) → Temporal `CrewWorkflow` (or `runCrewDirect`) → up to 3 child `AutonomousAgentWorkflow`s in parallel → manager synthesis. Cap 3. Greetings stay solo.

## 3. Key Rules / Conventions

1. **Tenancy**: every table has `org_id`; RLS enforced at DB. `getScopedClient()` sets `app.current_org_id` at **session level** and resets on release. Never trust an `orgId` from the request body — resolve from the session.
2. **Never await an agent/model call inline in a webhook** — return 200 first, then fire-and-forget Temporal.
3. **Never deadlock the DB pool** (`max:10`) — release pooled clients before opening SSE streams / slow calls.
4. **Never fabricate data** — missing OAuth connector → return `status:'error'` + `connected:false` + `/connectors` URL, don't pretend.
5. **Env-driven config only** — every URL/key/model has `process.env.X`; prod must fail-fast, no dev-key fallbacks in shipped code.
6. **LLM calls**: use `litellm-client.ts` for plain JSON completions; use `atomic-agent-client.ts` only for agent loops. Always pass timeouts; reasoning is disabled where only the final answer matters.
7. **Security**: never accept body `org_id`, validate webhook signatures, keep secrets out of git (`.env*` is gitignored), don't store plaintext tokens if avoidable.

## 4. Status (2026-08)
- Phases 0–4.6 and Phase 5 (real-time delivery) complete; Ask AI plan-confirm-execute live.
- Agent runtime = **atomic-agent** (external, v0.1.72) via MCP bridge — NOT LangGraph/Hermes anymore.
- Known manual items: real OAuth client IDs for some providers in Nango UI; Meta token rotation. Runtime defaults to `DB_USER=darex_app`; migrations still run as superuser `darex`.

## 5. Inspect / Debug
- `BUILD_STATE.md` — live source of truth, per-phase decisions & gotchas.
- `graphify-out/GRAPH_REPORT.md` + `graph.html` — knowledge graph of the corpus.
- `infra/scripts/check-phase*.js` — E2E/health probe scripts.
- `documentation/` (00–10) — standalone technical docs.