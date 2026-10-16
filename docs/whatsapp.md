# WhatsApp integration and auto-reply: options and recommendation

Goal: a customer connects their WhatsApp, inbound messages get an automatic
reply from the right AI employee, with the same approval rules as every other
channel.

## 0. Built (2026-09-30): both connect options, swappable providers

`/connectors` -> WhatsApp now asks how to connect:

| Option | Provider id | Transport | Use for |
|---|---|---|---|
| Scan a QR code | `evolution` | Self-hosted Evolution API (WhatsApp Web), unofficial | Trials, small teams, no Meta account. WhatsApp can restrict numbers. |
| Official WhatsApp Business API | `meta-cloud` | Meta Cloud API, customer's token | Production. Templates, receipts, no ban risk. |

All WhatsApp code that names a transport lives in `packages/whatsapp-gateway`.
To replace or add one (a different gateway, another BSP), follow its README:
one provider folder plus one registry line. Sending, the agent tool and the
inbound pipeline are provider-neutral.

Flow for QR: modal -> `POST /api/integrations/whatsapp/evolution` creates the
org's Evolution instance and returns the QR -> the modal polls
`GET .../evolution` -> phone scans -> Evolution posts `connection.update` to
`/api/webhooks/whatsapp-evolution` -> channel is `connected`. Customer
messages arrive on the same webhook, are saved by the shared
`ingestWhatsAppInbound`, and the assigned AI employee replies through the
gateway. Run the stack with `infra/scripts/compose-cmd.sh`; the `evolution`
service reads `EVOLUTION_API_KEY`, and the dashboard needs `EVOLUTION_API_URL`,
`EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_URL`, `EVOLUTION_WEBHOOK_SECRET`
(see `.env.example`).

Licence: Evolution API is Apache-2.0 with an attribution condition. The QR
modal shows "powered by Evolution API"; keep it. Details and what was verified
live are in `BUILD_STATE.md`.

### Where each login's connection and tokens live

A workspace can link several WhatsApp numbers; each is one `channels` row (`account_key` '' is the primary) under row-level security. The Meta token is
encrypted with `CHANNEL_SECRETS_KEY` before it is stored and opened only when a message is sent; the UI
only ever gets a hint and the number. QR links keep one Evolution instance per number (`darex-<org>` for the primary, `darex-<org>-<key>` for extras), with the session in
its own schema and volume. Back up `CHANNEL_SECRETS_KEY` with the database.

### Reply modes (both options)

Beyond the mode, the owner writes instructions (used by the AI employee and the simple AI), picks who gets
replies (everyone, only an allow list, or everyone except a block list) and on which messages (every
message or only the first of a new conversation). People who get no reply are still saved for the team. In agent mode the owner also picks which AI employee
answers (automatic prefers the customer or support employee). Other options: business hours (away message
or open-hours only, in the business timezone), how long the AI stays quiet after a teammate replies, and
whether voice notes and images are read. In agent mode an optional waiting note tells the customer a
teammate will follow up when the AI holds its answer for your approval.

After connecting, and any time from the WhatsApp card, the owner picks how replies work:
AI employee (full agent, default), Simple AI reply (business info you write, no agent, no tools),
Fixed message (once per customer per cooldown), or Off. Voice notes and images are read for
both providers. On the official API a closed 24-hour window is reported clearly and can fall back
to an approved template. "Continue with Facebook" (Meta Embedded Signup) appears once the Meta app
env vars are set; it is blocked on a Meta app and has not run against Meta.

Sections 1 to 4 below are the research and gap analysis that led here; the
gap list in section 1 is mostly closed (media reading, 24-hour window, Embedded Signup code).
Still open: a live Meta test and a real Meta app for Embedded Signup.

## 1. What already exists in this repo

The official Meta WhatsApp Cloud API path is already built. I read the code;
I did not run it against a live Meta account here.

