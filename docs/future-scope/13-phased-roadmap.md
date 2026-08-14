# 13 — Phased roadmap (6–18)

Phases 0–5 are done in code (see `docs/current-working/`). This
roadmap is **only the future**. Original spec 6–9 remain, expanded
into an OS + vertical program.

Do not start a phase without reading `BUILD_STATE.md` and the gap
file `01`. Exit criteria are testable. **Audit 2026-08-14:** Phase
6–15 scaffolding is largely in code; tracker is `docs/plan/README.md`.

---

## Phase 6 — Memory & RAG (Brain tissue)

**Why first:** every vertical is theater without recall.

**Build:**

- Tables: org/employee/entity/conversation memory + knowledge_sources
  + ingestion_jobs (RLS).
- embed-worker + `EMBEDDING_MODEL` env fail-fast.
- `retrieveMemory` in Ask AI + WhatsApp agent paths.
- Write-back activity.
- `/brain` inspector v1 (search + cite).
- Redaction before embed.

**Also hygiene in this phase (blockers):**

- Mount custom skills into atomic-agent image.
- Commit `infra/docker/sandbox/`.
- Delete or rewire hermes route.
- Chatwoot webhook → WorkItemWorkflow (even if memory is empty).

**Exit:** returning contact context retrieved on new thread; eval #7
style; disconnected sources still honest; RLS two-org vector test.

**Research (do not block on vendors):** hybrid vector+FTS, temporal
fact columns, async extract — `10` §10 and `15` §4. Not Mem0 Cloud,
not Neo4j, not GraphRAG on the webhook.

---

## Phase 7 — Insight engine (not templates)

**Build:**

- Semantic metrics registry (packs register YAML).
- Scheduled aggregation (not on request path).
- Insight cards from real numbers + recommended **named** workflows.
- Analytics uses same metrics.
- Langfuse cost per org on cards.

**Exit:** “Review Action” enqueues Temporal; numbers match SQL; no
LLM scanning raw message tables.

---

## Phase 8 — Scale, realtime, prod skeleton

**Build:**

- Redis pub/sub SSE.
- Dedicated Redis for Langfuse.
- `darex_app` DB user in running apps.
- Rate limits.
- Terraform starter: VPC, RDS Postgres, Redis, secrets, HTTPS.
- Backups + restore drill.
- Alerting (queue lag, 401 connectors, RLS job).
- PgBouncer.

**Exit:** two dashboard replicas both receive `needs_attention`;
restore drill documented; Langfuse traces persist stably.

---

## Phase 9 — Polish, billing, onboarding-as-pack

**Build:**

- Billing (Stripe/Razorpay): plans, seats, usage meters (LLM +
  WhatsApp).
- Invite emails.
- Mobile/responsive + a11y.
- Onboarding maps business type → pack install.
- Warm-up progress = real provisioning.
- Fix Meta webhook URL in settings.
- Inbox gateway outbound actually sends or is removed.

**Exit:** stranger signup → pack → connect WhatsApp → first AI reply
with memory retrieve (token permitting).

---

## Phase 10 — Connector registry + Wave A/B integrations

**Build:**

- `connector_defs` / `org_connectors` / `sync_cursors`.
- Split `tool-executor.ts` into modules.
- Finish stubs: GBP, Meet, GA4, GSC.
- Add: Outlook, Zoho CRM, Salesforce, DocuSign, Leegality, Exotel
  or Twilio, Instagram, Maps geocoding, Zoho Books or QuickBooks.

**Exit:** registry-driven UI; GBP reviews real; Salesforce or Zoho
sync contacts; e-sign confirm class works.

---

## Phase 11 — Real estate brokerage pack v1 (India wedge)

**Build:** `05` launch sequence 1–5:

- Entities `re.*`.
- CSV/Sheets inventory as SoR.
- ISA + showing coordinator employees + skills.
- Inquiry → match → showing workflows.
- Fair housing / RERA validators (RERA module on).
- Golden eval set 1–10 (as applicable).
- Listings table + inquiry pipeline UI modules.

**Exit:** WhatsApp “2BHK in X under Y” returns only sheet/MLS rows;
zero matches does not invent; showing books on Calendar; pack quality
bar in `03` §11.

---

## Phase 12 — Real estate expansion (US + PM + developer)

**Build:**

