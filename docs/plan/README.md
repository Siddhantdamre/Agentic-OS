# Darex completion plan

> This folder is the **path from today to the Brain OS**.
> It is not the current working map and it is not the vision pack.
>
> - **What exists today:** [`docs/current-working/`](../current-working/)
> - **What we intend to become:** [`docs/future-scope/`](../future-scope/)
> - **This folder:** the sequenced, executable plan between those two.
>
> Snapshot date of the baseline: **2026-08-13**. Status audit:
> **2026-08-14** (code + `BUILD_STATE.md`). Current-working 13 Aug
> docs are stale on Phases 6–15 — trust this folder’s audit until
> they are rewritten.

Darex is already a working multi-tenant AI-employee SaaS: Ask AI
plan-confirm-execute, atomic-agent + MCP (`mcp.darex.*`), Nango
connectors, WhatsApp/Chatwoot inbound, Temporal, RLS. The future
product is the same kernel productized as an **industry operating
system** — generic B2B first, then vertical packs — with memory,
orchestration, channels, and governance that make it a brain, not a
capable agent with amnesia.

**This folder is the execution tracker.** When a work item lands,
update `docs/current-working/` and `BUILD_STATE.md`, then mark the
matching row here. A 2026-08-14 audit found most Immediate/Near
items already in the tree; statuses are from code, not the original
“not started” snapshot.

---

## How to read this corpus

If you are a coding agent about to implement: read
[`04-principles-and-constraints.md`](./04-principles-and-constraints.md)
and [`AGENTS.md`](../../AGENTS.md) first, then the workstream you
are on, then the phase file that owns that work.

If you are planning a quarter: start at
[`00-executive-summary.md`](./00-executive-summary.md), then
[`phases/00-phase-map.md`](./phases/00-phase-map.md) and
[`execution/03-build-order.md`](./execution/03-build-order.md).

If current-working and future-scope disagree on **what exists**,
**code wins** (then this audit). If they disagree on **what to build
next**, future-scope wins until `BUILD_STATE.md` records a deviation.
See [`02-gap-analysis.md`](./02-gap-analysis.md).

---

## Table of contents

### Foundation

| File | Purpose |
|------|---------|
| [00-executive-summary.md](./00-executive-summary.md) | What “complete” looks like, why this sequence, success definition |
| [01-current-state-baseline.md](./01-current-state-baseline.md) | Faithful snapshot of what exists today (from current-working) |
| [02-gap-analysis.md](./02-gap-analysis.md) | Every future-scope capability vs current: done / partial / missing |
| [03-target-architecture.md](./03-target-architecture.md) | End-state architecture grounded in the current monorepo |
| [04-principles-and-constraints.md](./04-principles-and-constraints.md) | Invariants from AGENTS.md + build principles + keep/reject |
| [05-workstream-index.md](./05-workstream-index.md) | All workstreams, owners, dependencies |

### Workstreams

| File | Purpose |
|------|---------|
| [workstreams/01-runtime-and-agent-loop.md](./workstreams/01-runtime-and-agent-loop.md) | atomic-agent, MCP bridge, LiteLLM split, skills, sandbox |
| [workstreams/02-orchestration-and-workflows.md](./workstreams/02-orchestration-and-workflows.md) | Temporal, WorkItemWorkflow, plans, schedules, HITL signals |
| [workstreams/03-memory-rag-brain.md](./workstreams/03-memory-rag-brain.md) | Phase 6 pgvector RAG, retrieve/write-back, `/brain` |
| [workstreams/04-integrations-and-connectors.md](./workstreams/04-integrations-and-connectors.md) | Nango, registry, Wave A–E connectors, honest `notConnected` |
| [workstreams/05-data-sources-and-knowledge.md](./workstreams/05-data-sources-and-knowledge.md) | Ingest, sync, parse, cite, semantic layer |
| [workstreams/06-channels-and-surfaces.md](./workstreams/06-channels-and-surfaces.md) | WhatsApp, Chatwoot, new channels, owner WhatsApp, embeds |
| [workstreams/07-security-compliance-tenancy.md](./workstreams/07-security-compliance-tenancy.md) | RLS, `darex_app`, confirm classes, audit, DSR |
| [workstreams/08-employees-roles-and-org.md](./workstreams/08-employees-roles-and-org.md) | Roster, router, allowlists, critic, pack employees |
| [workstreams/09-dashboard-ux-and-ask-ai.md](./workstreams/09-dashboard-ux-and-ask-ai.md) | Ask AI, inbox, Brain, listings modules, mobile/a11y |
| [workstreams/10-analytics-observability.md](./workstreams/10-analytics-observability.md) | Insight engine, Langfuse, eval-runner, cost per org |
| [workstreams/11-infra-deploy-and-ops.md](./workstreams/11-infra-deploy-and-ops.md) | Compose, Redis bus, Terraform, PgBouncer, probes |
| [workstreams/12-open-source-and-research-adoption.md](./workstreams/12-open-source-and-research-adoption.md) | What to adopt vs steal vs reject from future-scope 15 |
| [workstreams/13-vertical-packs.md](./workstreams/13-vertical-packs.md) | Pack model, Core B2B, real estate, later waves |
| [workstreams/14-billing-evals-and-learning.md](./workstreams/14-billing-evals-and-learning.md) | Billing, seats, meters, learning loop, marketplace preview |

