# Broken and half-wired integrations: fix plan (2026-10-09)

Companion to [`01-integrations-status-matrix.md`](01-integrations-status-matrix.md). Every item below was confirmed in code on 2026-10-09; file:line citations are to the current tree. Nothing here has been changed yet.

## Conventions

- **Priority.** P0: tenant isolation, security, or an advertised core flow that cannot work. P1: works partly, fails silently, misleads the user, or blocks an integration that the catalog offers. P2: hygiene, coverage, polish, or provider currency that should be checked.
- **Effort.** S: under half a day, one or two files. M: one to three days, several files or a migration. L: more than three days, new subsystem or provider review.
- **Verification.** Each item names the unit test to add and the live check. Live checks follow the "done" rule in file 01: run from `/ask-ai` or the real inbound path on a deployed stack, then record it in `BUILD_STATE.md` and the gap doc tracker row in the same commit, per `CLAUDE.md` §5.
- **Human-only.** Steps that need a provider console, a contract or a secret are marked **(human)** and must be tracked as 🔴 Blocked with a reason, never faked.

## Index

| ID | Title | Area | Priority | Effort |
|---|---|---|---|---|
| X-01 | Platform-wide env credentials used as per-org fallbacks | cross-cutting, security | P0 | M |
| X-02 | `NEXT_PUBLIC_NANGO_PUBLIC_KEY` / public host not enforced in production | cross-cutting | P0 | S (+ human) |
| X-03 | Nango image unpinned, default secret in compose | infra | P1 | S |
| X-04 | Provider errors reported as "not connected" | cross-cutting | P1 | M |
| X-05 | 401 does not evict the token cache or force a Nango refresh | cross-cutting | P1 | M |
| X-06 | Retry wrapper never fires; outbound retries can double-send | cross-cutting | P1 | M |
| X-07 | Chat-sent messages are not written back to `messages` | cross-cutting | P1 | M |
| X-08 | System-of-record writes classed as `draft` (no approval) | cross-cutting, governance | P1 | S |
| X-09 | Connect allowlist (`CONNECTOR_SIGN_IN_IDS`) excludes ten integrations | cross-cutting | P1 | M |
| X-10 | BYOK secrets stored in plaintext for Twilio, Instagram, Leegality, Chatwoot | security | P1 | M |
| X-11 | Gmail MIME built twice; the outbound copy has no header sanitising | security | P1 | S |
| X-12 | No per-provider circuit breaker; rate-limit buckets are per process | resilience | P2 | M |
| X-13 | Nango webhooks are log-only; no scheduled health sweep | health | P2 | M |
| X-14 | Scope validation missing for five Google APIs; non-Google scopes never seeded | auth | P2 | M |
| X-15 | Two sources of truth for `connector_defs`; `isOAuthTool` catalog stale | registry | P2 | M |
| X-16 | Pinned provider API versions not tracked | currency | P2 | S |
| X-17 | Invented "API quota used" stat | honesty | P2 | S |
| X-18 | Missing integration tests for four webhook receivers | test debt | P1 | M |
| G-01 | Gmail inbound can never fire | Gmail | P0 | L |
| W-01 | WhatsApp chat send bypasses the gateway and picks an arbitrary number | WhatsApp | P1 | M |
| W-02 | No WhatsApp template send outside the 24-hour window | WhatsApp | P1 | M |
| W-03 | Legacy `manual_json:` plaintext credential branch | WhatsApp | P2 | S |
| I-01 | Instagram cannot be connected; inbound cannot resolve an org | Instagram | P1 | M |
| I-02 | Instagram echo messages can loop into the agent | Instagram | P1 | S |
| T-01 | Twilio cannot be connected; `sms` vs `twilio` channel types disagree | Twilio | P1 | M |
| A-01 | Google Ads calls a sunset API version | Google Ads | P1 | S |
| A-02 | Meta Ads id format and error mapping | Meta Ads | P2 | S |
| S-01 | Shopify and Zendesk connect fails in NEW-FRONTEND (no subdomain) | Shopify, Zendesk | P1 | S |
| C-01 | Salesforce, Zoho, DocuSign, Leegality, LinkedIn, Apollo cannot be connected | CRM, e-sign, prospecting | P1 | M (+ human) |
| C-02 | LinkedIn tools call APIs that do not deliver the advertised data | LinkedIn | P2 | M |
| SL-01 | Slack has no Events API receiver | Slack | P2 | M |
| MS-01 | Outlook and Microsoft Calendar have no inbound | Microsoft | P2 | L |
| ST-01 | `stripe_create_charge` never charges | Stripe | P2 | S |
| CW-01 | Chatwoot has no chat tools | Chatwoot | P2 | M |
| Z-01 | Zendesk public comments reach the requester without approval | Zendesk | P1 | S |
| N-01 | Implemented actions with no chat tool | coverage | P2 | S |
| U-01 | Ghost tiles (Zillow, Calls, Zoho id) and misleading blurbs | NEW-FRONTEND | P2 | S |
| U-02 | Duplicate nested webhook routes and the `/api/integrations/webhooks` stub | dashboard | P2 | S |
| M-01 | MLS advertised in the internal catalog, permanent stub | real estate | P2 | S |

## Suggested order

1. X-01 (tenant isolation) and X-02 (unblocks every OAuth connect). Both are small in code.
2. X-04, X-05, X-06 together: one error model for every provider module. Most other items get easier once modules throw typed errors.
3. X-08 and Z-01 (approval coverage), X-11 (header injection), X-10 (secret sealing).
4. X-09 and C-01, S-01, I-01, T-01: make every advertised integration connectable.
5. G-01 (Gmail inbound), then X-07 (chat sends visible in the inbox), W-01, W-02, I-02.
6. A-01, X-18, then the P2 list.

---

## P0

### X-01. Platform-wide env credentials used as per-org fallbacks (P0, M)

**Symptom.** An org that never connected Twilio can send SMS from Ask AI using the platform's Twilio account. The same holds for Instagram and WhatsApp replies through the platform Meta token, Chatwoot replies through the platform Chatwoot account, and Leegality e-sign through the platform token. Single-tenant identifiers (Salesforce instance, QuickBooks realm, Shopify shop, Zendesk subdomain, Ads account ids) can route one org's OAuth token at another tenant's account.

**Root cause.** Fallback chains end in `process.env` with no production guard:

| Credential | Fallback site |
|---|---|
| Twilio SID / token / from | `services/workflows/src/tools/twilio.ts:57-62`; `apps/dashboard/lib/channel-outbound.ts:117-124`, `:321-335` |
| Meta token | `channel-outbound.ts:106-107`, `:417`; `services/workflows/src/tools/instagram.ts:107` |
| WhatsApp phone number id | `channel-outbound.ts:105`; `tools/whatsapp.ts:162` |
| Chatwoot base / token / account | `channel-outbound.ts:108-114` |
| Leegality token / profile | `tools/leegality.ts:52-53`, `:75-86` |
| Salesforce instance URL | `tools/salesforce.ts:34` |
| QuickBooks realm | `tools/quickbooks.ts:43` |
| Shopify shop domain, Zendesk subdomain | `tools/shopify.ts:21`, `tools/zendesk.ts:23` |
| Google Ads customer id, Meta ad account id | `tools/google-ads.ts:18`, `tools/meta-ads.ts:19` |

Razorpay is the only one already guarded (`tools/razorpay.ts:34`: `NODE_ENV !== 'production' && ALLOW_GLOBAL_RAZORPAY_DEV === 'true'`).

