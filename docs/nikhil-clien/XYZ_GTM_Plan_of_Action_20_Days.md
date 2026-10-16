# XYZ GTM Automation — 20 Working Day Plan of Action

> **Based on:** [`XYZ_GTM_From_Scratch_Build_Estimate_and_Labor_Hours.md`](file:///Users/addy/Coding/SaaS/Agentic-Os-SaaS/docs/nikhil-clien/XYZ_GTM_From_Scratch_Build_Estimate_and_Labor_Hours.md) and the full spec in [`XYZ_GTM_Automation_Plan_3_XYZ_v2 copy.md`](file:///Users/addy/Coding/SaaS/Agentic-Os-SaaS/docs/nikhil-clien/XYZ_GTM_Automation_Plan_3_XYZ_v2%20copy.md)
> **Target:** Live, production-grade XYZ Talent Agency GTM engine on top of the existing DareX (`Agentic-Os-SaaS`) codebase.
> **Duration:** 20 working days (4 calendar weeks) — a deliberately paced version of the "10–14 day" DareX plan, with extra days reserved for QA, security hardening, and client review checkpoints instead of compressing everything to a bare-minimum sprint.
> **Estimated Labor:** ~70–80 Hours total (config, wiring, prompt-tuning, and testing — not greenfield coding, since ~82% of the engine already exists in this repo).
> **Prepared:** 2026-09-28

---

## 0. Ground Rules

- This is a **configuration + integration** build, not a greenfield build — reuse existing DareX modules (`reply-classifier.ts`, `lookalike.ts`, `visitor-enrich.ts`, `MeetingDossierWorkflow.ts`, `OpportunityCard.tsx`, `DraftPanel.tsx`, the 62 existing connectors) rather than rewriting them.
- Every day ends with a **verified checkpoint** (build passes, test run, or manual click-through) — no day is marked done on code existing alone.
- **3 items are human-only blockers**, flagged wherever they appear below:
  1. Purchasing 4–6 secondary sending domains (credit card).
  2. Purchasing 12 Google Workspace / Microsoft 365 inboxes (credit card).
  3. Clicking "Allow" on OAuth popups for HubSpot, LinkedIn, Google Calendar (client's own login).
- If a human blocker isn't resolved on schedule, work continues on the next unblocked track — the plan is ordered so no single blocker stalls the whole team.

---

## 1. Week-by-Week Milestones

| Week | Theme | Exit Criteria |
| :--- | :--- | :--- |
| **Week 1** (Days 1–5) | Data foundation + domain/email infra | DB schema live with RLS, ICP scoring running against real TAM data, domains warming, HubSpot/Apollo connected |
| **Week 2** (Days 6–10) | Outbound sending engine | Cadence state machine live, Why-Now AI copy generating + passing guardrails, first test cadence sends |
| **Week 3** (Days 11–15) | Reply agent, closer pipeline, LinkedIn/content | Reply classifier + router live end-to-end, dossier generator working, LinkedIn content loop + HeyReach running |
| **Week 4** (Days 16–20) | Learning loop, dashboard, security, launch | Self-learning loop active, dashboard reviewed by client, security/E2E pass, system live and sending |

---

## 2. Day-by-Day Breakdown

### Week 1 — Data Layer, TAM Sourcing, Domain/Email Setup

| Day | Focus | Labor Hrs | Action Items | Checkpoint |
| :---: | :--- | :---: | :--- | :--- |
| **1** | Domains & DNS (🔴 human blocker) | 3 LH | Client purchases 4–6 secondary domains (Namecheap/Cloudflare). Configure SPF, DKIM, DMARC. Start Instantly warmup. | DNS records verified via `dig`/DKIM validator |
| **2** | Inboxes & Postgres schema | 4 LH | Client purchases 12 Google Workspace/M365 inboxes. In parallel: finalize/verify `accounts`, `contacts`, `signals`, `cadences`, `orgs` schema + RLS policies for this tenant. | Migration runs clean; RLS isolation test passes |
| **3** | ICP scoring engine | 4 LH | Configure scoring weights (+5 US, +5 talent agency, +5 team size, +4 roster count) in `lookalike.ts` for XYZ's ICP; validate Tier 1–3 split against sample data. | Sample TAM list scores into correct tiers |
| **4** | Apollo/scraping waterfall + HubSpot connector | 4 LH | Wire Apollo → Findymail → Freckle waterfall for decision-maker discovery. Connect HubSpot via Nango (🔴 OAuth click needed). | Test contact resolves through full waterfall; HubSpot sync confirmed |
| **5** | Website de-anonymization + HubSpot field mapping | 4 LH | Configure RB2B/Warmly reverse-IP webhook, set 2-visit/24hr threshold. Map `Tier`, `Awareness_Stage`, `Signal_Events` custom fields in HubSpot. | Test visitor event creates enriched contact + syncs to HubSpot |

**Week 1 total: ~19 LH**

---

### Week 2 — Multi-Channel Cadence & Sending Engine

| Day | Focus | Labor Hrs | Action Items | Checkpoint |
| :---: | :--- | :---: | :--- | :--- |
| **6** | Cadence state machine config | 4 LH | Configure Tier 1 (13 touches/28d), Tier 2 (11/21d), Tier 3 (6/14d), Hot Burst (8/10d) in the existing Temporal cadence FSM for XYZ. | Test contact walks through full cadence timeline in staging |
| **7** | Email infra & sender rotation | 3 LH | Configure sender pool across the 12 inboxes, 30 sends/day cap per inbox, bounce/spam-rate health pause thresholds. | Test send rotates senders correctly and respects caps |
| **8** | Why-Now AI copy generator | 5 LH | Seed `/wiki` with XYZ talent-agency objections, rate-card examples, case studies. Tune prompt for <80-word Why-Now emails using live signals. | Generated sample emails reviewed and approved by client |
| **9** | Copy guardrails & verifier | 3 LH | Configure length/CTA/banned-phrase checks and fallback substitution for XYZ's voice and compliance rules. | Guardrail test suite catches injected bad examples |
| **10** | Cross-channel pause + webhook routing | 4 LH | Wire Instantly + HeyReach killswitch on reply/HubSpot status change. Route inbound Tally + Instantly reply webhooks to DareX endpoints, confirm Slack alerts fire. | Manual reply triggers immediate pause across both channels |

**Week 2 total: ~19 LH**

---

### Week 3 — Reply Agent, Closer Pipeline, LinkedIn & Content

| Day | Focus | Labor Hrs | Action Items | Checkpoint |
| :---: | :--- | :---: | :--- | :--- |
| **11** | Webhook intake & normalization | 3 LH | Confirm HTML stripping, quoted-history removal, and schema normalization for XYZ's reply volume/format. | 10 sample replies normalize correctly |
| **12** | 7-category reply classifier tuning | 4 LH | Calibrate classifier (`reply-classifier.ts`) against XYZ-specific reply language (talent-agency objections, referral patterns). | Classifier hits target accuracy on labeled test set |
| **13** | Action router & review cards | 4 LH | Configure auto-booking for Interested, return-date scheduler for OOO, 12-month suppression for opt-outs. Verify `OpportunityCard.tsx` / `DraftPanel.tsx` 1-click approve/edit flow for this org. | End-to-end: reply → classified → routed → reviewable in dashboard |
| **14** | Pre-meeting dossier generator | 4 LH | Point `MeetingDossierWorkflow.ts` at XYZ's Calendar; configure agency roster/news scraper and Slack summary format. | Test booking produces correct 1-page dossier in Slack |
| **15** | LinkedIn content ideation + Notion bridge | 4 LH | Configure weekly content-ideation loop (call transcripts, objections, trending posts) → 9 idea briefs in 3 voices; wire Notion CMS sync + hook scoring. | Client reviews first week's draft briefs in Notion |

**Week 3 total: ~19 LH**

---

### Week 4 — Learning Loop, Dashboard, Security, Launch

| Day | Focus | Labor Hrs | Action Items | Checkpoint |
| :---: | :--- | :---: | :--- | :--- |
| **16** | Lead magnet + HeyReach orchestration | 3 LH | Upload monthly lead magnet to Tally. Configure HeyReach sender rotation, 20–25 connections/day cap, comment-catcher polling. | Test commenter flows into Tally DM within 30 min |
| **17** | Self-learning loop & attribution | 4 LH | Wire user-edit/rejection tracking into `org_preferences`; confirm outbound attribution ledger (email/DM/call/sign-up) logs to HubSpot + Postgres. Enable Langfuse tracing. | Edited draft updates preference weights; ledger entry confirmed |
| **18** | Weekly reporting + dashboard review | 4 LH | Confirm Monday auto-reporter cron produces the weekly optimization memo. Full client walkthrough of the Operator Dashboard (campaigns, review queue, analytics). | Client sign-off on dashboard UX |
| **19** | Security & compliance hardening | 4 LH | Verify SSRF protection on scrapers, prompt-injection fencing, CAN-SPAM opt-out handling, rate limiters, and the 3-tier autonomy gate (read-only / draft / external-mutation) for this org. | Security checklist fully green |
| **20** | E2E test pass + production launch | 5 LH | Run full integration test suite (webhooks, state transitions, classifier accuracy, fail-safes). Flip system live. Monitor first live sends/replies for 2 hours post-launch. | System live and sending; no failed health checks in first 2 hours |

**Week 4 total: ~20 LH**

---

## 3. Total Labor Summary

| Week | Labor Hours |
| :---: | :---: |
| Week 1 | ~19 LH |
| Week 2 | ~19 LH |
| Week 3 | ~19 LH |
| Week 4 | ~20 LH |
| **Total** | **~77 LH over 20 working days** |

This sits above the aggressive 40–42 LH / 10-day DareX plan by design — the extra ~35 hours buy dedicated QA, security hardening, and two client review checkpoints (Day 8 copy approval, Day 18 dashboard walkthrough) instead of compressing everything into the bare minimum.

---

## 4. Human-Only Blockers (Track Separately)

| # | Blocker | Needed By | Owner |
| :---: | :--- | :--- | :--- |
| 1 | Purchase 4–6 secondary domains | Day 1 | Client |
| 2 | Purchase 12 Workspace/M365 inboxes | Day 2 | Client |
| 3 | OAuth approval — HubSpot | Day 4 | Client |
| 4 | OAuth approval — LinkedIn (HeyReach) | Day 10 | Client |
| 5 | OAuth approval — Google Calendar | Day 14 | Client |

Flag these 🔴 in daily standups if not resolved by the "Needed By" day — do not fake or stub credentials to keep the schedule moving.

---

## 5. Risks & Buffer

- **Domain/inbox warmup lag:** DNS propagation and Instantly warmup can take 3–5 days on their own; Day 1–2 start is intentionally early to absorb this.
- **Classifier accuracy on Day 12** depends on having real/representative reply samples — if XYZ has no reply history yet, use analogous talent-agency reply data and re-tune in the first week post-launch.
- **No slack days built in** beyond the extra ~35 hours already added — if a blocker slips more than 2 days, the plan shifts by the same amount rather than silently compressing later weeks.
