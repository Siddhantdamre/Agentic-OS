# 06 · Channels, conversations, realtime, widget

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 0 | 0.0% |
> | 🟡 **Pending / In Progress** | 3 | 5.1% |
> | 🔴 **Not Done (Open)** | 56 | 94.9% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **59** | **100.0%** |

Audit date 2026-09-27, read-only. `WH/` = `apps/dashboard/app/api/webhooks/`, `LIB/` = `apps/dashboard/lib/`, `API/` = `apps/dashboard/app/api/`, `WF/` = `services/workflows/src/`. Docs checked: `gap26sept/webhooks.md`, `conversations.md`, `realtime-stream.md`, `widget.md`, `docs/api-endpoints/{webhooks,conversations,stream,widget-embed}.md`.

**Headline.** Inbound WhatsApp/Chatwoot/Gmail/SMS/Instagram persist fast and return 200 before agent work — the rule is honoured. Around that core: a global-secret `/webhooks/outbound` route lets anyone with a conversation UUID send WhatsApp/SMS from any org's credentials; Slack interactions trust `orgId` from the button payload; widget sessions merge all anonymous visitors into one conversation; WhatsApp delivery receipts are dead because sends never store the wamid; Gmail push ingests the mailbox's own sent mail and replies to itself; human takeover on widget silently never reaches the visitor; and the SSE event allowlist, route mapping and client listeners have drifted so several published events can never arrive.

---

## 1. Channel matrix

| Channel | Inbound | Signature | Org resolution (spoofable?) | Dedupe | Outbound | 24h / templates | Media | Typing / read | Threading | Human handoff | SLA |
|---|---|---|---|---|---|---|---|---|---|---|---|
| WhatsApp Cloud | `WH/whatsapp/route.ts:179` | HMAC + `*_PREVIOUS`, **prod-only** (`LIB/webhook-crypto.ts:74-90`) | `phone_number_id` → channel, then WABA (`:59-97`); env fallbacks (`:292,296`); WABA not verified at connect (`API/integrations/whatsapp/route.ts:34-42`) → WABA-spoofable | wamid → `messages.chatwoot_msg_id` unique (`:404-443`) | `LIB/channel-outbound.ts:144-186` text only | **none** — no 24h check, no template send | inbound metadata only; outbound none | statuses parsed (`:233-280`) but never match (CH-B01) | `contact_id` | `ai_paused_until` (`:472-481`) | `needs_attention` publish; no SLA set |
| Chatwoot | `WH/chatwoot/route.ts:199` | Global HMAC `x-chatwoot-signature` (`:203`) — stock Chatwoot does not sign → needs proxy | inbox map → per-org secret → header+token → query+token (`:133-197`); account `''` wildcard (`LIB/channel-normalize.ts:160-166`) | msg id | `LIB/channel-outbound.ts:188-229` | n/a | none | none | `chatwoot_conv_id` | skip outgoing/private | needs_attention |
| Gmail | Pub/Sub `WH/gmail/route.ts:195` | OIDC JWT or shared token (`webhook-crypto.ts:301-343`) | mailbox `email` meta | `mail.id` | `channel-outbound.ts:256-303` | n/a | attachments **none** | n/a | **no thread** — `gmailThreadId` never set, `In-Reply-To` never passed (`:238-254,267-272`) | pause via persist | none |
| Slack | interactions only (`WH/slack/interactions`) | v0 HMAC + 5-min skew | **`orgId` from button value** (`slack-interact.ts:57,66`) | **none** | agent tool only | | | | not a conversation channel | | |
| Twilio SMS | `WH/sms/route.ts:16` | X-Twilio-Signature; dev unsigned | `To` → channel; env `TWILIO_FROM_NUMBER` fallback | MessageSid | `channel-outbound.ts:351-398` | STOP/opt-out **none** | MMS **none** | | contact_id | pause | none |
| Instagram | `WH/instagram/route.ts:94` | Meta HMAC | `ig_user_id/page_id` | `mid` | `channel-outbound.ts:400-511` | 24h window checked (`:446-473`) ✅ | | | | pause | none |
| Messenger | only via `object==='page'` on IG route (`:109`) | shared | resolves as `instagram` — misattributed | mid | IG sender path — unverified | | | | | | |
| Web widget | `API/widget/session|message|stream` | site key hash + HMAC visitor token (`widget-token.ts:38-58`) | token hash | **none** on POST message | dashboard→visitor via polling only; **human_agent replies never shown** (CH-B06) | | | | `widget:<visitorId>` | broken | none |
| Email (Resend) | outbound only `LIB/mail.ts:16-57` | | | | transactional | | | | | | |
| Google Chat / Teams / Outlook / Voice | **not found** | | | | | | | | | | |
| Owner WhatsApp (control) | `WH/owner-whatsapp/route.ts:176` | Meta HMAC | `owner_whatsapp` meta; sender **suffix** match (`channel-normalize.ts:435`) | via persist | `sendChannelReply` | | | | | | |

