# 09 — Verification Checks

All verification scripts are Node scripts in `infra/scripts/` that hit the running Docker stack on localhost. Run from the repo root. **Expected result: every suite reports ALL CHECKS PASSED.**

## Suite matrix

| Script | Covers | Expected | Notes |
|---|---|---|---|
| `check-phase0.js` | Infra containers + service health | **17/17 PASS** | Postgres (pg_isready + pgvector), Temporal (namespace list), Redis PING, Nango /health, Langfuse /api/public/health, LiteLLM /health/readiness, all 10 containers running |
| `check-auth-nango.js` | Auth + Integrations | **3/3 PASS** | register → login (session cookie) → GET /api/integrations |
| `check-phase2.js` | Connector layer | **17/17 PASS** | connect 7 integrations (whatsapp, gmail, google-calendar, hubspot, razorpay, meta-ads, google-ads), verify Connected status + dynamic stats, proxy 7 connector actions via /api/integrations/test, webhook ingestion to channel_logs, live DB log feed |
| `check-phase3.js` | Conversation inbox | **6/6 PASS** | inbox gateway health (:3004), chatwoot webhook ingestion (<500ms + HMAC), DB RLS row verification, human manual reply POST, conversations feed + stats, email channel ingestion |
| `e2e-live-llm.js` | End-to-end real LLM | 5 checks | registers user, connects WhatsApp with real Meta creds (SKIP/FAIL if `META_ACCESS_TOKEN` missing — currently expired), sends Meta-format webhook, verifies conversation + assistant AI reply persisted in DB, verifies outbound channel_log |

## Running one suite

```bash
# From repo root, with the stack up
node infra/scripts/check-phase0.js
node infra/scripts/check-auth-nango.js
node infra/scripts/check-phase2.js
node infra/scripts/check-phase3.js
node infra/scripts/e2e-live-llm.js
```

## Script details worth knowing

### `check-phase0.js`
- Asserts each compose container is running and healthy (Postgres, Temporal, Temporal UI, Redis, Nango, Langfuse server/worker/minio/clickhouse, LiteLLM).
- Prints service URLs + dev credentials.

### `check-phase3.js`
- Registers a throwaway user (`check_<ts>@example.com`), extracts the session cookie, and extracts `org_id` from the `darex_org_id` cookie to scope the webhook (`?org_id=...`).
- **HMAC-signed Chatwoot webhooks** (test 2 and 6): computes `x-chatwoot-signature: sha256=<hex HmacSHA256(JSON body, CHATWOOT_WEBHOOK_SECRET || 'darex-chatwoot-webhook-secret-dev')>`. This was added because the webhook route rejects unsigned requests with 401 now that `CHATWOOT_WEBHOOK_SECRET` is enforced. **If you change the secret, update this script's fallback or export `CHATWOOT_WEBHOOK_SECRET`.**
- Test 2 also enforces `<500ms` ingestion latency.
- Test 3 verifies the conversation + message rows exist under RLS for the org.
- Test 4 posts a human reply, test 5 reads the feed, test 6 ingests an email channel message.

### `e2e-live-llm.js`
- The only script that needs **real** credentials. It loads env from `.env`, `apps/dashboard/.env.local`, `infra/.env`.
- Requires `META_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`; with the current expired token it will FAIL/SKIP steps 2–5. (See open items in `10-features-roadmap.md`.)

### Launchers (not checks)
- `worker-launcher.js` — host-launched Temporal worker (env merge + spawn `dist/worker.js`).
- `bridge-launcher.js` — host-launched MCP bridge (env merge + spawn `dist/mcp-bridge.js`).

## Full-stack verification command

```bash
cd "dare xai"   # repo root
node infra/scripts/check-phase0.js && \
node infra/scripts/check-auth-nango.js && \
node infra/scripts/check-phase2.js && \
node infra/scripts/check-phase3.js
# Expect: 17/17, 3/3, 17/17, 6/6 all PASS
```

## If a check fails — quick triage

| Symptom | Likely cause | Fix |
|---|---|---|
| Container "not running" in Phase 0 | compose down / partial boot | `docker compose -f infra/docker-compose.yml up -d`, wait for health |
| Webhook 401 in Phase 3 | HMAC secret mismatch | export `CHATWOOT_WEBHOOK_SECRET` matching the route's env, or restart dashboard after changing it |
| Webhook 200 but ingestion >500ms | cold start / DB busy | re-run; first run after boot is usually slower |
| Auth 401 in check-auth-nango | dashboard not up or cookie handling | `docker compose up -d dashboard`; wait for health |
| E2E fails at connect | expired `META_ACCESS_TOKEN` | rotate Meta token (see roadmap) |
