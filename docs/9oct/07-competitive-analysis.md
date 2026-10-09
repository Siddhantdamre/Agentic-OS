# 07 — Competitive analysis: Darex / DareXAI One vs the AI assistant and AI workforce market

> Observed: 2026-10-09. Scope: 22 named competitors plus two CRM-native agent
> suites (Salesforce Agentforce, HubSpot Breeze) that SMB buyers compare us to.
> Companion plan: `08-beat-grok-and-leaders-plan.md`.

---

## 0. How to read this document

**Evidence rules.**

- Every competitor fact carries a source. "Official" means the vendor's own
  page, docs, help centre or press release. "3P" means a third-party review,
  aggregator, analyst or news report.
- **UNVERIFIED** marks a claim that rests on one weak source, where sources
  disagree, or where the official page could not be read on 2026-10-09 (several
  pricing pages returned HTTP 403 or rendered client-side only).
- Prices are list prices in USD unless stated, as observed on the date given.
  AI pricing changes monthly. Re-check before quoting any number to a customer
  or investor.
- Nothing here was benchmarked hands-on. Statements about quality ("best",
  "strongest") are judgements from documentation and reviews, not test results.

**Darex rules.**

- "Darex today" means what is in the code on `main` as of 2026-10-09, using
  `AGENTS.md`, the top of `BUILD_STATE.md`, `docs/new-109-pg-plan/gap26sept/`
  and direct reads of the source. Where the repo says "not verified live", this
  document repeats that caveat.
- Where a capability exists only as UI (for example the chat microphone), it is
  marked **UI only**, not counted as shipped.
- Existing positioning material was used as input and is not repeated in full:
  `docs/how-we-are-differennt/us-vs-everyone-else.md`,
  `docs/how-we-are-differennt/how-we-are-different.md`,
  `docs/grok-bot/*`, `docs/new-109-pg-plan/competitors/competitor-analysis.md`,
  `docs/new-109-pg-plan/payment/payment-plans.md`.

**Legend used in the matrices.**

| Mark | Meaning |
|---|---|
| ✅ | Shipped and documented (for Darex: in code and wired) |
| 🟡 | Partial, beta, preview, add-on only, higher tier only, or Darex code that is built but not proven live |
| ❌ | Not offered / not found |
| ❓ | Could not verify |
| UI | Darex: control exists in the UI but does nothing real yet |

---

## 1. Executive summary

1. **The market split into four camps in 2025–2026, and Darex sits in the gap
   between them.**
   - *Frontier assistants* (Grok, ChatGPT, Claude, Gemini, Microsoft Copilot)
     own the consumer and knowledge-worker front door. They are adding
     connectors, scheduled tasks, cloud computers and "teammate" agents fast.
     xAI's Grok Bot (beta, 2026-08-11) and OpenAI's ChatGPT Work (2026-07-09,
     3P) are the clearest moves toward "AI that finishes work".
   - *General autonomous agents* (Manus — now part of Meta, Genspark, Lindy)
     sell task execution on a cloud computer, priced in credits.
   - *Builder platforms* (Relevance AI, Dust, Glean, Zapier, n8n, Copilot
     Studio) sell the parts; the customer assembles the agents.
   - *Single-function AI employees* (Artisan, 11x for sales; Fin, Decagon,
     Sierra, Agentforce, Breeze for customer service) sell one job, often at
     enterprise prices.

2. **Nobody in the set ships all of these together for an SMB:** ready-made
   role-based employees, one shared company memory, a single chat front door,
   real write actions in business systems, an approval ladder before risky
   actions, durable execution, and customer-facing WhatsApp. Sintra comes
   closest on framing and price but is shallow (250 credits a month, "15+"
   integrations, no WhatsApp). Relevance AI comes closest on depth but moved
   upmarket and requires building. That combined lane is Darex's position.

3. **Darex wins today on control and business depth:** plan-confirm-execute,
   autonomy tiers, per-employee tool allowlists, row-level tenant isolation,
   honest "not connected" failures, Temporal durability, WhatsApp (QR and Meta
   Cloud) plus Instagram, Gmail, Outlook and Slack read-and-reply from chat, a
   real-estate vertical pack, and 154 chat tools across ~40 provider modules.

4. **Darex loses today on the "assistant basics" every frontier product treats
   as table stakes:** file and image understanding in chat (the attach button
   is UI only), voice (the mic is a mock), deep research with citations,
   user-created scheduled tasks from chat, a mobile app, shareable artifacts
   (docs, slides, sheets, pages), model choice and frontier-model quality (the
   default route is `gemini-2.5-flash-lite` with a Groq `gpt-oss` fallback),
   and browser/computer use for apps with no API. It also loses on
   distribution, brand, funding and proof (none of its channels is proven at
   scale with paying customers).

5. **Biggest threats, in order:**
   - ChatGPT Work plus the Plugin Directory and scheduled tasks — the default
     tool an SMB owner already pays for.
   - Grok Bot / Grok Business — closest product concept (named teammates,
     routines, approvals, cloud computer), bundled into subscriptions people
     already have.
   - Gemini Enterprise Business edition and Microsoft 365 Copilot Business —
     free-ish upgrades inside the suite an SMB already runs.
   - Genspark Claw — the only general agent with WhatsApp, Telegram and LINE as
     native channels, a 24/7 VM and shared memory, from about $40 a month (3P).
   - Salesforce + Fin (about $3.6B, pending close) — a cheap, self-serve
     support agent at $0.99 per outcome with an SMB mandate.

6. **The pricing story needs one answer.** Internal documents disagree:
   `us-vs-everyone-else.md` advertises $49 / 10,000 credits and $99 / 30,000
   credits, while `payment-plans.md` defines Starter $99, Growth $299, Scale
   $799 and Enterprise from $2,499. Market anchors are: Sintra about $16–49,
   Manus $20, Genspark Plus about $25, Lindy from $29.99, Grok Business $30 per
   seat, Claude Team $25 per seat, Fin $0.99 per outcome with a ~$50 floor,
   HubSpot Customer Agent $0.50 per resolution. See section 6.

---

## 2. Darex today — the baseline used in every comparison

### 2.1 What Darex is

A multi-tenant SaaS where specialised AI employees (Growth, Customer,
Operations, plus the roster: Executive, Customer Support, Sales & Lead Gen,
Marketing & Analytics, Research, Finance, and org-custom employees) share one
brain (memory and connectors). Ask AI chat is the front door. Risky actions
need approval. Backend: `apps/dashboard` (Next.js 15 API), agent runtime in
`services/workflows` (TrueForge engine, Temporal worker, MCP bridge). UI:
`NEW-FRONTEND/` (separate repo).

### 2.2 Capability inventory with evidence

| Area | State | Evidence / notes |
|---|---|---|
| Ask AI chat, streaming | ✅ | `apps/dashboard/app/api/ask-ai/`, `NEW-FRONTEND/src/app/(app)/chat/page.tsx` |
| Plan → confirm → execute with editable steps, parallel stages, cancel | ✅ | `lib/plan-generator.ts`, `ask-ai-plan-execution-state.ts`; audited (`plan.cancel`, `plan.step_edit`, migration 207) |
| Employee mode selector (Auto / Pick one / Team) and `@Name` | ✅ | `lib/ask-mode.ts`, `ask-mode-selection.ts`, `employee-mentions.ts` |
| Crew (manager + up to 3 parallel specialists, synthesis) | ✅ | `services/workflows/src/workflows/` CrewWorkflow, `crew-runner.ts`, cap 3 |
| Chat tool count | ✅ 154 chat tools | `gap26sept/chat-coverage.md` (generated 2026-10-09); every row still 🔴 "not proved live" |
| Provider tool modules | ✅ ~45 | `services/workflows/src/tools/`: Gmail, Google Calendar/Drive/Sheets/Slides/Forms/Tasks/Meet/Chat/Ads/Analytics/Search Console/Business Profile/Cloud, Outlook, Microsoft Calendar, HubSpot, Salesforce, Zoho, Stripe, Razorpay, QuickBooks, Shopify, Zendesk, Intercom, Slack, Notion, GitHub, Twilio, LinkedIn, Meta Ads, Instagram, WhatsApp, DocuSign, Leegality, Apollo, Maps, web search, web extract, database (read-only), file ops, sandbox, Cognee |
| Connector auth | 🟡 | Nango OAuth. Only Google/Meta/GitHub have real client IDs; HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Microsoft, Salesforce need registration (`AGENTS.md` §4, `gap26sept/00-summary.md` P1) |
| Honest failure when not connected | ✅ | Rule 4 in `AGENTS.md`; `connected:false` + connect URL |
| WhatsApp (Meta Cloud + Evolution QR), multi-number, auto-reply modes, voice-note transcription, image description, 24h window | ✅ built / 🟡 live | `apps/dashboard/lib/whatsapp-*.ts`, `packages/whatsapp-gateway`; real phone scan and real Meta number "not proven yet" |
| Instagram DMs read/reply from chat | ✅ built / 🟡 live | `tools/instagram.ts` (BUILD_STATE 2026-10-09; not verified against a real account) |
| Gmail read/search/reply/reply-all/draft | ✅ built / 🟡 live | `tools/gmail.ts` (BUILD_STATE 2026-10-05/06) |
| Outlook, Slack read/reply | ✅ built / 🟡 live | `tools/microsoft-outlook.ts`, `tools/slack.ts` |
| Web widget, Chatwoot inbound | ✅ | `app/api/widget`, `app/api/webhooks` |
| SMS / phone voice agent | 🟡 / ❌ | Twilio tool for SMS; no real-time voice phone agent |
| Memory | ✅ | Postgres + pgvector hybrid retrieval, Cognee knowledge graph (`memory/cognee-client.ts`), Hindsight agent memory; per-org datasets; role-scoped learning; Company Brain page |
| Brain search in UI | 🟡 | P0 #10: UI search is keyword-only while the agent uses hybrid vector |
| Autonomy tiers, approvals, tool gate | ✅ backend / 🟡 UI | `services/workflows/src/tool-gate.ts`, `autonomy.ts`; P0 #5/#6 say the autonomy tab lacked tier editing and approve/reject (check tracker for closure) |
| Audit log | ✅ | `audit_events`, 150 kinds, append-only; UI page was P0 #2 |
| Tenant isolation | ✅ | RLS on every table, `getScopedClient()`, org from session only |
| Durable execution | ✅ | Temporal workflows, idempotency keys on Stripe writes |
| Scheduled work | 🟡 | Built-in periodic sweeps (`periodic-registry.ts`: morning triage, lead search, buying signals etc.). **No user-created scheduled task or routine from chat** |
| Web search | ✅ | `web_search` (SearXNG and other providers in `tools/search-providers.ts`) + `web_extract` (Crawl4AI). Snippet-level answers |
| Deep research (multi-step, cited report) | ❌ | Priced in `payment-plans.md` (20 credits) but no deep-research workflow exists |
| Citations | 🟡 | Memory answers cite records; web answers are written from snippets with no standard citation UI |
| File / image upload in chat | **UI** | `NEW-FRONTEND/src/components/ui/chat-bar.tsx`: file is validated, its *name* is shown, but `onSend(text)` sends text only |
| Knowledge file upload | ✅ | `components/settings/knowledge-files.tsx`, `knowledge-library.tsx` → ingestion jobs |
| Voice input in chat | **UI** | `chat-bar.tsx` mic inserts a fixed sample string ("Text the mock microphone hears") |
| Voice output / live voice | ❌ | — |
| Image generation | ❌ | — |
| Document generation | 🟡 | Via Google Docs/Sheets/Slides tools when Google is connected; no native artifact or export |
| Shareable artifacts / public links | ❌ | — |
| Model choice / routing | 🟡 | LiteLLM with one alias `darex-default` → `gemini/gemini-2.5-flash-lite` / `gemini-flash-lite-latest`, fallback `groq/openai/gpt-oss-120b` / `-20b` (`infra/litellm/config.yaml`). No per-task routing, no user-visible model picker, no frontier reasoning model |
| Browser / computer use | ❌ | No Playwright/Browserbase agent; `web_extract` only reads pages |
| Code / data analysis | 🟡 | `tools/sandbox.ts` and read-only SQL (`tools/database.ts`) |
| Mobile app | ❌ | Web only; no PWA manifest in `NEW-FRONTEND/public`; web push exists (`lib/web-push-notify.ts`) |
| Daily brief to Slack / WhatsApp | ✅ | `tools/daily-brief.ts`, `app/api/brief` |
| Vertical pack | ✅ | Real-estate: listings, showings, inquiries, rent reminders (`app/api/{listings,showings,inquiries,rent-reminders}`); licensed MLS client still a human blocker |
| Billing | 🟡 | Stripe/Razorpay, credit metering; P0 #9 says the usage cap was computed but not enforced (BUILD_STATE says direct agent routes now capped) |
| Auth / SSO / MFA / email verification | ✅/🟡 | SuperTokens, TOTP (`lib/totp.ts`), SSO fail-closed, opt-in email verification (migration 209) |
| GDPR export/delete | ✅ backend / 🟡 UI | `services/workflows/src/dsr`; knowledge-graph part not covered |
| Observability | ✅ | Langfuse traces for dashboard and worker turns, cost per org |
| Compliance certifications | ❌ | No SOC 2 / ISO 27001 |
| Platform admin console | ✅ | `NEW-FRONTEND/src/app/(platform)/admin/*` |

### 2.3 Frontend surfaces (what a user can click)

