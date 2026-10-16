# XYZ GTM Automation — Features & Integrations

Extracted from `XYZ_GTM_Automation_Plan_3_XYZ_v2.md`.

---

## 0. Feasibility Scorecard — Is It Doable, With What, and How

Legend: **✅ Doable** = standard build with the named tools, no unresolved risk. **⚠️ Doable with caveats** = buildable, but has a real accuracy/risk/rate limitation to plan for. **❌ Not reliably doable** = the named tools cannot guarantee this outcome; needs a fallback.

### Signal & Data Layer

| Feature | Feasible? | Tools Used | How It Gets Built |
| :--- | :--- | :--- | :--- |
| TAM list build | ✅ Doable | Clay + Apollo, AI Ark, Ocean.io | Pull each source into a Clay table, dedupe on domain, merge into one master list |
| ICP scoring | ✅ Doable | Clay formula columns | Weighted-points formula column reading enriched fields (team size, roster size, hiring signals, etc.) |
| Enrichment (firmographic + contacts) | ✅ Doable | Clay + Findymail + BetterContact | Clay enrichment API calls, chained waterfall: Findymail first, BetterContact as fallback for phone |
| Exclusion check (customer/deal/opt-out) | ✅ Doable | Clay ↔ HubSpot API | Clay looks up the HubSpot contact/company record via API before any record proceeds |
| Hot-signal detection (real-time) | ⚠️ Doable with caveats | RB2B, Warmly webhooks | Webhook fires into Clay/n8n on visit event; real latency is minutes, not seconds — plan for it, don't promise instant |
| 3rd-party signals (job posts, news, roll-ups) | ⚠️ Doable with caveats | Clay Jobs, TheirStack, PredictLeads, Perplexity/Serper | Scheduled Clay monitors poll these APIs; coverage for a niche market (talent agencies) will be thinner than for tech/SaaS — expect false negatives, not false positives |
| HubSpot as record of truth | ✅ Doable | HubSpot properties + workflows | Custom properties for tier/stage/signal, workflows to re-tier on data change |
| Company wiki / skills repo | ✅ Doable | Notion or a git repo, Claude Code | No integration risk — it's just structured docs the AI prompts read from |

### Automated Outbound Email

| Feature | Feasible? | Tools Used | How It Gets Built |
| :--- | :--- | :--- | :--- |
| 6 trigger-based flows (E1–E6) | ✅ Doable | Instantly + n8n + HubSpot | n8n listens for the HubSpot trigger property, enrolls the contact in the matching Instantly campaign |
| Tiered cadences (touches/timing) | ✅ Doable | Instantly sequence builder | Native step/delay configuration per campaign, one campaign per tier |
| One-sequence-per-contact guard | ✅ Doable | HubSpot custom property + n8n check | `Active sequence` property gates enrollment; n8n checks it before every new enrollment |
| AI personalization (first line, signal line) | ⚠️ Doable with caveats | Claude API + Clay research columns | One Claude call drafts the line, a second Claude call fact-checks it against the research columns and rejects unverifiable claims — hallucination risk is real, this second pass is not optional |
| A/B copy testing | ✅ Doable | Instantly native A/B testing | Two variants per step, winner promoted after the 200-send threshold |
| Sending infrastructure (domains, warmup, SPF/DKIM/DMARC) | ✅ Doable | Instantly + manually purchased domains | Domain purchase and DNS records are a manual one-time setup; Instantly automates warmup and rotation after that |
| Health gates (bounce/spam auto-pause) | ✅ Doable | Instantly built-in monitoring | Native thresholds, no custom build needed |

### Automated Reply Handling