## 2. Bugs

| ID | Sev | Where | What happens | Fix sketch | Status |
|---|---|---|---|---|---|
| CH-B01 | P1 | `LIB/failed-webhooks.ts:56-61`, `channel-outbound.ts:168-175`, `inbound-agent.ts:422-426` | Receipts update `WHERE chatwoot_msg_id = wamid`, but sends never capture the returned wamid → `updateMessageDeliveryStatus` always false; `delivery_status` dead. `webhooks.md:15` says 🟢. | Store `messages[0].id` from Graph response on the outbound row. | 🔴 |
| CH-B02 | P1 | `realtime-hub.ts:16-25` vs `API/stream/events/route.ts:7-32`, `WH/whatsapp:269-274`, `WH/rent-payment:174-179`, `conversations/page.tsx:184`, `employees/customer/page.tsx:83` | Schema drift: `message_status_updated`, `rent_charge_paid` dropped by hub allowlist; `conversation_takeover_updated`, `poll_sync` pass hub but map to generic `event` in the route → listener never fires; `work_item.updated` / `plan_updated` / `memory.updated` / `connector.health` routable but never published. | One `RealtimeEventType` union shared by hub, route, clients; exhaustive switch. | 🔴 |
| CH-B03 | P1 | `inbound-agent.ts:148-172`, `WorkItemWorkflow.ts:290-291` | Dashboard awaits `handle.result()` in-process for up to the 24h HITL wait. Process restart → approved reply persisted by the workflow but **never sent**. | Send inside a Temporal activity (guardedSend). | 🔴 |
| CH-B04 | P1 | `WH/gmail/route.ts:96-122,297` | `startHistoryId` = the notification's own id → history always empty → falls back to "last 5 messages" with no `labelIds=INBOX`; **sent mail is ingested as inbound**, `contactId = own mailbox` → agent replies to itself; new ids defeat dedupe. | Persist last historyId per mailbox; filter INBOX; skip `from == mailbox`. | 🔴 |
| CH-B05 | P1 | `API/widget/session/route.ts:39-45,52-60`, `channel-normalize.ts:254-260` | Session lookup by `contact_id = widget:<client visitorId>`; default `widget-visitor` merges **every anonymous visitor into one conversation** and mints a valid token for it; knowing another visitorId yields their transcript. | Server-generated id per session; never reuse client hint. | 🔴 |
| CH-B06 | P1 | `API/widget/message/route.ts:93-103`, `channel-outbound.ts:44-66,551-559`, `conversations/[id]/messages/route.ts:287-319` | `human_agent` rows filtered out of widget GET and `sendChannelReply('widget')` is `unsupported` → visitor never sees the human reply while API returns success. | Include non-internal `human_agent` rows in widget GET/stream. | 🔴 |
| CH-B07 | P1 | `realtime-hub.ts:130-138,141-144` | `pushRecent` on publish **and** on Redis echo → duplicate ring entries → duplicate events on `Last-Event-ID` reconnect. | Dedupe by `eventId`. | 🔴 |
| CH-B08 | P1 | `realtime-hub.ts:42-49` | `recentByOrg` never evicted → unbounded with tenant count. | LRU/TTL. | 🔴 |
| CH-B09 | P1 | `API/stream/events/route.ts:205-208` | `cancel()` sets `closed` but does not `unsubscribe()` → Redis handler leak if abort never fires. | Shared `shutdown()` from `cancel`. | 🔴 |
| CH-B10 | P1 | `API/widget/stream/route.ts:95-106` | `ensureReady()` inside `start()` after 200 sent → Redis down errors mid-flight instead of 503. | Check readiness before constructing stream. | 🔴 |
| CH-B11 | P1 | `rate-limit-core.ts:98-132`, `rate-limit.ts:55-70`; `WH/whatsapp:323-326` | Webhook/widget limits per-process in-memory (Redis only for `ask_ai`); 429 mid-batch makes Meta retry the whole batch. | Redis fixed window; never 429 Meta after persist — throttle fan-out instead. | 🔴 |
| CH-B12 | P1 | `conversations/[id]/messages/route.ts:180-186,304-317` | Human reply inserted before send; on 502 the row stays as sent with no failed status. | `delivery_status='failed'` on failure. | 🔴 |
| CH-B13 | P1 | `channel-normalize.ts:254-310`, `WH/whatsapp:356-400`; no unique index | Concurrent deliveries race on find-or-create → duplicate open conversations. | Partial unique `(org_id, contact_id) WHERE status<>'resolved'` + `ON CONFLICT`. | 🔴 |
| CH-B14 | P2 | `WH/google-calendar/route.ts:139-143,79` | Awaits Google sync inline before 200; raw driver error on throw. | Ack then Temporal. | 🔴 |
| CH-B15 | P2 | `WH/rent-payment/route.ts:20-33` | Stripe signature without `t` tolerance, no event-id dedupe → replayable. | Tolerance + `claimWebhookEvent` like `WH/billing:90-93`. | 🔴 |
| CH-B16 | P2 | `conversations/[id]/messages/route.ts:79-87` | Message history unbounded. | Keyset pagination. | 🔴 |
| CH-B17 | P2 | `conversations/route.ts:198`, `[id]/route.ts:146`, `messages/route.ts:342`, `WH/chatwoot:446` | Raw `err.message` in 500 bodies. | Generic + log id. | 🔴 |
| CH-B18 | P2 | `conversations/route.ts:152-164` | Two GROUP BY full scans per list call. | Cache/materialise. | 🔴 |
| CH-B19 | P2 | `conversations/[id]/route.ts:111` | `RETURNING *` lacks `channel_type` → event `channelType:'unknown'`. | Join channels. | 🔴 |
| CH-B20 | P2 | `conversations/page.tsx:161-163` | `needs_attention` event force-selects conversation, stealing focus. | Badge. | 🔴 |
| CH-B21 | P2 | `inbound-agent.ts:290-294` | Outbound idempotency claim **fails open**. | Fail closed for send/pay/sign. | 🔴 |
| CH-B22 | P2 | `widget-embed-src.ts:203-222` | Polling stops at 300 s; HITL-approved replies never appear; `/api/widget/stream` unused by the script. | SSE + fallback; resume on focus. | 🔴 |
| CH-B23 | P2 | `channel-normalize.ts:160-166` | Chatwoot inbox map `account_id=''` wildcard → collisions across accounts. | Require account id. | 🔴 |
| CH-B24 | P2 | `WH/chatwoot:217-229` | `conversation_status_changed` / `message_updated` ignored → resolve/edit never syncs. | Handle. | 🔴 |