### Phases

| File | Purpose |
|------|---------|
| [phases/00-phase-map.md](./phases/00-phase-map.md) | How this plan maps to `docs/future-scope/13-phased-roadmap.md` |
| [phases/01-phase-immediate.md](./phases/01-phase-immediate.md) | Next concrete work from today (hygiene + Phase 6 start) |
| [phases/02-phase-near.md](./phases/02-phase-near.md) | Memory complete, insight, scale skeleton, connector Wave A/B |
| [phases/03-phase-mid.md](./phases/03-phase-mid.md) | Billing, RE pack, event-bus maturity, Wave 2 packs |
| [phases/04-phase-complete.md](./phases/04-phase-complete.md) | What “complete OS” means and remaining Phase 15–18 work |

### Execution

| File | Purpose |
|------|---------|
| [execution/00-end-to-end-journeys.md](./execution/00-end-to-end-journeys.md) | Every user/system journey that must work when complete |
| [execution/01-definition-of-done.md](./execution/01-definition-of-done.md) | Checklists per workstream and per phase |
| [execution/02-risks-and-open-questions.md](./execution/02-risks-and-open-questions.md) | Contradictions, source-doc gaps, risks |
| [execution/03-build-order.md](./execution/03-build-order.md) | Sequenced build order: what unblocks what |
| [execution/04-verification-and-probes.md](./execution/04-verification-and-probes.md) | How we prove each piece is real (no fabricated data) |

---

## Status of this plan

| Field | Value |
|-------|-------|
| Created | 2026-08-13 |
| Last status audit | **2026-08-14** — code vs `docs/future-scope/` vs this folder |
| Baseline | `docs/current-working/` as of 2026-08-13 is **stale** on Phases 6–15. Prefer this README + [02-gap-analysis.md](./02-gap-analysis.md) until current-working is rewritten. |
| Target | `docs/future-scope/` Phases 6–18 |
| Code changes from this folder | Documentation only |

Legend: **done** (wired in code) · **partial** (code exists, gap remains) · **ops-blocked** (code ready, credentials) · **not done** · **deferred** (RFC / pull / Phase 16–18).

---

## Audit summary (2026-08-14)

The 13 Aug plan assumed Phases 6–18 were empty. The tree now contains
migrations **001–020**, Temporal workflows beyond Autonomous/Crew,
`packs/core-b2b` + `packs/re-brokerage-in`, Redis SSE bus, billing
APIs, DSR, SSO routes, and eval YAML. **Operator credentials and
Wave 2–4 packs are the remaining product work**, not “start Phase 6.”

### Fully done (kernel + Immediate + most Near)