| Feature | Feasible? | Tools Used | How It Gets Built |
| :--- | :--- | :--- | :--- |
| Single pipeline for email + LinkedIn replies | ✅ Doable | n8n + Instantly/HeyReach webhooks | Both send a "reply" webhook to one n8n endpoint; n8n normalizes them to a shared schema |
| Auto-pause across all channels | ✅ Doable | Instantly API, HeyReach API, HubSpot API | Three parallel API calls fired the moment the webhook lands |
| 7-category reply classification | ⚠️ Doable with caveats | Claude API | Prompt returns structured JSON; the plan's 95%+ accuracy target is realistic only after 2-4 weeks of labeled-example tuning, not from day one |
| Category-based auto-actions | ✅ Doable | n8n branching + HubSpot + Cal.com | Straightforward router: each category maps to one automated action |
| Sub-5-minute response on "Interested" | ✅ Doable | n8n (event-driven, not polling) + Slack API | Achievable because the whole pipeline is webhook-triggered end to end |
| Weekly accuracy audit + prompt retune | ⚠️ Doable with caveats | Claude Code + human labeling | Needs a human to label the 50-reply sample every week — this step is manual, not automated |

#### LinkedIn Reply Handling — Step by Step, How It Actually Works

This is the same n8n pipeline used for email replies (section 13 of the source plan), just with a LinkedIn-specific trigger. Walking through one real reply, end to end:

1. **Trigger.** A contact replies to a HeyReach DM. HeyReach's unified inbox catches it and fires a "message received" webhook to the *same* n8n endpoint that Instantly uses for email replies — one pipeline, two channels feeding it.
2. **Pause everywhere, immediately.** n8n fires three parallel API calls: HeyReach (stop this lead's DM sequence), Instantly (pause the same contact's email sequence, in case both are running), HubSpot (`Active sequence = none`). This stops the contact getting a scripted DM 10 minutes after they just replied.
3. **Normalize.** A fast, cheap Claude model strips emoji/quoted text/noise from the raw LinkedIn message and maps it into the same schema as an email reply: `{contact, channel: "linkedin", campaign, step, reply_text}`. From here on, LinkedIn and email replies are indistinguishable to the rest of the pipeline.
4. **Log.** The raw and cleaned message is written to Supabase for the audit trail and dashboards.
5. **Classify.** A second Claude call reads the message and returns structured JSON: category (one of the same 7 buckets as email — Interested, Question/Objection, Referral, Not now, Out of office, Not interested, Unclear), a confidence score, and any extracted fields (a return date, a referred person's name, an objection type).
6. **Act, by category** (identical routing logic to email, just executed through HeyReach's send-DM API instead of Instantly's):
   - **Interested** → Cal.com link auto-sent back as a LinkedIn DM, closer alerted in Slack, HubSpot deal created — no human in the loop, because speed wins this category
   - **Question** → Claude drafts a reply from the company wiki, posted as a Slack card; a rep clicks approve, and only then does HeyReach's API actually send the DM
   - **Referral** → Claude extracts the referred person's name, creates a fresh Clay record for them, and re-enters them at the top of the routing pipeline (this is "Loop 2" in the source plan's system map)
   - **Not now / Out of office** → Claude reads the date mentioned, HubSpot schedules automatic re-enrollment for that date
   - **Not interested** → suppressed for 12 months, across *every* channel, not just LinkedIn
   - **Unclear (under 80% confidence)** → a human review card in Slack; whatever the rep corrects it to becomes a new labeled example fed back into the classification prompt
7. **Surface it to humans directly in LinkedIn too.** Kondo sits on top of the HeyReach inbox and adds labels/reminders, so anyone scanning the inbox itself (not just Slack) can see reply state at a glance.
8. **Sync back.** OutboundSync writes the final category and outcome to HubSpot as a timeline activity, so it rolls into the same attribution and weekly-review reporting as every email reply.

**Why one pipeline for two channels, not two separate ones:** a contact who's running both an email cadence and a LinkedIn DM cadence in parallel needs *both* paused the instant they reply on either one — a person who replies "not interested" on LinkedIn but still gets a cold email three days later is the exact experience this design exists to prevent.