## 3. Security

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| CH-S01 | **P0** | `WH/outbound/route.ts:14-18,37-43,69-72,95` | Single global `CHATWOOT_WEBHOOK_SECRET` + a conversation UUID lets a caller insert `human_agent` messages into **any org** and override `channel`/`recipient` → send WhatsApp/SMS from that org's credentials to arbitrary numbers. Per-org secret; no recipient override. | 🟡 |
| CH-S02 | P1 | `slack-interact.ts:49-57,66-69`, `WF/tools/slack.ts:84,92` | Signature proves origin = Slack, not the org's workspace; `orgId` from button payload. Any workspace on the same app can approve/reject another org's work item. Map `team_id` → org. | 🔴 |
| CH-S03 | P1 | `API/widget/session/route.ts:43-45` | Cross-visitor transcript exposure (CH-B05). | 🔴 |
| CH-S04 | P1 | `conversations/[id]/messages/route.ts:51-68`, `page.tsx:924-931` | Attachment `url` not scheme-validated → `javascript:` / `data:` hrefs rendered to operators. | 🔴 |
| CH-S05 | P1 | `API/conversations/**`, `API/stream/**` — no `rbac.ts` import | Any role (`auditor`, `billing`) can send customer replies, pause AI, resolve, create channels (`conversations/route.ts:222-238`). | 🔴 |
| CH-S06 | P1 | `API/integrations/whatsapp/route.ts:34-42`, `channel-outbound.ts:87-108`, `widget-embed.ts:113-118` | Plaintext `accessToken`, Chatwoot token, Twilio token, widget `site_key` in `channels.meta`; env `META_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` fallbacks send any tenant's replies through a **shared platform number**. | 🔴 |
| CH-S07 | P1 | `failed-webhooks.ts:30-39`, migration `117:7-27` | `org_id` never set → every DLQ row NULL org, invisible under FORCE RLS, no retention; raw bodies hold phone numbers/text; outbound failures log `to`+preview (`channel-outbound.ts:567-573`). | 🔴 |
| CH-S08 | P2 | `API/integrations/whatsapp:34-42`, `WH/whatsapp:294-302` | `wabaId` unverified; WABA fallback picks newest `connected_at` across orgs → WABA-only events claimable by another tenant. | 🔴 |
| CH-S09 | P2 | `channel-normalize.ts:435` | Owner phone `endsWith` suffix match. | 🔴 |
| CH-S10 | P2 | `API/widget/_lib.ts:121-131,155-159`, `app/embed/widget.js/route.ts:15-20` | No-Origin requests bypass allowlist; preflight always `*`; site key in `Authorization` from any DOM-reading script. | 🔴 |
| CH-S11 | P2 | `widget-token.ts:11` | Dev fallback secret if `NODE_ENV` misconfigured. | 🔴 |
| CH-S12 | P2 | `webhook-crypto.ts:78-83,95-99,184-186` | Non-production skips signatures entirely — staging unsigned. | 🔴 |
| CH-S13 | P2 | `WH/chatwoot:474-482` | Response echoes `org_id`, ids to the caller. | 🔴 |

