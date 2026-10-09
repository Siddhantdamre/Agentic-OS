# Darex Build State

## Chat coverage matrix exists and CI keeps it complete (2026-10-09)

- `AGENTS.md` and the ASK-G01 audit row pointed at `gap26sept/chat-coverage.md`, which did not exist, so nothing tracked whether every tool and tab action can be done from Ask AI. `services/workflows/src/scripts/chat-coverage.ts` (`pnpm --filter @darex/workflows chat-coverage`, after a build) now writes it: one row per chat tool (154, with provider action, risk and whether approval is required) and one per mutating dashboard API route a tab calls (83; webhooks, auth, the chat itself, the public widget and platform admin excluded). Regeneration keeps any status cell edited by hand, and new rows start 🔴.
- `chat-coverage.test.ts` (in the workflows test run) fails when a tool or route has no row or a row is stale, and checks that hand-set statuses survive regeneration.
- Every row is 🔴: none has been proved live from `/ask-ai` yet. Tab-action rows don't yet name the chat tool that covers them.
- Verified: workflows tests pass, including the 2 new ones. This change is docs and tooling only; runtime behaviour is unchanged.

## Instagram DMs read and reply from Ask AI (2026-10-09)

- Chat had no Instagram tools: inbound DMs reached the inbox and the auto-reply agent, but Ask AI could neither read them nor answer one. New `instagram` tool module with `instagram_list_messages` (stored DMs, `messages.channel_key = 'instagram'`, RLS-scoped, optionally one contact by IGSID) and `instagram_send` (Graph `/{ig_user_id}/messages`, send-risk, approval first). Credentials come from the connected `instagram` channel meta (same keys as `channel-outbound.ts`), else `META_ACCESS_TOKEN`; a connected channel puts the tool on the turn allowlist through `mergeRuntimeAllowlist`.
- The send refuses outside Meta's 24-hour window (no inbound DM from that contact in 24 h) and refuses a recipient id that is not a numeric IGSID before anything reaches a Graph URL. Inbound HITL and dashboard confirm classes treat it as a send.
- Verified: 487 `@darex/workflows` tests (new cases in `messaging-actions.test.ts`: IGSID validation, risk of both actions, tool-to-action wiring) and 625 dashboard tests, dashboard typecheck. Not verified: a live list or send against a real Instagram account. A chat-sent DM is not written back to `messages` (the WhatsApp chat send behaves the same).

## Outlook, Slack and WhatsApp read and reply from Ask AI (2026-10-06)

- Chat could send on these channels but not read or answer a conversation. Outlook was list and send only; Slack could post but not see channels or threads; WhatsApp could only send.
- Outlook: `outlook_list_messages` takes a search `query`, new `outlook_read_message` (full body as text), `outlook_reply` (Graph `reply`/`replyAll`, approval first), `outlook_draft_reply` (`createReply`/`createReplyAll`), `outlook_send` takes bcc and comma-separated `to`. Message ids are validated and URL-encoded before reaching Graph.
- Slack: new `slack_list_channels`, `slack_read_thread` (`conversations.replies`) and `slack_reply_thread` (posts with `thread_ts`, approval first; needs an explicit channel, never the ops fallback). `slack_read_channel` takes a limit. The thread action is named `send_reply` on purpose: "thread" contains "read", so a name like `reply_in_thread` was classed as a read by the risk check, which a test caught.
- WhatsApp: new `whatsapp_list_messages` reads stored inbound and outbound messages (`messages.channel_key = 'whatsapp'`, RLS-scoped), optionally for one phone matched on its last 10 digits. Replying stays `whatsapp_send`, which already goes to approval.
- Inbound HITL treats `outlook_reply` and `slack_reply_thread` as sends.
- Verified: 485 `@darex/workflows` tests (new `messaging-actions.test.ts`: search URL, id validation, Slack ts, phone key, the risk class of every new action, tool-to-action wiring) and 625 dashboard tests. Not verified: live calls to Graph, Slack or the WhatsApp query against a real database. The Slack token may lack `channels:read` and `groups:history`; Slack then returns a clear `missing_scope` error.

## Gmail reply-all from Ask AI (2026-10-06)

- `gmail_reply` and `gmail_draft_reply` take `reply_all: true`. The reply goes to the sender (Reply-To, else From) and copies everyone else on the original To/Cc. The connected account's own address (from the Gmail profile) and duplicates are dropped. When you reply-all to your own sent mail, the first person you wrote to becomes the main recipient. An explicit `to`/`cc` from the caller still wins or is added.
- Verified: new `replyAllRecipients` / `parseAddressList` tests (quoted names with commas, case-insensitive self and duplicate removal, own sent mail, Reply-To). Not verified: a live reply-all against Gmail.

