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