| Piece | Where | What it does |
|---|---|---|
| Connect (BYOK) | `apps/dashboard/app/api/integrations/whatsapp/route.ts` | Customer pastes a System User access token, phone number id and WABA id. `pingWhatsApp` checks them against Meta, then the row is saved in `channels` and `org_connectors`. Needs the connector-manager role and writes an audit entry. |
| Inbound webhook | `apps/dashboard/app/api/webhooks/whatsapp/route.ts` | `GET` answers Meta's verify challenge (`VERIFY_TOKEN`). `POST` checks the Meta signature, resolves the org from `phone_number_id` or WABA id (never guesses across tenants), dedupes on wamid, saves the conversation and message, rate-limits per org, and returns 200 fast. |
| Auto-reply | `apps/dashboard/lib/inbound-agent.ts` (`fireInboundAgent`) | Picks the conversation's employee, applies that employee's tool allowlist and persona, runs the agent (Temporal workflow or direct), and sends the reply back through the Cloud API. Inbound is always a single employee, never a crew. |
| Human takeover | `conversations.ai_paused_until` | While set, the webhook saves the message but skips the agent. |
| Delivery status | `messages.chatwoot_msg_id` + `delivery_status` | Sent/delivered/read/failed receipts match rows by wamid. |
| Chatwoot inbox | `apps/dashboard/app/api/webhooks/chatwoot/route.ts`, `infra/docker-compose.yml` | Chatwoot fork acts as the multi-channel inbox gateway. |
| Owner number | `webhooks/owner-whatsapp` | A separate number for the business owner, kept apart from the customer number. |
| Billing meters | `DAREX_METER_WHATSAPP_SOFT/HARD` in `.env.example` | Usage limits for WhatsApp. |

`BUILD_STATE.md` records a live end-to-end run (WhatsApp inbound, Temporal,
real LLM, AI reply saved) as 5/5 passing, but also says "No live Meta send or
receipt exercised" for the delivery-status work.

### Known gaps to close for a real "connect and it works" product