| Route | What it does |
|---|---|
| `/home` | Briefing, KPIs, what the employees did |
| `/chat` | Ask AI front door: modes, plan cards, approvals, tool results |
| `/ai-employees` | Roster, per-employee settings, crew spawn |
| `/conversations` | Unified inbox across WhatsApp, Instagram, widget, email |
| `/actions` | Pending decisions and approvals |
| `/plans` | Plan list and status |
| `/opportunities` | Growth employee's leads and signals |
| `/insights`, `/insights/plans`, `/insights/observability` | Analytics, plan history, cost and health |
| `/integrations` | Connectors (Nango) |
| `/settings/[tab]` | Org, team, autonomy, knowledge, channels, billing |
| `/onboarding/*` | Guided setup and pack install |
| `/admin/*` | Platform operator console (orgs, users, billing, flags, audit, health) |

### 2.4 Honest one-line read

Darex is deep where business operators need trust (approvals, isolation,
durability, real write actions, WhatsApp) and thin where consumers judge an
assistant in the first five minutes (talk to it, drop a file on it, ask it to
research something, get a nice document back, use it on a phone).

---

## 3. Market map

| Camp | Members in this report | What they sell | Typical SMB price point | Threat to Darex |
|---|---|---|---|---|
| Frontier assistants | Grok, ChatGPT, Claude, Gemini, Microsoft Copilot | A general assistant with connectors, research, files, voice, scheduled tasks and, increasingly, a cloud computer | $20–30 per seat per month | **High**: already paid for, improving monthly |
| General autonomous agents | Manus (Meta), Genspark, Lindy | Task execution in a VM or with integrations, credit-metered | $20–40 per month entry, credits on top | **High** (Genspark Claw, Lindy) / Medium (Manus) |
| AI workforce builders | Relevance AI, Dust, Copilot Studio | Platform to build and govern many agents | Seat or credit; Relevance now sales-led | Medium |
| Knowledge platforms | Glean, Dust | Permission-aware search plus agents | Glean ~$50K+/yr minimum (3P) | Low for SMB |
| Automation platforms | Zapier Agents, n8n | Triggers + actions + DIY agents | $20–70 per month | Medium: they own "connect 9,000 apps" |
| SMB "AI employees" | Sintra | Persona helpers with shared brand memory | $16–49 per month | Medium: same pitch, cheaper |
| Sales AI employees | Artisan, 11x | Outbound SDR, inbound phone | $7K–64K+ per year | Low–medium (different budget) |
| CX agents | Fin, Decagon, Sierra, Agentforce, HubSpot Breeze | Customer-service resolution, outcome-priced | Fin $0.99/outcome; Breeze $0.50/resolution; Decagon/Sierra six figures | Medium (Fin, Breeze), Low (Decagon, Sierra) |

---

## 4. Competitor profiles

Each profile uses the same headings: positioning, key features, integrations,
memory, autonomy and agents, pricing, strengths, weaknesses for an SMB owner,
and what it means for Darex.

### 4.1 xAI Grok (Grok app, Grok in X, Grok Business, Grok Bot)

**Positioning.** A frontier assistant with real-time access to X data, sold to
consumers through X Premium and SuperGrok, to teams through Grok Business, and
— since August 2026 — a separate "AI teammates" product, Grok Bot, that runs
persistent agents on a cloud computer.

**Key features.**
- Grok app on web (grok.com), iOS and Android, conversations synced across
  devices; "Talk to Grok" hands-free voice; Grok Imagine for image and video;
  file upload for PDFs, images, spreadsheets, code and audio (docs.x.ai/grok/overview, official).
- Real-time X data is the defining differentiator in reviews (3P: ai-toolbox.co, suprmind.ai).
- Projects use the Collections API for agentic search over large document
  stores; answers from Drive include citations with quote previews (x.ai/news/grok-business, official, 2025-12-30).
- Heavy tier exposes the multi-agent "Grok 4 Heavy" mode (3P). Model naming
  per tier moves quickly (sources cite Grok 4.3 and 4.5 in mid-2026; UNVERIFIED).
- **Grok Bot** (early beta, announced 2026-08-11): named Bots with a job
  description and their own memory, running on a persistent cloud VM (Chrome,
  terminal, `/workspace`); connectors first, computer use as fallback; Skills
  (`/`), Routines on schedule or event (up to 50 per Bot), group chats of 2–6
  Bots, Bot-to-Bot messaging, "watch me once" screen-recording to draft a
  skill, approvals (allow once / create rule / deny) plus an "Auto Review"
  model; desktop (macOS, Windows, Linux) and iOS clients (docs.x.ai/grok-bot/overview official; internal notes in `docs/grok-bot/`; 3P: unite.ai, eesel.ai, composio.dev).
- Team Bots announced 2026-09-28 as a public beta for Teams and Enterprise
  (internal notes; 3P only, UNVERIFIED). Enterprise access with org, network
  and audit controls reported from 2026-09-03 (3P, UNVERIFIED).
- Scheduled "Tasks" inside the main Grok app: **could not verify** in this
  pass (❓). Routines exist inside Grok Bot.

**Integrations.** Connectors listed on docs.x.ai: Google Drive (search, read,
create and write files including Google Docs), Gmail & Google Calendar,
Outlook Mail & Calendar, SharePoint, OneDrive, Microsoft Teams, Salesforce,
and custom MCP tunnelling (docs.x.ai/grok/connectors/google-drive, official;
list from search summary of the docs overview). Grok Bot adds a plugin
marketplace and computer use for anything else. No CRM depth beyond
Salesforce; no WhatsApp channel.

**Memory.** Grok app memory is not documented on the overview page (❓). Grok
Bot memory is **per Bot** (preferences, role context, summaries); Bots share
files and browser sessions on one computer per account (internal notes from
xAI docs).

**Autonomy.** High in Grok Bot (runs while you are away, escalates for
approvals, passwords, 2FA, CAPTCHAs, payments). The main Grok app is a
conversational assistant.

**Pricing (observed 2026-10-09).**
| Tier | Price | Source |
|---|---|---|
| Free | $0, capped prompts | 3P (ai-toolbox.co) |
| SuperGrok Lite | ~$10/mo | 3P, UNVERIFIED |
| SuperGrok | ~$30/mo ($25/mo yearly) | 3P |
| SuperGrok Heavy | ~$300/mo list, promo ~$99 for three months | 3P |
| X Premium / Premium+ | $8 / $40 per month | 3P |
| Grok Business | $30 per user per month, self-serve | Official (x.ai/news/grok-business, 2025-12-30); one 3P source says the Oct 2026 page hides the price |
| Grok Enterprise | Custom; SSO, SCIM, audit; Vault add-on with CMEK | Official |
| Grok Bot | Bundled: SuperGrok Heavy, Cursor Ultra ($200), Cursor Teams Premium ($120/seat); some reviews say lower tiers are eligible | 3P, conflicting, UNVERIFIED |
| API | Per token; one 3P source gives $2 / $6 per M tokens for grok-4.5 | 3P, UNVERIFIED |

**Strengths.** Real-time X data and news; strong models; fast shipping
cadence; a credible "teammates" product with a cloud computer and routines;
consumer distribution through X; low per-seat price for business.

**Weaknesses for an SMB owner.**
- Grok Bot is an early beta with no published reliability data, model choice
  is automatic with no override (3P), and one shared computer per account means
  Bots are not security boundaries.
- Approvals are prompt-driven plus a reviewing model; reviewers call them
  advisory (internal notes, 3P).
- No company-wide shared memory; per-Bot memory.
- No WhatsApp, Instagram or SMS customer channels; Grok acts in the owner's
  tools, it does not answer the owner's customers.
- Pricing for Bots is split across xAI and Cursor plans and has changed since
  launch.
- No compliance certifications claimed (internal notes; not re-checked).

**What it means for Darex.** Grok Bot validates Darex's concept (named
employees, routines, approvals, team chats) and beats it on reach (computer
use), clients (desktop + iOS), voice, files and model quality. Darex's answer
is control (tenant isolation, per-employee allowlists, plan cards, audit by
employee) plus customer-facing channels and business depth. Darex must close
the assistant basics (voice, files, research, routines) so the comparison is
fought on the ground where Darex is strong. See `08` §3.

---

### 4.2 OpenAI ChatGPT (Chat, Work, Codex; apps/plugins; scheduled tasks)

**Positioning.** The default AI assistant, now organised as three modes:
Chat (everyday conversation), Work (multi-step agent that delivers finished
spreadsheets, slides, docs and web apps) and Codex (software) — launched
2026-07-09 per several 3P sources (digitalapplied.com, leadwithai.co,
thecentral.ai, usecarly.com; official release notes could not be fetched,
HTTP 403).

**Key features.**
- **ChatGPT Work** gathers context from connected apps and files, plans,
  works for hours, can run on a schedule, and delivers finished artifacts (3P).
- **ChatGPT agent** (the July 2025 agent that absorbed Operator) was reportedly
  removed in early August 2026, with users pointed to Work and a separate cloud
  browser feature (single source: Wikipedia "OpenAI Operator"; UNVERIFIED).
- **Apps / Plugin Directory.** Connectors were renamed "apps" in December
  2025; the App Directory became the Plugin Directory on 2026-07-09 (3P).
  Most connectors need Business, Enterprise or Edu, and admins enable each one
  (3P: coupler.io, justinmckelvey.com). Count not verified (❓).
- **Scheduled tasks.** Active task limits: 3 (Free, Go), 5 (Plus), 10
  (Business, Edu), 15 (Pro, Enterprise); recurring as often as hourly on paid
  plans (help.openai.com article 10291617, via search summary).
- **Pulse** (proactive overnight research based on memory and past chats) was
  retired in 2026 and folded into scheduled tasks; Pro users had 14 days of
  continued access (3P: techjacksolutions.com, justinmckelvey.com; UNVERIFIED date).
- Memory (saved memories and chat history reference), Projects, custom GPTs,
  Deep Research, voice mode, Canvas, image generation, file and image
  understanding: long-standing features; not re-verified on the pricing page in
  this pass (❓ for exact plan gating).
- Atlas browser reportedly being phased out with agentic browsing folded into
  ChatGPT (3P, UNVERIFIED).
- Agent-mode message caps when it existed: Plus 40/month, Pro 400/month
  (help centre via search summary).

**Integrations.** "Slack, Gmail, Google Drive, Salesforce and dozens more"
through plugins (3P). MCP-based apps via the Apps SDK. No WhatsApp business
channel for answering customers.

**Memory.** Personal memory per user; on Business/Enterprise connector data is
not used for training by default (3P). Long-term memory was disabled in agent
mode in 2025 to reduce prompt injection (3P, may have changed).

**Autonomy.** Work mode runs multi-hour tasks and schedules; there is no
business approval ladder, role allowlist or org-level policy engine beyond
admin enablement of apps.

**Pricing (observed 2026-10-09; official page returned 403).**
| Tier | Price | Source |
|---|---|---|
| Free / Go | $0 / low-cost regional tier | ❓ |
| Plus | $20/mo (historical list; not re-verified) | UNVERIFIED |
| Pro | $200/mo (historical list; not re-verified) | UNVERIFIED |
| Business (ex-Team) | $20/seat/mo annual, $25 monthly (3P, sources conflict) | UNVERIFIED |
| Enterprise / Edu | Custom | — |

**Strengths.** Largest user base and brand; strongest all-round assistant;
artifacts (slides, sheets, docs, apps) out of the box; scheduled tasks;
plugin ecosystem; voice and multimodal; constant shipping.

**Weaknesses for an SMB owner.**
- Personal productivity, not an operations workforce: no roles, no shared
  company brain across a team's agents, no approval queue tied to business
  risk (refund limits, sends), no audit attributed to an AI employee.
- Does not run the customer-facing front line (WhatsApp, Instagram DMs,
  website widget) for the business.
- Feature churn: agent mode, Operator, Pulse and Atlas launched and were
  retired or folded within about a year (3P), which makes it hard to build an
  operation on.
- Connectors gated to higher tiers and admin enablement.

**What it means for Darex.** ChatGPT sets the bar for the chat experience
(files, voice, research, artifacts, schedules). Darex should not try to be a
better general assistant; it should be the operations layer that ChatGPT is
not, and it can even meet ChatGPT users where they are by publishing Darex as
an MCP app/plugin (see `08` §4.12).

---

### 4.3 Anthropic Claude apps (Claude, Cowork, connectors, Claude in Chrome)

**Positioning.** An assistant aimed at professionals and teams, with
connectors built on the Model Context Protocol (MCP), research, memory,
skills, file creation, a Chrome browser agent and Claude Code. The Cowork
desktop agent (announced January 2026, GA 2026-04-09 per 3P) is now presented
as part of Claude itself.

**Key features (official pricing page, fetched 2026-10-09).**
- Connectors on every plan including Free; memory on every plan; skills and
  file creation on every plan.
- Research, Claude in Chrome and Claude Code on Pro and above.
- "Claude Cowork is now just Claude", rolling out to Pro and Max first, included
  on Team (claude.com/pricing).
- Projects with their own files, instructions and memory (3P).
- Cowork admin features: RBAC, per-group spend limits, usage analytics (3P);
  tasks run only while the desktop app is open and the computer awake (3P).

**Integrations.** MCP connectors (remote and local); Team plans connect
Microsoft 365, Slack and more; admin controls for remote and local connectors
(3P). Directory size not verified (❓).

**Memory.** Cross-conversation memory on all plans (official); per-project
memory (3P).

**Autonomy.** Agentic work through Cowork (desktop), Claude in Chrome and
Claude Code. No customer-facing channels; no business approval ladder beyond
tool permission prompts.

**Pricing (official, claude.com/pricing, observed 2026-10-09).**
| Tier | Price |
|---|---|
| Free | $0 |
| Pro | $17/mo annual ($200 up front) or $20 monthly |
| Max | From $100/mo (5x or 20x Pro usage) |
| Team | Standard seat $20/mo annual or $25 monthly; Premium seat $100 annual or $125 monthly |
| Enterprise | $20/seat/mo annual plus usage at API rates |

