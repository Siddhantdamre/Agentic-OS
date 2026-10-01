# DareXAI One: what we built and how we are different

> Written 2026-09-30 from the code and `BUILD_STATE.md`. Every feature below
> names the folder it lives in, so it can be checked. Where something is built
> but not proven end to end, the status says so. Nothing here is marketing
> gloss: a feature marked "built" exists in the tree, "verified live" means it
> was run against a real stack, and "blocked" needs a human (keys, OAuth
> client IDs, DNS).

---

## 1. The one-paragraph difference

Most AI products do one job: outbound bots (11x, Artisan) only prospect, support bots
(Intercom Fin, Decagon) only reply, and automation tools (Zapier, Make) run
brittle trigger-action scripts. **DareXAI One is a whole autonomous workforce
on one shared brain.** Growth, Customer and Operations employees, plus a roster
of specialists, share one memory and one set of connected tools. They take real
actions (refunds, calendar moves, CRM writes, WhatsApp replies), they ask a
human before anything risky, and they run durably on Temporal so a provider
outage never loses work. The **Ask AI chat is the front door**: anything doable
on a tab or through a connected tool is doable by asking.

## 2. Seven things competitors do not do together

| # | Difference | What it means in practice | Where it lives |
|---|---|---|---|
| 1 | **One shared brain across employees** | A cancellation reason found by Customer changes what Growth pitches and what Operations audits. Point tools cannot do this because each owns one department. | `services/workflows/src/memory/`, `apps/dashboard/app/(dashboard)/brain` |
| 2 | **Resolve, don't just reply** | 62+ real tool executors mutate Stripe, Calendar, Shopify, HubSpot, Gmail, WhatsApp, Sheets and more. | `services/workflows/src/tool-executor.ts`, `tools/` |
| 3 | **Autonomy ladder with approval** | Four tiers. Irreversible actions always ask first. Escalation is a one-click decision card, not a raw chat log. | `services/workflows/src/autonomy.ts`, `components/inbox/DecisionCard.tsx` |
| 4 | **Durable execution** | Temporal timers, retries and cancellation. A 4 PM promise to a customer still fires after a restart. | `services/workflows/src/workflows/` |
| 5 | **Honest by construction** | A missing connector returns `notConnected` with a link to connect, never invented data. Empty states never hide a server error. | AGENTS.md rule 4, `tools/*`, BUILD_STATE "Elimination of fabricated empty states" |
| 6 | **Multi-tenant SaaS from the database up** | Row-level security on every table, org taken from the session, never the request body. | `apps/dashboard/lib/db.ts`, `infra/db/migrations/` |
| 7 | **Flat, predictable price** | $99 to $799 a month for the workforce, not per-seat taxes or six-figure single-role bots. | `docs/new-109-pg-plan/competitors/` |

---

## 3. The AI employees

### 3.1 Growth employee (find and win revenue)

| Feature | What it does | Code |
|---|---|---|
| Lookalike finder | Learns from closed-won deals, searches for twins, ranks candidates | `growth/lookalike.ts` |
| Market scout | Daily ICP search through Apollo, capped, inserts into HubSpot or a fallback card | `workflows/MarketScoutWorkflow.ts`, `tools/apollo.ts` |
| Buying-signal radar | Funding, hiring and tech-change signals every 4 hours | `growth/signals.ts`, `workflows/growth-watcher.ts` |
| Website visitor identifier | Reverse-IP, needs 2+ high-intent visits in 24h, finds a department head, creates a lead card | `lib/visitor-enrich.ts`, `app/api/widget/intent` |
| Lost-deal reviver | Wakes leads idle 90+ days when fresh news appears | `workflows/DormantLeadRevivalWorkflow.ts` |
| "Why today?" reasoner | Two-sentence reason to reach out now | `growth/why-now.ts` |
| Pre-meeting dossier | One-page brief to Slack when a demo is booked | `workflows/MeetingDossierWorkflow.ts` |
| Outreach drafter | Personalised email, approve or edit in one click, then really sent through Gmail | `components/growth/OpportunityCard.tsx` |
| Smart reply sorter | Interested / objection / out of office / unsubscribe, updates stage, alerts the rep | `growth/reply-classifier.ts`, `workflows/ReplySorterWorkflow.ts` |
| Voice and style learner | A "wrong fit" rejection becomes a saved preference rule | `growth/preferences.ts` |