- Follow Up Boss or US CRM; RESO/MLS path if licensed.
- `real-estate-pm` on Sheets then AppFolio/Buildium.
- `real-estate-developer` on LeadSquared/Sell.Do or Sheets.
- Owner briefing RE KPIs.
- GBP posts confirm.

**Exit:** two markets documented; PM rent reminder from SoR + PSP
webhook; developer site-visit no-show workflow.

---

## Phase 13 — Event bus maturity + named playbooks

**Build:**

- Work items UI (not only conversations).
- Playbook matcher (skip free-form plan when confident).
- Nurture timers.
- Owner WhatsApp approvals.
- Critic gate on send/publish.

**Exit:** inbound Chatwoot+WhatsApp+Gmail parse all create work items;
nurture cancels on reply.

---

## Phase 14 — Wave 2 vertical packs

**Build:** agencies, ecommerce (mount existing skill + Shopify CX
workflows), saas-gtm, prof-services — each to pack quality bar
**or** explicitly “beta” with eval subset.

**Exit:** at least two Wave 2 packs live; onboarding choices work.

---

## Phase 15 — Enterprise + marketplace preview

**Build:**

- SSO SAML.
- Data residency flag (region pin) design; maybe single-region still.
- Audit role.
- First-party skill versioning UI.
- Design only: third-party pack review (no public store yet unless
  bar met).

**Exit:** SSO login for a test IdP; auditor cannot call `pay` tools.

---

## Phase 16 — Wave 3 packs (wholesale, recruiting, hospitality)

Implement to the cards in `04`. Sheets+WhatsApp wedge first for
wholesale. ATS for recruiting. GBP+WhatsApp for hospitality.

---

## Phase 17 — Voice + computer-use last resort

Deepgram/Whisper inbound; owner voice briefing; browser-runner for
API-less SoR with confirm. Optional.

---

## Phase 18 — Wave 4 (construction, education ops, clinic-ops, insurance)

Only after compliance review (`12`). Clinic-ops default no PHI
storage. Education minors controls. Not a commitment to sell
healthcare in year one.

---

## Parallel work that is not a “phase”

- Real OAuth client IDs in Nango UI (manual, ongoing).
- Meta token rotation (ops).
- Eval-runner CI from Phase 6 onward.
- `BUILD_STATE.md` updates every ship.
- Absorb shipped items in `01` with dates.

---

## Suggested calendar (indicative, not a promise)

| Quarter | Phases |
|---------|--------|
| Q1 | 6 + hygiene + 10 start |
| Q2 | 7, 8, 11 (RE IN wedge) |
| Q3 | 9, 12, 13 |
| Q4 | 14, 15 start |
| Y2 | 16–18 as pull |

If capacity is one team: **never skip Phase 6**. Skip Wave 4 first.

---

## Alternatives in the world (instead of this phase order)

**What Darex does:** Phase 6 memory first, then insight, scale,
billing, connectors, RE pack. Never skip memory.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Ship RE pack first** (Elise-shaped demo) | Revenue and story | Theater without RAG, mounted skills, live WhatsApp (`01` §2) | This pack `13` + `05` |
| 2 | **Buy Mastra/Letta and skip kernel work** | Faster agent UX | Dual runtime = hang class + tenancy holes | `15` §3 |
| 3 | **Insight/analytics before memory** | Dashboard looks smart | Templates without recall are the current Insight page | `01` Insight row |
| 4 | **Connector spray (Wave E) first** | Logo wall for sales | Stubs already lie; finish GBP/Meet before vanity | `06` Wave A |
| 5 | **Voice/computer-use (Phase 17) as launch** | Demo wow | Last resort; APIs first (`14`) | LiveKit, OpenHands, CUA |

**Five things to steal anyway**

1. Hygiene in Phase 6: skills mount, sandbox git, hermes delete, Chatwoot→agent.
2. Eval-runner CI from Phase 6 (Promptfoo + τ-bench shape).
3. Two dashboard replicas + Redis before “scale marketing.”
4. Sheets wedge for RE IN — do not wait on MLS license.
5. Absorb shipped rows into `01` with dates.

### Open-source GitHub

This file is **phase order**, not a repo dump. Kernel KEEP is `15` §1.
Phase 6 evals → `01`. Memory → `10`. Connectors → `06`. Voice → `11`.
Showings → `05`. Durable → `09`. Do not paste those GitHub tables here.