- Phases 0–5 (Ask AI, atomic-agent, Nango honesty, WhatsApp/Chatwoot inbound, RLS, single-process SSE then Redis bus).
- **M1–M5** memory schema, embed worker, `retrieveMemory` on Ask AI / agent/run / Temporal `runAgentTurnActivity`, write-back workflow, `/brain` UI. Evidence: `infra/db/migrations/013_memory_rag.sql`, `services/workflows/src/memory/retrieve.ts`, `apps/dashboard/app/(dashboard)/brain/page.tsx`.
- **R1/I2** skills COPY + `infra/docker/sandbox/`. **R2** grounded user prefix. **R5** risk metadata. **R6** CI deny-list.
- **O1–O6** work items, WorkItemWorkflow wrap, plan-execute Temporal, briefing/stale-chase/nurture, playbook matcher. **O7** HITL `condition()` wait on `PlanExecuteWorkflow` and WorkItem inbound send/pay/sign **tools** (wait before `executeChild`).
- **C3/C4/C5** registry + `tools/*.ts` split + Outlook/Calendar. **C6** Salesforce + Zoho CRM + DocuSign + Leegality + Maps + Twilio + QuickBooks (executors; live OAuth/BYOK still ops).
- **S1** `DB_USER=darex_app` + PgBouncer. **S2/S3** webhook confirm + `audit_events`. **S5** demo-auth prod refuse + rate limits. **S6** DSR. **E1–E6** router, critic, Research/Finance seeds, @employee (org-union), auditor role.
- **U1–U5** citations, `/plans`, `/brain`, listings/inquiries, onboarding → pack recommend. **P1/P2** Core B2B + InstallPackWorkflow.
- **I3/I4/H7** Redis bus + PgBouncer. Terraform starter + restore-drill + alerting **scripts** (I5/I6 **partial** until staging apply).
- **A2/A3/A4/A5/B4** evals, insight engine enqueue, cost cards, promote playbook. **B5** marketplace **preview** (`docs/current-working/marketplace-preview.md` + `/skills`). **L1–L5** deny-list in CI.

### Partial (code present, DoD not fully met)

| Item | There | Missing |
|------|-------|---------|
| **M6** returning-contact | `infra/evals/phase6-returning-contact.yaml` + `check-phase6-memory.js`; WorkItem parent `retrieveMemoryActivity` calls `retrieveMemory` | Live eval green on a migrated DB |
| **A1** Langfuse | Ingestion 201; dedicated Redis | ClickHouse persistence still flaky |
| **C2** catalog | Registry-driven UI | Confirm every Google product is `live` in seed vs leftover `catalog_only` |
| **C6** Wave B | SF / Zoho CRM / DocuSign / Leegality / Maps / Twilio / QuickBooks executors + honesty goldens | Live Nango/BYOK credentials (ops). Pipedrive / Mailchimp / Instagram still out of C6 leftovers. |
| **C7 / P3** RE IN | Pack YAML (`live: false`), listings/inquiries UI with showing + rent schedule, Sheets SoR tools, goldens + live RLS evals | Quality bar (`03` §11) not fully live-verified: Calendar-connected showing from UI and Ask AI against a real sheet still need an operator DB/OAuth pass |
| **H1** WhatsApp outbound | Inbound + Graph executor | Token expired 2026-06-12 |
| **H3–H5** Gmail push / IG / SMS / owner WA | Webhook routes | Pub/Sub, Meta IG, Twilio, distinct owner number |
| **H6** public widget | `/embed/widget.js` + Settings snippet | **done** |
| **O7** HITL | `PlanExecuteWorkflow` + WorkItem inbound `condition()` wait **before** send/pay/sign tools; conversation → `needs_attention` while waiting | Greetings/read-only skip wait; inbound without `planId` still needs a signal (PlanCard / owner WhatsApp / Temporal). Agent-initiated send without user-message intent is a leftover (reply still gated). |
| **B1/B2/B3** invites + billing | Resend-if-key; `/billing` Stripe/Razorpay checkout + meters; org from session; prod fail-fast | Live Darex PSP keys still human; invite email still optional |
| **S7** SSO | SuperTokens SAML/OIDC + test-IdP env; password path when SSO off | Live Jackson/mocksaml (or real IdP) still human |
| **U6** mobile/a11y | `components/a11y/*`, BottomTabs | No recorded 375px / axe pass |
| **I5/I6** Terraform / alerting | `infra/terraform/`, `alerting-*.js`, `restore-drill.sh` | No staging apply / pager |
| **P4** RE expansion | `packs/real-estate-pm/RFC.md`, `MARKETS.md` | Not a live pack |
| Virus scan (K2) | Ingest workflow | Scanner is an always-clean **stub** |
| Compensation | `needs_attention` on partial fail | No compensating txn |