## 4. Functional gaps

| ID | Gap | Evidence | Status |
|---|---|---|---|
| CH-G01 | WhatsApp templates / 24h window / opt-out | No template send, no window check (`channel-outbound.ts:144-186`); no STOP/DND anywhere | 🔴 |
| CH-G02 | Two-way parity | Slack approve/reject only; Messenger/Teams/Google Chat/voice absent; Gmail reply loses thread | 🔴 |
| CH-G03 | Unified inbox: tags, snooze, bulk, canned, CSAT, transcript export | Only `is_internal`, `assigned_user_id`, `unread_count`, `sla_deadline_at` (`091`); no tables; no bulk UI | 🔴 |
| CH-G04 | Human agent seat / handoff protocol | Takeover = `ai_paused_until` +2h/+24h; `assigned_user_id` not validated as member; no queue/presence routing | 🔴 |
| CH-G05 | SLA | `sla_deadline_at` only on API-originated customer messages; never in webhook persist; sweep does not touch conversations; no policy table | 🔴 |
| CH-G06 | Business / quiet hours | Only `guarded-send.ts:74-95`; webhook replies via `inbound-agent.ts:258-260` bypass quiet hours, budget, autonomy | 🔴 |
| CH-G07 | Delivery receipts | Dead (CH-B01) | 🔴 |
| CH-G08 | Retry / backoff / DLQ replay | 3 attempts, `400·2ⁱ` ms, no jitter, ignores `Retry-After` (`channel-outbound.ts:123-138`); no replay endpoint; `status='replayed'` never written | 🔴 |
| CH-G09 | Provider rate limits | None modelled | 🔴 |
| CH-G10 | Multi-number / multi-account per org | `UNIQUE (org_id, channel_type)` (`005:10-11`) → one WhatsApp number, one Gmail, one Twilio per org | 🔴 |
| CH-G11 | Channel health dashboard | `channel_logs` written, no per-org surface | 🔴 |
| CH-G12 | Outbound media | none on any channel | 🔴 |
| CH-G13 | Chatwoot native compatibility | Requires HMAC header stock Chatwoot does not send | 🔴 |

