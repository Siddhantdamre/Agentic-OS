# Working / Fixed — as of 2026-08-25

Source: `docs/current-working/13-what-works.md` (2026-08-14, commit `334b52c`) verified still
current, plus commits `73b0451`..`855b646` (2026-08-14 to 2026-08-15), plus a fresh `tsc --noEmit`
and TODO/FIXME grep run today (2026-08-25).

## Freshly fixed since the last audit (2026-08-14 → 2026-08-15)

- **Langfuse worker Redis timeout** — `infra/docker-compose.yml` socket timeout was too low,
  killed idle blocking queue connections. Fixed `855b646`. Closes the "ClickHouse persistence
  flaky" item from the prior known-gaps list.
- **Dashboard port hardcoded in auth check script** — `check-auth-nango.js` hit `localhost:3000`
  unconditionally; now reads `DASHBOARD_PORT`. Fixed `e04a52d`.
- **`tsc --noEmit` failing on jest-dom matchers** — `tsconfig.json` lacked a `types` array so
  `toBeInTheDocument` etc weren't picked up; added pre-push typecheck guard. Fixed `4966b9a`.
  Verified today: `npx tsc --noEmit` in `apps/dashboard` runs clean, no output/errors.
- **Memory write-back embedding pipeline silently no-oping** — `litellm/config.yaml` had no
  embedding route; added `text-embedding-3-small` → Gemini `gemini-embedding-001`. Fixed
  `ea2740c`.
- **Ask AI JSON leak / Brain search 500s / raw markdown in inbox / demo action validation** —
  `sanitizeAgentReply` now unwraps the bare-tag `reply — {...}` envelope some models emit.
  Fixed `89d4f04`.
- **Security, correctness, Docker build bugs across API routes/services/setup scripts** —
  includes OAuth/SSO callback CSRF bypass when state cookie missing, WhatsApp webhook WABA-id
  fallback matching wrong field. Fixed `e06db75`.
- **`AutonomousActionConsole` missing error state** — `useState` for error referenced but never
  initialized, broke TS build. Fixed `85334dd`.
- **Stats endpoint syntax errors** — fixed `0b2933d` / `73b0451`.
- **Local/docker stack startup** — health-check auth, bad pin, bake bug, empty-array crash all
  fixed `15cf0af`.

## Fixed today (2026-08-25)

- **`updatePlan` failures silently swallowed** — `apps/dashboard/app/api/ask-ai/execute/route.ts:313,317,323`
  wrapped DB writes in `.catch(() => {})`; a failed write left `agent_plans.current_step`/`status`
  desynced from what the SSE stream told the client. Now logs the error (`console.error`) on
  failure instead of a bare no-op.
- **Rollback failure swallowed, connection could return to pool in unknown state** —
  `services/workflows/src/tools/database.ts:42` (`ROLLBACK.catch(() => {})`) and
  `services/workflows/src/tools/shared.ts` (`withOrgScopedClient`). Now logs on rollback failure
  and, when it fails, destroys the connection (`client.release(err)`) instead of returning it to
  the pool.
- Verified: `tsc --noEmit` clean on both `apps/dashboard` and `services/workflows` after the change.
- **Langfuse per-step/summary trace failures now logged** — `execute/route.ts:308,339` were bare
  `.catch(() => {})`; now `console.debug` on failure so a recurrence of the 08-15 Langfuse Redis
  issue is visible in logs instead of invisible.
- **4 bare `catch {}` in Ask AI page logged** — `ask-ai/page.tsx:176,828,848,873` (session fetch,
  plan cancel, step toggle, add instruction). These are still fire-and-forget by design (UI already
  updated optimistically), but failures now `console.error` instead of vanishing, so a server/UI
  desync is diagnosable.
- **Stale hermes doc reference removed** — `documentation/10-features-roadmap.md` cited
  `apps/dashboard/app/api/agent/hermes/route.ts` as broken; the route was already deleted, doc just
  hadn't caught up. Removed the stale line.
- **"Migrations need manual run" was a stale note, not a real gap** — confirmed `start.sh` already
  calls `infra/db/migrate.js` idempotently (tracked via `_migrations` table) on every boot, so a
  fresh DB provisioned before 009–011 gets them automatically on next `./start.sh`.

## Verified working today (2026-08-25)

- `npx tsc --noEmit -p apps/dashboard/tsconfig.json` — clean, zero errors.
- Grep for `TODO|FIXME|XXX|HACK|not implemented|known gap|flaky` across `apps/`, `services/`,
  `packages/` (excluding `node_modules`, `.next`, tests) — only 6 hits, all benign: one honest
  "not implemented yet" message string in `integrations/test/route.ts`, a regex literal matching
  the word `xxxx` as a placeholder-secret pattern, and 3 docstring mentions of `spaces/xxx` in
  Google Chat/Meet tool descriptions. No real TODO debt.
- `pnpm pull` fast-forwarded clean, no conflicts.

## Everything below still holds (verified 2026-08-14, unchanged by later commits)

**Platform** — full Docker stack (Postgres, Temporal, Redis + dedicated Langfuse Redis, Nango,
Langfuse, SuperTokens, LiteLLM, atomic-agent, MCP bridge, worker, dashboard, inbox, sandbox);
`pnpm build` green; Phase checks 0=17/17, 2=17/17, 3=6/6, auth+Nango=3/3.

**Auth & tenancy** — SuperTokens/Postgres scrypt login, per-user org creation, RLS FORCE +
WITH CHECK (migration 008), invites, body `org_id` rejected on org APIs.

**Ask AI** — classifier → simple stream (~6s) or complex plan → approve → SSE execute (~13s);
plan failure falls back to direct agent; daily session key; org grounding in user message.

**Agent runtime** — atomic-agent v0.1.72 SSE, MCP bridge (62+ tools), `AutonomousAgentWorkflow`
(max 3 durable turns), `CrewWorkflow` (up to 3 child agents), tool allowlist = union of active
employees + connected channels + core tools.

**Tools live-verified**: `database_query`, gmail fetch/compose/send, google-docs, google-sheets,
google-drive, google-calendar, `web_search`/`web_extract` (Jina), `code_execution` (python/node,
bash when image built), github, zoho_crm, quickbooks, leegality, whatsapp send (until token
expiry — see broken.md), instagram DM, file_ops, `database_list_tables`, `analytics_report`.

**Inbox/realtime** — conversations CRUD, WhatsApp inbound persist+SSE+agent, Chatwoot HMAC
ingest + fireInboundAgent, SSE `needs_attention` E2E.

**Integrations/OAuth** — Nango source of truth, real connection ids, WhatsApp BYOK, Zoho/QBO/
Razorpay/Leegality per-org creds in `channels.meta`.

**Product UI** — Home KPIs from SQL, Employees/Listings/Showings/Rent-reminders/Live-evals,
Conversations, Analytics (real aggregates), Integrations, Connectors test, Settings, Billing
dashboard, Langfuse ingestion schema fixed.

**Security & compliance** — RBAC, audit logs, DSR export/delete, HITL gate on send/pay/sign,
encrypted org credentials, RLS isolation.

**Real estate domain** — listings CRUD, showings, rent flow, live eval, SMS/email inbound,
Temporal scheduled tasks.

**Memory & RAG** — pgvector tables, ingest/retrieve/write-back workflows (write-back embedding
now fires — see fix above), M6 eval metrics.

**Billing** — subscriptions, meters, checkout, webhooks, invoices, self-serve portal.