## Gmail read, reply and reply-draft from Ask AI (2026-10-05)

- Gmail gains `read_email` (one message in full by id), `reply_email` (sent in the original thread with `In-Reply-To`/`References`, `Re:` subject, to the Reply-To/From unless `to` is given; send-risk, approval first) and `draft_reply` (same, saved as a draft). Chat tools: `gmail_read_email`, `gmail_reply`, `gmail_draft_reply`; `gmail_send` takes cc/bcc. Before this, chat could only start new emails, so "reply to that email" produced an unthreaded message or a refusal.
- All outgoing mail goes through `buildRawEmail`, which strips CR/LF from model-supplied headers (no header injection), RFC 2047-encodes non-ASCII subjects and base64-encodes the body. Message ids are validated before reaching a Gmail URL. Inbound HITL treats `gmail_reply` as a send.
- Verified: 476 `@darex/workflows` and 625 dashboard tests, including new Gmail cases (header injection, unicode subject, threading headers, `Re:` once, action risks). Not verified: a live read, reply or draft against a real Gmail account, because no local stack was running.

## Below the skill tier minimum a call asks for approval instead of failing (2026-10-05)

- "Send an email" from chat failed with `Action blocked: autonomy tier 1 is below skill minimum 2 for "gmail"`. The skill-tier check in `tool-gate.ts` refused every non-read call, including drafts, and also ran on the approval executor's re-entry, so even a human-approved send could never execute. Below the skill minimum a call now parks for approval (reason `skill_tier`; sends already park as `confirm_class`), drafts are not tier-checked (they reach nobody), and an approved re-entry skips the check.
- Verified: `@darex/workflows` tests, including new gate cases (below-tier send parks, non-confirm write parks as `skill_tier`, draft runs, approved send runs). Not verified: a live send through the deployed chat, because no local stack was running.

## Next 15 upgrade follow-up: codemod leftovers, React 19 peers, params test (2026-10-05)

- The async-request-api codemod left `Promise<Promise<{ id }> | { id }>` types with `await Promise.resolve((await context.params))` in the listings, showings, packs config and integrations ping routes, plus `@next-codemod-error` comments on two re-exports. These are now plain `Promise<{ id }>` with `await context.params`. Both re-export targets (`employees/growth/page`, `api/listings` GET) take no params, so the warnings didn't apply.
- `@testing-library/react` 14 and `lucide-react` 0.368 declared React 18-only peers. Moved to RTL 16 (adds `@testing-library/dom` 10) and lucide-react 0.562, the version `@openuidev` already installs, so it dedupes. Every icon import still type-checks.
- New `lib/__tests__/route-params-async.test.ts` calls 11 dynamic handlers with Promise params. A valid id must reach auth and an invalid one must 400 first. Mutation-checked: un-awaiting `params` in one route fails its case.
- Verified: typecheck (also with no `.next/`), lint, 621 dashboard tests, `next build`, audit gate exit 0. `next dev` serves the auth pages (200) and they hydrate with no browser console errors, dashboard pages redirect (307), and dynamic API routes return 401. Not verified: signed-in pages, because the local Postgres/SuperTokens stack wasn't running.
## Email routing only claims inbox triage, not every message with "email" (2026-10-05)

- The routing rule added for email and inbox triage (to Emma / Customer Support) matched the bare words "email" and "gmail" at weight 0.88, so "Email the qualified lead the demo invite" (Sales outreach) and "Draft a reply to this ad-lead email" (Marketing) were taken from their owners and sent to Support; two `employee-capabilities` rows failed in CI. The pattern now needs inbox-triage phrasing (inbox, mailbox, recent/unread/new/latest emails, emails in Gmail, triage/check/fetch my email or inbox). The three triage examples from the original change still route to Emma, and a new test asserts that writing or sending an email does not.
- Verified: 470 `@darex/workflows` tests and 603 dashboard tests pass with a fresh workflows build (the dashboard test reads the built `dist`, so a stale build hides this). Not verified: live Ask AI routing on real phrasing beyond these examples.

## Deleting a Cognee dataset keeps its marker until the delete succeeds (2026-10-05)

- A branch change in `deleteCogneeDataset` removed the org's "dataset present" marker before calling Cognee's delete. If the delete then failed, the marker was gone while the dataset still existed, so search skipped that org's data and the next DSR delete could not find it; `memory/cognee-client.test.ts` ("keeps the dataset marked present when the delete fails") caught it and failed the branch's CI unit-test step. The marker is again removed only after the delete returns ok or 404.
- Verified: all 468 `@darex/workflows` tests pass after merging main into the branch. Not verified: a delete against a real Cognee instance.