**Strengths.** Strong reasoning and writing; MCP is the open standard most
tools now speak; transparent pricing; memory, research, skills and file
creation broadly available.

**Weaknesses for an SMB owner.** A personal or team assistant, not an
operations workforce: no always-on employees answering customers, desktop
agent depends on a running machine (3P), no role-based approvals, no
WhatsApp, no vertical packs.

**What it means for Darex.** MCP is the shared language. Darex already runs an
MCP bridge (`services/workflows/src/mcp-bridge.ts`); exposing a scoped,
approval-gated Darex MCP server lets users drive their Darex employees from
Claude, ChatGPT or Grok, turning those assistants into distribution rather than
substitutes.

---

### 4.4 Google Gemini (Gemini app, Gems, Deep Research, Live; Gemini Enterprise)

**Positioning.** Two products. The Gemini app (consumer and Workspace) is an
assistant with Gems, Deep Research, Gemini Live and Canvas. Gemini Enterprise
(formerly Agentspace) is a per-seat "work agent" platform with connectors,
an agent designer, a workflow builder and an agent gallery.

**Key features.**
- Gemini app: Deep Research, Gemini Live, Canvas and Gems listed on the free
  tier, with more capacity on paid tiers (gemini.google/subscriptions,
  official via search summary). Deep Research browses up to hundreds of sites
  and writes multi-page reports (3P).
- Scheduled Actions in the Gemini app: recurring and future tasks across
  Android, iOS and web, up to ten active on Google AI Pro or Ultra (How-To Geek
  via Yahoo; launched 2025).
- "Gemini Spark", a 24/7 personal agent, and a "Daily Brief" morning agent
  reported in Google Play listings in September 2026 (3P newsletter,
  UNVERIFIED). Google I/O 2026 (May 19–20) themed "agentic Gemini era" (3P).
- Gemini Enterprise: connectors to Google Workspace, Microsoft OneDrive,
  Outlook and SharePoint, ServiceNow, Jira and Confluence
  (cloud.google.com/gemini-enterprise/faq, official via search); Workflow
  Builder connector **actions** that send messages, create events, upload
  files and manage records, with admins choosing read-only or write-back per
  agent node (docs.cloud.google.com workflow-builder, official); schedule
  triggers by minutes to months or cron (official docs).
- Scheduled agents run on user credentials that expire every 14 days and must
  be renewed manually (official docs, Japanese edition, via search).

**Integrations.** Deepest in Google Workspace; Microsoft and ITSM connectors
in Enterprise. Count not verified (❓).

**Memory.** Personal context in the app; enterprise index and grounding in
Gemini Enterprise. ❓ for a long-term per-agent memory product.

**Autonomy.** Scheduled actions in the app; scheduled and event workflows in
Enterprise; no customer-facing messaging channels.

**Pricing (observed 2026-10-09; official Enterprise pricing URL returned 404).**
| Tier | Price | Source |
|---|---|---|
| Google AI Plus | $4.99–7.99/mo | 3P, conflicting |
| Google AI Pro | $19.99/mo, 5 TB storage | Official subscriptions page (via search) |
| Google AI Ultra | ~$99.99 and ~$199.99 tiers after I/O 2026 (was $249.99) | 3P, conflicting, UNVERIFIED |
| Gemini Enterprise Business | ~$21/user/mo annual, capped at 300 users | 3P (Redress Compliance, June 2026); UK G-Cloud list shows 25 |
| Gemini Enterprise Standard / Plus | ~$30 / from ~$50 per user per month | 3P; G-Cloud shows 35 / 60 |

**Strengths.** Native to Workspace (where many SMBs keep mail, calendar,
docs); generous free tier; scheduled actions; Deep Research quality;
enterprise-grade governance; Android distribution.

**Weaknesses for an SMB owner.** Two separate products and licences to
understand; write-back requires building workflows; credentials for scheduled
agents expire every 14 days; no WhatsApp/Instagram customer front line; no
role-based employees out of the box.

**What it means for Darex.** Many Darex customers will run Google Workspace,
and Darex's tool layer is already Google-heavy (15 Google modules). Darex must
be clearly better at *doing the operations* — owning outcomes across Google
plus non-Google systems (HubSpot, Stripe, Shopify, WhatsApp) — not at being a
Workspace assistant.

---

### 4.5 Microsoft Copilot Studio (and Microsoft 365 Copilot, Agent 365)

**Positioning.** A low-code agent builder on the Power Platform; agents run
inside Microsoft 365 and Teams and can publish to external channels. Billing
is a metered credit pool.

**Key features.**
- Autonomous agents with event triggers, GA March 2025, with an activity log
  (microsoft.com Copilot Studio blog, official).
- Computer use (virtual mouse and keyboard) in public preview from September
  2025, US environments only (official blog).
- MCP tools in agent workflows, GA cited for 2026-07-15 in Message Center
  MC1471573 (copies disagree whether past or planned; UNVERIFIED).
- Human Review / Request for Information connector pauses a flow and asks a
  reviewer in Outlook (3P says preview).
- WhatsApp and SMS through Azure Communication Services, which needs a
  WhatsApp Business account (Microsoft Learn release plan, official). Native
  live handoff on WhatsApp needs Dynamics 365 Omnichannel (community forum).

**Integrations.** Power Platform connectors (prebuilt, premium, custom).
"1,400+" is a common claim but not on the pricing page (UNVERIFIED).

**Memory.** Grounding on M365, SharePoint and Dataverse. Long-term memory ❓.

**Pricing (official, observed 2026-10-09).**
| Item | Price |
|---|---|
| Copilot Studio credit pack | $200/month for 25,000 Copilot Credits |
| Pay-as-you-go | $0.01 per credit |
| Credit burn | Classic answer 1, generative answer 2, agent action 5; reasoning response reportedly 100 (3P, UNVERIFIED) |
| Microsoft 365 Copilot | $30/user/month (annual); includes Copilot Studio for internal agents |
| Microsoft 365 Copilot Business | $21/user/month for ≤300 users, launched 2025-12-01 (3P) |
| Agent 365 | GA 2026-05-01, $15/user/month standalone or in M365 E7 at $99/user/month (3P) |

**Strengths.** Enterprise identity (Entra), governance, the Microsoft
connector catalogue, MCP and computer use; effectively free for internal
agents if the business already pays for M365 Copilot.

**Weaknesses for an SMB owner.** Licensing complexity (seats, credits, Azure,
Dataverse, premium connectors billed separately — 3P); unpredictable credit
burn; built for IT makers, not owners; WhatsApp and voice need extra Azure or
Dynamics products; poor fit for Google Workspace shops.

**What it means for Darex.** Win Microsoft-light SMBs with "ready on day one,
one price". Darex has Outlook and Microsoft Calendar tools but Microsoft OAuth
client registration is still a human blocker (`AGENTS.md` §4).

---

### 4.6 Manus (part of Meta since late 2025)

**Positioning.** A general-purpose autonomous agent that plans and executes
multi-step work (research, coding, data analysis, websites, decks) in a cloud
VM. Its site now says "Manus is now part of Meta".

**Key facts.**
- Meta acquisition announced around 2025-12-29, reported value above $2B
  (techradar.com, eweek.com; price undisclosed). To continue operating and to
  be integrated into Meta AI, Facebook, Instagram and WhatsApp (announced
  intent).
- $100M ARR announced 2025-12-17; over 80M VMs created (company claims,
  manus.im blog).
- Agent Mode runs Manus 1.6, 1.6 Max and 1.6 Lite (help.manus.im, official).

**Key features.** Wide Research (parallel sub-agents, each a full Manus
instance, launched 2025-07-31); Browser Operator extension that uses the
user's real browser and logins; Scheduled tasks (daily/monthly, output to
email, Slack or Drive); Mail Manus (forward an email to trigger a task;
allow-listed senders); Slack connector (manus.im docs, official).

**Integrations / memory.** Connector count not stated; persistent business
memory UNVERIFIED.

**Autonomy / approvals.** High autonomy per task; asks for takeover on logins
and CAPTCHAs; no formal approval queue found (UNVERIFIED).

**Pricing (official help page, observed 2026-10-09).** Free: 300 credits
daily refresh, 1 concurrent task, 2 scheduled tasks. Pro from $20/month with
4,000 credits. Higher tiers ($40 / 8,000; $200 / 40,000) and Team ($20/seat,
2-seat minimum) are 3P only (UNVERIFIED). Credits do not roll over; failed
re-runs consume credits (3P).

**Strengths.** Best-in-class general task execution; Wide Research; Meta
distribution with possible WhatsApp reach.

**Weaknesses for an SMB owner.** Task-oriented, not a persistent role-based
workforce; unpredictable credit burn; weak approvals; no phone; roadmap
uncertainty after the acquisition and data-privacy concerns about Meta
ownership.

**What it means for Darex.** Watch Meta: if Manus becomes a native agent
inside WhatsApp Business, it competes directly with Darex's WhatsApp front
line. Darex's defence is the shared business brain, the approval ladder and
system-of-record actions that a generic agent does not have.

---

### 4.7 Genspark (Super Agent, AI Workspace, Genspark Claw)

**Positioning.** An "all-in-one AI workspace" (slides, sheets, docs, sites,
media, inbox, phone calls) plus Genspark Claw (2026): a personal "AI employee"
on a dedicated 24/7 cloud computer, reachable from messaging apps.

**Key features.**
- AI Slides (export PPTX, PDF, web link), AI Sheets 2.0 (live web data,
  Python charts), AI Docs, AI Inbox, AI Meeting Notes, image and video
  generation (mainfunc.ai blog; 3P).
- Call For Me: an AI phone agent that places calls, navigates phone trees and
  returns a transcript (3P; ~1 credit per second reported, UNVERIFIED).
- **Claw** (official help centre): channels WhatsApp, Telegram, LINE, Slack,
  Teams, Discord, Signal, Google Chat, Feishu/Lark; its own email address;
  long-term memory shared across channels; Schedules tab with cron, templates
  and "Heartbeat" check-ins; dedicated cloud VM with fixed IP; external
  actions like sending email or posting require permission; local desktop mode
  from April 2026.

**Integrations.** Gmail, Outlook, Slack, Teams, Google Chat, LINE, Zoom, X and
others; no total count (official help centre).

**Funding / scale.** Series B over $200M (Nov 2025) past a $1B valuation; a
2026 extension reported at $385M/$1.6B or $485M/$2.6B (sources conflict);
~$250M annualised revenue estimated March 2026 (Sacra, UNVERIFIED).

**Pricing (official page 403; 3P, observed Sept–Oct 2026, UNVERIFIED).** Free
100 credits/day; Plus $24.99/mo ($19.99 annual) with 10,000 credits; Pro
$249.99/mo with 125,000 credits; Team ~$30/user; Claw from ~$39.99/mo
separately; a video generation uses 800–1,000 credits.

**Strengths.** Broadest output suite; Claw has the widest messaging coverage
of any general agent, including WhatsApp, with shared memory and schedules;
heavy funding and fast growth.

**Weaknesses for an SMB owner.** Product sprawl priced separately; opaque
credit maths; individual-assistant focus with no role-based team or org
governance; connectors mostly communication tools, limited CRM/ERP depth.

**What it means for Darex.** Genspark Claw is the most direct consumer-grade
threat to "AI employee on WhatsApp". It acts *for the owner* over messaging;
Darex acts *for the business toward its customers* with business rules and
approvals. Darex should match Claw on owner-side messaging (talk to your
employees on WhatsApp, `08` §4.9) and on artifacts (`08` §4.7).

---

### 4.8 Lindy

**Positioning.** "Less chatting, more doing": an AI teammate or executive
assistant that plugs into your tools and learns how you work (lindy.ai,
official). Earlier framing was "AI employees" (Lindy 3.0).