**Fix.**
1. Add `allowPlatformCredentialFallback(name: string): boolean` to `services/workflows/src/tools/shared.ts` and a twin in `apps/dashboard/lib/` (or one copy in `@darex/shared-types` if it must be shared). It returns true only when `NODE_ENV !== 'production'` and `ALLOW_PLATFORM_CREDENTIAL_FALLBACK=true`.
2. Wrap every env read in the table above with it. Where the env value is a per-tenant identifier (Salesforce, QuickBooks, Shopify, Zendesk, Ads ids), remove the env fallback entirely and return `apiError(..., '<field> is not set on this connection. Reconnect and enter it.')`.
3. In `channel-outbound.ts` `replyTargetFromChannelMeta` (`:87-128`), stop merging env values into the target; let the per-channel resolvers decide, using the guard.
4. Keep the owner-WhatsApp env (it is the platform's own approval number by design) and Maps/Jina/SearXNG (platform services by design), but document them as platform-billed in `deploy/env.production.example`.
5. Add a boot warning in `apps/dashboard/lib/boot-guards.ts` when any of the guarded variables is set in production, since it will now be ignored.

**Tests.**
- `services/workflows/src/tools/env-fallback-guard.test.ts`: with `NODE_ENV=production` and env Twilio vars set but no channel row, `twilio.execute` returns `notConnected`; with `NODE_ENV=test` and the flag, it uses env. Same for Instagram, Leegality.
- `apps/dashboard/lib/__tests__/outbound-env-fallback.test.ts`: `sendChannelReply` for `sms` and `instagram` with env set and no channel meta returns `attempted: false` in production mode.
- Salesforce / QuickBooks: missing instance or realm on the connection returns the explicit error even when the env var is set.

**Live.** On the deployed stack with `TWILIO_*` set: from an org with no Twilio channel, ask "text +1… 'test'"; the result must be "Twilio is not connected", and Twilio's console must show no message.

**Security note.** This item touches credentials and tenant isolation; call it out in the commit body.

### X-02. Nango public key and public host not enforced in production (P0, S + human)

**Symptom.** Every OAuth connect fails in NEW-FRONTEND with "Nango public key is not configured on the backend" (`NEW-FRONTEND/src/lib/api/integrations.ts:151`) or a popup on container DNS (`:156-160`). Both example env files ship the key empty (`.env.example:27`, `deploy/env.production.example:37`).

**Root cause.** Missing configuration, and no boot check: `getNangoServerConfig` returns `publicKey: undefined` silently (`apps/dashboard/lib/nango-server.ts:13-20`).

**Fix.**
1. **(human)** Copy the public key of the same Nango environment as `NANGO_SECRET_KEY` into `NEXT_PUBLIC_NANGO_PUBLIC_KEY`; set `NEXT_PUBLIC_NANGO_HOST` to the public HTTPS Nango URL; set `NANGO_SERVER_URL` to the same so callback URLs are public (runbook §1). Rebuild the dashboard: the variable is inlined at build time.
2. In `apps/dashboard/lib/boot-guards.ts`, when `NODE_ENV=production`, log an error (not a crash, so BYOK-only deployments still boot) if `NANGO_SECRET_KEY` is set but `NEXT_PUBLIC_NANGO_PUBLIC_KEY` is empty, or if `NEXT_PUBLIC_NANGO_HOST` is unset or matches `/localhost|nango-server/`.
3. Add both to the `required=(…)` list that `deploy/deploy.sh:302` checks before deploying.
4. Newer Nango versions replace the public key with connect session tokens. Because the image is `latest` (X-03), confirm which flow the running Nango supports; if public keys are deprecated in that version, switch `oauthConnect` to `POST /connect/sessions` from the server and pass the session token to `nango.openConnectUI` / `auth`. Mark this unverified until the pinned version is chosen.

**Tests.** `boot-guards.test.ts`: production + secret + empty public key → error logged; container-DNS host → error logged.

**Live.** `GET /api/integrations` → `nango.publicKeyConfigured: true`; connect Gmail from NEW-FRONTEND end to end; `channels` row for `gmail` becomes `connected`.

### G-01. Gmail inbound can never fire (P0, L)

**Symptom.** Mail arriving in a connected Gmail box never appears in the inbox and never reaches the Customer employee. `/api/webhooks/gmail` exists and is signed, but nothing ever calls it for a real org.

**Root cause.**
1. No `users.watch` registration anywhere. The only push registration is Calendar (`services/connectors/src/calendar.ts:242`).
2. Org lookup needs `channels.meta.email` (`apps/dashboard/app/api/webhooks/gmail/route.ts:229-232`), which connect never writes: confirm only keeps `PUBLIC_META_KEYS` (`apps/dashboard/app/api/integrations/nango-token/route.ts:118-123`, keys at `apps/dashboard/lib/integrations-catalog.ts:683`).
3. `startHistoryId` is set to the notification's own `historyId` (`gmail/route.ts:96-101`), which skips the message that caused it; the fallback lists the five newest messages of any label, including SENT (`:113-122`). `fetch` without timeouts.
4. A disconnected token still writes a placeholder message into the conversation (`gmail/route.ts:249-262`).

**Fix.**
1. **Store the mailbox.** After a successful Gmail/Google confirm in `nango-token/route.ts` POST (and the `connect` branch of `integrations/route.ts`), call `GET gmail/v1/users/me/profile` with the new token and write `meta.email = emailAddress` and `meta.gmail_history_id = historyId` on the `gmail` channel row. Do this server-side; do not add `email` to `PUBLIC_META_KEYS` (that list is client-writable).
2. **Register the watch.** New `apps/dashboard/lib/gmail-watch.ts` with `registerGmailWatch(orgId)`: `POST users/me/watch` with `{ topicName: process.env.GMAIL_PUBSUB_TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'include' }`; store `historyId` and `expiration` on the channel meta. Call it after connect.
3. **Renew.** Watches expire after at most seven days. Add a periodic job in `services/workflows/src/periodic-registry.ts` (daily) that renews watches expiring within 48 hours, Calendar watches are only reused while unexpired (`apps/dashboard/lib/gcal-watch.ts:60-65`) and no renewal job was found for them either, so build one job that renews both.
4. **Process history correctly.** In the webhook, read the stored `gmail_history_id` from the channel row and use it as `startHistoryId`; filter `history.list` with `historyTypes=messageAdded&labelId=INBOX`; skip messages whose `labelIds` include `SENT` or `DRAFT`; after processing, compare-and-set the stored history id to the notification's `historyId`. On HTTP 404 from `history.list` (history too old), fall back to listing `INBOX` messages newer than the last processed internal date, not "latest five".
5. Use `fetchWithTimeout` (15 s) for every Google call in the webhook.
6. Do not persist a conversation message when the token is missing; record a `channel_logs` error and a `failed_webhooks` row instead.
7. Unwatch (`users/me/stop`) on disconnect in the `disconnect` branch of `integrations/route.ts`.
8. **(human)** Create the Pub/Sub topic and push subscription to `https://<host>/api/webhooks/gmail?token=…`, grant `gmail-api-push@system.gserviceaccount.com` publisher on the topic, set `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUSH_TOKEN`.

**Tests.**
- `apps/dashboard/lib/__tests__/gmail-watch.test.ts`: watch request body, expiry renewal window, stop on disconnect.
- `apps/dashboard/app/api/webhooks/gmail/__tests__/route.test.ts`: org resolved from `meta.email`; history uses stored id, not the pushed one; SENT messages skipped; missing token writes no message; duplicate push (same history id) is idempotent.

**Live.** Connect Gmail; check `channels.meta.email` and `gmail_watch_expiration`; send a mail from another account; within a minute a conversation row appears with channel `gmail`, and the auto-reply agent runs once. Send from the connected box itself: no conversation is created.

---

## P1: cross-cutting

### X-03. Nango image unpinned, default secret in compose (P1, S)

**Symptom.** A redeploy can pull a new Nango major version with a changed auth flow (public key vs connect sessions) or schema, and break every connection without a code change. A deployment that forgets `NANGO_SECRET_KEY` runs with a secret that is in the repo.

**Root cause.** `image: nangohq/nango-server:latest` (`infra/docker-compose.yml:239`); `NANGO_SECRET_KEY=${NANGO_SECRET_KEY:-cc462f97-…}` (`:261`). The prod overlay does not override either (`deploy/docker-compose.prod.yml:58-62`).

**Fix.**
1. Pin the image to the version currently running on the VM (`docker inspect darex-nango --format '{{.Config.Image}} {{.Image}}'`, then pin by tag and digest).
2. In the prod overlay, set `NANGO_SECRET_KEY=${NANGO_SECRET_KEY:?NANGO_SECRET_KEY missing}` so a missing value fails `compose config`, matching how ports are handled (`deploy/ports.conf` pattern described in `BUILD_STATE.md`).
3. Note the upgrade procedure (backup `nango` schema, read Nango release notes, test connect) in `deploy/SERVER.md`.

**Tests.** Extend `tests/deploy-port-guard.sh` or add `tests/deploy-nango-pin.sh`: rendered prod config has no `:latest` for `nango-server` and fails without the secret.

**Live.** `compose config` on the VM renders the pinned image; Nango health stays 200 after redeploy.

### X-04. Provider errors reported as "not connected" (P1, M)

**Symptom.** With a valid token, a provider 400/403/429/500 or a network error makes the tool answer "<tool> is not signed in. Connect it at /connectors". Users reconnect a working account; the model gives up on the provider for the rest of the turn.

**Root cause.** Read branches only handle `res.ok`; anything else and any `catch` falls out of the `try` to the trailing `return _authErr ?? notConnected(...)`:

| Module | Fall-through |
|---|---|
| Meta Ads | `services/workflows/src/tools/meta-ads.ts:26-45` |
| Google Ads | `google-ads.ts:44-74` |
| GitHub `fetch_user_repos` | `github.ts:105-129` |
| Shopify reads | `shopify.ts:84-124` |
| Zendesk fetch / create | `zendesk.ts:63-103` |

Other modules (Google Chat, Meet, Cloud, Contacts, Forms, Tasks, Analytics, Search Console, Business Profile, Intercom, Stripe) catch into a generic error; check each for the same pattern when fixing.

**Fix.**
1. Add `providerHttpError(tool, action, timestamp, res, bodyText)` to `tools/shared.ts`: 401/403 → `revoked(...)` with the provider detail; 404 → `apiError` "not found"; 429 → throw `ProviderRateLimitError` with `retryAfterMs` from `Retry-After` (feeds X-06); 5xx → throw `ProviderUnavailableError`; other 4xx → `apiError` with the first 200 characters of the body.
2. In each module above, replace the `if (res.ok) {…}` fall-through with `if (!res.ok) return providerHttpError(...)`, and change the trailing `catch` to return `apiError(tool, action, timestamp, 'Network error calling <provider>: …')` instead of falling through.
3. Keep the trailing `notConnected` only for the "no token" branch.
4. Add a lint-style test that greps provider modules for a trailing `notConnected(` after a `try` block and fails (cheap guard against regressions), or cover each module with the test below.

**Tests.** `services/workflows/src/tools/provider-error-mapping.test.ts`, table-driven over the five modules with a stubbed `fetch`: connected token + 401 → `data.reason === 'revoked'`; + 500 → error message mentions the provider status, `data.connected` not false; + thrown network error → "Network error"; + 200 → executed.

**Live.** Connect Meta Ads, call `meta_ads_metrics` with a wrong `adAccountId`: the answer quotes Graph's error ("Unsupported get request…"), not "not signed in".

### X-05. 401 does not evict the token cache or force a refresh (P1, M)

**Symptom.** After a user revokes access, or after Nango's stored access token is invalidated before expiry, calls keep failing for up to 60 s with the cached token; long plan runs see 401 mid-run with no retry (`integrations-connectors.md` "What's broken" #4).

**Root cause.** Successful Nango lookups are cached for 60 s (`tools/shared.ts:210-218`, `:371`); nothing evicts on a provider 401. No call passes Nango's `force_refresh=true` (searched: zero hits). `getNangoAccessToken` (`:203-206`) still exists for legacy callers and cannot distinguish revoked from missing.

**Fix.**
1. Export `invalidateNangoToken(connectionId, providerKey)` from `shared.ts` that deletes the cache entries; call it from `providerHttpError` on 401 (X-04).
2. Add an optional `forceRefresh` to `resolveNangoAuth` that appends `&force_refresh=true` to the Nango `GET /connection/{id}` URL.
3. Add `withAuthRetry(fn)` helper: run once; on a 401 result, invalidate, re-resolve with `forceRefresh`, run once more; if still 401 return `revoked`. Use it in the Google, Microsoft, HubSpot, Salesforce, Zoho and QuickBooks modules, where access tokens expire hourly.
4. Serialize refreshes per connection in-process (a `Map<connId, Promise>`) so parallel crew steps do not trigger several refreshes at once (`integrations-connectors.md` #10). Nango itself locks refreshes server-side; the in-process lock only avoids a burst of identical calls.
5. Remove `getNangoAccessToken` once no caller remains (`grep -rn getNangoAccessToken services apps`).

**Tests.** `shared.test.ts` additions: cache is cleared by `invalidateNangoToken`; `withAuthRetry` calls Nango with `force_refresh=true` after a 401 and returns success when the second call succeeds; two concurrent `withAuthRetry` calls cause one refresh.

**Live.** In Google account settings, remove Darex access; ask "list my Drive files" twice 10 s apart: both answers say revoked (second one without waiting a minute). Reconnect: the next call works without waiting for the cache.

### X-06. Retry wrapper never fires; outbound retries can double-send (P1, M)

**Symptom.** Provider 429s are not retried or backed off in chat tools, while inbox replies retry POSTs on 5xx and 429 and can deliver the same SMS, Gmail or Instagram message twice.

**Root cause.**
- `withProviderRateLimit` retries only on a thrown error with status 429/503 (`tools/provider-rate-limit.ts:80-85`). Modules return error objects instead of throwing, so the loop runs once.
- When it does retry, it re-runs the whole module, including non-idempotent sends.
- `channel-outbound.ts` `fetchWithRetry` (`:140-155`) retries any POST on `>= 500` or 429 up to three times, for Chatwoot (`:192`), Gmail (`:266`), Twilio (`:361`) and Instagram (`:469`). A 502 after the provider accepted the message produces a duplicate.

**Fix.**
1. After X-04, modules throw `ProviderRateLimitError` / `ProviderUnavailableError`; extend `isRetryableProviderError` to recognise them and honour `retryAfterMs`.
2. Pass the call's risk into `withProviderRateLimit` (`tool-executor.ts:323`): retry only when the risk is `read`, or when the provider honours an idempotency key and `ctx.idempotencyKey` is set (Stripe today; Twilio, Gmail, Graph and Meta sends do not). Otherwise retry only on 429 where the provider guarantees the request was not processed.
3. In `channel-outbound.ts`, retry POSTs only on 429 and on network errors that happen before a response; never on 5xx. For WhatsApp the gateway already handles retries; keep it.
4. Cap total retry time below `TOOL_EXECUTION_TIMEOUT_MS` (15 s) so retries do not trip the executor deadline (`tools/shared.ts:18`).

**Tests.** `provider-rate-limit.test.ts`: a send-risk call that throws 503 is not retried; a read that throws 429 with `retryAfterMs: 200` is retried once after ≥ 200 ms. `outbound-delivery.test.ts`: a 502 from the SMS endpoint results in one fetch call.

**Live.** Hard to force on real providers; verify with a local stub provider behind `fetch` in a staging run, and watch `tool_invocations` latency for retried reads.

### X-07. Chat-sent messages are not written back to `messages` (P1, M)

**Symptom.** When Ask AI sends a WhatsApp, Instagram, SMS, Gmail reply, Outlook reply or Slack thread reply, the conversation in the inbox does not show it. The next inbound message's context (and the auto-reply agent) does not know the business already answered; `whatsapp_list_messages` will not list it. Stated in `BUILD_STATE.md:14`.

**Root cause.** The chat tools call the provider and return (`tools/whatsapp.ts:184-209`, `tools/instagram.ts:136`, `tools/twilio.ts:121`, `tools/gmail.ts:794`, `tools/microsoft-outlook.ts:118`, `tools/slack.ts:153`). Only the dashboard paths insert outbound rows (`apps/dashboard/lib/inbound-agent.ts:565`, `channel-normalize.ts:354`, `whatsapp-inbound.ts:181`).

**Fix.**
1. New `services/workflows/src/tools/outbound-record.ts` with `recordOutboundMessage(client, { orgId, channelKey, contactId, content, providerMessageId, source: 'ask-ai', actor })`. It finds the open conversation for `(org_id, channel_key, contact_id)` (same matching as `whatsapp_list_messages`, last 10 digits for phones), creating one if none exists, and inserts `messages(role='assistant', channel_key, content, chatwoot_msg_id = providerMessageId, tool_calls = {source, pendingActionId})`. Use the same column set as `channel-normalize.ts:354`.
2. Call it after a successful send in WhatsApp (both providers), Instagram, Twilio, Gmail send/reply (channel `gmail`, contact = recipient email), Outlook send/reply (channel `outlook`), Slack reply (only if Slack conversations are stored; otherwise skip).
3. Publish the existing realtime event the inbox listens to (the dashboard uses `realtimeHub.publish`; the worker cannot reach it in-process, so use the Redis channel the SSE route consumes, per `realtime-stream.md`).
4. Failure to record must not turn a successful send into an error: log and add a `channel_logs` warning row.
5. Make it idempotent on `(org_id, channel_key, chatwoot_msg_id)` so a retried approval does not insert twice. Check whether a unique index exists; if not, add one in a migration (schema change: confirm with the repo owner first, per `AGENTS.md` §4a).

**Tests.** `outbound-record.test.ts` with a fake client: creates conversation when missing; reuses by phone suffix; idempotent on provider id. Extend `messaging-actions.test.ts` so a successful `whatsapp_send` calls the recorder once.

**Live.** From `/ask-ai`, approve "reply 'thanks' to +91…" on WhatsApp; open the conversation in NEW-FRONTEND: the reply is there, labelled as sent from Ask AI; `whatsapp_list_messages` lists it as outbound.

### X-08. System-of-record writes classed as `draft` (P1, S)

**Symptom.** Ask AI creates and updates HubSpot deals and contacts, reassigns owners, creates Salesforce/Zoho leads and deals, QuickBooks customers, Zendesk tickets, Notion pages, appends Sheets rows, uploads Drive files and creates Stripe customers with no approval, at any autonomy tier, because `draft` never parks (`tools/risk.ts:15-19`).

**Root cause.** Module risk functions return `draft` for every non-read action: `hubspot.ts:17-22`, `salesforce.ts` and `zoho.ts` and `quickbooks.ts` (`riskFor` returns `draft` for non-reads), `zendesk.ts` (`create`/`update` → `draft`), `notion.ts:13-17`, `google-sheets.ts`, `google-docs.ts`, `google-drive.ts:18-23`, `stripe.ts:12-13`. `connector_defs` has a `write_sor` class (`connector_defs_wave_ab.sql:46`, `:69`) that the executor ignores.

**Fix.**
1. Add `'write'` to `ToolRisk` in `tools/risk.ts` with `confirmForRisk('write') === false` by default, so behaviour does not change until a policy is chosen, and route it through the autonomy tier: at tier ≤ 1 park, at tier ≥ 2 run. Implement in `tool-gate.ts` next to the existing skill-tier check.
2. Reclassify CRM, accounting, ticketing and Stripe customer writes as `write`. Keep Docs/Sheets/Slides/Drive creates as `draft` only when they create a new private file; appends to an existing shared file and uploads into a shared folder become `write`.
3. Delete actions (any `delete_*`) stay `delete`.
4. Regenerate `chat-coverage.md` (`pnpm --filter @darex/workflows chat-coverage`); the risk column changes, and `chat-coverage.test.ts` will require it.
5. Update the inbound HITL send list and dashboard confirm classes (`apps/dashboard/lib/confirm-classes.ts`) if they enumerate risks.

**Tests.** `role-capability.test.ts` / a new `risk-classes.test.ts`: table of `(tool, action) → risk` for every CRM write; gate test: tier 1 + `hubspot_create_deal` parks with reason `write_tier`, tier 3 executes.

**Live.** At tier 1, ask "create a HubSpot deal for Acme"; an approval card appears; approve; the deal exists once in HubSpot.

**Governance note.** This changes what runs without a human; mention it explicitly in the commit.

### X-09. Connect allowlist excludes ten integrations (P1, M)

**Symptom.** Salesforce, Zoho CRM, DocuSign, Leegality, Twilio, LinkedIn, Apollo, Instagram, Google Maps and Zillow cannot be connected; their cards (when `connector_defs` came from the SQL seed) open a flow that ends in "A valid provider query param is required".

**Root cause.** `CONNECTOR_SIGN_IN_IDS` (`packages/shared-types/src/connector-signin.ts:6-39`) is the gate for `GET` and `POST /api/integrations/nango-token` (`apps/dashboard/app/api/integrations/nango-token/route.ts:25-28`, `:85-87`) and for `getIntegration`. The static catalog (`apps/dashboard/lib/integrations-catalog.ts:71-645`) has no entries for these ids, and the BYOK branch of `POST /api/integrations` only redirects to WhatsApp or Razorpay (`route.ts:282-294`).

**Fix.**
1. Make the DB `connector_defs` row the source of truth for "is this a connectable id": in `nango-token` GET/POST replace `isIntegrationId(provider)` with `await getConnectorDef(client, provider)` (`apps/dashboard/lib/connector-registry.ts:445-455`), and read `authMode`, `extraConnectFields` and scopes from it.
2. Add the OAuth ones (Salesforce, Zoho CRM, DocuSign, LinkedIn, Apollo) to `CONNECTOR_SIGN_IN_IDS` as well, because `connectorSignInPath` uses it to build reconnect links shown by `notConnected` (`tools/shared.ts:245-258`).
3. Add `nangoKeysFor` aliases for `zoho-crm` (`['zoho-crm', 'zoho']`) and `quickbooks` (`['quickbooks', 'quickbooks-sandbox']`) in `services/connectors/src/providers.ts:40-72`, matching what the tools already try (`tools/zoho.ts:23-25`, `tools/quickbooks.ts:24`).
4. Add ping specs for each to `NANGO_PING_SPECS` (`providers.ts:135-169`) so `connector-ping-coverage.test.ts` covers them.
5. For BYOK providers (Twilio, Leegality, Instagram), see T-01, C-01, I-01: add a generic `POST /api/integrations/byok/[provider]` route instead of one route per provider.
6. **(human)** Register each provider app in Nango (runbook §2 plus Salesforce, Zoho, DocuSign, LinkedIn, Apollo rows to be added to the runbook).

**Tests.** `connector-signin.test.ts`: every `connector_defs` seed key with `auth_mode = 'oauth'` is accepted by `nango-token` GET; `connector-ping-coverage.test.ts` extended automatically.

**Live.** Connect Salesforce from NEW-FRONTEND; `salesforce_list_contacts` returns real rows.

### X-10. BYOK secrets stored in plaintext for Twilio, Instagram, Leegality, Chatwoot (P1, M)

**Symptom.** WhatsApp tokens and Razorpay secrets are sealed (`BUILD_STATE.md:183`, `:506`), but the other channel credentials are read as plain strings from `channels.meta`, so whatever writes them (today: hand SQL; after X-09: the new BYOK route) would store them unencrypted.

**Root cause.** Plain reads: `tools/twilio.ts:52-56`, `tools/instagram.ts:106-107`, `tools/leegality.ts:70-77`, `apps/dashboard/lib/channel-outbound.ts:107-124`, `:321-335`, `:414-422`.

**Fix.**
1. Use `sealSecret` / `openSecret` from `@darex/whatsapp-gateway` (`packages/whatsapp-gateway/src/secrets.ts`), already used for WhatsApp and Razorpay. Consider moving them to a neutral package (`@darex/shared-types` cannot hold crypto with Node deps; a small `packages/secrets` is cleaner, but only if a third consumer appears; otherwise import from the gateway package as Razorpay does).
2. Seal on write in the BYOK route (X-09 step 5); open on read in every site above. `openSecret` passes unsealed values through unchanged (`packages/whatsapp-gateway/src/secrets.ts:51-52`), so reads keep working for legacy rows; still add a one-time sealing script for these keys, modelled on `infra/scripts/seal-whatsapp-tokens.js` and `seal-razorpay-secrets.js`.
3. Never return secrets from `GET` routes (the WhatsApp/Razorpay GET routes already return `hasToken` booleans; copy that).

**Tests.** `secret-seal.test.ts` per provider: stored value is not the plaintext; tool reads work with sealed values; a sealed value with a wrong key yields "Reconnect" error.

**Live.** Connect Twilio via the new BYOK form; `SELECT meta->>'auth_token' FROM channels WHERE channel_type='twilio'` shows ciphertext; a send works.

### X-11. Gmail MIME built twice; the outbound copy does not sanitise headers (P1, S)

**Symptom.** Inbox replies on the Gmail channel can carry header injection (a CR/LF in the subject adds headers such as `Bcc:`) and garble non-ASCII subjects. Chat sends are safe because they use `buildRawEmail` (`BUILD_STATE.md:31-33`).

**Root cause.** `encodeGmailRaw` in `apps/dashboard/lib/channel-outbound.ts:231-247` concatenates `To`, `Subject` and `In-Reply-To` unescaped. The subject comes from channel meta or the inbound mail (`:115-116`, `:258`), i.e. attacker-controlled text from the original sender.

**Fix.** Export `buildRawEmail` from the workflows Gmail module (or move it to `@darex/connectors`) and use it in `sendGmail` (`channel-outbound.ts:249-296`). Delete `encodeGmailRaw`. Also take the token through the scope-aware Google resolver rather than `getNangoConnection(orgId, 'gmail')` (`:224-229`).

**Tests.** `outbound-delivery.test.ts`: subject `"Hi\r\nBcc: evil@x.com"` produces a raw message with one header line for Subject and no Bcc header; non-ASCII subject is RFC 2047 encoded.

**Live.** Reply from the inbox to a Gmail conversation whose subject contains non-ASCII characters; Gmail shows it correctly in the same thread.

**Security note.** Header injection; call it out in the commit.

### X-18. Missing tests for four webhook receivers (P1, M)

**Symptom.** The Instagram, SMS, Gmail and Google Calendar receivers have no route tests (searched `apps/dashboard` for `*.test.ts` under `webhooks/`: only Evolution has one, at `apps/dashboard/app/api/integrations/whatsapp/evolution/__tests__/route.test.ts`). Signature checks and org resolution are only exercised indirectly through library tests.

**Fix.** Add `__tests__/route.test.ts` beside each receiver, following the Evolution test's pattern: bad signature → 401/403 and no DB write; unknown account → 200 and no write; valid event → `persistInboundMessage` called with the resolved org and `fireInboundAgent` called once; body `org_id` ignored. For Gmail, include the G-01 cases.

**Live.** Not applicable; these are the regression net for G-01, I-01 and T-01.

---

## P1: per integration

### W-01. WhatsApp chat send bypasses the gateway and picks an arbitrary number (P1, M)

**Symptom.** Chat sends for Meta Cloud numbers go straight to Graph `v18.0` with no retry policy, different error text from inbox replies, and, in a workspace with several numbers, from whichever `channels` row Postgres returns first.

**Root cause.** `tools/whatsapp.ts:100-106` selects `meta, nango_connection_id FROM channels WHERE org_id AND channel_type = 'whatsapp'` with no `account_key`, status or order; only the Evolution branch uses the gateway (`:109-129`); the Meta branch builds its own request (`:166-182`). Inbox replies use `sendWhatsAppViaGateway` (`apps/dashboard/lib/channel-outbound.ts:161-179`). Multi-number support stores extra numbers with a non-empty `account_key` (`apps/dashboard/lib/whatsapp-numbers.ts`, `integrations/route.ts:64` selects the primary as `account_key = ''`).

**Fix.**
1. Accept an optional `from` / `channelId` argument on `whatsapp_send` (add to the tool definition in `tool-definitions.ts`).
2. Select the channel: by `channelId` if given; else the conversation's channel when the recipient has an existing conversation (`messages.channel_key = 'whatsapp'` joined to `conversations.channel_id` if that column exists; otherwise the number that last received from this contact); else the primary (`account_key = ''`). Always filter `status IN ('connected','active')`.
3. Send through `sendWhatsApp` from `@darex/whatsapp-gateway` for both providers; delete the inline Graph call and the Nango WhatsApp branch unless Nango WhatsApp connections exist in production (check `channels.nango_connection_id LIKE '%_whatsapp'` on the VM first).
4. Record the send (X-07).

**Tests.** `messaging-actions.test.ts`: two numbers, contact last wrote to number B → send uses B; `channelId` overrides; disconnected number never chosen; gateway called with sealed meta.

**Live.** Workspace with two QR numbers (already set up per `BUILD_STATE.md:428`): reply from Ask AI to a contact who wrote to number two; the reply arrives from number two.

### W-02. No WhatsApp template send outside the 24-hour window (P1, M)

**Symptom.** "Follow up with yesterday's lead on WhatsApp" fails with "Outside the 24-hour reply window: WhatsApp only allows an approved template" (`tools/whatsapp.ts:217-219`), and there is no tool to send the template. Rent reminders, showing reminders and dormant-lead nudges all need this.

**Root cause.** The module has two actions (`whatsapp.ts:6`); the gateway supports a `fallback_template` for auto-replies (`channel-outbound.ts:101`) but chat has no template action.

**Fix.**
1. Add action `send_template` and chat tool `whatsapp_send_template` with `{ to, template_name, language, components }`; risk `send`.
2. Add `whatsapp_list_templates` (read) calling `GET /{waba_id}/message_templates?status=APPROVED` so the model picks a real approved template; require `wabaId` on the channel (already collected, `integrations-catalog.ts:83`).
3. Before a free-text send, check the window the way Instagram does (`tools/instagram.ts:94-103`) and return a message that names `whatsapp_send_template`.
4. QR (Evolution) numbers have no template concept; return a clear "not needed / not supported" for them.

**Tests.** Template payload shape; window check routes to the template hint; Evolution returns the unsupported message.

**Live.** With a Meta Cloud number and an approved `hello_world` template, ask Ask AI to send it to a number that has not written in 24 h; it arrives.

### I-01. Instagram cannot be connected; inbound cannot resolve an org (P1, M)

**Symptom.** Instagram tools, webhook and outbound exist, but no org can set it up; real DMs are dropped with "Cannot resolve org for ig user" (`apps/dashboard/app/api/webhooks/instagram/route.ts:123-129`).

**Root cause.** No code writes a `channels` row of type `instagram` with `ig_user_id` (searched `apps/dashboard` and `NEW-FRONTEND`). Instagram is absent from `CONNECTOR_SIGN_IN_IDS`, the static catalog and `connector_defs`.

**Fix.**
1. Add a `connector_defs` row and catalog entry `instagram` with `authMode: 'oauth'` using the existing Meta Nango config (scopes `instagram_basic`, `instagram_manage_messages`, `pages_show_list`, `pages_manage_metadata`, `pages_messaging`), or reuse WhatsApp Embedded Signup's Facebook login (`apps/dashboard/lib/meta-embedded-signup.ts`) if that is simpler for operators.
2. After connect, server-side: list the user's Pages (`/me/accounts`), let the admin pick one, read `instagram_business_account{id}`, store `meta.page_id`, `meta.ig_user_id`, and a sealed `meta.page_access_token` (X-10). Subscribe the Page to the app webhook (`POST /{page_id}/subscribed_apps?subscribed_fields=messages`).
3. Point the tool and outbound at the sealed token; remove the `META_ACCESS_TOKEN` fallback (X-01).
4. Add a NEW-FRONTEND tile (category Channel).
5. **(human)** Meta app review for `instagram_manage_messages` and the Instagram webhook product configured to `/api/webhooks/instagram` with `INSTAGRAM_VERIFY_TOKEN`.

**Tests.** Route test (X-18); connect handler test with stubbed Graph returning one Page with an IG account → channel row has the three ids and a sealed token.

**Live.** Connect a test Instagram professional account; DM it from another account; conversation appears; reply from Ask AI within 24 h arrives.

### I-02. Instagram echo messages can loop into the agent (P1, S)

**Symptom.** If the Meta app subscribes to `message_echoes` (common when copying WhatsApp settings), every reply the business sends comes back as an inbound message from the business itself, is persisted as a customer message and can fire the auto-reply agent.

**Root cause.** `collectInstagramMessages` keeps any `messaging` item with a `sender.id` (`instagram/route.ts:52-64`) and never checks `message.is_echo` or `sender.id === entry.id`.

**Fix.** Skip items where `message.is_echo === true` or `sender.id === igUserId`. Optionally record echoes as outbound rows (they represent sends from the Instagram app itself), using X-07's recorder, so messages typed in the Instagram app also appear in the inbox.

**Tests.** Route test: an echo payload produces no inbound persist and no agent job.

**Live.** With echoes subscribed, reply from the Instagram app; no new inbound row, no agent reply.

### T-01. Twilio cannot be connected; channel types disagree (P1, M)

**Symptom.** The "Calls" tile maps to `twilio` and fails; the `connector_defs` row says BYOK but no form exists; SMS inbound resolves only `sms`/`twilio` rows that nothing creates; the chat tool reads only `twilio` rows.

**Root cause.** See file 01 row 5: `tools/twilio.ts:44-49` (`channel_type = 'twilio'`), `apps/dashboard/app/api/webhooks/sms/route.ts:37-43` (`sms` or `twilio`), `channel-outbound.ts:314` (`sms` or `twilio`), `integrations/route.ts:282-294` (no BYOK path), `NEW-FRONTEND/src/lib/api/integrations.ts:31`.

**Fix.**
1. Pick `twilio` as the single channel type for Twilio credentials; keep `channel_key = 'sms'` for messages. Make the webhook and outbound read `twilio` only (keep `sms` read-compat for one release).
2. Generic BYOK route (X-09 step 5) with fields `accountSid`, `authToken` (sealed), `fromNumber`; verify with `GET /2010-04-01/Accounts/{sid}.json` before saving, like WhatsApp and Razorpay. Optionally set the number's `SmsUrl` to `/api/webhooks/sms` via `POST IncomingPhoneNumbers/{sid}`.
3. Store `from_number` in E.164 so `resolveChannelByMeta('twilio','from_number', To)` matches Twilio's `To`.
4. NEW-FRONTEND: rename the "Calls" tile to "SMS (Twilio)" and add credential fields to `CREDENTIAL_FIELDS` (`NEW-FRONTEND/src/lib/api/integrations.ts:94-103`) and the BYOK path selection at `:173-174` and `:231-233`.
5. Remove env fallbacks in production (X-01).

**Tests.** BYOK route test (bad SID → 400, good → sealed row); SMS webhook route test; tool test reading the sealed token.

**Live.** Connect a Twilio trial number; text it; conversation appears; "reply 'ok'" from Ask AI parks, then arrives.

### A-01. Google Ads calls a sunset API version (P1, S)

**Symptom.** Once a developer token is set, `google_ads_metrics` and the connection ping will fail at Google with an unsupported-version error. (Google Ads API versions are sunset roughly twelve months after release; v14 was released in 2023. Unverified against the live API today; the fix is safe either way.)

**Root cause.** `services/workflows/src/tools/google-ads.ts:45` (`/v14/customers/{id}/googleAds:search`), `services/connectors/src/providers.ts:147` (`/v14/customers:listAccessibleCustomers`), `services/connectors/src/google-ads.ts:31` (`/v14/customers/{id}/googleAds:searchStream`).

**Fix.**
1. One constant `GOOGLE_ADS_API_VERSION` (env-overridable, default to the current supported version at the time of the fix) used in all three places.
2. Normalize `customerId`: strip dashes, require ten digits, `encodeURIComponent`.
3. Support `login-customer-id` header from connection meta for manager accounts.
4. Map errors through X-04.
5. Keep `executorStatus: 'catalog_only'` until the developer token is in place (runbook §3), and hide `google_ads_metrics` from the turn allowlist when `GOOGLE_ADS_DEVELOPER_TOKEN` is unset, so the model does not offer it.

**Tests.** URL contains the configured version; dashed id normalized; manager header present when set.

**Live.** Runbook §3 check.

### S-01. Shopify and Zendesk connect fails in NEW-FRONTEND (P1, S)

**Symptom.** Clicking connect on Shopify or Zendesk opens a Nango popup with no shop or subdomain; Nango cannot build the authorize URL and the popup fails.

**Root cause.** Both need `extraConnectFields` (`apps/dashboard/lib/integrations-catalog.ts:271-272`, `:292-293`); `GET nango-token` returns them (`nango-token/route.ts:46`) but `oauthConnect` ignores them and calls `nango.auth(providerConfigKey, connectionId, { authorization_params })` only (`NEW-FRONTEND/src/lib/api/integrations.ts:144-170`). The legacy page passed them (`connectors.md` "What works" #3). There is no NEW-FRONTEND tile for either today, but backend rows are appended as extra tiles (`mergeIntegrations`, `:69-86`), so the broken button is reachable.

**Fix.**
1. In the connect dialog, when the token response has required `extraConnectFields`, render inputs before opening the popup.
2. Pass them to Nango as connection config (`nango.auth(key, id, { params: { subdomain } })` for Zendesk, `{ params: { subdomain: shop } }` for Shopify; exact field name depends on the pinned Nango SDK version, see X-03).
3. Send the same values as `extra` to the confirm POST so they land in `channels.meta` (`shopDomain`, `subdomain` are already public meta keys, `integrations-catalog.ts:683`).

**Tests.** NEW-FRONTEND `connect-dialog-setup.test.tsx`: Shopify shows a shop field, the Nango mock receives it, confirm POST includes `extra.shopDomain`.

**Live.** Connect a Shopify dev store; `shopify_fetch_orders` returns orders.

### C-01. Salesforce, Zoho, DocuSign, Leegality, LinkedIn, Apollo cannot be connected (P1, M + human)

**Symptom and root cause.** As X-09 for the OAuth ones; Leegality is BYOK with no form (`connector_defs_wave_ab.sql:176-195`).

**Fix.** X-09 steps 1-5, then per provider:
- Salesforce: read `instance_url` from the Nango connection only (`tools/salesforce.ts:31-33`), no env fallback; refresh tokens need `refresh_token` scope (already in seed scopes).
- Zoho: Nango config key `zoho-crm`; `api_domain` from the token response (`tools/zoho.ts:30-37`). Map the NEW-FRONTEND `zoho` tile to `zoho-crm` in `BACKEND_ID` (`NEW-FRONTEND/src/lib/api/integrations.ts:28-32`).
- DocuSign: set `DOCUSIGN_OAUTH_BASE_URL=https://account-d.docusign.com` for the demo environment; production requires DocuSign go-live review **(human)**.
- Leegality: BYOK fields `authToken` (sealed), `profileId`, optional `apiBaseUrl`; verify with a list call before saving.
- LinkedIn, Apollo: see C-02 before investing; Apollo is API-key based (`tools/apollo.ts:27-33`), so a BYOK form is simpler than Nango.

**Tests.** Per provider: connect route accepts the id, confirm writes the channel row; existing `wave-b-c6-honesty.test.ts` keeps passing.

**Live.** One list call per provider from `/ask-ai` after connecting a sandbox account.

### Z-01. Zendesk public comments reach the requester without approval (P1, S)

**Symptom.** "Add a note to ticket 123 that the refund is approved" posts a comment that Zendesk emails to the customer, with no approval card.

**Root cause.** `update_ticket` sets `ticket.comment = { body: payload.comment }` (`services/workflows/src/tools/zendesk.ts:40`). Zendesk treats a comment without `public: false` as public, and the default trigger notifies the requester. The module classes every update as `draft` (`riskFor`: `update`/`create` → `draft`). `create_support_ticket` sends no `requester` (`zendesk.ts:84`), so today the requester is the connected agent and creation itself does not email a customer.

**Fix.** Send `comment: { body, public: Boolean(payload.public) }` so comments are internal by default; classify `update_ticket` with `public: true` as `send`, other updates as `write` (X-08). If a `requester` argument is ever added to `create_support_ticket`, classify that create as `send` too.

**Tests.** Risk table: update with `public: true` → send; update without → write and body carries `public: false`.

**Live.** Ask to add a public reply to a test ticket: approval card appears; after approval the requester receives the email. Ask for an internal note: no card, no email.

---

## P2

### X-12. No per-provider circuit breaker; rate-limit buckets are per process (P2, M)

**Symptom.** When a provider is down, every chat turn and every crew child waits out the 12 s HTTP deadline per call (`tools/shared.ts:24-27`) before failing. Rate limits are enforced separately in the worker and in the dashboard process (which also runs tools for direct agent turns), so the effective limit is a multiple of the configured one.

**Root cause.** `circuit-breaker.ts` is only used for model failover (`services/workflows/src/local-turn.ts:976-986`). Token buckets are an in-memory `Map` (`tools/provider-rate-limit.ts:8`).

**Fix.**
1. Wrap `executeProvider` in `tool-executor.ts:323-341` with a breaker keyed by provider (not by org, so one org's broken token does not trip it; count only 5xx and timeouts, never 401/403/4xx). Open after 5 failures in 60 s, half-open after 30 s. When open, return `apiError(tool, action, ts, '<provider> is not responding; try again in a minute.')` immediately.
2. Move buckets to Redis (the dashboard already uses Redis for SSE, `infra/docker-compose.yml` comment at line 21) with a Lua token bucket, falling back to in-memory if Redis is down.
3. Seed per-provider defaults that match published limits (HubSpot 100/10 s per app, Slack tier 3 ~50/min for `chat.postMessage` per channel, Graph per-mailbox limits) through the existing `RATE_LIMIT_<PROVIDER>_*` env names (`provider-rate-limit.ts:28-31`).

**Tests.** Breaker opens after 5 provider 503s and short-circuits; 401s do not count; half-open success closes it.

**Live.** Point `NANGO_HOST` at a dead port in staging: the second and later tool calls fail fast with the "not responding" message.

### X-13. Nango webhooks are log-only; no scheduled health sweep (P2, M)

**Symptom.** A revoked or refresh-failed connection stays "Connected" in the UI until someone opens Connectors (which demotes stale OAuth rows, `apps/dashboard/app/api/integrations/route.ts:95-122`) or runs a ping. Employees keep the provider on their turn allowlist and fail mid-task.

**Root cause.** `POST /api/webhooks/nango` only inserts into `channel_logs` (`apps/dashboard/app/api/webhooks/nango/route.ts:61-80`), by design ("a stray event can never disconnect an org", `:22-25`). No periodic job calls the ping route (`services/workflows/src/periodic-registry.ts` has no connector entry).

**Fix.**
1. On Nango `auth` events with `operation: 'refresh'` and `success: false`, set `org_connectors.health_status = 'revoked'` and `last_error`, but do not touch `channels.status` (keeps the "stray event" safety). Surface `health_status` on the Connectors card and in `connectors_status`.
2. Add a daily periodic job that pings every connected OAuth connector per org through the same code as `POST /api/integrations/[provider]/ping`, with concurrency 2 per org, and writes health columns. Emit a notification to org admins on a transition to `revoked`.
3. **(human)** Set `NANGO_WEBHOOK_SECRET` and the webhook URL in Nango (runbook §5).

**Tests.** Webhook test: failed refresh event updates health only; unknown org prefix is acked with no write. Sweep test with stubbed pings.

**Live.** Revoke a Google connection at Google; after the next sweep (or Nango's refresh attempt) the card shows "Reconnect needed".

### X-14. Scope validation gaps; non-Google scopes never seeded (P2, M)

**Symptom.** A token without Analytics, Search Console, Business Profile, Cloud or Ads scope is used for those tools and fails at Google with 403, which today becomes "not connected" (X-04). Non-Google providers get whatever scopes someone typed in the Nango UI; `nango.yaml` is not applied.

**Root cause.** `isGoogleScopeSufficient` returns `true` for unlisted keys (`tools/shared.ts:288-303`). The umbrella `google` config omits those scopes (`infra/scripts/seed-nango-configs.sql:36-38`). `services/connectors/nango.yaml` is not read by any code.

**Fix.**
1. Add scope checks for `google-ads` (`adwords`), `google-analytics` (`analytics`), `google-search-console` (`webmasters`), `google-business-profile` (`business.manage`), `google-cloud` (`cloud-platform`). When insufficient, return a specific "Reconnect Google and allow <scope>" error with `connected: true, reason: 'missing_scope'` instead of `never-configured` (`shared.ts:374-375` currently returns never-configured).
2. Replace `nango.yaml` with a small typed `services/connectors/src/scopes.ts` (provider → scopes) and a script `infra/scripts/apply-nango-scopes.js` that PATCHes Nango configs through Nango's API for every provider. Delete or clearly label `nango.yaml` as reference-only.
3. Reconsider least privilege: `nango.yaml` requests "maximum useful scopes … not least-privilege" (`nango.yaml:13-15`). Restricted Gmail/Drive scopes trigger Google's security assessment; `gmail.modify` + `gmail.send` + `drive.file` may be enough. Decide per product need **(human decision)**.

**Tests.** Scope validator table per key; resolver returns `missing_scope` state.

**Live.** Connect Google with only Gmail consent; ask for a GA4 report: answer names the missing scope.

### X-15. Two sources of truth for connector defs; stale OAuth catalog (P2, M)

**Symptom.** Which connector cards a deployment shows depends on whether `connector_defs` was first filled by `pnpm db:seed` (SQL, 38 rows, no `google-workspace`) or by `ensureConnectorDefsSeeded` from the static catalog (31 rows, no Salesforce et al.). `isOAuthTool` is wrong for Microsoft, Salesforce, Zoho, DocuSign and others.

**Root cause.** `apps/dashboard/lib/connector-registry.ts:420-441`; SQL seeds in `infra/db/seeds/`; `AUTONOMOUS_TOOL_CATALOG` in `services/workflows/src/tool-executor.ts:488-531` with `isOAuthTool` at `:539-545`.

**Fix.**
1. Generate the SQL seed from `INTEGRATION_CATALOG` plus a wave-B extension list in TypeScript (one source), or make `ensureConnectorDefsSeeded` upsert every catalog item on boot (`ON CONFLICT (key) DO UPDATE` for metadata columns only).
2. Derive `isOAuthTool` from `connector_defs.auth_mode` or from the tool modules (add an `auth: 'nango' | 'byok' | 'env' | 'internal'` field to `ToolModule` in `tools/shared.ts:159-164`), and delete the hand-kept catalog list or generate it.
3. Add a test that every `TOOL_MODULES` provider with an external API has a `connector_defs` row and vice versa.

**Tests.** The consistency test in step 3.

**Live.** Fresh database, boot, open Connectors: the same set of cards whichever seeding ran first.

### X-16. Pinned provider API versions not tracked (P2, S)

**Symptom.** Several modules pin versions that providers retire on a schedule. If a version is retired the provider either errors (Google Ads) or silently upgrades (Meta Graph, Shopify), which can change response shapes.

**Root cause.** Pins: Graph `v18.0` (`tools/whatsapp.ts:168`, `tools/instagram.ts:118`, `tools/meta-ads.ts:26`, `apps/dashboard/lib/channel-outbound.ts:470`, `services/connectors/src/test-connection.ts:128`, `:175`); Google Ads `v14` (A-01); Shopify `2024-01` (`tools/shopify.ts:43-102`, `providers.ts:163`); Salesforce `v59.0` (`tools/salesforce.ts:14`); Notion `2022-06-28` (`providers.ts:160`; check the module's header too); QuickBooks minor version `65` (`tools/quickbooks.ts:49`); DocuSign `v2.1`.

**Fix.** One `services/connectors/src/api-versions.ts` exporting each version with an env override and the date it was last checked; import it everywhere; add a CI test that fails when a version's `checkedOn` is older than 9 months, as a reminder to re-verify. Re-verify each against provider docs when doing this (unverified today which of these are still served).

**Tests.** The age test.

**Live.** Ping each connected provider after the bump.

### X-17. Invented "API quota used" stat (P2, S)

**Symptom.** The Connectors stats show an "API quota used" percentage that is today's `channel_logs` row count divided by 1000. There is no such quota.

**Root cause.** `apps/dashboard/app/api/integrations/route.ts:227`.

**Fix.** Remove `apiQuotaUsed` from the response (and from any UI that reads it; the NEW-FRONTEND `IntegrationStatsValues` does not, `NEW-FRONTEND/src/components/integrations/integration-filters.ts:52-57`), or replace it with real per-provider rate-limit headroom once X-12 exists.

**Tests.** Route test asserts the key is absent.

**Live.** Connectors page shows no quota figure.

### W-03. Legacy `manual_json:` plaintext credential branch (P2, S)

**Root cause.** `tools/whatsapp.ts:145-148` parses `channels.nango_connection_id` values starting with `manual_json:` as JSON credentials; `JSON.parse` is unguarded and would throw an unhandled error into the executor's catch.

**Fix.** Query production for such rows (`SELECT count(*) FROM channels WHERE nango_connection_id LIKE 'manual_json:%'`); if zero, delete the branch; otherwise migrate them to sealed `meta.accessToken` with `seal-whatsapp-tokens.js` first.

**Tests.** Remove the branch's test if any; add one asserting a `manual_json:` value is treated as not connected.

### A-02. Meta Ads id format and error mapping (P2, S)

**Root cause.** `tools/meta-ads.ts:19-26` uses the ad account id as given; Graph requires `act_<id>`. Errors fall through (X-04). Only last 7 days, fixed field list.

**Fix.** Prefix `act_` when missing; accept `date_preset` and `level` (campaign/adset/ad) arguments; map Graph error 190 to `revoked`, 17/80004 to rate limit.

**Tests.** Id normalisation; error mapping.

**Live.** "Meta Ads spend this month by campaign" returns rows.

### C-02. LinkedIn tools call APIs that do not deliver the advertised data (P2, M)

**Symptom.** `linkedin_company_signals` is described as hiring/funding/leadership signals; it calls `organizationAcls` (`tools/linkedin.ts:47`), which lists organisations the member administers. `linkedin_search_people` calls `peopleTypeahead` (`:72`), which is not part of LinkedIn's generally available APIs (provider policy; unverified for this app's product approvals).

**Fix.** Either remove both tools and the catalog row until a licensed data source is chosen **(human decision)**, or re-implement against an approved partner programme / a data provider (Apollo already covers people search and company enrichment, `tools/apollo.ts:49-75`). Do not ship scraping.

**Tests.** If removed: `chat-coverage.test.ts` regenerates without the rows. If kept: honesty tests remain.

### SL-01. Slack has no Events API receiver (P2, M)

**Symptom.** Messages in Slack never reach Darex; the runbook refers to `/api/webhooks/slack` (`integrations-credentials-runbook.md` row 6), which does not exist. Only button interactions arrive (`apps/dashboard/app/api/webhooks/slack/interactions/route.ts`).

**Fix.** Add `POST /api/webhooks/slack/events`: verify the signing secret (reuse `verifySlackSignature` from `apps/dashboard/lib/slack-interact.ts`), answer `url_verification`, handle `message.im` and `app_mention` only, resolve the org from `team_id` stored on the Slack channel meta at connect, persist with `channel_key = 'slack'`, return 200 before firing the agent (per `AGENTS.md` §3 rule 2). Ignore `bot_id` messages to avoid loops. Store `team_id` at connect (read it from `auth.test`).

**Tests.** Route tests: URL verification, bad signature, bot message ignored, mention persisted.

**Live.** Mention the Darex app in a channel; a conversation appears and the employee replies in thread (approval as configured).

### MS-01. Outlook and Microsoft Calendar have no inbound (P2, L)

**Fix outline.** Graph change notifications: `POST /subscriptions` for `me/mailFolders('inbox')/messages` (created) and `me/events`, `notificationUrl` = new `/api/webhooks/microsoft`, `clientState` = random per subscription stored hashed (same pattern as `gcal-watch.ts`), validation token echo, renewal before the 3-day mail expiry via the periodic job from G-01. Org from subscription id lookup. Then fetch the message by id and persist like Gmail. Effort L because of renewal, validation and lifecycle notifications.

**Tests / live.** As G-01.

### ST-01. `stripe_create_charge` never charges (P2, S)

**Root cause.** Creates a PaymentIntent with `confirm: 'false'` (`tools/stripe.ts:31-50`), so approval results in an unconfirmed intent and no money moves, while the tool name and catalog text promise a charge (`tool-executor.ts:498`).

**Fix.** Decide **(human decision)**: rename to `stripe_create_payment_intent` and say so in the description, or confirm the intent with a saved `payment_method` and `off_session: true` after approval. The second is a real charge and must stay `pay` risk with RBAC (`gatePayRbac`, `tools/gate-hooks.ts`).

**Tests.** Payload contains `confirm=true` only in the confirmed variant.

### CW-01. Chatwoot has no chat tools (P2, M)

**Fix.** Add a `chatwoot` module with `list_conversations` and `reply` (send risk) using the same credentials resolution as `sendChatwoot` (`channel-outbound.ts:181-222`, minus env fallbacks per X-01), or route Ask AI replies for Chatwoot conversations through the generic conversation reply route. Prefer the second if Chatwoot conversations are already mirrored into `conversations`.

### N-01. Implemented actions with no chat tool (P2, S)

Add tool definitions for `shopify_update_order_address` (write, X-08), `tasks_create` (draft), `forms_get_responses` (read), `hubspot_list_contacts` (read); decide whether `hubspot_reassign_owner` should be chat-callable (write). Regenerate `chat-coverage.md`. Files: `services/workflows/src/tool-definitions.ts`, module action lists cited in file 01 "Chat coverage gaps".

### U-01. Ghost tiles and misleading blurbs (P2, S)

In `NEW-FRONTEND/src/mocks/integrations.ts`:
- Remove `zillow` (`:20`) or mark it "Coming soon" with no connect button.
- Rename `calls` (`:15`) to SMS once T-01 lands; until then hide it.
- Map `zoho` → `zoho-crm` (C-01) or rename the tile id.
- Rewrite blurbs that promise sync the backend does not do: Meta Ads "Lead form sync" (`:12`), HubSpot "Two-way contact sync" (`:14`), Razorpay "Revenue + churn signals" (`:13`), Google Ads "Spend + lead source attribution" (`:11`). Use what the tools do today (campaign metrics, on-demand CRM read/write, payment links).
- This is the separate NEW-FRONTEND repo; commit there.

### U-02. Duplicate nested webhook routes and the integrations-webhooks stub (P2, S)

- Delete `apps/dashboard/app/api/webhooks/google-calendar/google-calendar/route.ts` (copy of the parent minus `orgId` at line 94) and `apps/dashboard/app/api/showings/calendar-watch/calendar-watch/route.ts` after confirming nothing registers those URLs (grep the watch registration for the `webhook_address` it stores, `apps/dashboard/lib/gcal-watch.ts:109`).
- Delete `apps/dashboard/app/api/integrations/webhooks/route.ts`, which only logs any JSON a signed-in admin posts (`:6-28`) and has no caller, or document its purpose.

### M-01. MLS advertised, permanent stub (P2, S)

Remove `mls` from `AUTONOMOUS_TOOL_CATALOG` (`tool-executor.ts:527`) until a licensed feed exists (blocked, human: contract), keep the stub module so a stray call stays honest (`tools/realestate/index.ts:802-808`).