## A server checkout with commits that are not on origin/main is refused (2026-10-05)

- A redeploy failed in the worker image build with duplicate `hasCogneeDataset` / `DATASET_CACHE_TTL_MS` declarations in `cognee-client.ts`: the server's checkout had both its own agent-written version and the one on `main`, which happens when `main` is merged into a server branch and the conflict is resolved by keeping both sides. `main` itself had one definition and CI was green.
- `redeploy.sh` ran `git merge --ff-only origin/main`, which reports "up to date" when the checkout is ahead of origin, so commits made on the box (and merge commits from `git pull`) were built and deployed untested.
- New `require_in_sync` (`deploy/lib.sh`) runs right after the merge in `redeploy.sh` and `deploy.sh`: if `origin/<branch>..HEAD` has any commit it stops, names up to five of them, and prints the recovery (`git branch backup-<date> && git reset --hard origin/main`). `ALLOW_LOCAL_COMMITS=1` deploys them anyway with a warning, for a deliberate hotfix. A checkout that is only behind origin still fast-forwards.
- Verified: `tests/deploy-sync-guard.sh` (9 checks on real temporary git repos: in sync, behind, a commit on the server refused and named, override warns, a `git pull` merge commit refused, clean after reset) runs in CI. Not yet verified: on the VM itself.

## The dashboard runs on Next 15 and React 19 (2026-10-05)

- Next 14.2.35 carried two critical and eight high advisories (fix needs 15.5.24+), which the CI audit gate had been allowlisting. `apps/dashboard` now uses Next 15.5, React 19 and eslint-config-next 15. The `@next/codemod` async-request-api pass changed `params` to a promise in 11 route/page files (the rest already used `await cookies()`), the obsolete `experimental.instrumentationHook` flag is gone, `BottomTabs` keeps a plain `<a>` for the sign-out endpoint (a `Link` would prefetch it) with a lint exemption, and the connectors link in `ActionPermissionCard` is now a `Link`.
- The allowlist in `infra/scripts/audit-gate.js` is down to `braces` (no upstream patch). Production advisories: 2 critical and 9 high before, 0 critical and 1 high (`braces`) now.
- Verified: typecheck, `next build`, all 599 dashboard tests, the audit gate exits 0. `next dev` serves `/login` (200), redirects `/` to login (307) and answers API routes (401 unauthenticated); `next start` without production secrets stops at the `MCP_BRIDGE_SECRET` boot guard, so the instrumentation hook still runs. Not verified: signed-in pages and flows, React 19 behaviour in third-party UI packages beyond the build, and a deployed run.
- nodemailer 10 (override) is only loaded by supertokens-node's SMTP delivery services, which the dashboard never configures; its `createTransport`/`sendMail` API was exercised with a JSON transport. A real SMTP send is untested because nothing sends through it. A global pnpm 11 prints a harmless "pnpm.overrides ignored" warning but runs the pinned 9.0.0; moving to pnpm 11 was tried and rejected for now (its minimum-release-age policy refuses nodemailer 10.0.15 and nanoid 3.3.20, published under 24 hours ago).

## CI dependency audit gates on production deps with pinned overrides (2026-10-05)

- CI's `Dependency audit` step (`pnpm audit --audit-level=high`) failed every push with 88 advisories (2 critical, 38 high); typecheck, build, tests, the RLS suite and the deny-list job were already green. Root `package.json` now has `pnpm.overrides` for axios, fast-uri, @grpc/grpc-js, nanoid, postcss, nodemailer (6 to 10, pulled in by supertokens-node), hono, ip-address, qs and yaml, and the lockfile is regenerated. Production advisories drop from 88 to 25 (9 high, 2 critical).
- The step is now `node infra/scripts/audit-gate.js`: it audits production deps only and fails on any high/critical advisory not in its allowlist. pnpm 9.0.0 (the pinned `packageManager`) ignores `pnpm.auditConfig.ignoreGhsas`, so the allowlist lives in the script. Accepted for now: the Next 14.2.35 advisories (fix is the Next 15.5.24+ major upgrade of apps/dashboard, not done) and `braces` (no upstream patch). Dev-only advisories (jest, eslint) are no longer gated.
- Verified: the gate exits 0 locally with pnpm 9.0.0 and the new lockfile. Not verified: a CI run after the push, the dashboard build and tests with the overridden versions, and a real email send through nodemailer 10 from supertokens-node.

## A guard stops Darex from taking another project's ports (2026-10-05)