**Key features.** 1,000+ integrations on the homepage, 1,500+ on the pricing
page (inconsistent); MCP support; browser use when no integration exists (Pro
and up); 40+ skills; meeting recording; Agent Builder; Autopilot (agent gets
its own cloud computer); editable memory stored as plain files; scheduled
routines from one sentence; approvals by default ("Nothing irreversible
happens without your approval"); channels Slack, iMessage, email; Lindy Phone
in docs (transfer, phone trees) but de-emphasised.

**Pricing (official, observed 2026-10-09).** Free $50 in credits for 7 days.
Team from $29.99/mo for 3,000 credits, pooled; ladder 5,000 for $49.99,
15,000 for $99.99, 35,000 for $199.99, up to 1.75M for $9,999.50; top-ups
$10 per 1,000; Enterprise custom with HIPAA BAA, SSO/SCIM, audit logs.

**Funding.** ~$35M Series B (2023); no 2025–26 round found.

**Strengths.** Polished assistant UX, approvals by default, editable memory,
iMessage and Slack, MCP and browser fallback, transparent credit ladder.

**Weaknesses for an SMB owner.** Now a single personal assistant rather than
a multi-role workforce; no WhatsApp; phone priced separately; credit
consumption hard to forecast.

**What it means for Darex.** Lindy's "editable memory as files" and
"routines from one sentence" are UX patterns Darex should copy (`08` §4.4,
§4.11). Its credit ladder is the clearest public reference for Darex credit
pricing.

---

### 4.9 Relevance AI

**Positioning.** "The home of the AI Workforce": a no-code platform to build,
run and govern teams of autonomous agents, mainly for GTM and ops
(relevanceai.com, official).

**Key features.** No-code builder for agents, tools, workflows and evals;
"Invent" copilot that wires an agent from a description; build via MCP from
coding agents; sub-agents as tools with parallel runs; sandboxed Python/JS;
version rollback and dry runs; Workforce multi-agent canvas; 1,000+
integrations (features page) or 2,000+ (Enterprise pricing page); RAG with
hybrid retrieval and scheduled re-sync; long-term agent memory; hundreds of
app-event triggers, webhooks, cron and self-scheduling; voice and phone
agents (Enterprise); email, SMS and WhatsApp through Twilio; Slack and Teams;
hosted chat app, mobile app and widget; all major LLMs or BYOK with fallback
models; SOC 2 Type II, GDPR, EU environment.

**Approvals (best in this set).** Per-action approval: required, not needed,
or agent's choice; escalate with reason; bulk approve/reject; pause and resume
the queue; step limits; cost-based pauses; plain-English escalation rules
(relevanceai.com/approvals-escalations, official).

**Pricing.** Official page shows Enterprise only ("Talk to sales"). Billing
since September 2025: Actions plus pass-through Vendor Credits. 3P legacy
figures: Pro $19–29/mo, Team $234–349/mo, overage $80 per 1,000 Actions;
failed runs billed (UNVERIFIED).

**Funding.** $24M Series B (May 2025, Bessemer), $37M total.

**Strengths.** Deepest workforce platform; strongest approvals; voice,
WhatsApp, Slack, Teams; model choice; compliance.

**Weaknesses for an SMB owner.** Moving upmarket with no public self-serve
price; builder-heavy; two-meter billing that charges for failures.

**What it means for Darex.** Relevance is the benchmark for governance UX.
Darex already has the mechanics (autonomy tiers, tool gate, pending actions)
but not the UX (bulk approve, rule-based escalation in plain English, cost
pause). See `08` §3.2.

---

### 4.10 Sintra

**Positioning.** "Hire AI employees today — get your first 24/7 digital
team": twelve persona helpers for solopreneurs and SMBs (sintra.ai, official).

**Key features.** Twelve helpers (support, copywriting, business
development, data, eCommerce, sales, personal development, recruiting, SEO,
social, virtual assistant, email marketing); Brain AI, "one memory across
your whole team" (brand, website, tone, documents); "15+" integrations on plan
cards, "1000+" on a banner (inconsistent); social scheduling and scheduled
tasks; 100+ languages; iOS app and web. HITL: "approval levels" with no detail.

**Pricing (official, observed 2026-10-09).** All helpers on every plan, 250
credits/month, 15+ integrations, 14-day money-back: $48.50/mo monthly,
$23.60/mo on 3 months, $15.60/mo on 12 months. Credits do not roll over; chat,
images and scheduled tasks all consume credits (3P).

**Scale.** $17M seed (June 2025), ~$12M ARR and 40,000+ paying customers at
the round (tech.eu).

**Strengths.** Clearest SMB "AI employees" framing; very cheap; shared Brain;
simple for non-technical owners; mobile app.

**Weaknesses for an SMB owner.** 250 credits is tiny; shallow integrations;
mostly content and marketing, not operations; no WhatsApp, phone or Slack;
weak autonomy and approvals.

**What it means for Darex.** Sintra proves an SMB will pay for "AI employees
with one brain" and shows the price ceiling for the entry tier. Darex is
deeper on every operational axis; the risk is losing the top of the funnel to
a $16 offer with an iOS app.

---

### 4.11 Artisan (Ava, the AI BDR)

**Positioning.** "Artisan builds AI employees for go-to-market teams"; Ava is
an autonomous BDR running outbound end to end (artisan.co, official).

**Key features.** Lead finding and enrichment from a "250M+ verified
contacts" database; personalised outreach from the customer's domains;
reply handling and meeting booking; CRM reactivation; deliverability,
sequencing, dialer and intent signals bundled; approvals, tone and CTA locks,
escalation rules; SOC 2 Type II, SSO, audit logs.

**Pricing.** Not published ("Talk to Sales"). 3P: from ~$250/mo annual, an
"Employee" tier ~$600/mo with 30,000 credits; a competitor estimates
$2K–10K+/mo by lead volume (all UNVERIFIED).

**Funding / scale.** $25M Series A (April 2025); ~$5M ARR then, $9M+ reported
by April 2026 (UNVERIFIED).

**Criticisms.** "Stop Hiring Humans" billboard backlash (2024); opaque
pricing and annual lock-in (competitor claims).

**Strengths / weaknesses.** Polished single-role AI employee with data
bundled; but outbound sales only, opaque pricing, annual contracts, no shared
business brain.

**What it means for Darex.** Darex's Growth employee covers lookalikes,
signals, outreach drafting and reply sorting, but has no proprietary contact
database (uses Apollo). Do not compete on data; compete on "growth plus
support plus ops in one brain".

---

### 4.12 11x (Alice SDR, Julian phone and chat agent)

**Positioning.** "Digital workers" for revenue teams (11x.ai, official).

**Key features.** Alice: outbound, nurture, reactivation, visitor
retargeting, closed-lost recovery, event follow-up. Julian: inbound voice and
chat, speed to lead, qualification, scheduling, live transfer. Platform:
company and lead database, live web search, visitor tracking, signals, deep
research, playbooks and knowledge base, multichannel sequences, 105+
languages, deliverability. Channels: email, phone, chat, SMS, WhatsApp,
LinkedIn.

**Pricing (official docs, observed 2026-10-09).** Alice Growth from
$3,750/mo (~$45K/yr); Julian Voice from $5,333/mo (~$64K/yr, 2,000 calls);
Julian Chat from $2,417/mo (~$29K/yr, 3,000 chats); annual billing; no trial.

**Criticisms.** TechCrunch (2025-03-24) reported 11x claimed customers it did
not have; ARR inflation allegations; CEO stepped down May 2025.

**What it means for Darex.** 11x shows what a real-time voice agent and
WhatsApp/SMS inbound are worth to revenue teams (tens of thousands a year).
A voice receptionist is a credible Darex upsell (`08` §4.3) at a fraction of
the price.

---

### 4.13 Dust

**Positioning.** Model-agnostic, multiplayer platform where companies build
agents, deploy them in a shared workspace and work alongside them (dust.tt,
official).

**Key features.** Custom agents with skills, knowledge and tools;
multi-agent workflows on schedules and triggers; 20+ models (GPT, Claude,
Gemini, Mistral, DeepSeek); "Frames" turn output into interactive content;
audit logs, usage/cost/ROI analytics; SOC 2 Type II; US/EU residency;
connectors "70+" (homepage) incl. Drive, Notion, Confluence, Intercom, GitHub,
Microsoft, Zendesk, Snowflake, BigQuery, Gong, Slack plus MCP; opt-in Agent
Memory (private per user and per agent); natural-language schedules and
webhook triggers; action validation API (approve/reject a tool call);
channels: web, Slack, Teams, browser extension, Zendesk, API, MCP.

**Pricing (official, EUR).** Free €0 (500 credits lifetime); Pro €24/seat/mo
annual (8,000 credits); Max €120/seat/mo annual (40,000 credits); Business
plan capped at 3 connectors, 5 spaces, 5 remote MCP servers; Enterprise
custom.

**Scale.** $40M Series B (May 2026, Sequoia and Abstract); >$20M ARR; 3,000+
organisations, 300K+ agents.

**Strengths / weaknesses.** Closest "shared brain plus many agents" design
with strong Slack/Teams presence and model choice; but owners design every
agent, actions depend on connectors (capped on Business), no phone, SMS or
WhatsApp.

**What it means for Darex.** Dust's multi-model support and "Frames"
interactive outputs are the patterns to copy (`08` §4.6, §4.7). Darex's
prebuilt roles and customer channels are the wedge.

---

### 4.14 Glean

**Positioning.** "Work AI" on permission-aware enterprise search, plus
Assistant and Agents (glean.com, official).

**Key features.** Agent builder grounded in the enterprise index; 275+
connectors with permissions enforced; content triggers and chat triggers;
scheduled triggers in private beta (UNVERIFIED); March 2026 MCP release lets
agents act through 17 preloaded MCP servers plus any remote MCP; "100M+ agent
actions annually" (company claim).

**Pricing.** Not published. 3P: ~$45–50+/user/mo plus ~$15 for agents,
~$50–60K annual minimum, ~100-user minimum (UNVERIFIED).

**Scale.** $150M Series F at $7.2B (June 2025); ~$200M ARR (Sacra, Dec 2025);
$300M reported May 2026 (UNVERIFIED).

**What it means for Darex.** Not an SMB competitor on price. Glean sets the
expectation that answers respect source permissions and cite sources —
Darex's Brain should show both.

---

### 4.15 Zapier (Agents, Copilot, MCP, Canvas)

**Positioning.** Automation across "9,000+ apps", now with AI agents that work
"on command and while you sleep" (zapier.com/agents, official).

**Key features.** Agents with company knowledge, event-driven templates,
activity monitoring, web browsing, Chrome extension; Copilot builds Zaps,
Agents, Tables, Interfaces and Canvas from plain English; Zapier MCP exposes
30,000+ actions across ~8,000 apps to any AI client; Human in the Loop app
(approve, decline or edit, notified by email or Slack; reviewers need Zapier
accounts); agent runs capped at 10 (Free) or 40 (Pro) activities before
asking for input.

**Pricing (official, observed 2026-10-09).** Free 100 tasks; Professional
from $19.99/mo annual (750 tasks); Team from $69/mo annual (2,000 tasks);
Agents billed in activities (Free 400; Pro 1,500 at ~$33.33/mo annual,
conflicting 3P figure $50); MCP tool call = 2 tasks; overage 1.25×–2.5×.

**Criticisms.** Reliability drops when the AI chooses its own steps; weak
debugging; no unified audit or provenance (3P).

**What it means for Darex.** Zapier MCP is a legitimate shortcut for long-tail
integrations: Darex could accept a customer's Zapier MCP (or any MCP) as an
extra tool source under Darex approvals (`08` §4.13), rather than building
thousands of connectors.

---

### 4.16 n8n

**Positioning.** Source-available ("fair-code") workflow automation and AI
orchestration, self-hostable (n8n.io, official).

**Key features.** AI Agent node where workflows, integrations, code and MCP
servers become tools; AI Workflow Builder (text to workflow, beta Oct 2025);
n8n MCP; evaluations on Pro+; 500+ nodes, 600+ agent templates; session
memory by default, cross-session memory opt-in; per-tool human review with
approval via Slack, Gmail, Discord, Telegram, Teams, WhatsApp, Google Chat,
Outlook.

**Pricing (official, EUR annual).** Starter €20/mo (2.5K executions); Pro
€50/mo (10K); Business €667/mo self-hosted (40K); Enterprise custom;
Community Edition free to self-host.

**Scale.** $180M Series C at $2.5B (Oct 2025); >$40M ARR (Aug 2025).

**What it means for Darex.** n8n's approval-over-messaging (approve a tool
call from WhatsApp or Slack) is a pattern SMB owners will expect: Darex
already pushes approval cards to Slack and should add WhatsApp approval
replies (`08` §3.2).

---

### 4.17 Fin (formerly Intercom)

**Positioning.** An AI customer-service agent that resolves queries end to
end, priced per outcome; works on Intercom's helpdesk or on top of others.
Intercom renamed itself Fin in May 2026 (3P). Salesforce signed a definitive
agreement to acquire Fin for about $3.6B on 2026-06-15, aimed at small and
mid-sized businesses that need to launch quickly (investor.salesforce.com,
official).

**Key features (Fin 3, 2025-10-15, official).** Procedures (plain-language
SOPs with deterministic controls, code snippets, data connectors, conditional
steps); Simulations (multi-turn tests, regression library; closed beta per
help docs); Fin Voice (28 languages, transcripts, escalation rules); Insights
(CX Score, topic trends, content-gap suggestions); Copilot for human agents
($35/user/mo); approval checkpoints before sensitive actions; steps back when
a human joins in Slack/Discord. Runs on Fin's own "Apex" model (official).

**Channels.** Voice, email, chat, Slack, Discord, WhatsApp, SMS, Instagram,
Facebook Messenger, API (fin.ai/pricing, official). Helpdesks: Intercom,
Salesforce, HubSpot, Freshworks, Dixa, Front, Zoho, Sprinklr, Gorgias.

**Pricing (official, observed 2026-10-09).** $0.99 per outcome on an
existing helpdesk, minimum 50 outcomes/month (~$49.50 floor), no seat fees;
on Intercom helpdesk $0.99 per outcome plus $29/seat; lead qualifications
$9.99 each; Fin Voice custom; 14-day trial.

**Scale.** 30,000+ companies; 76% average end-to-end resolution in examples
(Salesforce release).

**Weaknesses for an SMB owner.** Cost rises with success; routings and
handoffs billed as outcomes; support-only; acquisition uncertainty.

**What it means for Darex.** Fin is the price benchmark for the Customer
employee: ~$1 per resolution. Darex's credit cost for an inbound WhatsApp turn
(3 credits in `payment-plans.md`) is far below that, which is a pitch point if
Darex's resolution quality is proven.

---

### 4.18 Decagon

**Positioning.** "The AI concierge for every customer": enterprise CX agents
defined in plain-language Agent Operating Procedures (AOPs) (decagon.ai,
official).

**Key features.** AOPs compiled to executable logic; Watchtower QA;
Simulations; Experiments (A/B); Insights; knowledge suggestions; personal
agent channel for customers' own AI agents; Proactive Agents with user memory
and outbound voice (Spring 2026, 3P); voice on ElevenLabs models; channels
voice, chat, email.

**Pricing.** Not published; per conversation (~$0.99) or per resolution
($0.50–1.50) with ~$50K/yr platform floor; median contracts ~$386–433K (3P,
competitor-sourced, UNVERIFIED).

**Scale.** $250M Series D at $4.5B (Jan 2026, Bloomberg); customers include
Duolingo, Chime, Notion, Rippling.

**What it means for Darex.** Not an SMB competitor. AOPs, simulations and
proactive outreach are the feature vocabulary SMB buyers will hear; Darex
should offer a lightweight version (SOP-to-playbook, test conversations).