1. **Connecting is manual.** The customer must create a Meta app, a System User
   token and a WABA by hand. There is no Embedded Signup (Meta's "Log in with
   Facebook" flow that provisions the number for them). This is the biggest
   onboarding hurdle.
2. **Webhook URL is set by hand** in the Meta console. Embedded Signup can
   subscribe the app to the WABA automatically.
3. **Media is metadata only.** Voice notes and images are stored with
   `transcript: null`, so the employee cannot read or hear them.
4. **24-hour window and templates.** The Cloud API only allows free-form
   replies within 24 hours of the customer's last message. After that, only
   approved templates. Check that the outbound path handles the rejection
   and does not report success.
5. ~~No QR-scan option~~ Added (section 0).
6. Human-only blockers (Meta app review, business verification, real token)
   stay marked 🔴 in the gap docs, never faked.

## 2. The open-source options

Two families exist. The split that matters is how they reach WhatsApp.

- **Official Cloud API.** Compliant, no ban risk, needs a Meta Business account
  and a number registered to the Cloud API. Per-conversation fees go to Meta.
- **Web emulation (Baileys, whatsapp-web.js).** Scan a QR code and it acts like
  WhatsApp Web. No Meta approval needed. Violates WhatsApp's terms and the
  number can be banned. Do not put a customer's main business number on it.

| Project | Type | Connection | License | Fit for us |
|---|---|---|---|---|
| **Meta Cloud API** (current) | Official API | Official | n/a (Meta service) | **Keep as the core.** Already built. |
| **Chatwoot** | Support inbox | Official Cloud API (or Twilio) | MIT (community) | **Already in the stack.** Use for human handoff and shared inbox. Not a sales CRM. |
| **wacrm** (the "AWCRM" you mean, most likely) | WhatsApp CRM: inbox, contacts, kanban pipelines, broadcasts, automations | Official Cloud API | MIT | Do not adopt. It duplicates our conversations, contacts and workflows. Read it for ideas (broadcasts, pipeline UI). |
| **Vocero CRM** | CRM with AI-agent sandbox | Official Cloud API | MIT | Do not adopt. Young project (mid 2026), thin English docs, same overlap. |
| **Frappe CRM** | CRM inside the Frappe/ERPNext stack | Official Cloud API | Open source | Skip. Needs the whole Frappe framework. |
| **Whatomate** | Messaging, WhatsApp calling, IVR | Official Cloud API | Open source | Skip unless we want voice/IVR later. |
| **Evolution API** | REST gateway | Both: Baileys and official Cloud API | Open source | **Best optional add-on** if we want a QR-scan mode. It also has built-in Chatwoot, Typebot, n8n, Dify and OpenAI hooks. Run it self-hosted; you own reconnects and updates. |
| **WAHA** | REST gateway (Docker) | WEBJS, NOWEB and GOWS engines, plus the Cloud API in newer builds | Free core, paid "Plus" tier (check the license before use) | Alternative to Evolution. Same ban risk in emulation modes. |
| **OpenWA** ("waopen" is most likely this) | Gateway with dashboard, multi-session, Chatwoot and Typebot plugins | Web emulation | Open source | Skip. Emulation only, small project. |
| **WaSphere** | Multi-account QR UI | Baileys | MIT | Skip. High ban risk. |
| **Baileys / whatsapp-web.js** | Libraries | Web emulation | MIT / Apache | Only ever behind a gateway, never called directly from our code. Baileys is the lighter (about 50 MB RAM, no browser). |

I matched "awcrm" to wacrm and "waopen" to OpenWA. Tell me if you meant other
projects.

## 3. Recommendation

1. **Keep the Meta Cloud API as the one production path.** It is already wired
   to the AI employees, tool allowlists, approvals and audit log. No open-source
   project above adds anything the agent runtime lacks.
2. **Use Chatwoot** (already present) for human handoff, not a second CRM.
3. **Do not adopt wacrm, Vocero, Frappe CRM or OpenWA.** They bring their own
   contacts, inbox and automation, which would fight our conversations and
   workflow engine.
4. **Evolution API as the opt-in "QR mode"** for customers with no Meta
   account, clearly labelled as unofficial with ban risk. Done: same `channels`
   row, same `fireInboundAgent`, only the transport differs.
5. **Fix the real gaps first** (section 1), in this order:
   1. Embedded Signup, so connecting is one click.
   2. Voice-note transcription and image reading.
   3. 24-hour window and template handling on outbound.
   4. Live send-and-receipt test with a real Meta number.

## 4. How to check it works (auto-reply)

1. Set `VERIFY_TOKEN`, the Meta app secret and `WHATSAPP_PHONE_NUMBER_ID` in
   `.env`.
2. Expose the dashboard over HTTPS (tunnel in dev) and set the Meta webhook URL
   to `https://<domain>/api/webhooks/whatsapp` with the `messages` field
   subscribed.
3. Connect WhatsApp from `/connectors` with the token, phone number id and WABA id.
4. Message the number from a phone. Expect a conversation in `/conversations`
   and an AI reply in the chat.
5. Check the reply carries a wamid and `delivery_status` moves past `sent`.
6. Set `ai_paused_until` on the conversation and confirm no reply is sent.

## Sources

- [Best open-source and self-hosted WhatsApp CRMs in 2026](https://wacrm.tech/blog/best-open-source-whatsapp-crm)
- [wacrm on GitHub](https://github.com/ArnasDon/wacrm)
- [Evolution API](https://github.com/evolution-foundation/evolution-api)
- [Evolution API alternatives in 2026](https://www.indiehackers.com/post/best-10-evolution-api-alternatives-in-2026-tested-9fc702d744)
- [OpenWA](https://github.com/rmyndharis/OpenWA)
- [Baileys vs whatsapp-web.js](https://www.libhunt.com/compare-Baileys-vs-whatsapp-web.js)
- [Open-source WhatsApp integration APIs](https://www.sobot.io/article/open-source-whatsapp-integration-apis/)