## 5. Enterprise readiness

| ID | Item | Reality / Evidence | Status |
|---|---|---|---|
| CH-E01 | Realtime across replicas | Redis fan-out ✅ (`event-bus.ts:409-517`); replay ring per-process → gap-fill misses other replicas' events | 🟡 |
| CH-E02 | Presence / typing | Operator presence via DB heartbeat (`stream/presence:66-93`); customer typing none | 🔴 |
| CH-E03 | Connection caps | No per-user/org SSE limit; no PUBLISH cap | 🔴 |
| CH-E04 | Webhook idempotency store | Only `messages.chatwoot_msg_id`; statuses/rent/gcal none; billing has `claimWebhookEvent` | 🔴 |
| CH-E05 | DLQ ops | Write-only; no retention | 🔴 |
| CH-E06 | Secret rotation | `*_PREVIOUS` for Meta/Chatwoot/Twilio/Nango; not `WIDGET_SESSION_SECRET`, `GMAIL_PUSH_TOKEN` | 🟡 |
| CH-E07 | Audit of channel actions | Human replies, takeover, resolve emit none; owner-WhatsApp approve does | 🔴 |
| CH-E08 | Ordering | Parallel deliveries reorder; no per-conversation sequence (`eventId` is `ts-rand`) | 🔴 |
| CH-E09 | Consent / TCPA | none | 🔴 |

## 6. Realtime / SSE specifics

- Redis down: `/api/stream/events` → 503 (`route.ts:75-80`); inbox falls back to 5 s polling; widget stream errors after 200 (CH-B10); `publish` swallows errors so webhooks still 200.
- Reconnect: client `1.5ⁿ` + jitter; server ring replay via `Last-Event-ID` with duplicate risk (CH-B07). Redis link reconnects and resubscribes ✅.
- Backpressure: `desiredSize` gating, pending cap 200; heartbeat 15 s; Redis PING 20 s.
- Isolation: topic `org:{id}`, payload `orgId` cross-checked ✅; presence payload embeds viewer names/emails.
- Auth: session cookie only; no RBAC.
- Live subscribers: **2 pages** open their own `EventSource` (`conversations/page.tsx:154`, `employees/customer/page.tsx:77`) — no shared hook; customer page listens to `work_item.updated`, which can never arrive.

## 7. Widget specifics