---

### 4.19 Sierra

**Positioning.** Enterprise conversational AI platform selling branded
customer-facing agents on outcome-based pricing; co-founded by Bret Taylor
and Clay Bavor (sierra.ai, official).

**Key features.** Agent OS 2.0; Agent Studio (no-code) and Agent SDK; Agent
Data Platform (cross-session memory joining CRM, billing, inventory data);
Ghostwriter (build agents from SOPs, transcripts, whiteboard photos; improve
loop); Insights (Explorer, Monitors, Experiments, Observability); Horizon
(long-horizon planning, proactive engagement); voice; "supervisor" models
that watch and can block or rewrite; deterministic gates; SOC 2, ISO 27001,
ISO 42001, HIPAA, PCI DSS claims. Channels: chat, SMS, WhatsApp, email,
voice, ChatGPT.

**Pricing.** Outcome-based, negotiated; 3P estimates ~$150K+/yr plus $50–200K
setup (UNVERIFIED).

**Scale.** $950M Series E at $15.8B (May 2026, 3P via CNBC); ~$150M ARR (Feb
2026, 3P).

**What it means for Darex.** Sierra defines best practice for guardrails
(supervisor models, deterministic gates) and outcome pricing. Darex's tool
gate and confirm classes are the deterministic half; an independent
"reviewer" model for high-risk actions is the missing half (`08` §3.2).

---

### 4.20 Salesforce Agentforce (SMB comparison set)

**Pricing (official, observed 2026-10-09).** Foundations $0; Flex Credits
$500 per 100K (standard action 20 credits ≈ $0.10, voice action ≈ $0.15);
$2 per conversation for customer-facing agents; Help Agent resolutions $2
each (2026-06-25, 3P details); Agentforce user licence $5/user/mo; add-ons
$125–150/user/mo; Max editions from $550/user/mo. Agentforce ARR $1.2B, +205%
(Salesforce release).

**What it means for Darex.** Requires Salesforce CRM and consultants; Fin
will be its SMB arm after closing. Darex's pitch: works with HubSpot, Zoho,
Salesforce and Google without a CRM migration.

---

### 4.21 HubSpot Breeze agents (SMB comparison set)

**Pricing (official, effective 2026-04-14).** Customer Agent $0.50 (50
credits) per resolved conversation, unresolved free; Prospecting Agent $1.00
(100 credits) per lead recommended for outreach; Professional or Enterprise
tier required; 28-day trial; credits ~$10 per 1,000 (3P).

**What it means for Darex.** For HubSpot customers, Breeze is the default.
Darex already has HubSpot tools; it must show work Breeze cannot do (WhatsApp,
Stripe refunds, calendar moves, ops sweeps across systems) and must close the
HubSpot OAuth client registration blocker.

---

### 4.22 Cross-competitor observations

- **"AI employee" framing is no longer a differentiator.** Sintra, Lindy,
  Relevance, Genspark Claw, Artisan, 11x and Grok Bot all use it. What is
  still rare: roles that share one memory *and* act on systems of record
  *and* answer the business's customers *and* sit behind an approval ladder.
- **Cloud computers are the new frontier.** Grok Bot, Manus, Genspark Claw,
  Lindy Autopilot, Copilot Studio computer use and ChatGPT's cloud browser
  all give the agent a browser. Darex has none.
- **Outcome pricing is converging around $0.50–2 per resolution** in CX (Fin,
  Breeze, Agentforce).
- **WhatsApp is still rare in general agents.** Only Genspark Claw (owner-side
  chat), Relevance (via Twilio), 11x Julian, Fin, Sierra and Copilot Studio
  (via Azure) list it. Darex's dual transport (Meta Cloud + QR) and
  multi-number support are genuine differentiators in the SMB segment,
  particularly in India and other WhatsApp-first markets.
- **Approvals are table stakes in claims, uneven in practice.** Relevance,
  n8n, Zapier and Sierra have the most concrete mechanisms; Darex's
  plan-card plus autonomy tiers is competitive once its UI gaps close.
- **Feature churn at the frontier labs is a real cost for SMBs** (ChatGPT
  agent → Work, Pulse → scheduled tasks, App Directory → Plugin Directory,
  all within about a year per 3P). Stability is a selling point.

---

## 5. Feature-by-feature comparison matrix

Four tables, one per competitor camp, each with the same 45 rows and Darex in
the first column. Marks follow the legend in section 0. Competitor marks are
taken from section 4 and its sources; anything not found is ❓ rather than ❌
unless a source says it is absent. "Darex" means code on `main` today.

Row key (used in all four tables):

| # | Capability | What counts as ✅ |
|---|---|---|
| R1 | Ready-made role-based employees | Named roles that work on day one without building |
| R2 | One memory shared by all agents of a business | Org-level memory that every agent reads and writes |
| R3 | One chat front door to all agents | A single conversation can reach any agent |
| R4 | Multi-agent team on one request | Several agents run in parallel and a manager synthesises |
| R5 | Plan preview and edit before execution | User sees and edits steps before anything runs |
| R6 | Approval before risky actions | Sends, payments, deletes wait for a human |
| R7 | Graduated autonomy per agent | Configurable levels, not just on/off |
| R8 | Per-agent tool allowlist | Each agent restricted to its own tools |
| R9 | Audit trail attributed to the agent | Who/which agent did what, reviewable |
| R10 | Role-scoped memory | An agent only learns what its role should |
| R11 | Durable execution | Long jobs survive restarts and outages, resume |
| R12 | CRM write actions | Create/update records in a CRM |
| R13 | Payment actions (refund, link, invoice) | Stripe/Razorpay-style write actions |
| R14 | Calendar actions | Create/move events |
| R15 | Email read, search, reply | Threaded reply in the owner's mailbox |
| R16 | WhatsApp as a customer channel | Agent answers the business's customers on WhatsApp |
| R17 | Instagram / Messenger DMs | Agent answers DMs |
| R18 | SMS | Two-way SMS |
| R19 | Website chat widget | Embeddable widget |
| R20 | Real-time voice phone agent | Answers or places phone calls |
| R21 | Owner can talk to agents over a messaging app | WhatsApp/Telegram/iMessage/Slack to the assistant |
| R22 | Slack | Read and post |
| R23 | Integration breadth | Stated count or named list |
| R24 | Uses external MCP servers | Customer can plug in any MCP |
| R25 | Exposes itself as an MCP server | Other assistants can drive it |
| R26 | Real-time web search | Live web results in answers |
| R27 | Deep research with cited report | Multi-step research producing a cited document |
| R28 | File and image understanding in chat | Drop a PDF/image into the conversation |
| R29 | Voice conversation in the app | Speak and hear replies |
| R30 | Image generation | Text to image |
| R31 | Generated artifacts (docs, slides, sheets, pages) | Produced natively, downloadable |
| R32 | Shareable links to outputs | Public or org-scoped links |
| R33 | User-created scheduled tasks / routines | "Every Monday at 9, do X" from the UI or chat |
| R34 | Event triggers | Start on an app event or webhook |
| R35 | Proactive daily brief | Unprompted summary delivered to the owner |
| R36 | Browser / computer use | Agent drives a browser or desktop |
| R37 | Code / data sandbox | Run code on data |
| R38 | Model choice or multi-model routing | More than one model family, selectable or routed |
| R39 | Mobile app | Native iOS/Android (or full PWA) |
| R40 | Desktop app | Native desktop client |
| R41 | Vertical packs | Industry-specific bundles |
| R42 | SOC 2 or ISO 27001 | Claimed certification |
| R43 | Self-serve entry ≤ $50/month | Public price an SMB can buy without sales |
| R44 | Outcome- or resolution-based pricing | Pay per result |
| R45 | Built for the business's customers, not only the owner | Customer-facing front line is a core use |

### 5.1 Darex vs frontier assistants

| # | Darex today | Grok app / Business | Grok Bot (beta) | ChatGPT | Claude | Gemini (app + Enterprise) | Copilot Studio / M365 |
|---|---|---|---|---|---|---|---|
| R1 | ✅ 9 roles + custom | ❌ | 🟡 8 starter roles, user-defined | ❌ (GPTs are DIY) | ❌ | 🟡 Agent Gallery (Enterprise) | 🟡 templates |
| R2 | ✅ | ❌ | ❌ per-Bot memory | ❌ per-user | ❌ per-user / project | 🟡 enterprise index | 🟡 M365 graph grounding |
| R3 | ✅ | ✅ (one assistant) | 🟡 group chats 2–6 | ✅ (one assistant) | ✅ | ✅ | ✅ |
| R4 | ✅ cap 3 | 🟡 Heavy multi-agent model | ✅ | ❓ | ❓ | ❓ | 🟡 |
| R5 | ✅ plan card, edit, re-approve | ❌ | ❌ | 🟡 Work shows plan (3P) | ❓ | 🟡 workflow builder | 🟡 designer |
| R6 | ✅ confirm classes + tool gate | ❌ | 🟡 allow/rule/deny + Auto Review | 🟡 confirmations (❓ detail) | 🟡 permission prompts | 🟡 admin read/write per node | 🟡 HITL connector (preview) |
| R7 | ✅ tiers | ❌ | 🟡 "progressive trust" | ❌ | ❌ | ❌ | ❌ |
| R8 | ✅ | ❌ | ❌ shared computer, shared logins | ❌ | 🟡 admin connector controls | 🟡 | ✅ per agent |
| R9 | ✅ `audit_events`, by employee | 🟡 Enterprise audit | 🟡 Enterprise, actions look like the user | 🟡 Enterprise | 🟡 Enterprise | ✅ | ✅ |
| R10 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❓ |
| R11 | ✅ Temporal | ❌ | ✅ cloud VM persists | 🟡 Work runs for hours | 🟡 desktop must stay on | ✅ | ✅ |
| R12 | ✅ HubSpot, Salesforce, Zoho | 🟡 Salesforce connector | 🟡 via plugins / browser | 🟡 plugins | 🟡 MCP | 🟡 connector actions | ✅ Dynamics + connectors |
| R13 | ✅ Stripe, Razorpay, QuickBooks | ❌ | 🟡 browser, asks for payments | ❓ | ❓ | ❓ | 🟡 connectors |
| R14 | ✅ Google + Microsoft | ✅ Google/Outlook calendar | ✅ | ✅ | ✅ | ✅ | ✅ |
| R15 | ✅ Gmail, Outlook (🟡 live) | 🟡 Gmail/Outlook connectors | ✅ | ✅ | ✅ | ✅ | ✅ |
| R16 | ✅ Meta Cloud + QR (🟡 live) | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 via Azure Communication Services |
| R17 | ✅ Instagram (🟡 live) | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 "social platforms" |
| R18 | 🟡 Twilio send | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 ACS |
| R19 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| R20 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 Dynamics Contact Center |
| R21 | 🟡 daily brief to WhatsApp/Slack; no two-way owner chat | 🟡 Grok in X | ❌ (desktop/iOS app) | ❌ | 🟡 Slack (❓) | ❌ | ✅ Teams |
| R22 | ✅ | ❓ | ✅ plugins | ✅ | ✅ | ❓ | ✅ |
| R23 | ~45 provider modules, 154 chat tools | ~8 connectors + MCP | marketplace + any website | "dozens" of plugins | MCP directory (❓ count) | Workspace + MS + ITSM | Power Platform (1,400+ UNVERIFIED) |
| R24 | 🟡 MCP bridge is internal only | ✅ custom MCP tunnelling | ✅ | ✅ Apps SDK | ✅ | ❓ | ✅ (GA 2026, UNVERIFIED) |
| R25 | 🟡 bridge exists, not customer-facing | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| R26 | ✅ SearXNG etc. | ✅ incl. X real-time | ✅ | ✅ | ✅ | ✅ | ✅ |
| R27 | ❌ | ✅ DeepSearch (3P) | ✅ | ✅ Deep Research | ✅ Research | ✅ Deep Research | ❓ |
| R28 | UI only | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R29 | UI only (mock mic) | ✅ | ✅ | ✅ | ❓ | ✅ Gemini Live | ✅ |
| R30 | ❌ | ✅ Imagine | ❓ | ✅ | ❌ | ✅ | ✅ |
| R31 | 🟡 via Google Docs/Sheets/Slides tools | 🟡 Drive write | ✅ files in workspace | ✅ Work deliverables | ✅ file creation | ✅ Canvas | ✅ |
| R32 | ❌ | ✅ shared links | ❓ | ✅ | ✅ | ✅ | ✅ |
| R33 | ❌ (built-in sweeps only) | ❓ | ✅ Routines (50/Bot) | ✅ 3–15 active | ❓ | ✅ Scheduled Actions (10) | ✅ |
| R34 | ✅ webhooks, inbound channels | ❌ | ✅ Slack/GitHub events | ❓ | ❓ | ✅ | ✅ |
| R35 | ✅ morning triage + brief | ❌ | 🟡 via routine | 🟡 scheduled briefing (Pulse retired) | ❓ | 🟡 Daily Brief (3P) | ❓ |
| R36 | ❌ | ❌ | ✅ core feature | ✅ cloud browser / Work (3P) | ✅ Claude in Chrome | ❓ | 🟡 preview, US |
| R37 | 🟡 sandbox tool | ❓ | ✅ terminal | ✅ | ✅ | ✅ | 🟡 |
| R38 | ❌ one cheap Gemini route + Groq fallback | ❌ Grok models | ❌ auto, no override | 🟡 OpenAI family | 🟡 Claude family | 🟡 Gemini family | 🟡 |
| R39 | ❌ | ✅ iOS + Android | ✅ iOS | ✅ | ✅ | ✅ | ✅ |
| R40 | ❌ | ❓ | ✅ macOS/Win/Linux | ✅ | ✅ | ❌ | ✅ |
| R41 | ✅ real estate | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 industry templates |
| R42 | ❌ | ❓ | ❌ (none claimed) | ✅ | ✅ | ✅ | ✅ |
| R43 | ❓ plan docs disagree ($49 vs $99) | ✅ $30/seat | 🟡 bundled from $20–200 | ✅ | ✅ | ✅ | ❌ ($200 credit pack) |
| R44 | ❌ credits | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| R45 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 |

