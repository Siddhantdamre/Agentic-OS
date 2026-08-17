# 11 — Channels and owner surfaces

Perception (inbound) and presentation (owner UI) are how the Brain OS
touches the world. This file lists every channel and surface, what
exists, and what to add.

---

## 1. Customer / counterparty channels

| Channel | Now | OS target | Notes |
|---------|-----|-----------|-------|
| WhatsApp Cloud API | Inbound persist + agent; outbound token expired | Full + templates + 24h window logic | Primary IN |
| Chatwoot-format webhook | Ingest only, **no agent** | Same WorkItemWorkflow | HMAC stays |
| Gmail | Tools, not inbound push | Gmail push → inquiry/ticket | |
| Web widget | none | Embeddable chat (org branded) | |
| Instagram DMs | none | Meta messaging | RE/ecom |
| Messenger | none | Meta | |
| SMS | none | Twilio/Exotel | US + missed-call IN |
| Voice / IVR | none | Transcribe → work item | |
| Slack (customer) | Slack is team alerts | Optional shared channel | |
| Teams | none | Enterprise | |
| Telegram | none | P2 | |
| GBP messages | stub executor | Inbound + reviews | RE |
| Web forms / Typeform | none | Webhook | |
| Portal emails | via Gmail if connected | Parser skills | RE P0 |
| In-app (customer portal) | none | Optional later | PM tenants |

**Rules that never change:**

- Verify signatures.
- Persist then 200 then Temporal.
- Resolve org from channel config, not body `org_id`.
- Media: store pointers; virus scan.
- Language: detect; reply in customer language if org enabled.

---

## 2. Owner surfaces (dashboard today → OS)

| Surface | Now | OS |
|---------|-----|-----|
| Home KPIs | Real SQL | + briefing narrative + attention |
| Ask AI | Live plan-confirm | + citations + @employee |
| Conversations | Live + SSE | Work items omnibox |
| Employees | CRUD + seed | Pack seeds, skill versions |
| Integrations | Nango truth | Registry + sync health |
| Analytics | Aggregates | Semantic metrics |
| Insight | Templates | Engine + actions |
| Settings | Partial | SSO, retention, confirm policies |
| Onboarding | Wizard | Pack install + warm-up real |
| **Brain / memory** | none | Inspector |
| **Listings / pipeline** | none | Pack UI modules |
| **Plans history** | in Ask AI | Global plans inbox |
| Mobile responsive | Phase 9 | Bottom nav |
| PWA / native | none | After web mobile |
| Owner WhatsApp | none | “Text your business” |
| Slack owner | tool | Briefing delivery |
| Email owner | none | Digest |

Design: keep shadcn + existing layout language
(`darex-frontend-architecture.md`). Packs add **modules**, not a
second app.

---

## 3. Realtime

Today: in-process EventEmitter, one Node process.

OS: Redis pub/sub (or Streams) topics `org:{id}`. Events:

- `needs_attention`
- `conversation_updated`
- `plan_updated`
- `memory.updated`
- `connector.health`
- `work_item.updated`

SSE endpoint stays for the browser; it subscribes to Redis. Multiple
dashboard replicas safe. Auth still `darex_session` + scoped org.

---

## 4. Voice of the owner

A distinct channel: the **owner’s** WhatsApp/SMS to Darex.

- Authenticate by registered number.
- Commands: “brief me”, “approve plan X”, “pause Emma”.
- Approvals for HITL when they are not at the laptop.
- Same confirm tokens as the PlanCard (plan id).

This is not the customer WhatsApp number. Mixing them is a security
bug.

---

## 5. Notification policy

Severity:

1. Emergency (PM gas leak, payment fraud signal) — push all channels.
2. HITL waiting — dashboard + owner WhatsApp if enabled.
3. Briefing — scheduled only.
4. Marketing — never notify owner per send.

Rate limit notifications per org. No 200 Slack messages for 200
tool calls.