| Piece | Build Method | Tool | Subscription Needed? | AI Model Used |
| :--- | :--- | :--- | :--- | :--- |
| Reply webhook trigger | Paid subscription (webhook is native) | HeyReach | Yes | None |
| Pause-everywhere logic | Custom code (workflow) | n8n | Yes (Cloud) or self-hosted | None |
| Normalize raw message | Custom code + AI call | Claude API | Usage-billed | Fast/cheap model (Haiku-class) |
| Classification | Custom code + AI call | Claude API | Usage-billed | Mid-tier reasoning model (Sonnet-class) — this is the one call worth not cheaping out on, since the 95% accuracy target depends on it |
| Draft-for-approval (Question category) | Custom code + AI call | Claude API + Slack | Usage-billed + Slack subscription | Same Sonnet-class model, prompted against the wiki |
| Send the actual DM back | Paid subscription | HeyReach API | Yes | None |
| Inbox-level visibility | Paid subscription | Kondo | Yes | None |
| Outcome sync | Custom code | OutboundSync + HubSpot API | Yes (HubSpot) | None |

### LinkedIn Engine

| Feature | Feasible? | Tools Used | How It Gets Built |
| :--- | :--- | :--- | :--- |
| Scheduled posting (official API) | ✅ Doable | Ordinal | Uses LinkedIn's official posting API — no ban risk on the posting side |
| AI content draft loop | ✅ Doable | Claude API + Notion API | Claude writes into Notion pages on a schedule; human approves before Ordinal picks it up |
| Post-engager / profile-visitor capture | ⚠️ Doable with caveats | Gojiberry, Teamfluence | These read LinkedIn activity outside the official API (browser-session based) — functionally works today, but sits in LinkedIn's ToS gray zone and can throttle or flag the account it runs under |
| Comment-to-get lead magnet DM delivery | ⚠️ Doable with caveats | HeyReach/Gojiberry + Tally | Same automation-surface risk as above; keep DM volume conservative per the plan's own limits |
| HeyReach connect + DM sequences | ⚠️ Doable with caveats | HeyReach | Works, but LinkedIn can restrict/ban a sending profile if limits are pushed — the plan's 20–25 connects/day cap exists specifically to manage this risk, don't exceed it |

#### LinkedIn Engine — Exactly How Each Piece Gets Built

For each LinkedIn feature: is it hand-written code, a paid subscription product, or an open-source project you'd self-host — and which AI model (if any) sits behind it.

| Feature | Build Method | What It Actually Is | Subscription Needed? | Self-Hosting / CI Needed? | AI Model Used |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Posting (Ordinal)** | Paid subscription product | Closed-source SaaS that calls LinkedIn's official Content API on your behalf | Yes — Ordinal plan + a LinkedIn Company Page/API app approval | No — it's fully hosted by Ordinal, you just connect your account | None (it only publishes text/images you already wrote) |
| **AI content drafting** | Custom code (glue only) + paid API | You write a small n8n workflow that calls the Claude API and writes results into Notion. Notion itself is a paid subscription; the code you write is just orchestration, not the AI itself | Yes — Notion plan + Claude API usage billing | If self-hosting n8n: yes, a server + Docker + a basic CI pipeline to deploy workflow updates. If using n8n Cloud instead: no infra, it's a subscription | Claude — a fast/cheap model (e.g. Haiku-class) for the 9 idea briefs at volume, a stronger reasoning model (Sonnet-class) for the actual 3-variant drafts in each author's voice |
| **Post-engager / profile-visitor capture** | Paid subscription product (with a riskier open-source alternative) | Gojiberry/Teamfluence are closed-source SaaS browser-extension tools — no code to write, you configure and export | Yes, their monthly plan | No hosting needed for the SaaS option. An open-source alternative exists (e.g. unofficial Python LinkedIn API wrappers on GitHub using session-cookie auth) but that path means you self-host the scraper, maintain it against LinkedIn's frequent layout/API changes, and carry materially higher ban risk with zero vendor support | None — this is data capture, not generation |
| **Comment-to-get lead magnet delivery** | Mix: paid subscription (HeyReach/Gojiberry, Tally) + custom code (the connecting workflow) | The DM-sending and comment-capture are subscription products; the "wire Tally form → Clay → HubSpot → Slack alert" logic is code you (or your agency) writes in n8n | Yes — HeyReach/Gojiberry + Tally (free tier exists, paid tier for volume) | Same n8n hosting choice as above (self-hosted + CI, or Cloud subscription) | None directly, unless you also want Claude drafting the DM copy — then same model tier as outbound email personalization |
| **HeyReach connect + DM sequences** | Paid subscription product | Closed-source SaaS; you configure campaigns and sender limits in their dashboard, and call their API for webhooks | Yes — HeyReach seat-based subscription | No hosting for HeyReach itself; only the reply webhook needs your n8n instance (subscription or self-hosted) | None for sending. If DM copy is AI-personalized per contact, same Claude model as the email personalization pipeline |

