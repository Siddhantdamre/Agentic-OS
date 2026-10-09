# Darex — Agent Context

> Read this file first. It is the map of the whole repo. Darex is the "brain of
> the organization": a multi-tenant AI-employee SaaS where AI employees answer
> business questions, act on connected tools (Gmail, Calendar, HubSpot, WhatsApp,
> SQL, etc.) and confirm before running multi-step plans.

---

## 1. Command Cheat-Sheet

```bash
pnpm install            # install all workspace deps
pnpm infra:up           # boot Postgres/Temporal/Nango/Langfuse/LiteLLM/TrueForge/mcp-bridge via docker
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
  app/api/agent/      Direct TrueForge agent run/stream/tools + crew spawn
  app/api/webhooks/   WhatsApp + Chatwoot inbound webhooks → Temporal agent
  app/api/conversations|integrations|employees|settings|analytics|dashboard
  lib/                db.ts (pool + getScopedClient RLS), classify.ts, plan-generator.ts,
                      crew-planner.ts, litellm-client.ts, nango-*.ts, supertokens.ts,
                      realtime-hub.ts, langfuse-trace.ts
services/workflows    Temporal worker + shared agent runtime (imported by dashboard via dist/)
  src/agent-client.ts          Canonical entrypoint for TrueForge agent turns + execution
  src/trueforge-client.ts      TrueForge HTTP SSE harness client
  src/local-turn.ts            In-process @truefoundry/trueforge-core execution engine
  src/tool-executor.ts         62 real connector+DB+web tool executors (+ per-org allowlist)
  src/mcp-bridge.ts            SSE MCP server :8790 exposing 62 mcp.darex.* tools to TrueForge
  src/workflows/               AutonomousAgentWorkflow + CrewWorkflow (child spawns, cap 3)
services/connectors   Nango-based connector SDK (mostly used by /integrations/test diagnostic)
packages/whatsapp-gateway  Swappable WhatsApp transports (meta-cloud, evolution/QR); see its README to add or replace one
packages/shared-types Shared TS types
infra/                docker-compose.yml, db/migrations + init, litellm config, scripts
NEW-FRONTEND/         The live site UI (Next.js). Separate git repo (agentic-os-frontend,
                      branch feat/new-frontend), gitignored here. Proxies /api/* to the
                      dashboard; its own docs are in NEW-FRONTEND/docs (BACKEND-WIRING.md, status.md)
deploy/               deploy.sh (one-run server setup + deploy), redeploy.sh, prod compose overlay,
                      Caddyfile.example, env.production.example
```

The dashboard (`apps/dashboard`) is now the API and auth backend. Users see
`NEW-FRONTEND`, served on `127.0.0.1:3100` in production behind Caddy/nginx. See
`deploy/README.md`. The production server (Azure Spot VM shared with two other
projects, ports, risks, tuning) is described in `deploy/SERVER.md`.

### Data flow (Ask AI)
`ask-ai/page.tsx` → `POST /api/ask-ai` → `classifyRequest` (LiteLLM or heuristics) →
- **simple**: SSE stream → `runAutonomousAgentDirect` → TrueForge agent loop → MCP bridge `mcp.darex.*` (or in-process tools) → `executeAutonomousToolAction` → real API / honest `notConnected` → chunks + `tool` events stream to the page.
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
6. **LLM calls**: use `litellm-client.ts` for plain JSON completions; use `agent-client.ts` only for agent loops. Always pass timeouts; reasoning is disabled where only the final answer matters.
7. **Security**: never accept body `org_id`, validate webhook signatures, keep secrets out of git (`.env*` is gitignored), don't store plaintext tokens if avoidable.

## 4. Status (2026-10-01)
- **Since 09-27:** most P0/P1 rows in `gap26sept/` are verified closed in code (usage cap on direct agent routes, SSO fail-closed, widget gate, live refresh through the shared SSE hook on every tab, work-item create/reassign, per-employee metrics and approval rate, audit filters). The new frontend is wired to the backend. A platform console (users, audit, team, disable user, migration 206) exists. `deploy/deploy.sh` sets up a fresh server in one run, deploys the backend and the frontend, binds all prod ports to loopback only, and stops on port clashes. Details and what was not verified: `BUILD_STATE.md`.
- Phases 0–5 are complete. Ask AI plan-confirm-execute, roster routing, crew-from-chat (cap 3), parallel agent threads, readable tool results, and connector sign-in from the chat are all live. See the top of `BUILD_STATE.md`.
- Agent runtime = **TrueForge** (`@truefoundry/trueforge-core` v0.2.0-rc.0 in-process engine & HTTP sidecar) via MCP bridge — NOT LangGraph/atomic-agent anymore.
- The three blueprint employees (Growth, Customer, Operations) have their engines, workflows, and periodic sweeps in `services/workflows/src/{growth,customer,operations}` and `activities/`.
- Known manual items:
  - real OAuth client IDs for some providers in the Nango UI (HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Microsoft, Salesforce)
  - `NEXT_PUBLIC_NANGO_PUBLIC_KEY`
  - Meta token rotation
  - a licensed MLS API client
- The runtime defaults to `DB_USER=darex_app`. Migrations still run as superuser `darex`.