- Site key SHA-256 at rest **and** plaintext `site_key` in `channels.meta` (`widget-embed.ts:102,109-115`); visitor token HMAC 7-day TTL.
- Rate limits on `message` POST and `intent`; **none** on `session` POST, `message` GET, `stream` GET.
- Pack gate deny-all until a pack installed ✅. XSS: `textContent` ✅; `escapeHtml` dead.
- Polling stops at 300 s; SSE endpoint unused. Widget stream forwards any org event lacking `conversationId` (`stream/route.ts:104`).
- `[widget session started]` stored as a `user` message and shown in the inbox.

## 8. Dead / duplicate

- `WH/google-calendar/google-calendar/route.ts` byte-identical to `WH/google-calendar/route.ts`.
- `channel-normalize.ts:138-145` `resolveSingleOrgChannel` always null; `webhook-crypto.ts:36-57` `verifyChatwootSignature`/`verifyMetaSignature`/`metaAppSecret` unused.
- Two outbound stacks: `LIB/channel-outbound.ts` vs `WF/tools/{whatsapp,twilio,slack,gmail}.ts` + `guarded-send.ts` (different creds resolution).
- Two Gmail ingest paths: push webhook and `ReplySorterWorkflow.ts:25-31` polling.
- Inbound persist re-implemented in `WH/whatsapp:329-500` and `WH/chatwoot:264-449` instead of `persistInboundMessageWithClient`.
- `threadHeaders` param never supplied; `inbound-confirm.ts:22` re-export; `escapeHtml`.
- Docs overclaim: `webhooks.md:15`, `widget.md:13`, `conversations.md:11` (SLA).

## 9. Test coverage map

| Area | Present | Missing |
|---|---|---|
| Signature verification | none (only `check-phase3.js` signs Chatwoot) | HMAC / Twilio / OIDC / dual-secret |
| Webhook routes | `check-phase2/3.js` e2e scripts | route tests for statuses, org resolution, Gmail history, SMS, IG, owner, rent, gcal |
| Inbound persist / dedupe | none | contact race, dedupe, pause |
| Outbound | none for `channel-outbound.ts`; `gmail.test.ts` tool only | retry/429, IG 24h, creds |
| Inbound agent / HITL | `inbound-hitl.test.ts`, `critic-check.test.ts` | send claim, restart recovery |
| Realtime | `event-bus-resp.test.ts`, `check-two-replica-sse.js` | allowlist/route parity, ring dedupe, cancel cleanup |
| Widget | none | token forgery, origin, session merge |
| Conversations API | none | RBAC, pagination, URL validation |
| Slack interactions | none | team→org binding |

## 10. Fix order for this domain

1. **CH-S01** — per-org secret on `/webhooks/outbound`, no recipient override, RBAC; **CH-S02** — Slack `team_id`→org binding.
2. **CH-B05 / S03** — server-generated widget session ids; **CH-B06 / B22** — visitor sees human replies; SSE for widget.
3. **CH-S05 / E07** — RBAC + audit on conversations and stream routes.
4. **CH-B04** — Gmail history cursor + INBOX filter (stops self-reply loops); **CH-B01** — store wamid, revive receipts.
5. **CH-B03 + CH-G06 + CH-B21** — send from a Temporal activity through `guardedSend` (quiet hours, budget, autonomy, fail-closed idempotency).
6. **CH-B02** — one realtime event type union; shared `useRealtimeStream` hook (UI-G07); fix ring dedupe/eviction/cancel (B07/B08/B09).
7. **CH-S06 / S07** — encrypt channel tokens at rest; set `org_id` on DLQ rows; remove shared-number env fallbacks.
8. **CH-B13 + CH-B11** — unique open-conversation index; Redis-backed webhook limits; never 429 Meta after persist.
9. **CH-G01 / G10** — WhatsApp templates + 24h window + opt-out; multi-number per org (drop `UNIQUE(org_id, channel_type)`).
10. **CH-G03 / G04 / G05** — inbox tags/snooze/bulk/canned/CSAT, human seat protocol, SLA policy table + sweep.
