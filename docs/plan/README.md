# Darex completion plan

> This folder is the **path from today to the Brain OS**.
> It is not the current working map and it is not the vision pack.
>
> - **What exists today:** [`docs/current-working/`](../current-working/)
> - **What we intend to become:** [`docs/future-scope/`](../future-scope/)
> - **This folder:** the sequenced, executable plan between those two.
>
> Snapshot date of the baseline: **2026-08-13**. If current-working has
> moved, trust current-working for facts and update this plan.

Darex is already a working multi-tenant AI-employee SaaS: Ask AI
plan-confirm-execute, atomic-agent + MCP (`mcp.darex.*`), Nango
connectors, WhatsApp/Chatwoot inbound, Temporal, RLS. The future
product is the same kernel productized as an **industry operating
system** — generic B2B first, then vertical packs — with memory,
orchestration, channels, and governance that make it a brain, not a
capable agent with amnesia.

**Do not treat this folder as shipped.** When a work item lands,
update `docs/current-working/` and `BUILD_STATE.md`, then mark the
matching row here as absorbed.

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
current-working wins. If they disagree on **what to build next**,
future-scope wins until `BUILD_STATE.md` records a deviation. Several
hygiene items in `docs/future-scope/01-from-today-to-os.md` are
already closed in the 2026-08-13 working tree — see
[`02-gap-analysis.md`](./02-gap-analysis.md) section 0.

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
| Baseline | `docs/current-working/` as of 2026-08-13 (includes uncommitted working-tree work in `16-updates-2026-08-13.md`) |
| Target | `docs/future-scope/` Phases 6–18 |
| Replaces | Nothing. No prior `docs/plan/` existed. |
| Code changes | None. This corpus is documentation only. |

---

## How current maps to future (one screen)

```
Today (Phases 0–5 in code)
  Ask AI simple stream + complex plan-confirm-execute
  atomic-agent → MCP → tool-executor (62 tools)
  Nango OAuth truth + honest notConnected
  WhatsApp/Chatwoot inbound → Temporal → reply
  RLS + WITH CHECK; SuperTokens + Postgres auth
  SSE inbox (one process); Insight = templates
  pgvector enabled; no RAG pipeline

Immediate (hygiene still open + Phase 6 start)
  Operator: migrate 009–011, OAuth client IDs, Meta token, Gmail re-connect
  Commit sandbox + skills if not on the default branch
  Switch DB_USER=darex_app; Redis pub/sub design
  Memory tables + embed-worker + retrieveMemory prefix

Near (Phases 6 done → 7 → 8 start → 10 Wave A/B)
  Returning-contact RAG; /brain inspector
  Insight engine + named workflow actions
  Two dashboard replicas + Redis bus
  Connector registry; GBP/Meet/Outlook/Zoho/Salesforce/DocuSign

Mid (Phases 9, 11–14)
  Billing + pack onboarding
  Real estate brokerage IN wedge, then PM/US/developer
  Work items + playbooks + owner WhatsApp
  Agencies / ecom / SaaS / prof-services packs

Complete OS (Phases 15–18 + quality bar)
  SSO, audit role, residency design
  Wave 3–4 packs as pull
  Voice + computer-use last resort
  Success definition in future-scope 00 §8 is true
```

---

## Source-of-truth order (unchanged)

1. `docs/current-working/` — what the code does **today**.
2. `BUILD_STATE.md` — live verification log (some infra bullets there are superseded by current-working `16`).
3. `AGENTS.md` — short agent cheat-sheet (tool count there is stale: 49 vs 62).
4. `docs/future-scope/` — what we **intend to become**.
5. **This folder** — how we get there.
6. `documentation/` — older standalone docs (some claims stale).