- The VM also runs mtip (80/443, 47020-47544), WA-AKG (3030, 3306), TrueForge (8085, 8791) and openclaw (18789). Nothing checked Darex's ports against them: `deploy.sh` ignored every Docker proxy, and `redeploy.sh` had no check, so a clash only showed up as a `compose up` failure after images were built.
- `check_port_ownership` in `deploy/lib.sh` now runs in both scripts before any build or recreate. It reads the real ports from `compose config` and refuses when one is outside Darex's range (10000-19999, set in `deploy/ports.conf`), in `OTHER_PROJECTS_PORTS` (18789 openclaw), used twice, or already held by anything that is not a `darex-*` container (it names the holder). Our own containers holding a port is fine: they are about to be replaced.
- SearXNG moved from 8088 to 18088 (`SEARXNG_HOST_PORT`) so every Darex port is in the range; nothing on the host used 8088, services reach it as `searxng:8080`. A server `.env` that still sets `DASHBOARD_PORT=3000` or `EVOLUTION_PORT=8086` now fails the guard instead of silently keeping the old ports.
- `tests/deploy-port-guard.sh` (10 cases against stubbed compose/ss/docker: clean, own containers, below range, above range, reserved, duplicate, other project's container, host process, substring port, `.env` override) runs in CI. Also run against the real prod compose config: passes, and DASHBOARD_PORT=3000, MCP_BRIDGE_HOST_PORT=18789 and EVOLUTION_PORT=47033 are each refused.
- Not yet verified: the live holder check on the VM itself (it runs on the next redeploy).

## Cognee search skips orgs that have no dataset yet (2026-10-05)

- Every agent turn paid for a slow Cognee `/search` even for an org that has no Cognee dataset. `hasCogneeDataset(orgId)` now reads `/api/v1/datasets` (2 s timeout) and `searchCognee` returns `[]` without searching when Cognee answered and the org has no `org_<id>` dataset.
- Safety: any doubt searches anyway (HTTP error, timeout, thrown fetch, a list that is not an array of named datasets). A cached "no" is re-checked after 5 s because another process may have created the dataset; a cached "yes" lasts 30 s. `rememberCognee` marks the dataset present at once; `deleteCogneeDataset` only forgets it after the delete succeeded. The check runs before the search timer starts, so it neither eats the search budget nor leaves a timer behind.
- Rewritten from the server's first version (its early return leaked the search timer, a failed delete hid live memory for 30 s, and a stale "no" from another process hid new memory). Its Hindsight change, a hardcoded `darex-hindsight-dev-key` fallback in `hindsight-client.ts`, was not taken: compose already provides that variable to the worker and dashboard.
- Verified: 7 new tests in `cognee-client.test.ts` (empty list, exact-name match, search skipped vs reaching Cognee, error / throw / odd shape all search anyway, 5 s recheck, remember, failed delete). Not yet verified: against a live Cognee.

## Unknown Nango connections no longer show as revoked (2026-10-05)

- A 400 or an "unknown connection" answer from Nango counted as `revoked`, so a connector that was never linked told people to reconnect it. `resolveNangoAuth` now treats only 401, `invalid_grant` and revoked or expired tokens as revoked; unknown connection or provider config is `never-configured`, and a token without the needed scope is `never-configured` instead of "no access token".
- The live probe passes the connector key and resolves the Google Workspace connectors through the umbrella Google login (`resolveGoogleAuth`).
- Origin: written on the server by an agent and run there; reviewed, re-authored and landed from the `vm-agent-fixes-2026-10-05` branch. Verified: workflows build, 461 tests including the new probe test. Not yet verified: the Connectors tab against a real Google account after redeploy.

## Redeploy rolls back a failed swap and builds the dashboard faster (2026-10-05)

- `next build` had no build cache, so every code change recompiled the whole dashboard (several minutes on the 2 vCPU VM). The dashboard Dockerfile now mounts a persistent `.next/cache` for the build; the install layer was already cached by lockfile and only reruns when `package.json` or the lockfile change.
- `redeploy.sh` already built every image before touching a running container, so a failed build left the old version serving. New: before building it tags each image it is about to replace as `<image>:rollback`. If anything after the swap fails (compose up, health checks, migrations) it restores those tags, recreates only those containers with `--no-build --no-deps`, waits for the site to answer, clears the "already built" stamp (otherwise the next run would skip the rebuild and redeploy the old image) and still exits non-zero. Migrations are not reversed; they are additive and idempotent.
- The frontend is no longer restarted on every run, only when its image was rebuilt; the restart was extra downtime for an unchanged image.
- Not zero downtime: dashboard and frontend are single containers, so a recreate is a gap of the container start time. True zero downtime needs two replicas behind the proxy (not built).
- Verified: shell syntax; the rollback function run against stubbed docker/compose/curl (restores tags, recreates, clears the stamp on failure; does nothing when disarmed or on success). Not yet verified: a real failing deploy on the VM.

## Production host ports live in one file, deploy/ports.conf (2026-10-05)

- Host ports were `${NAME:-default}` repeated across `docker-compose.prod.yml`, `deploy.sh`, `redeploy.sh` and `lib.sh`, so a port change meant editing several files and a missed one probed a dead port (Evolution health check defaulted to 8085 while prod binds 18085).
- New `deploy/ports.conf` is the only place a prod host port is set. `lib.sh` loads it for both deploy scripts, `infra/scripts/compose-cmd.sh` passes it to compose whenever a `--overlay` is used, and the prod overlay reads each name with `${NAME:?...}`, so a missing value fails the config instead of publishing a wrong port. A per-machine `.env` still wins because it loads after. SearXNG and Crawl4AI host ports are now `SEARXNG_HOST_PORT` / `CRAWL4AI_HOST_PORT` (dev keeps its 8088 / 11235 fallback).
- Port values themselves are unchanged. Caddy (the proxy in front of the stack) is not read by compose: its upstream still has to match `FRONTEND_HOST_PORT` by hand (`deploy/Caddyfile.example`).
- Verified: `compose-cmd.sh --overlay deploy/docker-compose.prod.yml config` renders all 22 published ports on 127.0.0.1 from the file; `FRONTEND_HOST_PORT=23100` overrides; with the file removed, config fails with "POSTGRES_HOST_PORT missing". Not yet verified: a live redeploy on the VM.

## Password signups verify their email address (2026-10-05)

- Signup created a working session for any address, typed or not. Migration `209_email_verification.sql` adds `users.email_verified_at` (every existing user is backfilled as verified, so turning enforcement on locks nobody out), a hashed single-use 24h `email_verification_tokens` table, and four SECURITY DEFINER functions (create, consume, mark, check) in the same style as password reset.
- Signup now emails a link to `/verify-email?token=...` (new page; `POST /api/auth/verify-email` consumes the token and audits `auth.email_verified`; `POST /api/auth/resend-verification` always answers OK so it cannot reveal which accounts exist). A signup that accepts an invite sent to that address is marked verified at once.
- Enforcement is opt-in: with `REQUIRE_EMAIL_VERIFICATION=true`, signup returns 202 `VERIFY_EMAIL` without a session and password login returns 403 `EMAIL_NOT_VERIFIED` (audited as a denied login). Without the flag the email is still sent but nothing is blocked, because a deploy with no `RESEND_API_KEY` could never verify anyone. OAuth/SSO logins are not gated: the provider verifies the address. Before migration 209 every check degrades to "verified".
- NEW-FRONTEND still has to handle the `VERIFY_EMAIL` and `EMAIL_NOT_VERIFIED` responses (show "check your inbox" plus a resend button) before the flag is turned on; the dashboard's own login page does not yet either.
- Verified: dashboard `tsc --noEmit` clean; jest 599/599 including new `email-verification.test.ts` (flag, hashing of the token, bad/expired/used tokens, pre-migration fallback, public paths). Not verified: migration 209 (no Postgres running here), the routes over HTTP, a real mail send, or the login gate end to end.

## Worker agent turns are traced in Langfuse (2026-10-05)

- Only dashboard routes traced turns. Turns the worker runs (inbound WhatsApp/email/SMS/widget replies via WorkItemWorkflow, crews, sweeps) used a no-op tracer, so the busiest customer-facing traffic never showed in Langfuse (27sept OPS-B03). Spend was already metered (`recordTurnSpend`).
- New `src/langfuse-trace.ts` posts the same ingestion batch as the dashboard helper (trace with the org as `userId`, plus a generation with token usage, duration and USD cost when reported). `runAgentTurnActivity` fires it after each turn, without waiting, with employee, conversation, tools used and step count; failed turns are level ERROR. It is not added to `runTrueForgeTurn`, which dashboard chat also uses and already traces. A missing config is logged once per process and an ingest failure is logged; neither affects the turn. The worker container already gets `LANGFUSE_HOST` and keys from compose.
- Verified: `langfuse-trace.test.ts` (event-level timestamp, trace/generation link, usage and cost mapping, config), workflows suite, typecheck. Not verified: ingestion into a running Langfuse (not up locally).

## Each embed job keeps its own text (2026-10-05)

- The text an embed job was about to embed lived in `knowledge_sources.metadata.pendingText`, one row per source. Conversation write-back queues a job on every message for the same source, so the second write replaced the first and both jobs embedded the later text; the earlier message was never indexed (27sept MEM-B03).
- Migration `208_ingestion_job_payload.sql` adds `ingestion_jobs.payload` (JSONB). The three places that queue text (worker `persistEmbedJobWithClient`, dashboard `enqueueEmbedJob` for the first part and for each `#chunk-N`) write the text on the job and no longer on the source row. Both worker claim paths read the job's payload first and fall back to `metadata.pendingText` only for jobs queued before 208. `markJob` clears the payload when a job finishes, so raw text is not kept. Brain re-index takes the newest queued job's text before the old metadata copy.
- Verified: typechecks, workflows 454/454, dashboard 594/594. Migration 208 applied locally; through the real `enqueueEmbedJobFromWorker`, two jobs queued back to back for one conversation kept their own texts and the source row held none. Rows deleted. Not verified: EmbedWorkflow embedding them (no Temporal/LiteLLM run).

## Stripe writes carry an idempotency key (2026-10-05)

- No provider write sent an idempotency key, so a Temporal retry of a plan step, or an approval executed twice, could create a second Stripe charge, refund, customer or payment link (27sept RT-B10).
- `providerIdempotencyKey` (`tools/shared.ts`) derives `darex-<sha256>` from org, a durable anchor (approved pending-action id, else workflow id), tool, action and the arguments (key order ignored). `invokeProvider` passes it on `ToolActionContext.idempotencyKey`; Stripe adds `Idempotency-Key` to its write POSTs (one per action). A call with no anchor (a chat turn, which RT-B03 no longer retries) gets no key, so identical but separate chat requests are not merged. Two identical writes in one plan do collapse into one at Stripe.
- Not done: Razorpay, Twilio and HubSpot. No idempotency header was verified for them, so none is guessed; plan steps there still rely on the per-step `claimIdempotent`.
- Verified: `provider-idempotency.test.ts` (same step same key, any field change a new key, no anchor no key), workflows suite, typecheck. Not verified: the header against Stripe (no test account; Stripe auth goes through Nango).

## The Gmail tool can search, not only read the latest emails (2026-10-05)

- `gmail_fetch` listed the newest N messages only, so "find the invoice email from Acme" read the last ten and hoped (27sept TOOL-G01).
- `gmail_fetch` takes an optional `query` in Gmail search syntax (`from:`, `subject:`, `is:unread`, `newer_than:`), sent as `q`. The URL is built by `gmailListUrl` (URLSearchParams encoding, query trimmed and capped at 500 chars, count clamped to 1..50). The reply message and `data.query` say what was searched. The tool description tells the model when to use it.
- Verified: `gmail-http.test.ts` (encoding, clamping, empty query), workflows suite, typecheck. Not verified: a live Gmail account.

## Ask AI plan, approval, mode and crew actions are audited (2026-10-05)

- Only plan approve and tool execute wrote `audit_events`. Cancelling a plan, editing its steps, approving or denying a paused tool in chat, changing who answers (Ask mode), and dispatching a crew left no record of who did it (27sept ASK-E01).
- Migration `207_audit_event_kinds_ask_ai.sql` adds `plan.cancel`, `plan.step_edit`, `tool.approve`, `tool.deny`, `crew.dispatch` to `audit_events_kind_chk` (full union of 150; `AUDIT_EVENT_KINDS` updated, pinned by `audit-events.test.ts`). Plan cancel and step edit (`api/ask-ai/plan`) record the actor; step edits store step ids, tools and on/off plus which steps had arguments edited, never the arguments. `api/ask-ai/approve` writes one row per decision before resuming and returns 500 without resuming if that fails, like `/api/decisions`. The Ask mode save runs every turn, so a `settings.update` (`setting: ask_ai.mode`, from/to) is written only when the mode or employees actually change. Crew dispatch from `/api/ask-ai` and `/api/agent/crew` records the manager and specialist employee ids. Failures on the non-approval paths are logged, not thrown.
- Verified: dashboard typecheck; `ask-ai-plan-rbac.test.ts` (cancel and step-edit cases, arguments absent), `ask-ai-approve-audit.test.ts` (per-decision rows, no resume when the insert fails), `audit-events.test.ts`; migration 207 applied to the local DB and all five kinds inserted (rolled back). Not unit-tested: the mode-change and crew-dispatch rows (large route; typechecked only).

## A chunked file becomes ready once its chunks are indexed (2026-10-05)

- Worker ingest stages a file, queues one embed job per chunk (`path#cN`, each with its own `knowledge_sources` row) and leaves the file's own row at `syncing`. `markJob` only updated the chunk rows, so every chunked Drive file showed "Syncing" forever and never got `last_synced` (27sept MEM-B01).
- `rollupChunkedSource` (`activities/embed.ts`) runs after any chunk job finishes and once more right after staging (all chunks may already be embedded via the hash skip). When no current chunk (`#c0`..`#c<chunkCount-1>`) is pending or syncing, the file becomes `ready` with `last_synced`, or `error` with "N of M parts failed to index". Leftover chunk rows from a longer earlier version are ignored; a disabled file is left alone. Each chunk's update commits before the rollup runs, so the last chunk to finish sees the others.
- Verified: typecheck, workflows suite; against the local Postgres: one of two chunks done left the file syncing, both done made it ready (a stale `#c2` error row ignored), one failed made it error with the reason. Rows deleted. Not verified: a real Drive file through EmbedWorkflow. Known gap: if every chunk is skipped before a row is written (all redacted away), the file stays syncing.

## DSR delete covers every org table, or names why it keeps it (2026-10-05)

- The DSR delete job (`dsr/tables.ts`) listed 36 tables; the schema has 89 with `org_id`. It left customer data behind: CRM entities and identifiers, real-estate inquiries/showings/listings, leases and charges, growth leads and dossiers, intent signals, tool invocations (arguments), failed webhook payloads, notification log, sentiment, feedback, and earlier memory text in `memory_revisions` (27sept SEC-C01, MEM-E01).
- New `CUSTOMER_DATA_TABLES` (25) joins the delete list (61 total). `DSR_RETAINED_TABLES` names the 28 kept tables with a reason: account (users, memberships, invites, push devices), configuration (employees, skills, packs, channels, connectors, widget) and legal records (audit, billing, the DSR request itself), because the org stays a working account. Deleting any of those is a product/legal decision, left open. `tables.test.ts` parses the migrations for `org_id` tables (matches the live schema, 89/89) and fails when one is in neither list; checked by removing one entry. The org soft-delete purge (`lib/org-purge.ts`) also clears `memory_revisions` and `sync_cursors`.
- Verified: workflows dsr tests 14/14, dashboard and workflows typecheck, every listed name exists in the live schema. All FKs onto the new tables are SET NULL or CASCADE, so the order cannot fail. Not verified: a full DSR delete run on a populated org. Still open: export covers fewer tables than delete; org purge does not call Cognee/Hindsight; Nango/Langfuse/SuperTokens/MinIO cleanup.

## A knowledge source can be disabled, and disabling hides its chunks (2026-10-05)

- Retrieval and the Brain list skip memory whose `knowledge_sources` row is `disabled`, but matched `ks.path = source_ref` exactly. Chunk memories carry `path#cN` (worker ingest) or `path#chunk-N` (dashboard embed), so a disabled file's chunks were still retrieved. Nothing could set `disabled` anyway, and every sync upsert wrote its own status over it (27sept MEM-B02).
- The six filters (`memory/retrieve.ts` ×4, `api/brain/route.ts` ×2) now also match the source_ref with the chunk suffix removed (`regexp_replace(source_ref, '#(c|chunk-)[0-9]+$', '')`), so a path with its own `#` is not cut. `PATCH /api/brain/source:<id>` takes `action: disable | enable` (owner/admin, org-scoped, 404 otherwise; enable sets `ready`). Every status write on `knowledge_sources` (ingest upsert and updates, embed `markJob` and upsert, dashboard embed upserts, reindex upsert) keeps `disabled` in place. NEW-FRONTEND Settings > Business has a Disable/Enable button and a "Disabled" chip per source (committed in that repo).
- Verified: `brain-source-disable.test.ts` (4 cases), both typechecks; on the local Postgres in a rolled-back transaction: after disabling, the whole-file row and both chunk formats were hidden and another file's chunk stayed visible, a re-sync upsert plus a `markJob`-style update left it `disabled`, and enable restored `ready`. Frontend: vitest (API client and component), tsc, eslint. Not verified: a browser click-through against the live stack.

## Contact enrichment runs through the tool gate (2026-10-05)

- After a HubSpot contact was created, `backfillContactFieldsActivity` read Gmail and wrote `update_contact` to HubSpot through the raw `executeProvider`: no allowlist, autonomy, approval or audit, and a failed write was swallowed with `.catch(() => undefined)` (27sept EMP-S02, the remaining CRM write).
- Both calls now go through `executeAutonomousToolAction`, injected by `tool-executor.ts` (no circular import), as the employee that created the contact (allowlist, role, employee id, actor, workflow id; `source: 'sweep'`). A HubSpot update that is denied, parked or fails is logged and returned as `reason: crm_sync_<status>`; the local entity update still stands.
- Still raw on purpose: operator-internal Slack/WhatsApp alerts in `activities/customer.ts` and `activities/open-loop-sweep.ts`.
- Verified: typecheck; ran the activity against the local Postgres with a recording executor: Gmail read and HubSpot write both went through it with the creator's allowlist and role, phone and title were filled from the signature, and a denied HubSpot write came back as `crm_sync_denied`. Test entity deleted. Not verified: a real Gmail/HubSpot account.

## A routed employee with no tools no longer inherits the webhook default's tools (2026-10-05)

- `routeEmployeeActivity` merged the router's pick with the caller's defaults. When the pick was a different employee whose card had no tools (a blank custom employee), it inherited the webhook default employee's allowlist and persona, so it could use Customer's Stripe/WhatsApp tools (27sept EMP-B02).
- `mergeRoutedForCaller` now falls back to the caller's allowlist and persona only when the routed employee is the caller's own (`CallerDefaults.employeeId`, passed from `params.employeeId`). Another employee keeps its own empty list, which downstream means core tools plus connected channels only (`mergeRuntimeAllowlist`), not everything. With no caller id, nothing is inherited. Name/role fallback for empty fields is unchanged.
- Verified: `route-employee.test.ts` (new EMP-B02 case; the existing fallback case now names the caller's employee), workflows suite 447/447, typecheck. Not verified: a live inbound webhook routed to a blank custom employee.

## Razorpay key secrets are stored encrypted (2026-10-05)

- The per-org Razorpay key secret was saved as plaintext in `channels.meta` (`keySecret`/`key_secret`), so anyone with DB or backup access could create payment links for that org (27sept RT-S04 / BIZ-S01; the WhatsApp half was already sealed).
- `POST /api/integrations/razorpay` now seals the secret with the same AES-256-GCM helper as the WhatsApp token (`sealSecret`, key `CHANNEL_SECRETS_KEY`), under both legacy names, with a `secret_hint`. It refuses with 503 before calling Razorpay when the key is not set. Readers open it at use: the agent's `razorpay` tool (a secret it cannot open is reported as "reconnect", never sent) and the connector test route (treated as not connected). Old plaintext rows keep working until `node infra/scripts/seal-razorpay-secrets.js [--dry-run]` seals them (idempotent, same shape as `seal-whatsapp-tokens.js`).
- Verified: `razorpay-secret-seal.test.ts` (sealed under both names, never plaintext, opens back, 503 without a key and Razorpay not called); dashboard and workflows typecheck. Ran the backfill on a temporary local row: dry run, seal, re-run skipped, value opens to the original; row deleted. Dev DB had no Razorpay rows. Not verified: a live Razorpay connect and payment link with a real key.

## A retried agent turn no longer re-runs tools the first attempt already ran (2026-10-05)

- `runAgentTurnActivity` (`AutonomousAgentWorkflow`, also the child turn of every inbound `WorkItemWorkflow`) has `maximumAttempts: 2` and catches its own errors, so Temporal retries it only after a 12-minute timeout or a dead worker. The retry re-ran the whole turn, so a send, charge or update from the first attempt could happen twice, sometimes while the first attempt was still running (RT-B03, the part still open after the failover fix).
- The activity now claims `wf:<workflowId>:<runId>:agent-turn:<activityId>` in `idempotency_keys` before running (`runGuardedAgentTurn`). Retries share the key and the workflow's own follow-up turns do not. A retry that finds a finished attempt returns its saved result. One that finds an unfinished attempt runs nothing and returns `turn_retry_held` (customer channels get the escalation holding reply), which `WorkItemWorkflow` turns into needs_attention. A claim error is thrown so Temporal retries the claim; only SQLSTATE 42P01 (table missing) runs unguarded. `isUndefinedTable`'s "does not exist" text match is not used here, because it also matches a missing role or database.
- Inbound redelivery was already deduped: the `WorkItemWorkflow` id is derived from the inbound event, and a second start gets the existing handle.
- Verified: `agent-turn-retry.test.ts` (8 cases), full workflows suite 446/446, typecheck. Also ran against the local Postgres `idempotency_keys` with a real org: the second call with the same key returned the saved result without running, and a concurrent call while the first was running was held. Probe rows deleted. Not verified: a real Temporal activity timeout and retry.


---

Older entries (2026-10-01 and before): `docs/archive/BUILD_STATE-2026-10-01-and-older.md`. Search it with grep, do not read it whole.
