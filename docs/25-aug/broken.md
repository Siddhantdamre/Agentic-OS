# Broken / Bugs / Gaps — as of 2026-08-25

Source: `docs/current-working/14-what-does-not-work.md` (2026-08-14) reconciled against commits
through `855b646` (2026-08-15) and today's verification pass. Items already fixed since 08-14
are removed (langfuse ClickHouse flakiness — see working.md). Nothing new found broken in code
by today's grep/typecheck pass; this list is the remaining known-real gaps, not invented ones.

## Blocking — needs a human to unblock (credentials/ops, not code bugs)

| Item | Where | Why | Fix direction |
|------|-------|-----|----------------|
| WhatsApp **outbound** send | Meta Graph API | `META_ACCESS_TOKEN` expired 2026-06-12 (401) | Rotate token in Meta Developer Console, update `channels.meta` |
| Gmail draft/send on old tokens | Nango gmail connection | Token minted before `gmail.compose` scope added | Disconnect + reconnect Gmail OAuth on `/connectors` |
| Google Drive (some orgs) | Nango | Never completed OAuth for that org | Connect via `/connectors` UI |
| HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Meta Ads | Nango UI `:3003` | Placeholder OAuth client IDs, not real ones | Register real OAuth apps, paste client id/secret into Nango |
| Google Ads metrics | `analytics_report` tool | Missing `GOOGLE_ADS_DEVELOPER_TOKEN` + customer id | Set env vars |
| Razorpay | Billing/PSP | Env empty, no per-org `channels.meta` keys | Set org-level keys |
| `web_search` reliability | Jina tool | Requires `JINA_API_KEY`; no key = honest error, not a bug | Set key in `infra/.env` |
| Meta production webhook | WhatsApp/Instagram inbound | Webhook URL not registered in Meta Developer Console for prod domain | Register URL |

## Code / repo gaps (real, not ops-blocked)

| Item | Where | Detail | Fix direction |
|------|-------|--------|----------------|
| Insight page | `apps/dashboard` insight page | Rule templates only, not a real insight engine (Phase 7 not built) | Build actual analysis/insight engine; scope is a feature build, not a bug fix |
| Realtime scale | Dashboard SSE layer | In-process `EventEmitter`, single Next.js process — won't fan out across multiple dashboard instances | Wire the already-provisioned Redis pub/sub (mentioned in old notes as "wired but not active") |
| pgvector RAG pipeline | Memory/RAG workflows | Exists, wired, but M6 live eval against a real DB still pending per plan docs (`docs/plan/README.md`) | Run M6 eval on a real DB before calling Phase 6 done |
| Production Terraform | `infra/` terraform scripts | Present in tree, not auto-deployed | Wire into CI/CD or document as manual-apply-only |
| Custom skills / playbooks | Skills service | Editing a playbook requires an image rebuild to take effect — no hot reload | Add hot-reload or a build step trigger; low priority |

Fixed today (moved to `working.md`): stale hermes doc reference (route was already deleted, doc just
hadn't caught up), migrations-not-run-on-fresh-DB (already automated — `start.sh` calls `migrate.js`
idempotently on every boot, this was a stale note not a real gap).

## Not started (roadmap, not bugs)

- **Phase 7** Insight engine — partial (see above).
- **Phase 8** Redis bus + PgBouncer done; Terraform/alerting scripts partial.
- **Phase 9** Packs + billing APIs partial; Wave 2 (second vertical pack) not started, blocked
  on M6 eval being green first per `docs/plan/README.md`.

## Security items to keep an eye on (not currently exploited, but flagged in prior audits)

- `ALLOW_DEMO_AUTH` auto-provisions OAuth users if left on — **must stay off in prod**.
- Pre-004 users have `NULL password_hash` (only affects very old seed data, not new signups).
- SuperTokens only works if `SUPERTOKENS_API_KEY` matches the compose `API_KEYS` value — easy
  to silently drift when editing `.env` files across services.
- Rotate any keys accidentally left in gitignored `.env` files (OpenRouter, Groq, Gemini, Meta) —
  no evidence of a leak, just standing hygiene advice from the prior audit.

## More found today (deeper pass — silent failure points)

All six silent-failure items are now fixed (logged instead of bare-swallowed) — see `working.md`.
One item remains, and it isn't a bug:

| Item | Where | Why it's a problem | Fix direction |
|------|-------|---------------------|----------------|
| Integrations "not implemented yet" tools | `apps/dashboard/app/api/integrations/test/route.ts:164` | Some integration test pings return an honest `"Agent tools for {name} are not implemented yet"` message — i.e. certain catalog integrations have a connection test but no actual agent tool behind them. | Not a bug (honest message, no fake success) — but worth listing so nobody assumes every item in `integrations-catalog.ts` has a working executor. Cross-check catalog vs. `services/workflows/src/tools/*.ts` to find which providers are catalog-only. |

## Confirmed clean today (checked, nothing found)

- No `TODO`/`FIXME`/`HACK` debt of substance in `apps/`, `services/`, `packages/`.
- `tsc --noEmit` on the dashboard: zero errors.
- `git status`/`git pull`: clean fast-forward, no merge conflicts.

## Unconfirmed — needs manual browser/E2E check (not verified this pass)

- Full click-through of every sidebar page (Ask AI, Conversations, Plans, Brain, Listings,
  Inquiries, Employees, Insight, Analytics, Integrations, Connectors, Billing, Skills, Settings)
  was **not run** in this pass — `TESTING_AND_FIXING_GUIDE.md` / `RUN_AND_TEST_PROMPT.md`
  describe the full procedure. Do that pass live in a browser to catch UI-only regressions.
- `pnpm test` (dashboard jest suite, 57 tests / 6 suites) was **not re-run** this pass — last
  known result 2026-08-14 was all green (`TEST_RESULTS.md`). Re-run before shipping.
- Full docker stack boot (`./start.sh --dev`) was **not exercised** this pass.