### 5.2 Darex vs general agents and SMB AI-employee products

| # | Darex today | Manus | Genspark (+ Claw) | Lindy | Relevance AI | Sintra |
|---|---|---|---|---|---|---|
| R1 | ✅ | ❌ | 🟡 Claw = one personal employee | 🟡 templates | 🟡 BDR agent, templates | ✅ 12 helpers |
| R2 | ✅ | ❓ | 🟡 Claw cross-channel memory | 🟡 per-user editable memory | ✅ long-term + RAG | ✅ Brain AI |
| R3 | ✅ | ✅ | ✅ | ✅ | 🟡 per-agent chat | 🟡 per-helper chat |
| R4 | ✅ cap 3 | ✅ Wide Research | ✅ Super Agent | 🟡 | ✅ sub-agents, Workforce canvas | ❌ |
| R5 | ✅ | 🟡 shows plan | ❓ | ❓ | ✅ dry runs | ❌ |
| R6 | ✅ | 🟡 takeover on login | ✅ "external actions require permission" | ✅ by default | ✅ per action | 🟡 "approval levels" |
| R7 | ✅ | ❌ | ❌ | 🟡 | ✅ required / agent's choice / none | ❓ |
| R8 | ✅ | ❌ | ❌ | 🟡 | ✅ | ❓ |
| R9 | ✅ | 🟡 run history | ❓ | 🟡 Enterprise | ✅ | ❓ |
| R10 | ✅ | ❌ | ❌ | ❌ | ❓ | ❌ |
| R11 | ✅ | ✅ VM | ✅ 24/7 VM | 🟡 | ✅ | ❓ |
| R12 | ✅ | 🟡 browser | 🟡 limited | ✅ HubSpot etc. | ✅ | ❌ |
| R13 | ✅ | 🟡 browser | ❓ | 🟡 via integrations | ✅ | ❌ |
| R14 | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ Google Calendar |
| R15 | ✅ (🟡 live) | 🟡 Mail Manus trigger | ✅ AI Inbox | ✅ | ✅ | ✅ |
| R16 | ✅ (🟡 live) | ❌ (Meta intent only) | 🟡 owner-side WhatsApp, not a business inbox | ❌ | ✅ via Twilio | ❌ |
| R17 | ✅ (🟡 live) | ❌ | ❓ | ❌ | ❓ | 🟡 posts, not DMs (❓) |
| R18 | 🟡 | ❌ | ❓ | ❓ | ✅ | ❌ |
| R19 | ✅ | ❌ | ❌ | ❓ | ✅ | ❌ |
| R20 | ❌ | ❌ | 🟡 Call For Me (outbound) | 🟡 Lindy Phone | ✅ Enterprise | ❌ |
| R21 | 🟡 | 🟡 email | ✅ WhatsApp, Telegram, LINE, Slack, Signal… | ✅ iMessage, Slack | ✅ Slack/Teams | ❌ |
| R22 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| R23 | ~45 modules | ❓ | ❓ (comms-heavy list) | 1,000–1,500+ | 1,000–2,000+ | 15+ (banner 1000+) |
| R24 | 🟡 internal | ❓ | ❓ | ✅ | ✅ | ❌ |
| R25 | 🟡 | ❌ | ❌ | ❌ | ✅ build via MCP | ❌ |
| R26 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R27 | ❌ | ✅ Wide Research | ✅ | ❓ | 🟡 | ❌ |
| R28 | UI only | ✅ | ✅ | ✅ | ✅ | ✅ |
| R29 | UI only | ❌ | ✅ | ❓ | 🟡 voice agents | ❓ |
| R30 | ❌ | ✅ | ✅ | ❓ | 🟡 via tools | ✅ |
| R31 | 🟡 | ✅ decks, sites | ✅ Slides/Sheets/Docs | 🟡 | 🟡 | ✅ content |
| R32 | ❌ | ✅ | ✅ web links | ❓ | ✅ hosted app | ❓ |
| R33 | ❌ | ✅ | ✅ Schedules + Heartbeat | ✅ one-sentence routines | ✅ cron, self-schedule | ✅ |
| R34 | ✅ | 🟡 email trigger | 🟡 | ✅ | ✅ hundreds | ❓ |
| R35 | ✅ | 🟡 scheduled output | ✅ Heartbeat | ✅ morning brief | 🟡 | ✅ meeting prep |
| R36 | ❌ | ✅ | ✅ | ✅ Pro+ | 🟡 | ❌ |
| R37 | 🟡 | ✅ | ✅ | ❓ | ✅ Python/JS | ❌ |
| R38 | ❌ | 🟡 own models tiers | ❓ | ❓ | ✅ any + BYOK + fallback | ❓ |
| R39 | ❌ | ✅ | ✅ | ✅ iMessage-first | ✅ | ✅ iOS |
| R40 | ❌ | ❓ | ✅ Claw desktop mode | ❓ | ❌ | ❌ |
| R41 | ✅ | ❌ | ❌ | ❌ | ❌ | 🟡 eCommerce helper |
| R42 | ❌ | ❓ | ❓ | 🟡 HIPAA BAA Enterprise | ✅ SOC 2 Type II | ❓ |
| R43 | ❓ | ✅ $20 | ✅ ~$25 | ✅ $29.99 | ❌ sales-led | ✅ $15.60–48.50 |
| R44 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| R45 | ✅ | ❌ | ❌ | ❌ | ✅ | 🟡 support helper |

### 5.3 Darex vs builders, knowledge platforms and sales AI employees

| # | Darex today | Dust | Glean | Zapier Agents | n8n | Artisan | 11x |
|---|---|---|---|---|---|---|---|
| R1 | ✅ | ❌ DIY | 🟡 prebuilt agents | 🟡 templates | 🟡 templates | ✅ Ava (one role) | ✅ Alice, Julian |
| R2 | ✅ | ✅ workspace knowledge | ✅ enterprise index | 🟡 knowledge per agent | ❌ | ❌ | 🟡 KB |
| R3 | ✅ | ✅ | ✅ | 🟡 | 🟡 | ❌ | ❌ |
| R4 | ✅ | ✅ | 🟡 | ❓ | ✅ | ❌ | ❌ |
| R5 | ✅ | ❓ | ❓ | 🟡 Copilot builds visible Zap | ✅ visual workflow | ❌ | ❌ |
| R6 | ✅ | ✅ action validation | 🟡 moderators | ✅ HITL app | ✅ per-tool review | ✅ approvals | 🟡 live transfer |
| R7 | ✅ | ❌ | ❓ | ❌ | ❌ | 🟡 tone/CTA locks | ❌ |
| R8 | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a |
| R9 | ✅ | ✅ | ✅ | 🟡 activity log | 🟡 executions | ✅ | ❓ |
| R10 | ✅ | 🟡 per-user per-agent | ✅ permission-aware | ❌ | ❌ | n/a | n/a |
| R11 | ✅ | 🟡 | 🟡 | 🟡 | ✅ queue mode | ✅ | ✅ |
| R12 | ✅ | 🟡 beta imports | ✅ via MCP | ✅ | ✅ | ✅ CRM sync | ✅ |
| R13 | ✅ | ❌ | 🟡 | ✅ | ✅ | ❌ | ❌ |
| R14 | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ booking | ✅ booking |
| R15 | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ outbound | ✅ |
| R16 | ✅ | ❌ | ❌ | 🟡 via apps | 🟡 via nodes | ❌ | ✅ |
| R17 | ✅ | ❌ | ❌ | 🟡 | 🟡 | ❌ | 🟡 social |
| R18 | 🟡 | ❌ | ❌ | 🟡 | 🟡 | ❌ | ✅ |
| R19 | ✅ | ❌ | ❌ | ✅ chatbots | ✅ chat UI | ❌ | ✅ Julian Chat |
| R20 | ❌ | ❌ | ❌ | ❌ | 🟡 via nodes | 🟡 dialer | ✅ Julian Voice |
| R21 | 🟡 | ✅ Slack/Teams | ✅ Slack | 🟡 | ✅ Telegram etc. | ❌ | ❌ |
| R22 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| R23 | ~45 | 70+ (+MCP) | 275+ | 9,000+ apps | 500+ nodes | CRM + calendar | CRM, Slack, Gmail, LinkedIn |
| R24 | 🟡 | ✅ | ✅ | ❓ | ✅ | ❌ | ❌ |
| R25 | 🟡 | ✅ Dust MCP | ❓ | ✅ 30,000 actions | ✅ | ❌ | ❌ |
| R26 | ✅ | ✅ | ✅ | ✅ | ✅ | ❓ | ✅ |
| R27 | ❌ | 🟡 | 🟡 | ❌ | ❌ | ❌ | ✅ account research |
| R28 | UI only | ✅ | ✅ | 🟡 | 🟡 | ❌ | ❌ |
| R29 | UI only | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ voice agent |
| R30 | ❌ | ❓ | ❌ | 🟡 | 🟡 | ❌ | ❌ |
| R31 | 🟡 | ✅ Frames | 🟡 | 🟡 Interfaces | 🟡 | ❌ | ❌ |
| R32 | ❌ | ✅ | ❓ | ✅ | 🟡 | ❌ | ❌ |
| R33 | ❌ | ✅ NL schedules | 🟡 private beta | ✅ | ✅ | ✅ sequences | ✅ |
| R34 | ✅ | ✅ webhooks | ✅ content triggers | ✅ | ✅ | ✅ intent signals | ✅ signals |
| R35 | ✅ | 🟡 | ❓ | 🟡 | 🟡 | ❌ | ❌ |
| R36 | ❌ | ❌ | ❌ | 🟡 "work on the web" | 🟡 | ❌ | ❌ |
| R37 | 🟡 | 🟡 | ❌ | 🟡 code steps | ✅ | ❌ | ❌ |
| R38 | ❌ | ✅ 20+ models | 🟡 | 🟡 per-model AI steps | ✅ hundreds | ❓ | ❓ |
| R39 | ❌ | ❌ | 🟡 | 🟡 | ❌ | ❌ | ❌ |
| R40 | ❌ | ❌ (extension) | ❌ | ❌ | 🟡 self-host | ❌ | ❌ |
| R41 | ✅ | ❌ | ❌ | ❌ | 🟡 templates | ❌ | ❌ |
| R42 | ❌ | ✅ | ✅ | ✅ | ✅ (Enterprise) | ✅ | ❓ |
| R43 | ❓ | ✅ €24–30 | ❌ | ✅ $19.99+ | ✅ €20 | ❌ | ❌ |
| R44 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| R45 | ✅ | ❌ | ❌ | 🟡 | 🟡 | 🟡 prospects | ✅ |

### 5.4 Darex vs customer-experience agents and CRM-native suites

| # | Darex today | Fin | Decagon | Sierra | Agentforce | HubSpot Breeze |
|---|---|---|---|---|---|---|
| R1 | ✅ | 🟡 one role (support) | 🟡 one role | 🟡 one role | 🟡 role agents | 🟡 Customer + Prospecting |
| R2 | ✅ | 🟡 knowledge + data connectors | ✅ user memory (3P) | ✅ Agent Data Platform | ✅ Data Cloud | ✅ CRM |
| R3 | ✅ | ❌ | ❌ | ❌ | 🟡 | 🟡 |
| R4 | ✅ | 🟡 Operator agent | ❓ | 🟡 supervisors | ✅ | ❓ |
| R5 | ✅ | 🟡 Procedures + Simulations | ✅ AOPs + simulations | ✅ Ghostwriter + sandbox | ✅ builder | 🟡 |
| R6 | ✅ | ✅ checkpoints | ✅ guardrails | ✅ deterministic gates | ✅ | 🟡 handoff |
| R7 | ✅ | ❌ | ❌ | 🟡 creative ↔ deterministic per workflow | ❓ | ❌ |
| R8 | ✅ | ✅ per Procedure | ✅ | ✅ | ✅ | ✅ |
| R9 | ✅ | ✅ | ✅ Watchtower | ✅ observability | ✅ | ✅ |
| R10 | ✅ | n/a | n/a | n/a | ❓ | ❓ |
| R11 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R12 | ✅ | ✅ via helpdesks | ✅ | ✅ | ✅ Salesforce | ✅ HubSpot |
| R13 | ✅ | ✅ via Procedures | ✅ | ✅ | ✅ | 🟡 |
| R14 | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ |
| R15 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R16 | ✅ | ✅ | ❓ | ✅ | ✅ | 🟡 |
| R17 | ✅ | ✅ | ❓ | ❓ | ✅ | 🟡 |
| R18 | 🟡 | ✅ | ❓ | ✅ | ✅ | 🟡 |
| R19 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R20 | ❌ | 🟡 Fin Voice (sales-led) | ✅ | ✅ | ✅ voice actions | ❓ |
| R21 | 🟡 | ❌ | ❌ | ❌ | ✅ Slack | ❌ |
| R22 | ✅ | ✅ | ❓ | ❓ | ✅ | ✅ |
| R23 | ~45 | 9+ helpdesks + data connectors | ❓ not published | ❓ not published | Salesforce + MuleSoft | HubSpot + marketplace |
| R24 | 🟡 | ❓ | ❓ | ❓ | ✅ (❓ GA) | ❓ |
| R25 | 🟡 | ❌ | ❌ | 🟡 ChatGPT channel | ❓ | ❓ |
| R26 | ✅ | ❌ | ❌ | ❌ | ❓ | 🟡 |
| R27 | ❌ | ❌ | ❌ | 🟡 Explorer (analytics) | ❓ | 🟡 prospect research |
| R28 | UI only | 🟡 customer attachments | ❓ | ❓ | ✅ | ✅ |
| R29 | UI only | 🟡 | ✅ | ✅ | ✅ | ❓ |
| R30 | ❌ | ❌ | ❌ | ❌ | ❓ | ✅ content |
| R31 | 🟡 | ❌ | ❌ | ❌ | 🟡 | 🟡 |
| R32 | ❌ | ❌ | ❌ | ❌ | ❓ | ❓ |
| R33 | ❌ | ❌ | 🟡 proactive | ✅ Horizon triggers | ✅ | ✅ workflows |
| R34 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R35 | ✅ | 🟡 Insights | 🟡 Insights | 🟡 Monitors | ❓ | 🟡 |
| R36 | ❌ | ❌ | ❌ | ❌ | ❓ | ❌ |
| R37 | 🟡 | 🟡 code snippets | ❓ | ✅ SDK | ✅ Apex | ❌ |
| R38 | ❌ | ❌ Apex model | ❓ | ✅ multi-model (❓ detail) | ✅ | ❓ |
| R39 | ❌ | ✅ (Intercom app) | ❌ | ❌ | ✅ | ✅ |
| R40 | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| R41 | ✅ | ❌ | 🟡 industry focus | 🟡 industry focus | ✅ Industries add-on | ❌ |
| R42 | ❌ | ✅ | ✅ | ✅ SOC 2, ISO 27001/42001, HIPAA | ✅ | ✅ |
| R43 | ❓ | ✅ ~$49.50 floor | ❌ | ❌ | ❌ | ❌ Professional tier |
| R44 | ❌ | ✅ $0.99 | ✅ per resolution | ✅ outcome | ✅ $2 | ✅ $0.50 |
| R45 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 5.5 Matrix roll-up