## 4a. Where we are going: read before picking up work

**Product direction.** DareXAI One is an autonomous AI workforce. Specialised AI employees (Growth, Customer, Operations, plus the roster: Executive, Customer Support, Sales & Lead Gen, Marketing & Analytics, Research, Finance, and org-custom employees) share one brain (memory + connectors). They work 24/7 and escalate *decisions, not conversations*. The **Ask AI chat is the front door**: anything a user can do on any tab, and anything any connected tool can do, must be doable by asking in the chat. It must reach the right employee, call real tools, and require approval for risky actions.

**Planning corpus.** Code wins on *what exists*. The plans win on *what to build next*.

| Path | What it is | Use it when |
|---|---|---|
| `docs/plan/` | Path from the Aug baseline to the "AI Brain OS": exec summary, gap analysis, target architecture, principles (`04-principles-and-constraints.md`), 14 workstreams, phases (immediate → complete), build order, definition of done | Planning a phase, or checking a change fits the target architecture |
| `docs/new-109-pg-plan/DareXAI One_ Employee Blueprint.{md,pdf}` | The 106-page product blueprint (source of truth for employee behaviour) | Deciding what an employee *should* do |
| `docs/new-109-pg-plan/plan/` | Blueprint turned into engineering specs: Growth (01), Customer (02), Operations (03), Connect layer (04), state machines + DDL (05), gap bridge (06) | Implementing employee features, FSMs, schemas |
| `docs/new-109-pg-plan/3-employee.md` | Plain-English feature table per employee (GE-/CE-/OE- IDs) with status and code module | Checking a specific employee feature's status |
| `docs/new-109-pg-plan/gap/` | Earlier gap audit + `IMPLEMENTATION-TRACKER.md` (mostly closed; see `BUILD_STATE.md`) | History and design decisions (`11_design_decisions_deep.md`, `18_security_and_governance.md`, `19_agent_loop_architecture.md`, `20_memory_and_learning.md`) |
| `docs/new-109-pg-plan/gap26sept/` | **Current** per-tab gap audit (2026-09-26): `00-summary.md` (P0/P1/P2 roll-up), `00-workspace-connectivity.md` (cross-tab wiring), one file per domain with a Live Resolution Tracker | **Start here for any fix.** Read the domain file, not just the summary |
| `docs/new-109-pg-plan/{competitors,payment,pitch-deck}/` | Business context: competitors, pricing plans, funding, deck | Pricing, packaging, and positioning questions only. Not engineering specs |
| `docs/current-working/` | Aug snapshot of the live system (partly stale; `BUILD_STATE.md` is newer) | E2E flow walkthroughs |

**Active work (2026-09, branch `feat/close-109-plan-gaps`):**
1. Close every open row in `gap26sept/*.md`, in P0 → P1 → P2 order:
   - P0: autonomy tier UI + approve/reject, DSR UI with async delete/export, real observability metrics (no fake-healthy stubs), audit-log emit coverage + append-only, org-tenancy leftovers
   - P1: plans history + edit params, wiring `employee-gate`/`employee-metrics`, customer.md rows, one shared SSE hook, one canonical approval table (schema change: ask first), metrics keyed on employee UUID, one automation-rate formula
2. **Chat coverage:** a capability matrix (`gap26sept/chat-coverage.md`) with one row per tool and per tab action, each proved live from `/ask-ai`.
3. **AI employees in chat:** each employee owns and fully performs its own job, with per-employee specs in `gap26sept/employees/<role>.md` (capabilities, allowlist, persona, memory scope, hand-offs). The chat gets a mode selector:
   - **Auto** (router picks and shows why)
   - **Pick one** (thread locked to one employee; out-of-scope requests get a hand-off offer)
   - **Team** (up to 3 chosen employees run as a crew)

   The mode persists per conversation and is validated server-side, and `@Name` overrides it for one message. Picking an employee never widens its allowlist.
4. Anything that needs a human (OAuth IDs, keys, licences) is marked 🔴 Blocked with a reason. Never fake it.

`COMPLETE_SAAS_PROMPT.md` (repo root) is the orchestration prompt for this work: a lead agent that runs subagents in waves. `RUN_AND_TEST_PROMPT.md` is the full-stack browser-test prompt.

**Working loop for any task:**
1. Find the matching `gap26sept/<domain>.md` row, or blueprint section.
2. Confirm the gap still exists in code.
3. Fix it, then verify: typecheck, tests, and live in the browser.
4. Update that doc's tracker row and `BUILD_STATE.md` in the same commit.

## 5. Inspect / Debug
- `BUILD_STATE.md` — live source of truth, per-phase decisions & gotchas.
- `graphify-out/GRAPH_REPORT.md` + `graph.html` — knowledge graph of the corpus.
- `infra/scripts/check-phase*.js` — E2E/health probe scripts.
- `documentation/` (00–10) — standalone technical docs.

---

## 6. Git Commit Workflow

Full rules live in `CLAUDE.md` §1-3 (attribution, one concern per commit, branch and push). Short form: Conventional Commits `<type>(<scope>): <what>`, one feature per commit, stage paths explicitly, never commit secrets, never rewrite shared history.
