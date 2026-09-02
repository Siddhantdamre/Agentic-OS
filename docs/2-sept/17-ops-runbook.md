# 17 — Operations Runbook

Everything needed to boot, verify, diagnose, and recover the stack. Written so
someone who has never seen the repo can get to `ALL CHECKS PASSED`.

## 1. Boot

```bash
./start.sh
```

Builds images, boots compose, waits for Postgres, runs migrations, waits for the
dashboard health check, runs the phase-0 and auth/Nango probes, prints every
service URL. **`ALL CHECKS PASSED` is the only signal that means "working"** —
containers being up means nothing.

| Flag | Effect |
|---|---|
| `--dev` | Infra only; dashboard runs on the host via `pnpm dev` |
| `--no-build` | Skip image rebuild |
| `--seed` | Also run `db:seed` |
| `--checks` | Stack already running — re-verify only |
| `--down` | Stop compose, keep volumes |

## 2. The compose `--env-file` trap

**Never call `docker compose -f infra/docker-compose.yml ...` directly.**

Compose derives the project directory from the compose file's own folder
(`infra/`), so `${VAR}` interpolation resolves against `infra/.env`, not the
root `.env` you edited. Values silently fall back to their in-file defaults and
you get a stack that boots with the wrong ports and secrets.

Always go through `pnpm infra:up`, `./start.sh`, or
`infra/scripts/compose-cmd.sh`, all of which pass `--env-file "$ROOT/.env"`
explicitly. Calling compose by hand requires `--env-file .env` yourself.

## 3. Service map

| Service | URL / port |
|---|---|
| Dashboard | `http://localhost:${DASHBOARD_PORT}` (default 3000) |
| Postgres + pgvector | `localhost:5432` |
| Temporal / Temporal UI | `localhost:7233` · `http://localhost:8233` |
| Nango | `http://localhost:3003` |
| Langfuse | `http://localhost:3002` |
| LiteLLM | `http://localhost:4000` |
| Supertokens | `localhost:3567` |
| Atomic Agent | `localhost:8787` |
| MCP Bridge | `localhost:8790` |
| Sandbox | `http://localhost:8080/health` |
| Inbox (Chatwoot fork) | `http://localhost:3004` |

## 4. Demo login

`.env` ships `NEXT_PUBLIC_DEMO_EMAIL` / `NEXT_PUBLIC_DEMO_PASSWORD` and the
login page has a "fill demo" button. The account is a **normal row**, not
magic — on a fresh volume it must be registered once:

```bash
curl -X POST http://localhost:${DASHBOARD_PORT:-3000}/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"aditya@gmail.com","password":"DarexTest123!"}'
```

`ALLOW_DEMO_AUTH` gates a *different* thing (a demo OAuth provider) and must
stay `false` in production.

## 5. Verification scripts

| Script | What it proves |
|---|---|
| `check-phase0.js` (`.ps1`) | Base stack: 17 checks |
| `check-phase2.js` | Agent runtime: 17 checks |
| `check-phase3.js` | Webhooks and inbox: 6 checks — signs its Chatwoot POSTs with HMAC |
| `check-auth-nango.js` | Live register → login → `/api/integrations`: 3 checks |
| `check-phase6-memory.js` | Memory tier population and retrieval |
| `check-retrieve-memory.js` | `retrieveMemory` behaviour including the empty-index path |
| `check-memory-rls.sql` | Two-org isolation on memory tables and vectors |
| `check-two-replica-sse.js` | Both dashboard replicas receive `needs_attention` |
| `e2e-live-llm.js` | Real end-to-end against a live model |
| `run-evals.sh` | The promptfoo golden suites |

## 6. Alerting

| Script | Watches |
|---|---|
| `alerting-connector-401s.js` | Connectors whose tokens went bad |
| `alerting-queue-lag.js` | Temporal / queue backlog |
| `alerting-langfuse-ingest.js` | Trace ingestion health |
| `alerting-rls-job.js` | RLS enforcement job |
| `alerting-run.js` | Runs them together |

A connector 401 is an **org-facing** event ("reconnect Gmail"), not only an ops
alert. Both paths matter.

## 7. Recovery: the Postgres password trap

**Symptom:** `password authentication failed for user "darex"` from nango,
langfuse, litellm, or the dashboard.

**Cause:** Postgres applies `POSTGRES_PASSWORD` only on the **first init of an
empty volume**. Editing `.env` afterwards does not rotate it.

**Fix without losing data:**

```bash
docker exec darex-postgres psql -U darex -d postgres \
  -c "ALTER USER darex WITH PASSWORD '<DB_PASSWORD from .env>';"
docker exec darex-postgres psql -U darex -d postgres \
  -c "ALTER USER darex_app WITH PASSWORD '<APP_DB_PASSWORD from .env>';"
docker compose -f infra/docker-compose.yml --env-file .env \
  restart nango-server dashboard worker
```

**Destructive alternative — deletes all local data:**

```bash
./start.sh --down && docker volume rm infra_postgres-data && ./start.sh
```

## 8. Other known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard port in use | A stray `next dev` from another project | Stop it, or change `DASHBOARD_PORT` and re-run `./start.sh` |
| Langfuse DB empty | Ingestion payload schema, or wrong `LANGFUSE_HOST` inside Docker | `timestamp` at event level, not in `body`; worker host must be `http://langfuse-server:3000`, not `localhost:3002` |
| Langfuse traces flaky under load | Shared Redis (100 clients) times out BullMQ side-queues | Dedicated Redis for Langfuse |
| Tool 403 `insufficient scopes` | Token minted before a scope was added | Disconnect + reconnect that connector at `/connectors` |
| OAuth popup never completes | No real client ID registered in Nango | Register it in the Nango UI at `:3003`, then `restart nango-server` |
| `web_search` returns nothing | `JINA_API_KEY` unset — Jina now requires one | Set it in `infra/.env`; unset yields an honest error, never fake results |
| Classifier hangs 90s+ | A reasoning model burning the token budget on `reasoning_content` | `reasoning: { enabled: false }` and tight `max_tokens` (300/800/1000) |
| Plan steps fail "not in allowed tool list" | Allowlist resolved from one arbitrary employee | Union of all active employees ∪ core tools ∪ connected connectors |

## 9. Backup and restore

`infra/scripts/restore-drill.sh` and `restore-drill.md`. A backup that has never
been restored is not a backup — the drill must be run and its wall-clock timing
recorded.

## 10. Nango configuration

`infra/scripts/seed-nango-configs.sql` applies integration configs
idempotently: Gmail scopes (`gmail.send gmail.readonly gmail.compose
gmail.modify`), Intercom and Notion (`read write`), and Drive/Docs/Sheets
upserts. Run it, then `docker compose restart nango-server`.

**Missing `gmail.compose` is why `draft_email` returned 403** — a scope drift
bug that only surfaces at execution time. `connector_defs.scopes` exists so this
becomes detectable rather than discovered in production.

## 11. Operator hygiene

`infra/scripts/OPERATOR_HYGIENE.md` is the standing checklist. Non-negotiables:

- No committed secrets, no fake client IDs, ever.
- `error` columns must not store secrets (`ingestion_jobs.error` especially).
- Never mark a connector `connected` from a seed.
- Wipe volumes deliberately and never on a shared environment.