### 3.2 Customer employee (resolve, 24/7)

| Feature | What it does | Code |
|---|---|---|
| Fast-ack omnichannel ingress | WhatsApp and Chatwoot webhooks return 200 first, then run the agent in Temporal | `app/api/webhooks/` |
| Account profiler | Real MRR (Stripe), lifecycle (HubSpot), open tickets (Zendesk), VIP escalation | `customer/account-profile.ts` |
| Company rulebook expert | Answers from the org brain with citations, refund answers grounded in the real last charge | `memory/employee-retrieve.ts`, `customer/refund-eligibility.ts` |
| Self-service rescheduling | Real Google Calendar update, notifies attendees, logs to HubSpot | `tools/google-calendar.ts` |
| Automated refunds | Re-derives amount and age from Stripe, blocks outside 14 days / $100, approval above that | `tools/stripe.ts`, `autonomy.ts` |
| Order address corrector | Only while the Shopify order is still unfulfilled | `tools/shopify.ts` |
| Never-forgotten promises | Extracts "I'll update you at 4 PM" and sets a durable timer | `customer/obligation-extractor.ts`, `workflows/open-loop-monitor.ts` |
| Manager approval cards | Policy exceptions become one-click cards, with Slack push | `components/inbox/DecisionCard.tsx` |
| Angry-customer radar | Sentiment trend across turns, one Slack alert a day | `workflows/CustomerRecoveryWorkflow.ts` |
| Knowledge-gap finder | Low-confidence questions clustered into ranked missing-SOP topics | `customer/knowledge-gap-clusters.ts` |

### 3.3 Operations employee (the daily COO)

| Feature | What it does | Code |
|---|---|---|
| 9 AM morning triage | Runs at 9:00 in the org's own timezone | `workflows/morning-check.ts` |
| Executive standup brief | Two-minute summary pushed to Slack and WhatsApp | `operations/brief.ts`, `/api/brief` |
| Expected-vs-actual engine | Declarative operating standards audited continuously | `operations/expected-vs-actual-engine.ts` |
| Slow-rep reminder | Nudge at 3 hours, escalate to manager at 5 | `workflows/rep-followup-sla.ts` |
| Workload balancer | Assigns leads to the least-loaded rep, respects quiet hours | `workflows/workload-balancer.ts` |
| Duplicate cleaner | 0.85+ safe merge, 0.60 to 0.85 queued for human review | `operations/dedup-engine.ts` |
| Missing-info auto-fill | Pulls phone and title from email signatures, fills blanks only | `tools/gmail.ts`, `activities/enrichment.ts` |
| Calendar deadlock fixer | Adds Meet links, flags double-bookings, pings unconfirmed guests | `operations/meeting-prep.ts` |
| Stuck-deal unblocker | Deals idle 10+ days get a drafted nudge | `workflows/stuck-work.ts` |
| Outage safety shield | Queues outbound work during a 5xx outage and replays it | `operations/outage-buffer.ts` |

### 3.4 The wider roster and packs

- Roster: Executive, Customer Support, Sales and Lead Gen, Marketing and Analytics, Research, Finance, plus **org-custom employees**. Roles are routed by role keywords, not persona text. (`route-employee.ts`, `employee-capabilities`)
- Each employee has its own **tool allowlist**, persona and memory scope. Picking an employee never widens its allowlist.
- **Industry packs** install a ready team. `core-b2b` (Sarah sales, Emma support, Marcus ops) and a **real-estate brokerage pack** (Aisha buyer ISA, Kabir showings, Meera listings) with RERA, charges and compliance helpers. (`services/workflows/src/packs/`, `tools/realestate/`, `tools/public/rera.ts`)
- **Cold-start seeding** so a new workspace has useful employees on day one. (`cold-start.ts`)

---

## 4. Ask AI chat, the front door

