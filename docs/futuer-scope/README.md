# Darex Future Scope — AI Brain OS for every B2B business

> This folder is the **forward map**. It is not the current working state.
> Current working state lives in [`docs/current-working/`](../current-working/).
> Live build log lives in [`BUILD_STATE.md`](../../BUILD_STATE.md).
>
> Folder name is `docs/futuer-scope` as specified. Treat this as the canonical
> future-scope pack even if the spelling is non-standard.

**What Darex becomes:** the **AI Brain Operating System** of a business.
Not a chatbot bolted onto a CRM. Not a helpdesk with an LLM. A multi-tenant
system that **senses** what is happening across every channel and system of
record, **remembers** it as org memory, **reasons** with specialist AI
employees, **acts** on connected tools, **confirms** before irreversible
side-effects, and **learns** after every cycle.

The first product is already a working AI-employee SaaS (Ask AI, plan-confirm-
execute, Nango connectors, WhatsApp, Temporal, RLS). The future product is
the same core, productized as an **industry operating system**: generic B2B
first, then deep vertical packs — **real estate** (brokerage, CRE, property
management, developers), agencies, SaaS, wholesale, professional services,
hospitality, construction, recruiting, and more.

---

## How to read this pack

Read in this order if you are planning a phase or writing a vertical pack:

| # | File | Answers |
|---|------|---------|
| 00 | [00-vision-ai-brain-os.md](./00-vision-ai-brain-os.md) | What “AI Brain OS” means, layers, non-goals |
| 01 | [01-from-today-to-os.md](./01-from-today-to-os.md) | Honest gap: what exists vs what the OS needs |
| 02 | [02-architecture-evolution.md](./02-architecture-evolution.md) | What we keep, what we add, new services |
| 03 | [03-industry-operating-system.md](./03-industry-operating-system.md) | Vertical pack model (employees + tools + data + workflows) |
| 04 | [04-b2b-verticals.md](./04-b2b-verticals.md) | Every B2B industry we intend to cover |
| 05 | [05-real-estate-vertical.md](./05-real-estate-vertical.md) | Deep real-estate OS: listings, CRM, showings, leases, RERA |
| 06 | [06-integrations-catalog.md](./06-integrations-catalog.md) | Master catalog of integrations (P0–P3), how each is wired |
| 07 | [07-data-sources-knowledge.md](./07-data-sources-knowledge.md) | Every source the brain reads; ingest, RAG, graph |
| 08 | [08-agent-workforce.md](./08-agent-workforce.md) | AI employees, skills, multi-agent, playbooks |
| 09 | [09-orchestration-workflows.md](./09-orchestration-workflows.md) | Classify → plan → confirm → execute, Temporal, events |
| 10 | [10-memory-rag-brain.md](./10-memory-rag-brain.md) | Hierarchical memory that makes it a *brain* |
| 11 | [11-channels-and-surfaces.md](./11-channels-and-surfaces.md) | Inbound/outbound channels + owner surfaces |
| 12 | [12-security-compliance-tenancy.md](./12-security-compliance-tenancy.md) | RLS, industry compliance, audit, residency |
| 13 | [13-phased-roadmap.md](./13-phased-roadmap.md) | Phases 6–18 with exit criteria |
| 14 | [14-build-principles.md](./14-build-principles.md) | Rules future agents must not break |

---

## One-page thesis

1. **Every B2B company already has a brain** — it is currently distributed
   across people, Slack, Gmail, WhatsApp, a CRM, spreadsheets, and “ask Priya”.
   Darex replaces that distributed brain with a durable, tenant-isolated OS.
2. **The OS is industry-agnostic at the core** and industry-specific at the
   pack layer. Adding real estate must not fork the agent runtime.
3. **Integrations are the nervous system.** Nango remains the OAuth/token
   plane. Tool executors remain honest: disconnected = `connected: false`.
4. **Memory is the actual brain tissue.** Without Phase 6 RAG + write-back,
   Darex is a capable agent with amnesia. That is the first future phase.
5. **Confirm before irreversible action** stays forever. Real estate
   (offers, leases, disbursements) makes this more important, not less.
6. **Clone infrastructure, build the brain.** Nango, Temporal, LiteLLM,
   Langfuse, SuperTokens, pgvector stay. Vertical IP is skills, data
   contracts, workflows, and employee personas.

---

## What this pack is not

- It is **not** a rewrite of `docs/current-working/`. Do not treat claims
  here as “already shipped”.
- It is **not** permission to fabricate connector results, skip RLS, or
  await LLM calls inside webhooks.
- It is **not** a commitment to every P3 integration in year one. Priority
  waves live in `13-phased-roadmap.md` and `06-integrations-catalog.md`.

---

## Source-of-truth order (unchanged)

1. `docs/current-working/` — what the code does **today**.
2. `BUILD_STATE.md` — live verification log.
3. `AGENTS.md` — short agent cheat-sheet.
4. **This folder** — what we **intend to become**.
5. `documentation/` — older standalone docs (some claims stale).

When a future phase ships, update `BUILD_STATE.md` and `docs/current-working/`,
then mark the matching item in this pack as **absorbed** (do not delete
history; add a “Shipped” note).