---

## 6. Accessibility and mobile (Phase 9, still in OS)

- Sidebar → bottom tabs.
- `aria-live` on streams (already called out in roadmap).
- Non-color status.
- Confirm buttons keyboard reachable.

Brain OS that only works on a 27" monitor is a dashboard, not an OS.

---

## 7. Embeds for the customer website

- Chat widget: token scoped to org public key, **no** admin APIs.
- Listing ask-box: only `listings.search` + memory of that session;
  no `database_query`, no Drive.
- Review request links: after closed showing/order, confirm first.

Public embeds are a different threat model. Separate allowlist.

---

## 8. Alternatives in the world (instead of our channel/surface plan)

**What Darex does:** WhatsApp + Chatwoot ingest + dashboard SSE;
unify on WorkItemWorkflow; owner WhatsApp separate from customer.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Twilio Conversations / Flex** | One omnichannel API (SMS, WhatsApp, chat, voice) | Cost + US gravity; IN is Meta Cloud + Exotel | Twilio Conversations docs |
| 2 | **Chatwoot as the product** (fork/full) | Inbox UI, agents, labels, OSS | We wrap it thin; forking Chatwoot is a second app | KEEP in `15` §1 |
| 3 | **LiveKit Agents** for voice as primary | Realtime voice OS, Apache-2.0, MCP tools | Phase 17; text WhatsApp is the IN wedge | [livekit/agents](https://github.com/livekit/agents) |
| 4 | **Intercom Fin / Zendesk AI / Crisp** | Polished widget + help center RAG | Closed CX; we need CRM+listings+confirm | Intercom Fin; Crisp |
| 5 | **Papercups** OSS widgets | Embeddable chat without Chatwoot | Widget is later; inbox already exists | [papercups-io/papercups](https://github.com/papercups-io/papercups) |

**Five things to steal anyway**

1. Twilio Conversations data model → our `channel_key` on messages.
2. Chatwoot HMAC + 200-first — already required; wire **agent**.
3. LiveKit: owner voice briefing later; same WorkItemWorkflow.
4. Redis pub/sub — Phase 8, not in-process hub.
5. Public widget allowlist = no admin APIs on the embed token.

### Open-source GitHub — this file only (channels / voice / widgets)

Chatwoot KEEP → `15` §1 (thin gateway). Do not list it again as a competitor product here.

| Repo | Similar to | We take |
|------|------------|---------|
| [livekit/agents](https://github.com/livekit/agents) | Voice employee | Phase 17 |
| [livekit/livekit](https://github.com/livekit/livekit) | WebRTC SFU | Same |
| [papercups-io/papercups](https://github.com/papercups-io/papercups) | Embeddable widget | Public chat later |
| [baptisteArno/typebot.io](https://github.com/baptisteArno/typebot.io) | Website chat/forms | Listing ask-box |
| [botpress/botpress](https://github.com/botpress/botpress) | Bot studio + channels | Channel adapters, not studio |
| [mattermost/mattermost](https://github.com/mattermost/mattermost) | Team chat OSS | Owner Slack-like later |
| [RocketChat/Rocket.Chat](https://github.com/RocketChat/Rocket.Chat) | Omnichannel OSS | WATCH |
| [matrix-org/synapse](https://github.com/matrix-org/synapse) | Matrix homeserver | Federation WATCH |
| [element-hq/element-web](https://github.com/element-hq/element-web) | Matrix client | Owner surface later |
| [RasaHQ/rasa](https://github.com/RasaHQ/rasa) | NLU + dialogue | Classifier ideas; LiteLLM stays |
| [jitsi/jitsi-meet](https://github.com/jitsi/jitsi-meet) | Video rooms | Showing walkthrough later |
| [signalapp/Signal-Server](https://github.com/signalapp/Signal-Server) | Private messaging | **REJECT** unofficial WA clones (ToS) |