- **Classify, plan, confirm, execute.** Simple asks stream straight through the agent. Complex asks become a **plan card** the user approves, edits or rejects; independent steps run in parallel. (`app/api/ask-ai/`, `plan-generator.ts`)
- **Employee mode selector: Auto / Pick one / Team.** Auto shows why it routed; Pick locks the thread and offers a hand-off for out-of-scope asks; Team runs a fixed crew of up to 3. `@Name` overrides for one message. Validated on the server. (`route-employee.ts`, `crew-runner.ts`)
- **Crew from chat** with a manager that synthesises the specialists' reports. Cap of 3; greetings stay solo. (`crew-planner.ts`, `CrewWorkflow`)
- **Plan runs survive.** Reconnect and resume without re-executing steps, real cancellation through Temporal, revision forces re-approval, each step runs as its assigned employee with audit attribution.
- **Connect a tool from inside the chat**, and the answer picks the best tool available.
- **Readable tool results** in the thread, search results inline, paused-for-approval turns say what is waiting.
- **Cost and speed controls:** output token cap per turn, identical read-only calls reused within a turn, no self-intro or tool narration in replies, blank prompts rejected.

---

## 5. Shared brain and memory

- **Company Brain page** shows what the AI has learned, per org. (`app/(dashboard)/brain`)
- **Three memory engines working together:** Postgres pgvector (SQL, first), **Cognee** knowledge graph, and **Hindsight** agent memory. Results merge with SQL citations first; a slow engine never blocks the answer. (`memory/retrieve.ts`, `cognee-client.ts`, `hindsight-client.ts`)
- One Hindsight bank per org, with business-conversation missions (preferences, budgets, deadlines, commitments, objections; small talk ignored).
- **Freshness aware:** stale rows lose rank so a close fresh hit wins. Fact conflicts are routed for review. (`fact-conflict-route.ts`)
- **Role-scoped memory** and write-back policy, so an employee only learns what its role should. (`writeback-policy.ts`)
- **Operator scripts** to browse databases, memory, logs and status (`infra/scripts/`), read-only by construction.

---

## 6. Connectors and tools

- **Roughly 60 to 139 tool actions** depending on how you count (`tool-definitions.ts`), across: Gmail, Google Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Meet, Chat, Contacts, Ads, Analytics, Search Console, Business Profile; Microsoft Outlook and Calendar; HubSpot, Salesforce, Zoho; Stripe, Razorpay, QuickBooks; Shopify; Slack; Notion; Zendesk, Intercom; Twilio; LinkedIn; Meta Ads; GitHub; DocuSign and Leegality; Apollo; web search and extract; read-only SQL; a code sandbox; file operations locked to the workspace.
- **Nango** handles OAuth. Every executor returns an honest `notConnected` with a connect link instead of pretending.
- **Sanitised tool output** on the MCP bridge, SSRF blocklist on outbound URLs, per-provider rate limits, circuit breaker. (`guardrails/tool-sanitizer.ts`, `tools/safe-url.ts`, `circuit-breaker.ts`)
- **MCP bridge** exposes the same tools as `mcp.darex.*` to the TrueForge agent runtime. (`mcp-bridge.ts`)

---

## 7. WhatsApp, built in (the newest work)

- **Two ways to connect:** scan a QR code (Evolution API) or the official Meta Cloud API, including **Continue with Facebook** embedded signup. A swappable transport package makes a third provider a small addition. (`packages/whatsapp-gateway`)
- **Several numbers per workspace**, QR and official mixed. Each has its own settings; one customer texting two numbers gets two threads answered by the right number.
- **Auto-reply modes:** full AI employee, simple AI from your own instructions, fixed message, or off.
- **Who and when:** everyone, allow list or block list; every message or only new conversations; business hours in the business's own timezone; away message outside hours.
- **Human handoff:** the AI pauses (never to 24 hours, your choice) after a teammate replies.
- **Choose which employee answers**, or let routing pick a customer or support role.
- **Voice notes and images** are transcribed or described, and answered.
- **24-hour window handling** for the official API, with an optional fallback template.
- **Waiting note** when the AI is unsure and holds its answer for the owner.
- **Security:** Meta tokens sealed with AES-256-GCM at rest, never sent to the browser, webhook secrets required.
- Live sign-in-to-reply flow was verified on the dev stack. A real phone scan and real Meta number are **not** verified.