### Not started / deferred

- **Ops forever:** C1 Nango client IDs; Gmail compose re-connect; H1 Meta token; `JINA_API_KEY`.
- **Connectors:** Zoho Books, Follow Up Boss, RESO/MLS, Pipedrive. (Zoho CRM / Leegality / QuickBooks executors shipped 2026-08-14.)
- **Packs:** Wave 2–4 are RFC (`packs/RFC-wave-2-4.md`) — P5/P6 **deferred**.
- **Enterprise leftover:** data-residency design (no fake EU pin); SCIM.
- **Pull (Phases 16–18):** voice, computer-use / browser-runner, AGE graph DB, I7 split ingest host.
- **Optional Phase 6 research:** temporal fact columns (`valid_from`); graph hop retrieve.

### In future-scope, missing from this plan (called out)

These live in future-scope but were never given a work-item id here. Treat as **deferred / pull**, not forgotten:

- Messenger, Telegram, LINE, WeChat, Apple Business Chat (`11`).
- Mailchimp, Linear, Jira, Freshdesk (`06` Wave D–E).
- Knowledge graph as Apache AGE (`02`/`07`) — `memory_edges` table is the steal; AGE is WATCH.
- Outcome pricing / Sierra-class (`00` non-goal).
- Public third-party skill store (`03` §10) — B5 is design-only, correctly.
- Clinic-ops PHI storage (`04` Wave 4) — RFC says **out**.

### Recommended next workstreams (parallel agents)

See the parent briefing in the audit conversation. Non-overlapping file owners:

1. **Ops credentials** (no product code) — Nango IDs, Meta token, Gmail re-connect, Jina.
2. **Wire inbound memory + HITL wait** — **done** (`retrieveMemoryActivity` + WorkItem `condition()`).
3. **Wave B leftovers** — **done** (Zoho CRM + Leegality + QuickBooks executors + seed + MCP + honesty goldens). Live OAuth/BYOK is ops.
4. **RE pack live-verify** — goldens + Calendar showing from UI; do not invent inventory.
5. **Channel go-live** — Gmail Pub/Sub, owner WhatsApp number (widget embed **done**).
6. **Billing/SSO staging** — Stripe/Razorpay Darex keys + test IdP.
7. **Wave 2 pack (one)** — only after M6 eval is green on a real DB.

---

## How current maps to future (one screen)

```
Shipped in code (Phases 0–5 + most 6–15 scaffolding)
  Ask AI + citations + @employee; plan-confirm-execute; Temporal PlanExecute
  atomic-agent → MCP (~85 tools) → tools/*.ts gateway
  Memory tables + retrieveMemory + /brain + write-back
  WorkItemWorkflow wrap; nurture / briefing / stale-chase
  Connector registry; Outlook; Salesforce; Zoho CRM; DocuSign; Leegality; Maps; Twilio; QuickBooks
  Redis SSE bus; PgBouncer; darex_app; packs/core-b2b + re-brokerage-in
  Billing APIs; DSR; SSO routes; eval YAML; CI deny-list

Still ops-blocked
  Nango client IDs; Meta WhatsApp outbound token; Gmail compose re-connect

Remaining product (not theater)
  M6 live eval
  RE quality bar live; Wave 2 RFC→pack
  Staging Terraform/SSO/billing keys; residency design

Pull
  Voice, computer-use, Wave 3–4, AGE, I7 ingest host split
```

---

## Source-of-truth order (unchanged)

1. **Code** — `apps/`, `services/`, `infra/db/migrations/`, `packs/`.
2. **This folder** (after 2026-08-14 audit) — execution status.
3. `BUILD_STATE.md` — live verification log (older “Phase 5 next” wording is historical).
4. `AGENTS.md` — short agent cheat-sheet (MCP tools grew past 62 after Wave A/B).
5. `docs/current-working/` — 13 Aug snapshot; **stale** on Phases 6–15 until rewritten.
6. `docs/future-scope/` — what we **intend to become** (some §holes in `01` are absorbed).
7. `documentation/` — older standalone docs (some claims stale).