**Net read for LinkedIn specifically:** nothing here is "write it from scratch" — every LinkedIn-touching feature rides on a paid, closed-source SaaS product (Ordinal, Gojiberry/Teamfluence, HeyReach, Kondo). The only code you actually write is the *glue* between these tools and HubSpot/Clay (in n8n), plus the Claude prompts for drafting and classification. The one open-source path that exists (self-hosted unofficial scraping libraries) is a cost-saving option, not a safer one — it trades subscription cost for ban risk and maintenance burden, and isn't recommended as the primary build.

### Closer Handoff & Inbound

| Feature | Feasible? | Tools Used | How It Gets Built |
| :--- | :--- | :--- | :--- |
| Deal creation + round-robin owner | ✅ Doable | HubSpot workflows | Native HubSpot rotation logic |
| AI prep doc generation | ✅ Doable | Claude API + HubSpot data | Claude reads the HubSpot record + reply thread, writes the doc, posts it to a HubSpot property and Slack |
| Qualifying form → booking logic | ✅ Doable | Tally + Cal.com + Clay + HubSpot | Standard webhook chain, all four tools have first-class webhook/API support |
| Reverse lookup of personal Gmail sign-ups | ❌ Not reliably doable | Findymail, Apollo, Freckle | Personal-email-to-person/company reverse lookup has a genuinely low match rate industry-wide — build it, but budget for a large fraction landing as "unresolved," not a false sense of full coverage |
| Website visitor de-anonymization | ⚠️ Doable with caveats | RB2B (person) + Warmly (company) | Both are established products with real match rates, but neither is 100% — expect gaps outside the US and on mobile traffic |

### Feedback Loop & Reporting

| Feature | Feasible? | Tools Used | How It Gets Built |
| :--- | :--- | :--- | :--- |
| Outbound attribution | ✅ Doable | OutboundSync + HubSpot | Every send/DM/call write-back is a standard API call, logged as a HubSpot activity |
| Weekly AI self-review | ✅ Doable | Claude Code + HubSpot/Instantly/HeyReach/Supabase APIs | A scheduled script pulls each API, ranks performance, drafts new copy, posts a Slack summary |
| KPI dashboard | ✅ Doable | HubSpot reporting + Supabase | Native HubSpot dashboards for CRM metrics; Supabase for raw reply-log-level detail |

### Program-Level Feasibility