---

## 8. Login, accounts and access

| Capability | Where |
|---|---|
| Email register / login / forgot and reset password | `app/(auth)/`, `app/api/auth/` |
| Terms acceptance stored at signup (`users.terms_accepted_at`) | `115_app_role_timeouts_and_signup_terms.sql` |
| SuperTokens-backed sessions, signed cookies with epoch so a session can be revoked | `lib/supertokens.ts`, `getScopedClient` |
| Social OAuth login and enterprise SSO routes | `app/api/auth/oauth`, `app/api/auth/sso` |
| **MFA (TOTP)** | `app/api/auth/mfa`, `lib/totp.ts` |
| Invite links with roles: owner, admin, member, **billing**, **auditor** | `app/api/auth/invite`, settings |
| Organization switcher and "create a workspace" | `OrganizationSwitcher.tsx` |
| Denied-login audit trail | BUILD_STATE 2026-09-29 |
| Role checks on money paths: pay tools and refunds enforced in Ask AI and approval routes | BUILD_STATE 2026-09-29 |

---

## 9. Trust, safety and governance

- **Autonomy ladder** (tiers 1 to 4) scored by reversibility, blast radius and confidence. Irreversible actions always ask. Approve and reject UI on the settings page. (`autonomy.ts`)
- **Confidence gate** holds low-confidence customer replies for the owner.
- **Audit log:** append-only, emitted from every mutating path including billing. (`audit-events`, `/audit`)
- **GDPR data-subject requests:** async export and delete jobs that cover Postgres tables and the Hindsight bank, verified after delete. (`services/workflows/src/dsr/`)
- **Untrusted content handling** and quiet hours. (`untrusted.ts`, `quiet-hours.ts`)
- **Never fabricates:** empty states, errors and unconnected tools all say what is true.
- **Row-level security** on every table with a low-privilege runtime role and query timeouts.
- **Spend guard and real cost accounting:** per-org meters, soft and hard caps, model-spend aggregation with a circuit breaker. (`usage-gate.ts`, `cost/`)

---

## 10. SaaS platform (multi-tenant business layer)

- **Billing:** plans, seats, dunning states, Stripe and Razorpay paths, billing audit trail.
- **Platform admin console (`/admin`)** with a separate database role: org drill-in, kill switch, plan overrides, feature flags, support impersonation that the owner must allow.
- **Org lifecycle:** suspend, soft delete, scheduled purge.
- **Edge rate limit per org** and an observability page with alert dispatch. (`lib/alert-dispatch.ts`)
- **Analytics** with ROI and cost-health views; a home briefing and a unified inbox with deep links.
- **Skills** catalogue and installable **packs**.
- **Docker stack:** Postgres, Temporal, Nango, Langfuse, LiteLLM, TrueForge, MCP bridge, Cognee, Hindsight, Evolution, plus deploy and redeploy scripts that fail fast on missing secrets.

---

## 11. Honest status

| Area | Status |
|---|---|
| Growth, Customer, Operations feature sets (30 features) | Built; tracked in `docs/new-109-pg-plan/3-employee.md` |
| Ask AI plan, crew, mode selector | Built and live-tested |
| WhatsApp (QR, official, multi-number, auto-reply) | Built; verified on dev stack; not verified with a real phone or real Meta number |
| Hindsight and Cognee memory | Built; Cognee per-org dataset is **not yet erased or exported by DSR** |
| SaaS control plane (migrations 116 to 122) | Built in code; was not applied to the live DB when last noted |
| Org purge | Partial: unknown workflow ids and external vector stores are skipped |
| Human blockers | OAuth client IDs (HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Microsoft, Salesforce), `NEXT_PUBLIC_NANGO_PUBLIC_KEY`, Meta token rotation, licensed MLS client, payment keys and price IDs, admin DNS |

*Sources: `AGENTS.md`, `BUILD_STATE.md`, `docs/new-109-pg-plan/3-employee.md`,
`docs/new-109-pg-plan/competitors/competitor-analysis.md`, and the code paths
named in each table.*
