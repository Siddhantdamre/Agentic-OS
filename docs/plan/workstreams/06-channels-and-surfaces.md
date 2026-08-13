# Workstream 06 — Channels and surfaces

Perception (inbound) and presentation (owner UI). Rules that never
change: verify signatures; persist then 200 then Temporal; resolve
org from channel config, not body `org_id`.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/06-e2e-webhooks-inbox.md`,
`09-dashboard-pages.md`, `16-updates-2026-08-13.md`.

- WhatsApp: GET verify; POST persist + SSE + `fireInboundAgent`;
  `X-Hub-Signature-256`. Outbound Graph **401** until token
  rotation (expired 2026-06-12).
- Chatwoot: HMAC; org via query/bearer/header/single-org; **does**
  start the agent. Future-scope `11` “ingest only” is stale.
- Inbox `:3004` is an HMAC Express proxy. Outbound →
  `/api/webhooks/outbound` — **done**.
- SSE hub is in-process, one Node process.
- Settings Meta vs Chatwoot URLs — **done**.
- No Instagram, SMS, voice, widget, Gmail push, owner WhatsApp,
  `/brain`, listings modules, mobile/a11y.

---

## 2. Target

Sources: `docs/future-scope/11-channels-and-surfaces.md`,
`13` Phases 8/9/13/17.

Customer: WhatsApp full + 24h window; Chatwoot on WorkItemWorkflow;
Gmail push; widget; Instagram; SMS; voice later; GBP; forms;
portal email parse.

Owner: briefing Home; Ask AI + citations; work-item omnibox; Brain;
listings modules; owner WhatsApp on a **distinct** number; mobile.

Realtime: Redis `org:{id}`. Public embeds: no admin APIs.

---

## 3. Gaps

WhatsApp inbound **done**; outbound **ops-blocked**. Chatwoot +
inbox send + settings URLs **done**. Redis bus, new channels,
owner WhatsApp, widget, mobile **missing**.

---

## 4. Work items

### H1 — Rotate Meta token + Console webhook

- **What:** Reissue token; set Console URL; re-run `e2e-live-llm.js`.
- **Where:** env + Meta UI.
- **DoD:** Outbound Graph 200. Token not in git.

### H2 — Unified `channel_key` on messages

- **What:** Stop special-casing WhatsApp vs Chatwoot.
- **Where:** migration; webhook handlers; inbox UI.
- **Depends on:** O1 helpful.
- **DoD:** Inbox filters by channel without a new page per channel.

### H3 — Gmail push + portal email parse

- **What:** Gmail watch → work item. Parse portal emails the org
  already received. Not a scrape.
- **Depends on:** O2, Gmail re-connect.
- **DoD:** Real forwarded lead email creates an inquiry.

### H4 — Instagram / Exotel or Twilio SMS

- **What:** Same persist → 200 → WorkItemWorkflow. Signatures
  required.
- **Depends on:** H2, O2, C6.
- **DoD:** Bad signature → 401. Org from channel config.

### H5 — Owner WhatsApp (distinct number)

- **What:** “brief me”, “approve plan X”, “pause Emma”. Must not
  mix with customer WABA.
- **Depends on:** O5, O7, H1.
- **DoD:** Owner approve unblocks the same plan id. Customer
  inbound cannot invoke owner commands.

### H6 — Public chat widget (later)

- **What:** Public token. Allowlist: session + listings.search.
  No `database_query`, no Drive.
- **DoD:** Stolen embed token cannot call admin APIs.

### H7 — Redis SSE (with workstream 11)

- **What:** Hub publishes to Redis. Two replicas both toast.
- **DoD:** Phase 8 two-replica exit. Cookie auth unchanged.

---

## 5. End-to-end connections

Orchestration (02) handles work. Memory (03) prefixes inbound.
Security (07) pauses risky webhook sends. Dashboard (09) is the
owner surface. Infra (11) is the bus.

---

## 6. Non-goals

Forking Chatwoot; unofficial WhatsApp clones; mixing owner and
customer numbers; voice as launch; notify-per-tool-call.

---

## 7. Verification

Keep Phase 3 (6/6) and `e2e-live-llm.js`. New channels: signature
401; two-org isolation; honest notConnected on send.

Related: [02-orchestration-and-workflows.md](./02-orchestration-and-workflows.md),
[09-dashboard-ux-and-ask-ai.md](./09-dashboard-ux-and-ask-ai.md),
[11-infra-deploy-and-ops.md](./11-infra-deploy-and-ops.md).