Counting ✅ only (🟡, UI and ❓ ignored) across the 45 rows, computed from the
four tables above. A ❓ counts as "not ✅", so poorly documented products are
under-counted; treat this as a rough shape, not a score.

| Product | ✅ of 45 | Where its ✅ cluster |
|---|---|---|
| **Darex today** | **24** | Governance (R5–R11), business actions (R12–R16), customer channels (R16–R19), packs |
| Agentforce | 31 | Enterprise breadth on the Salesforce platform |
| Relevance AI | 30 | Builder depth, approvals, channels, models |
| Copilot Studio / M365 | 22 | Governance, connectors, Microsoft clients |
| Genspark (+ Claw) | 22 | Outputs, owner-side messaging, VM, schedules |
| Sierra | 22 | CX guardrails, voice, outcome pricing |
| n8n | 21 | Triggers, HITL, models, self-hosting |
| ChatGPT | 19 | Assistant basics, artifacts, schedules, clients |
| Dust | 19 | Shared knowledge, models, MCP both ways |
| Fin | 19 | CX channels, approvals, outcome pricing |
| Gemini (app + Enterprise) | 18 | Assistant basics, schedules, Workspace actions |
| HubSpot Breeze | 18 | CRM-native actions and workflows |
| Grok Bot (beta) | 17 | Autonomy, computer use, routines, assistant basics |
| Claude | 16 | Assistant basics, MCP, file creation |
| Lindy | 16 | Approvals, routines, owner messaging |
| Decagon | 16 | CX guardrails, voice |
| 11x | 16 | Sales channels incl. voice and WhatsApp |
| Manus | 15 | Autonomy, research, outputs |
| Zapier Agents | 15 | Triggers, HITL, catalogue |
| Glean | 13 | Knowledge, permissions, governance |
| Sintra | 12 | Roles, shared brain, price |
| Grok app / Business | 11 | Assistant basics, X data |
| Artisan | 10 | Outbound sales loop |

Read: the products with more ✅ than Darex (Agentforce, Relevance AI) are
platforms that need a CRM migration or a builder. Agentforce, Sierra, Fin and
Relevance match Darex on the governance block (R5–R11), but each of them is
either one role (support) or a build-it-yourself platform, and none ships an
SMB price with prebuilt roles. Darex is the only product in the set that
combines the governance block with prebuilt roles, one shared memory, a single
chat front door, WhatsApp and Instagram business channels and a vertical pack.
Darex's ❌ and UI cells concentrate in R26–R40, the assistant-basics block that
the frontier labs dominate, plus certifications (R42) and pricing clarity
(R43–R44). That pattern is the core input to the plan in `08`.

---

## 6. Pricing comparison

### 6.1 Entry prices an SMB owner will see first

| Product | Entry paid price | Unit | Observed | Confidence |
|---|---|---|---|---|
| Sintra | $15.60–48.50/mo | Account, 250 credits | 2026-10-09 | Official |
| Manus Pro | $20/mo | Account, 4,000 credits | 2026-10-09 | Official |
| Claude Pro / Team | $17–20/mo; $20–25/seat | User | 2026-10-09 | Official |
| Google AI Pro | $19.99/mo | User | 2026-10-09 | Official via search |
| Zapier Professional | $19.99/mo annual | 750 tasks | 2026-10-09 | Official |
| n8n Starter | €20/mo annual | 2,500 executions | 2026-10-09 | Official (EUR) |
| ChatGPT Plus / Business | $20 / $20–25 per seat | User | not re-verified | UNVERIFIED |
| Gemini Enterprise Business | ~$21/seat | User, ≤300 | June 2026 | 3P |
| M365 Copilot Business | $21/seat | User, ≤300 | Dec 2025 | 3P |
| Dust Pro | €24–30/seat | 8,000 credits | 2026-10-09 | Official (EUR) |
| Genspark Plus | ~$24.99/mo | 10,000 credits | Sept–Oct 2026 | 3P |
| Lindy Team | $29.99/mo | 3,000 credits, pooled | 2026-10-09 | Official |
| Grok Business | $30/seat | User | 2025-12-30 | Official |
| SuperGrok | ~$30/mo | User | mid-2026 | 3P |
| Genspark Claw | ~$39.99/mo | Personal VM | 2026 | 3P |
| Fin | ~$49.50/mo floor | 50 outcomes at $0.99 | 2026-10-09 | Official |
| Copilot Studio | $200/mo | 25,000 credits | 2026-10-09 | Official |
| HubSpot Breeze agents | Professional tier + $0.50/resolution | Seat + outcome | 2026-04-14 | Official + 3P |
| Artisan | ~$250–600+/mo | Credits, annual | 2026 | 3P |
| 11x | $2,417–5,333/mo | Per worker, annual | 2026-10-09 | Official |
| Glean | ~$50K+/yr | ~100 seats min | 2026 | 3P |
| Decagon | ~$50K+/yr floor | Platform + usage | 2026 | 3P |
| Sierra | ~$150K+/yr | Platform + outcomes | 2026 | 3P |

### 6.2 Darex's own price, as documented (needs one answer)

| Source document | Plans |
|---|---|
| `docs/how-we-are-differennt/us-vs-everyone-else.md` (2026-10-01) | $49/mo for 10,000 credits; $99/mo for 30,000 credits; custom Enterprise |
| `docs/new-109-pg-plan/payment/payment-plans.md` | Free pilot 14 days / 500 credits; Starter $99 ($79 annual), 5,000 credits, 3 seats, autonomy L2; Growth $299 ($239), 25,000 credits, 10 seats; Scale $799 ($639), 80,000 credits, 25 seats; Enterprise from $2,499; top-ups $29 / 2,500 up to $249 / 30,000; add-ons incl. dedicated WhatsApp line $49/mo, BYOK $99/mo |

Observations:

- At **$99 Starter**, Darex sits above every general assistant and every SMB
  AI-employee product except Copilot Studio, and far below every sales or CX
  agent. That is defensible only if the buyer compares Darex to a human hire or
  to Fin/HubSpot/11x, not to ChatGPT or Sintra.
- At **$49 for 10,000 credits**, Darex is priced next to Fin's floor and
  Lindy's 5,000-credit tier ($49.99), with twice Lindy's credits.
- `payment-plans.md` prices an inbound WhatsApp turn at 3 credits (~$0.03 at
  $0.01/credit). Against Fin's $0.99 per outcome and HubSpot's $0.50, Darex can
  advertise **"a resolved WhatsApp conversation for cents"** — once resolution
  quality is proven.
- `payment-plans.md` also prices "Deep Web Research Task" at 20 credits; that
  feature does not exist yet (section 2.2).
- Recommendation (detailed in `08` §6): pick one public ladder before launch;
  keep a free pilot; show credit cost per action in the UI (already a stated
  differentiator); consider an outcome-priced add-on for the Customer employee
  so buyers can compare directly with Fin and Breeze.

---

## 7. Where Darex already wins, loses, and ties

### 7.1 Wins (defend and market these)

