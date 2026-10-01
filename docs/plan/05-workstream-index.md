# 05 — Workstream index

Map of every workstream file, what it owns, and what it depends on.
Implement from the workstream file plus the phase that currently
owns that work ([phases/00-phase-map.md](./phases/00-phase-map.md)).

Linked from [README.md](./README.md) and
[02-gap-analysis.md](./02-gap-analysis.md). Documentation only.

**Audit 2026-08-14:** most workstream items are in code. See
[README.md](./README.md). Do not rebuild M1–M5, O1–O6, C3–C5,
S1–S6, P1–P2, E1–E6.

---

## How to use a workstream file

Each file has the same shape:

1. Current reality (cited from current-working)
2. Target (cited from future-scope)
3. Gaps (missing / partial / ops-blocked / already absorbed)
4. Work items (numbered; repo path; dependencies; definition of done)
5. End-to-end connections to other workstreams
6. Non-goals
7. Verification (no fabricated connector or inventory data)

---

## Workstreams

| # | File | Owns | Depends on | Phase home |
|---|------|------|------------|------------|
| 01 | [01-runtime-and-agent-loop.md](./workstreams/01-runtime-and-agent-loop.md) | atomic-agent, MCP, LiteLLM split, skills, sandbox | Tenancy (07), tools (04) | Immediate + ongoing |
| 02 | [02-orchestration-and-workflows.md](./workstreams/02-orchestration-and-workflows.md) | Temporal, WorkItemWorkflow, schedules, HITL signals | Runtime (01), memory (03), channels (06) | Immediate unify inbound; near schedules |
| 03 | [03-memory-rag-brain.md](./workstreams/03-memory-rag-brain.md) | Phase 6 tables, embed-worker, retrieve/write-back, `/brain` | Runtime (01), tenancy (07) | Immediate → near. **Never skip.** |
| 04 | [04-integrations-and-connectors.md](./workstreams/04-integrations-and-connectors.md) | Nango, registry, Wave A–E, honest notConnected | Runtime (01), tenancy (07) | Immediate catalog hygiene; near Wave A/B |
| 05 | [05-data-sources-and-knowledge.md](./workstreams/05-data-sources-and-knowledge.md) | Ingest, parse, sync cursors, cite, semantic layer | Memory (03), connectors (04) | Near (after retrieveMemory) |
| 06 | [06-channels-and-surfaces.md](./workstreams/06-channels-and-surfaces.md) | WhatsApp, Chatwoot, new channels, owner WhatsApp, embeds | Orchestration (02), memory (03), security (07) | Immediate Meta token; mid new channels |
| 07 | [07-security-compliance-tenancy.md](./workstreams/07-security-compliance-tenancy.md) | RLS, `darex_app`, confirm classes, audit, DSR | All tables | Immediate `darex_app`; mid SSO |
| 08 | [08-employees-roles-and-org.md](./workstreams/08-employees-roles-and-org.md) | Roster, router, allowlists, critic, pack employees | Runtime (01), memory (03), packs (13) | Near router; mid packs |
| 09 | [09-dashboard-ux-and-ask-ai.md](./workstreams/09-dashboard-ux-and-ask-ai.md) | Ask AI, inbox, Brain, listings modules, mobile | Memory (03), orchestration (02), packs (13) | Immediate citations stub; mid modules |
| 10 | [10-analytics-observability.md](./workstreams/10-analytics-observability.md) | Insight engine, Langfuse, eval-runner | Memory (03), orchestration (02) | Near insight + evals |
| 11 | [11-infra-deploy-and-ops.md](./workstreams/11-infra-deploy-and-ops.md) | Compose, Redis bus, Terraform, PgBouncer, probes | All services | Immediate migrate; near Redis/Terraform |
| 12 | [12-open-source-and-research-adoption.md](./workstreams/12-open-source-and-research-adoption.md) | Adopt vs steal vs reject from future-scope `15` | Principles (04) | Parallel, binding |
| 13 | [13-vertical-packs.md](./workstreams/13-vertical-packs.md) | Pack model, Core B2B, real estate, later waves | Memory (03), connectors (04), employees (08) | Mid RE; later waves as pull |
| 14 | [14-billing-evals-and-learning.md](./workstreams/14-billing-evals-and-learning.md) | Billing, seats, meters, learning, marketplace preview | Observability (10), security (07) | Mid billing; late marketplace |

---

## Dependency graph (what unblocks what)

```
07 tenancy / darex_app
  └─ 03 memory tables + embed-worker
       ├─ 01 retrieveMemory prefix on all agent paths
       ├─ 02 WorkItemWorkflow (memory + route)
       ├─ 05 ingest / semantic layer
       ├─ 09 /brain + citations
       └─ 13 packs (cannot ship without recall)

01 runtime (skills/sandbox landed)
  └─ 04 connector registry + Wave A/B
       └─ 13 RE CRM / e-sign / maps

06 WhatsApp token + 11 Redis bus
  └─ 02 scheduled briefing + 09 multi-replica inbox

10 eval-runner
  └─ 13 pack quality bar + 14 learning / promotion

14 billing
  └─ Phase 9 stranger-signup exit
```

Detailed sequence: [execution/03-build-order.md](./execution/03-build-order.md).

---

## Parallel tracks that are not a phase

From future-scope `13`:

- Real OAuth client IDs in Nango UI (manual, ongoing) — workstream 04.
- Meta token rotation (ops) — workstream 06.
- Eval-runner CI from Phase 6 onward — workstream 10 / 14.
- `BUILD_STATE.md` + current-working updates every ship.
- Absorb shipped items in [02-gap-analysis.md](./02-gap-analysis.md)
  with dates.