| Item | Feasible? | Note |
| :--- | :--- | :--- |
| 4-week build timeline | ⚠️ Doable with caveats | Aggressive but achievable with one dedicated ops owner (per the plan's own "Aakash + GTM team" staffing) — this is a people/time constraint, not a tooling one |
| 95%+ reply-classification accuracy by week 4 | ⚠️ Doable with caveats | Achievable as a target, not a guarantee on day one — treat the review-gate date as a checkpoint to re-tune from, not a pass/fail cliff |
| LinkedIn-side automation (Gojiberry/HeyReach) at scale | ⚠️ Doable with caveats | The single biggest platform-risk item in the whole plan — every LinkedIn automation feature above shares this same underlying risk |

**Bottom line:** every feature in this plan is buildable with the tools already named. Nothing requires a tool that doesn't exist or an integration that isn't real. The genuine risk isn't "can it be built" — it's three specific things: (1) LinkedIn-side automation tools operating outside LinkedIn's official API, (2) personal-email reverse lookup having an inherently low match rate, and (3) AI accuracy targets (reply classification, personalization fact-checking) needing weeks of tuning before they hit the plan's stated thresholds.

---

## 0.5 Master Subscription & Input Checklist

Every account, subscription, or input you'd actually need to open/buy to run this plan end to end. Nothing here is optional glue code — these are real sign-ups, real seats, real recurring cost.

### Data & CRM
- [ ] **HubSpot** (Sales/Marketing Hub, a tier with custom properties + workflows) — the record of truth
- [ ] **Clay** (credit-based plan) — enrichment, scoring, tiering hub
- [ ] **Supabase** (free tier works to start, paid at scale) — reply/enrichment log + dashboards
- [ ] **n8n** — either **n8n Cloud** (subscription, no server needed) or **self-hosted n8n** (a server + Docker + a small CI pipeline to deploy workflow changes)

### TAM / List Sources
- [ ] **Apollo** — contact/company database
- [ ] **AI Ark** — lookalike list source
- [ ] **Ocean.io** — lookalike list source

### Email Outbound
- [ ] **Instantly** — sending, warmup, inbox rotation, A/B testing
- [ ] **OutboundSync** — logs sends into HubSpot
- [ ] **4–6 secondary sending domains** (registrar purchase, e.g. `XYZconnecthq.com`) + DNS access to set SPF/DKIM/DMARC
- [ ] **12+ mailboxes** across those domains — **Google Workspace** and/or **Microsoft 365** seats
- [ ] A **pre-warmed inbox provider** for weeks 2–4 (separate from Instantly's own warmup, per the plan's own timeline)

### LinkedIn
- [ ] **HeyReach** — connect + DM sequencing (seat-based)
- [ ] **Kondo** — LinkedIn inbox labels/reminders
- [ ] **Gojiberry** (or **Teamfluence** as backup) — engagement/profile-visitor capture
- [ ] **Ordinal** — official-API post scheduling
- [ ] **LinkedIn Sales Navigator** — one seat per real sender profile used in HeyReach (3–4 people)
- [ ] **Aged, real personal LinkedIn accounts** for every sender — not a subscription, but a hard input: these must already exist and be reasonably old, HeyReach can't manufacture this
- [ ] **LinkedIn Company Page** with API/app access approved — required before Ordinal can post on the official API

### Website & Signal Capture
- [ ] **RB2B** — person-level website visitor ID
- [ ] **Warmly** — company-level website visitor ID
- [ ] **Apify** — usage-based scraping (competitor followers, creator posts, rosters)
- [ ] **TheirStack** and/or **PredictLeads** — job-post / trigger-event monitoring
- [ ] **Perplexity API** and/or **Serper** — news search for trigger events

### Contact Data / Waterfall
- [ ] **Findymail** — verified email finder
- [ ] **BetterContact** — phone number waterfall (also used as Findymail's fallback)

### Forms, Booking & Nurture
- [ ] **Tally** — qualifying forms (free tier exists, paid needed for logic/volume)
- [ ] **Cal.com** — booking pages
- [ ] **Beehiiv** — newsletter/nurture (or use HubSpot email instead, avoiding this one)

### Content & Design
- [ ] **Notion** — content calendar, briefs, wiki
- [ ] **Figma** and/or **Canva** — post visuals

### AI
- [ ] **Anthropic Claude API account** — usage-billed, powers reply classification, drafting, weekly review, prep docs (this is the one line item that scales with volume, not a flat subscription)

### Calling (Phase 2/3)
- [ ] **Nooks** — parallel dialer, added weeks 5–6

### Ads (Phase 3)
- [ ] **LinkedIn Ads** account — retargeting only
- [ ] **Meta Ads** account — retargeting only

### Already Likely In Place
- [ ] **Slack** workspace — alerts, approvals, review posts (almost certainly already exists, listed for completeness)

---

**Total distinct paid subscriptions/accounts: ~24**, plus domain purchases, mailbox seats, and the human inputs (aged LinkedIn profiles, DNS access, a LinkedIn Company Page) that no subscription can substitute for. The two easiest to underestimate: **mailbox seats** (12+ individually billed inboxes, not one) and **LinkedIn Sales Navigator seats** (one per human sender, not one shared login).

---

## 1. Core Features

### Signal & Data Layer
- TAM mapping of US talent/creator management agencies (Apollo, AI Ark, Ocean.io lookalikes, LinkedIn, scraped directories)
- ICP account scoring model (points-based, Tier 1/2/3/Nurture)
- Enrichment: company, role, roster size, verified emails, phone waterfall
- Exclusion checks: existing customers, open deals, partners, opt-outs
- Hot-signal detection (site visit, form start, sign-up in last 7 days)
- HubSpot as single record of truth (tier, stage, signal, owner, every touch)
- 3-layer signal map: 1st-party, 2nd-party, 3rd-party signals
- Awareness stage tracking: Identified → Aware → Interested → Evaluating → Selecting
- Company "wiki" (ICP, personas, objections, case studies, call transcripts) that feeds all copy
- Enrichment hygiene flag (`Enriched by Clay`) to avoid duplicate spend; quarterly CRM domain dedupe

### Automated Outbound Email
- 6 trigger-based email flows (E1–E6): cold ICP, Tier 1 founder-to-founder, website visitor/hot signal, engagers, trigger events, re-engagement
- Tiered touch cadences: Hot burst (8 touches/10 days), Tier 1 (13/28 days), Tier 2 (11/21 days), Tier 3 (6/14 days), Nurture (email-only)
- One active sequence per contact, max 2 contacts per agency enrolled at once
- Personalization pipeline: research → AI-drafted opener/signal lines → AI compliance/fact-check pass → fallback line on failure
- A/B testing of copy variants (200 sends/variant threshold, weekly new challenger copy)
- Sending infrastructure: secondary sending domains, warmed inboxes, SPF/DKIM/DMARC, daily send caps, bounce/spam health gates, CAN-SPAM compliance footer

### Automated Reply Handling
- Single reply pipeline for both email and LinkedIn replies
- Auto-pause contact across all channels within 1 minute of any reply
- AI reply classification into 7 categories: Interested, Question/Objection, Referral, Not now, Out of office, Not interested, Unclear
- Category-specific automated actions (auto-send booking link, AI-drafted response for approval, referral re-routing, re-enrollment scheduling, 12-month suppression, human review queue)
- Sub-5-minute response time on "Interested" replies with Slack alert to closer
- Weekly accuracy check (50 labeled replies) with automatic prompt re-tuning if error rate exceeds threshold
- Auto-send policy that expands automation coverage as classification accuracy improves (95%+ gate)

### LinkedIn Engine
- Founder/team LinkedIn posting cadence (3x/week per executive), with content pillars and top/mid/bottom-funnel mix
- Weekly AI-assisted content production loop: ideation → AI drafts 3 variants → human review/approval → hook scoring → scheduling → engagement → analytics/repurposing
- Post-engager and profile-visitor capture, tiering, and automatic DM/connection outreach
- Comment-to-get lead magnet flow (monthly asset, comment trigger, DM delivery via Tally form)
- Signal-based connect + DM sequences matched to sender persona
- Tier 1 "warming" sequence (manual pre-outreach engagement) plus multi-threaded founder/closer outreach
- Around-meeting LinkedIn touches (pre-call connection request, post-call AI-drafted recap DM, no-show DM)

### Closer Handoff & Pipeline
- Automatic deal creation with round-robin/owner assignment on interested replies or bookings
- AI-generated prep docs (agency overview, signals, thread history, objections, talk track)
- Pre-call LinkedIn connection request from the closer
- No-booking nudges (24-hour email nudge, 72-hour re-engagement flow)

### Inbound Flows
- Qualifying demo/sign-up forms with conditional booking-page display
- Reverse lookup of personal/Gmail sign-ups to identify agency and LinkedIn profile
- Website visitor de-anonymization (person- and company-level) with tiered alerting
- Product sign-up scoring, tiering, and tier-based onboarding (Slack alert + personal email for Tier 1; milestone-triggered nurture for Tier 2–3)

### Feedback & Continuous Improvement
- Outbound attribution logging (every send/DM/call tied back to HubSpot)
- Weekly AI-generated performance review: ranks flows/steps/variants by reply rate and meetings, drafts new copy, flags scoring changes, surfaces uncovered objections
- KPI tracking dashboard: meetings booked, reply rates (email/LinkedIn), time-to-booking-link, meeting show rate, signal volume, pipeline influence, revenue won

### Rollout & Governance
- 4-week phased build (data/CRM setup → sending infra → reply pipeline → signal flows/DMs), with defined review-gate criteria
- Guardrails: deliverability limits, compliance (opt-out honoring, CAN-SPAM), LinkedIn automation risk limits, human approval gates on posts/Tier 1 first touches/objection replies, data hygiene (exclusion checks before every send)
- Reusable engine architecture designed to extend to a second product line (its own ICP, lists, copy, and channels)

---

## 2. Integrations & Tools

| Category | Tool | Role |
| :--- | :--- | :--- |
| Data / enrichment hub | **Clay** | Enrichment, dedupe, AI qualification, scoring, tiering, signal tables |
| Orchestration | **n8n** | Webhooks, reply pipeline, routing, Slack alerts, weekly reports |
| Backend log/reporting | **Supabase** | Raw reply/enrichment log, dashboards |
| CRM | **HubSpot** | Record of truth: tiers, stages, signals, owners, deal pipeline |
| Outbound activity sync | **OutboundSync** | Logs every Instantly/HeyReach touch into HubSpot |
| Email sending | **Instantly** | Cold/trigger email sequences, inbox warmup, rotation |
| LinkedIn outreach | **HeyReach** | Connection requests, DM sequences, unified inbox |
| LinkedIn inbox management | **Kondo** | Labels and reminders in the LinkedIn DM inbox |
| LinkedIn signal capture | **Gojiberry** (backups: Jungler, Teamfluence) | Post engagers, profile visitors, keyword/competitor tracking |
| Web scraping | **Apify** | Competitor followers, creator posts, agency roster scraping |
| Website visitor ID | **RB2B** + **Warmly** | Person-level and company-level visitor identification |
| Contact data / waterfall | **Findymail** + **BetterContact** | Verified emails, phone number waterfall |
| AI layer | **Claude Code** + **Claude API** | Copy generation, research, reply classification, campaign builds, weekly reviews |
| Content ops | **Notion** + **Ordinal** | Content calendar/approvals, LinkedIn post scheduling (official API) |
| Forms & booking | **Tally** + **Cal.com** | Qualifying forms, routed meeting booking |
| Nurture / newsletter | **Beehiiv** (or HubSpot email) | Newsletter and nurture sequences |
| Dialing | **Nooks** (Phase 2/3) | Parallel dialing for Tier 1 and hot signals |
| Alerts | **Slack** | Lead cards, reply alerts, approval workflows |
| Design assets | **Figma** / **Canva** | Post visuals and templates |
| Retargeting | **LinkedIn Ads** + **Meta Ads** | Retargeting audiences only (engagers, visitors, Tier 1) |
| News / trigger monitoring | **Perplexity** / **Serper**, **TheirStack**, **PredictLeads** | Job-post and company-news trigger detection |

---

## 3. Phasing Summary

- **Phase 1:** Data layer (TAM, scoring, HubSpot), 6 email flows (E1–E6), reply pipeline (R1), inbound form/sign-up handling (R2–R4), LinkedIn content start (L1–L2)
- **Phase 2:** Founder network outreach, full LinkedIn engine (L1–L6), engager/trigger-event flows, awareness-stage scoring
- **Phase 3:** Customer-alumni flow, warm calling (Nooks), ABM, LinkedIn/Meta retargeting ads, SEO/AEO
- **Later:** Content RAG agent, LinkedIn-to-blog publishing, PLG-to-sales scoring, CRM cleanup automation, internal GTM dashboard app