| # | Win | Against whom | Evidence in repo | Caveat |
|---|---|---|---|---|
| W1 | Ready-made roles sharing one company brain, run from one chat | Everyone except Sintra (shallow) and Relevance (DIY) | Roster, `route-employee.ts`, `ask-mode.ts`, Cognee + pgvector + Hindsight | Per-employee specs still being finished (`gap26sept/employees/`) |
| W2 | Plan preview, edit and re-approval before execution | Grok, ChatGPT, Claude, Gemini, Manus, Genspark, Lindy, Sintra | `plan-generator.ts`, plan card, `plan.step_edit` audit | — |
| W3 | Graduated autonomy, per-employee allowlists, confirm classes | Every assistant and general agent | `tool-gate.ts`, `autonomy.ts`, `role-capability.ts` | Autonomy UI gaps (P0 #5/#6) — confirm closed |
| W4 | Audit trail attributed to the employee | Grok Bot (acts as the user), ChatGPT, Claude | `audit_events`, 150 kinds | Audit UI page was P0 #2 |
| W5 | Row-level tenant isolation, org from session only | Grok Bot's shared computer; DIY builders | RLS everywhere, `getScopedClient()` | Not a buyer-visible feature until certified |
| W6 | Durable execution with idempotency | Assistants, Zapier | Temporal, `providerIdempotencyKey` | Idempotency only for Stripe so far |
| W7 | Business channels: WhatsApp (QR + Meta Cloud, multi-number), Instagram DMs, widget, Gmail/Outlook/Slack read-reply from chat | All frontier assistants, Manus, Lindy, Sintra, Dust, Glean | `whatsapp-*.ts`, `tools/instagram.ts`, `tools/gmail.ts` | Real phone scan, real Meta number and live sends **not proven yet** |
| W8 | Write actions across many systems from one place: Stripe refunds, Shopify address, HubSpot/Salesforce/Zoho, calendar | Sintra, Dust, Glean, Grok app | 154 chat tools | OAuth client IDs missing for several providers |
| W9 | Vertical pack (real estate) | Everyone except Agentforce Industries | `app/api/{listings,showings,...}` | MLS licence is a human blocker |
| W10 | Honest failure, no fabricated data | Builders and assistants that hallucinate tool results | Rule 4, `wave-*-honesty.test.ts` | — |
| W11 | Price vs sales/CX agents | 11x, Artisan, Decagon, Sierra, Glean, Agentforce | `payment-plans.md` | Pricing not settled |
| W12 | Proactive operations without prompting (morning triage, signals, slow-rep nudges, brief) | Assistants (only user-created schedules) | `periodic-registry.ts`, sweeps | Not user-editable |

### 7.2 Losses (fix or neutralise)

| # | Loss | Who beats Darex | Impact on SMB buyer | Plan ref (`08`) |
|---|---|---|---|---|
| L1 | No file or image understanding in chat (attach is UI only) | Everyone in the frontier and agent camps | High: first-minute test fails | §4.2 |
| L2 | No voice in chat (mic is a mock) | Grok, ChatGPT, Gemini, Genspark | High on mobile, medium on desktop | §4.3 |
| L3 | No deep research with citations | Grok, ChatGPT, Claude, Gemini, Manus, Genspark | High for Research/Growth employees | §4.1 |
| L4 | No user-created scheduled tasks or routines | ChatGPT, Gemini, Grok Bot, Manus, Genspark, Lindy, Dust, Zapier, n8n | High: "every Monday send me…" is expected | §4.4 |
| L5 | No mobile app | All frontier assistants, Sintra, Genspark, Lindy (iMessage) | High for owners who live on the phone | §4.8 |
| L6 | No shareable artifacts (docs, slides, sheets, pages) | ChatGPT Work, Claude, Gemini, Genspark, Manus, Dust Frames | Medium–high | §4.7 |
| L7 | One low-cost model, no routing, no picker | Dust, Relevance, n8n; frontier labs on quality | High on answer quality for hard tasks | §4.6 |
| L8 | No browser or computer use | Grok Bot, Manus, Genspark, Lindy, ChatGPT, Claude, Copilot | Medium: long-tail apps with no API | §4.10 |
| L9 | No real-time voice phone agent | 11x, Fin, Decagon, Sierra, Relevance, Lindy | Medium–high for service SMBs (clinics, real estate) | §4.3 |
| L10 | No image generation | Grok, ChatGPT, Gemini, Genspark, Sintra | Medium for Marketing employee | §4.5 |
| L11 | Owner cannot chat with employees over WhatsApp/Telegram/iMessage | Genspark Claw, Lindy, Dust (Slack) | Medium–high | §4.9 |
| L12 | No external MCP intake, no public MCP server | Grok, ChatGPT, Claude, Lindy, Dust, Zapier, n8n | Medium (long-tail integrations, distribution) | §4.12–4.13 |
| L13 | Integration breadth (~45 vs 1,000–9,000) and missing OAuth client IDs | Zapier, Lindy, Relevance, Copilot | Medium; quality matters more than count | §4.13 |
| L14 | No SOC 2 / ISO 27001 | Most funded competitors | Medium for SMB, high for mid-market | §5 |
| L15 | No distribution, brand, funding or published proof | Everyone | High | §6 |
| L16 | Live proof gaps: every chat-coverage row 🔴; channels not proven on real accounts | — | High (trust) | §3.1 |

### 7.3 Ties (parity; do not lead with these)

- Real-time web search (everyone has it; Darex's is snippet-level).
- Event triggers and webhooks.
- Slack, Gmail, calendar actions.
- Multi-agent orchestration (Darex cap 3; Grok Bot, Manus, Relevance freer).
- Knowledge upload into a company brain (Sintra, Dust, Relevance, Glean).

---

## 8. Threat assessment

Scored 1–5 on how likely an SMB owner in Darex's target segment picks this
instead of Darex in the next 12 months. Judgement, not measurement.

| Rank | Competitor | Overlap with Darex | Likelihood of substitution | Why | Darex response |
|---|---|---|---|---|---|
| 1 | ChatGPT (Work + plugins + schedules) | Medium | 5 | Already paid for; does research, docs, schedules | Be the operations layer; ship as a ChatGPT/Claude MCP app |
| 2 | Grok Bot / Grok Business | High (concept) | 4 | Same story (teammates, routines, approvals), bundled | Out-govern and out-channel; close basics |
| 3 | Gemini Enterprise / AI Pro | Medium | 4 | Workspace-native; scheduled actions | Cross-system ops (Stripe, Shopify, WhatsApp) Gemini does not do |
| 4 | Genspark Claw | Medium–high | 4 | WhatsApp/Telegram AI employee for ~$40 | Business-side channels, approvals, shared org brain |
| 5 | Fin (Salesforce) | High (Customer employee) | 3 | $0.99/outcome, SMB mandate | Whole workforce; cents per WhatsApp resolution |
| 6 | Lindy | Medium | 3 | Assistant with approvals and routines | Multi-role, WhatsApp, business actions |
| 7 | Sintra | High (framing) | 3 | Cheapest "AI employees" | Depth; real actions; proof |
| 8 | HubSpot Breeze | Medium | 3 | Default for HubSpot shops | Cross-system, WhatsApp |
| 9 | Microsoft Copilot (Business + Studio) | Medium | 2 | Default for M365 shops; complex | Simplicity, one price |
| 10 | Manus (Meta) | Medium | 2 (rising if WhatsApp-native) | General agent; Meta channels later | Watch; business brain |
| 11 | Relevance AI | High (depth) | 2 | Sales-led, builder-heavy | Ready on day one |
| 12 | Zapier / n8n | Medium | 2 | DIY | Ready on day one; use them as tool sources |
| 13 | Dust | Medium | 2 | DIY, Slack-centric | Ready roles, customer channels |
| 14 | 11x, Artisan | Low–medium | 1 | Different budget | Cheaper bundled Growth employee |
| 15 | Decagon, Sierra, Glean, Agentforce | Low | 1 | Enterprise | Not the target |

---

## 9. Positioning implications

### 9.1 One-line positioning that survives this comparison

> **DareXAI One is the operations team for a growing business: ready-made AI
> employees that share one memory of your company, answer your customers on
> WhatsApp, Instagram and email, act in your real systems, and ask before they
> do anything risky.**

Things the line deliberately avoids: "smartest AI" (frontier labs win), "most
integrations" (Zapier wins), "AI employee" alone (everyone says it).

### 9.2 Messages per competitor (for sales and the deck)

| When the buyer says… | Answer |
|---|---|
| "I already have ChatGPT / Grok / Gemini." | Keep it. Those help *you* work. DareXAI One runs the work your business does *without you*: answering customers at 2 AM on WhatsApp, chasing slow leads, issuing in-policy refunds, and asking you only for the decisions. You can even reach your Darex team from those assistants (once §4.12 ships). |
| "Grok Bot does teammates too." | Grok Bots share one computer and act as you; ours each have their own permissions, an audit trail in their own name, a plan you approve, and they talk to your customers on WhatsApp. |
| "Sintra is $16." | Sintra writes content. Ours do the operations: CRM updates, refunds, calendar, customer replies, with approvals. Compare to one hour of a human's time a month. |
| "Fin is $0.99 a resolution." | Fin answers support tickets. Ours also finds revenue and runs operations, from one memory, and a WhatsApp resolution costs cents in credits. |
| "I'll build it in Zapier / n8n." | You can, and you will maintain it. Ours arrive working, recover from outages, and plug into your Zapier or MCP tools when you need the long tail. |

### 9.3 Proof Darex must publish before these messages land

1. A live WhatsApp demo number answering real questions from the Company
   Brain, with an approval card on a refund.
2. Chat coverage matrix rows flipped from 🔴 to 🟢 for the top 30 tools.
3. Three named pilot customers (ideally one real-estate brokerage) with
   before/after numbers.
4. A public, single price ladder.
5. A security page (RLS, encryption, audit, data deletion) and a SOC 2 Type I
   timeline.

---

## 10. Gaps in this research

- Official pricing pages for ChatGPT, Grok (x.ai), Genspark and Manus tiers
  above Pro returned 403 or rendered client-side; their prices rest partly on
  3P sources and are marked.
- Gemini Enterprise official pricing URL returned 404; edition prices are 3P.
- ChatGPT "agent removed August 2026" rests on one source.
- Grok app "Tasks" (scheduled) could not be verified; Grok Bot routines are
  documented.
- Claude connector directory size and Claude in Chrome plan details beyond the
  pricing table were not verified.
- No competitor was tested hands-on; no Darex feature was re-run for this
  document.

---

## 11. Sources

Grouped by competitor. "Internal" means a file in this repo.

**Darex (internal):** `AGENTS.md`; `BUILD_STATE.md` (entries 2026-10-05 to
2026-10-09); `docs/new-109-pg-plan/gap26sept/00-summary.md`;
`docs/new-109-pg-plan/gap26sept/chat-coverage.md`;
`docs/how-we-are-differennt/us-vs-everyone-else.md`;
`docs/new-109-pg-plan/payment/payment-plans.md`; `docs/grok-bot/*`;
`infra/litellm/config.yaml`; `NEW-FRONTEND/src/components/ui/chat-bar.tsx`;
`services/workflows/src/tool-definitions.ts`;
`services/workflows/src/periodic-registry.ts`.

**xAI Grok:** https://docs.x.ai/grok/overview ;
https://docs.x.ai/grok/connectors/google-drive ;
https://x.ai/news/grok-business ; https://x.ai/grok/business ;
https://docs.x.ai/grok-bot/overview ;
https://www.unite.ai/xai-launches-grok-bot-always-on-ai-teammates-with-their-own-cloud-computers/ ;
https://www.eesel.ai/blog/grok-bot ; https://composio.dev/blog/guide-to-frok-bot ;
https://ai-toolbox.co/grok-models/grok-pricing-plans-api-2026 ;
https://suprmind.ai/hub/grok/pricing/ ; https://techjacksolutions.com/ai-tools/grok/grok-pricing/

**ChatGPT:** https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt ;
https://help.openai.com/en/articles/11752874-chatgpt-agent ;
https://help.openai.com/en/articles/6825453-chatgpt-release-notes ;
https://www.digitalapplied.com/blog/chatgpt-work-openai-agent-launch-2026 ;
https://www.leadwithai.co/article/chatgpt-work-is-here-openais-answer-to-claude-cowork ;
https://thecentral.ai/p/chatgpt-work-explained ; https://www.usecarly.com/blog/what-is-chatgpt-work/ ;
https://en.wikipedia.org/wiki/OpenAI_Operator ;
https://techjacksolutions.com/ai-brief/agentic-ai-news-openai-launches-scheduled-tasks-in-chatgpt-a/ ;
https://justinmckelvey.com/blog/chatgpt-pulse ; https://blog.coupler.io/best-chatgpt-connectors/ ;
https://www.g-talent.net/blogs/chatgpt/precio-agentes-chatgpt-plan-2026

**Claude:** https://claude.com/pricing ; https://ai.zenken.co.jp/en/post/claude-cowork-howto/ ;
https://fast.io/resources/claude-cowork-review-2026/ ; https://aiproductivity.ai/pricing/claude/

**Gemini:** https://gemini.google/subscriptions/ ;
https://cloud.google.com/gemini-enterprise/faq ;
https://docs.cloud.google.cn/gemini/enterprise/docs/workflow-builder/use-connector-actions ;
https://docs.cloud.google.com/gemini/enterprise/docs/agent-designer/schedule-agent ;
https://redresscompliance.com/google-gemini-enterprise-licensing-guide-2026.html ;
https://tech.yahoo.com/ai/articles/google-geminis-scheduled-actions-finally-025838564.html ;
https://blog.mean.ceo/?p=10343 ; https://www.ai-toolbox.co/gemini-models/gemini-pricing-plans-2026

**Microsoft:** https://www.microsoft.com/en-us/microsoft-365-copilot/pricing/copilot-studio ;
https://www.microsoft.com/licensing/guidance/Copilot-Credits ;
https://microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/whats-new-in-copilot-studio-march-2025 ;
https://www.microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/whats-new-in-copilot-studio-september-2025/ ;
https://learn.microsoft.com/en-us/power-platform/release-plan/2025wave1/microsoft-copilot-studio/deploy-copilots-whatsapp-azure-communications-service-chat-sms-channels ;
https://mc.merill.net/message/MC1471573 ; https://www.cloudzero.com/blog/copilot-studio-pricing/

**Manus:** https://help.manus.im/en/articles/11711111-what-is-the-current-membership-pricing-for-manus ;
https://manus.im/es/blog/introducing-wide-research ; https://www.manus.im/docs/features/scheduled-tasks ;
https://www.manus.im/docs/features/mail-manus ; https://www.techradar.com/pro/meta-buys-manus-for-usd2-billion-to-power-high-stakes-ai-agent-race ;
https://sacra.com/c/manus

**Genspark:** https://www.genspark.ai/helpcenter/genspark-claw ;
https://www.genspark.ai/helpcenter/connectors-and-integrations ;
https://mainfunc.ai/blog/genspark_ai_workspace_and_series_b_funding ;
https://www.eesel.ai/blog/genspark-ai-pricing ; https://sacra.com/c/genspark/

**Lindy:** https://www.lindy.ai ; https://www.lindy.ai/pricing ;
https://www.lindy.ai/blog/lindy-3-0 ; https://docs.lindy.ai/skills/by-lindy/lindy-phone

**Relevance AI:** https://relevanceai.com/features ; https://relevanceai.com/pricing ;
https://relevanceai.com/approvals-escalations ;
https://relevanceai.com/blog/the-ai-workforce-revolution-24m-series-b-to-accelerate-our-mission

**Sintra:** https://sintra.ai ; https://sintra.ai/pricing ;
https://tech.eu/2025/06/10/lithuanian-ai-startup-sintra-secures-17m-seed-empowering-smbs-with-ai-helpers/

**Artisan:** https://www.artisan.co/ ; https://www.artisan.co/llms-full.txt ;
https://theaiagentindex.com/agents/artisan-ava ; https://marketbetter.ai/blog/artisan-ai-pricing-2026/

**11x:** https://www.11x.ai/ ; https://docs.11x.ai/help-center/overview/11x-pricing-overview ;
https://www.11x.ai/products/julian/pricing ;
https://techcrunch.com/2025/03/24/a16z-and-benchmark-backed-11x-has-been-claiming-customers-it-doesnt-have

**Dust:** https://dust.tt/ ; https://dust.tt/home/pricing ; https://docs.dust.tt/llms.txt ;
https://sifted.eu/articles/dust-series-b-40m

**Glean:** https://www.glean.com/product/agents ; https://www.glean.com/pricing ;
https://docs.glean.com/agents/concepts/triggers ; https://www.glean.com/fr/blog/mcp-mar-drop-2026 ;
https://sacra.com/c/glean

**Zapier:** https://zapier.com/agents ; https://zapier.com/pricing ;
https://zapier.com/zapconnect/launches ; https://community.zapier.com/product-updates/245 ;
https://help.zapier.com/hc/en-us/articles/41776074420493

**n8n:** https://n8n.io/ai-agents/ ; https://n8n.io/pricing/ ;
https://docs.n8n.io/advanced-ai/human-in-the-loop-tools ; https://sifted.eu/articles/n8n-hits-2-5bn-valuation

**Fin:** https://fin.ai/pricing ; https://www.intercom.com/blog/whats-new-with-fin-3/ ;
https://investor.salesforce.com/news/news-details/2026/Salesforce-Signs-Definitive-Agreement-to-Acquire-Fin/ ;
https://www.intercom.com/help/en/articles/16527239-use-procedures-over-fin-voice

**Decagon:** https://decagon.ai/ ; https://decagon.ai/blog/decagon-voice ;
https://decagon.ai/resources/aop-the-future-of-cx ;
https://www.bloomberg.com/news/articles/2026-01-28/ai-customer-support-startup-decagon-valued-at-4-5-billion ;
https://www.eesel.ai/blog/decagon-ai-cost

**Sierra:** https://sierra.ai/ ; https://sierra.ai/blog/agent-os-2-0 ;
https://sierra.ai/blog/agent-data-platform ; https://sierra.ai/blog/defense-in-depth-in-the-age-of-agents ;
https://sierra.ai/blog/outcome-based-pricing-for-ai-agents ;
https://www.trendingtopics.eu/sierra-raises-950-million-bret-taylors-ai-agent-startup-now-valued-at-over-15-billion/

**Agentforce:** https://www.salesforce.com/agentforce/pricing/

**HubSpot Breeze:** https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete ;
https://resolve247.ai/blog/hubspot-breeze-pricing-change
