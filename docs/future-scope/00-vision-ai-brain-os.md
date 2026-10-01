# 00 — Vision: Darex as the AI Brain OS

## 1. The sentence

Darex is the **operating system for a company’s intelligence**: a multi-tenant
platform where AI employees share one memory, one permission model, one
action bus, and one confirmation layer — and where every B2B industry
(including real estate) is a **pack**, not a fork.

Today Darex can answer questions, draft plans, and call real tools (Gmail,
Calendar, Sheets, Drive, WhatsApp, HubSpot, GitHub, sandbox, SQL, web).
That is the **cortex prototype**. The Brain OS is the same loop, closed
across **all** of a business’s senses, memory, and muscles.

---

## 2. Why “OS” and not “copilot”

A copilot sits next to a human in one app. An OS:

| Copilot | Brain OS |
|---------|----------|
| Lives in one product (email, IDE, CRM) | Lives above every product the org uses |
| Stateless or session-scoped | Hierarchical durable memory (org → role → contact → asset) |
| Suggests; human always copies | Acts, with confirm on irreversible steps |
| One model, one prompt | Roster of employees + skills + allowlists |
| No tenancy story | RLS + org-scoped everything from day one |
| Breaks when the tab closes | Temporal resumes the thread |

Darex already has pieces of the OS column (tenancy, Temporal, plan-confirm-
execute, tool allowlists). The future work is to make those pieces **the
default way a business runs**, not a dashboard feature called Ask AI.

---

## 3. The six layers of the Brain OS

```
┌─────────────────────────────────────────────────────────────┐
│  6. LEARNING     traces, evals, skill updates, memory write │
├─────────────────────────────────────────────────────────────┤
│  5. GOVERNANCE   RLS, allowlists, confirm, audit, compliance│
├─────────────────────────────────────────────────────────────┤
│  4. ACTION       MCP tools, Nango, sandbox, Temporal acts   │
├─────────────────────────────────────────────────────────────┤
│  3. REASONING    classify → plan → employees → multi-agent  │
├─────────────────────────────────────────────────────────────┤
│  2. MEMORY       pgvector RAG, profiles, assets, graph      │
├─────────────────────────────────────────────────────────────┤
│  1. PERCEPTION   channels, webhooks, syncs, public data     │
└─────────────────────────────────────────────────────────────┘
```

### Layer 1 — Perception (senses)

Everything that happens outside Darex must be able to land inside it:

- **Conversational senses:** WhatsApp, Instagram, Facebook Messenger, SMS,
  email, web chat, Slack, Teams, voice/IVR, Google Business messages.
- **System-of-record senses:** CRM webhooks, ERP events, listing MLS
  changes, payment events, calendar updates, support tickets, form fills.
- **World senses:** web search/extract (already live via Jina), public
  records, maps/geo, ads platforms, review sites, job boards, MLS/IDX,
  government gazettes, weather/outage feeds where relevant.
- **Internal senses:** dashboard Ask AI, employee run, uploaded files,
  SQL warehouse, Drive/Docs/Sheets (already live), Notion.

Perception is **ingest + normalize + tenant-scope**. It must never block
the inbound webhook on an LLM call (existing rule: return 200, then
Temporal).

### Layer 2 — Memory (brain tissue)

Without memory, every turn is a talented intern with amnesia. The OS
memory is hierarchical and RLS-scoped:

1. **Org memory** — policies, brand voice, price lists, playbooks, SOPs.
2. **Employee memory** — what Sarah learned about closing; Emma’s ticket
   patterns.
3. **Contact / account memory** — this customer, this lead, this tenant.
4. **Asset memory** — this SKU, this property, this project, this policy.
5. **Conversation memory** — the current thread, plus retrieved neighbors.
6. **Working memory** — the plan, the tool results, the confirmation card.

Write-back is mandatory after resolved work. Decay and conflict resolution
are mandatory so memory does not become a junk drawer. See
`10-memory-rag-brain.md`.

### Layer 3 — Reasoning (cortex)

Keep the live loop; expand it:

- **Simple** questions → atomic-agent stream (already live).
- **Complex** work → generate plan → persist `agent_plans` → human
  approve → staged execute, independent steps in parallel (already live).
- **Future:** specialist routing (sales vs support vs listing coordinator),
  multi-agent (planner / critic / executor), vertical skill packs,
  scheduled reasoning (“every morning brief the owner”), threshold
  reasoning (“lead score crossed 80 — draft outreach”).

LiteLLM stays the JSON brain for classify/plan/revise. atomic-agent stays
the tool-using loop. Do not collapse those two paths again (that hang is
documented in `BUILD_STATE.md`).

### Layer 4 — Action (muscles)

Every action is a named tool with:

- org-scoped credentials (Nango or BYOK),
- allowlist (employee ∪ org connected channels ∪ core tools),
- honest `notConnected` when missing,
- idempotent Temporal activity for side-effects,
- `channel_logs` (or successor audit table) row.

The catalog grows from ~49 MCP tools to hundreds, but **the executor
pattern does not change**. New industries add tools; they do not add a
second agent runtime.

### Layer 5 — Governance (prefrontal)

This is why it is an OS for **business**, not a toy agent:

- Confirm before send/pay/delete/publish/contract.
- Role-based: owner vs admin vs member vs AI employee vs external auditor.
- Industry packs add extra confirm classes (fair housing language, RERA
  disclosures, refund thresholds, PHI-adjacent data never stored, etc.).
- Full audit: who approved, which model, which tools, which data retrieved.

### Layer 6 — Learning (plasticity)

Langfuse traces already exist (ingestion fixed 2026-08-13). The OS uses
them to:

- score employee quality per org,
- find failing tools and failing prompts,
- promote successful plans into reusable playbooks,
- never silently train on tenant data for other tenants.

---

## 4. The business loop (same for a SaaS company and a realtor)

Every B2B org, regardless of industry, runs this loop. Darex owns it.

```
Sense event
  → Identify entity (lead / ticket / listing / invoice / tenant)
  → Retrieve memory (who are they, what happened last, what is policy)
  → Decide (which employee, which plan, whether to confirm)
  → Act (message, CRM write, calendar, document, payment link)
  → Record (conversation, audit, memory write-back)
  → Notify owner if needs_attention
```

Industry packs only change:

- **entities** (Deal vs Listing vs WorkOrder vs Candidate),
- **systems of record** (HubSpot vs Follow Up Boss vs Yardi vs Greenhouse),
- **compliance gates**,
- **KPI definitions**.

If a proposed feature cannot be expressed as a change to those four, it
probably belongs in the core OS, not in a vertical.

---

## 5. Product surfaces of the Brain OS

### Owner surfaces (humans who pay)

- **Home** — daily brain briefing: needs attention, money at risk, stalled
  deals / listings / tickets, suggested plans.
- **Ask the business** — today’s Ask AI, but grounded in RAG + live tools.
- **Inbox** — every channel, one queue, human takeover.
- **Employees** — hire/pause/configure personas and allowlists.
- **Brain** (new) — knowledge base, memory inspector, “what does Darex
  know about X?”, source citations.
- **Insight** — real engine (Phase 7), not rule templates.
- **Connectors** — nervous system status, sync health, missing scopes.
- **Plans** — in-flight and historical confirmed executions.
- **Mobile / WhatsApp-to-owner** — the owner’s business texts them.

### Customer / counterparty surfaces

- WhatsApp, IG, web widget, email, voice, listing portal chat, tenant
  portal — the customer never needs to know it is Darex unless the brand
  wants that.

### Builder surfaces (us)

- Vertical pack SDK, skill playbooks actually mounted into atomic-agent,
  connector registry, eval suites per industry, Langfuse dashboards.

---

## 6. What “for all B2B” actually means

It does **not** mean we build 40 separate products. It means:

1. **Core OS** works for any org that has conversations, a CRM-like
   system, documents, a calendar, and payments.
2. **Vertical packs** are installable: they seed employees, tools,
   entities, workflows, and compliance rules.
3. **Integration waves** connect the systems those industries already
   bought (see `06-integrations-catalog.md`).
4. **Data source waves** connect the public/semi-public worlds those
   industries live in (MLS, GSTN, Companies House, Google Business,
   review sites, maps — see `07-data-sources-knowledge.md`).

Priority of vertical depth (rationale in `04` and `13`):

1. Generic B2B / agencies / professional services (we are closest today).
2. **Real estate** (explicit target: brokerage + property management +
   CRE + developers; India + US + later other markets).
3. E-commerce / D2C ops (Shopify already in catalog).
4. SaaS customer success + sales.
5. Wholesale / distribution.
6. Recruiting / staffing.
7. Hospitality / clinics-ops / construction (later; heavier compliance).

Healthcare **clinical diagnosis**, weapons, and anything that requires
practicing a licensed profession as the AI itself are **out of scope**.
Ops, scheduling, billing, CRM, and document flow for those industries
can be in scope with a compliance pack.

---

## 7. Non-goals (so the OS does not dissolve)

- **Not a new LLM.** We route through LiteLLM; models are interchangeable.
- **Not a new OAuth broker.** Nango stays; we do not rebuild Composio.
- **Not a generic RPA pixel-clicker** as the default. Prefer APIs. Browser
  automation is a last-resort tool behind confirm + sandbox policy.
- **Not an MLS.** We integrate listing sources; we do not become the
  listing authority.
- **Not a bank / escrow.** Payments via Stripe/Razorpay/etc.; Darex never
  holds client funds.
- **Not a replacement for licensed advice** (legal, medical, appraisal).
  Employees must disclose and escalate.
- **Not multi-tenant “shared brain” across orgs.** Memory never crosses
  `org_id`. Industry models may be global; tenant facts may not.

---

## 8. Success definition

Darex is the Brain OS of a business when **all** of the following are true
for a newly onboarded org in a supported vertical:

1. They connect 3+ systems (e.g. WhatsApp + Gmail + CRM or MLS-adjacent).
2. Inbound customer messages get a correct, memory-grounded reply without
   the owner in the loop, with honest fallback when a tool is disconnected.
3. Multi-step work (follow-up sequence, showing schedule, invoice chase)
   runs as a confirmed plan or a durable workflow, and survives process death.
4. The owner can ask “what do we know about this lead / listing / tenant?”
   and get cited memory + live system-of-record data, never invented facts.
5. Switching industry pack (agency → real estate) changes employees,
   entities, and workflows — not the runtime, tenancy, or connector plane.

Until then, Darex is a strong agent platform. The rest of this folder is
the plan to close that gap.

---

## 9. Where this sits in the 2026 market (so we do not clone the wrong thing)

The world is full of “AI employee” products. They are not the Brain OS.
Full catalog of libraries, people, and papers: `15-open-source-research-landscape.md`.

| Shape | Examples | Darex is |
|-------|----------|----------|
| No-code task bots | Lindy, Gumloop, n8n | No — we are an OS with packs, not a Zapier with an LLM |
| Agent *builders* | Relevance AI, CrewAI AMP | No — employees are config on *our* runtime |
| Enterprise search + chat | Glean | Partial cousin on retrieval; they are not the action/confirm plane |
| Specialist employees | Devin, 11x, Artisan, Sierra | Learn depth; we stay platform + vertical packs |
| Multiplayer company AI | Dust.tt | Closest UX cousin (shared knowledge, MCP, permissions). We add tenancy-as-product, WhatsApp, plan-confirm, Nango muscles |
| Agent *frameworks* | LangGraph, Mastra, Letta, Agno | Libraries. We already picked atomic-agent + Temporal + MCP |

The academic name for what we are building is closest to **CoALA**
(cognitive architecture for language agents: memory, action, decision)
plus **Generative Agents** memory stream — applied to a *real tenant*,
not a simulated village.

**Non-goal restated:** we do not become LangChain, Mem0 Cloud, or
Dust. We become the OS a brokerage or agency *runs on*.

---

## 10. Alternatives in the world (instead of “Brain OS”, 5 other bets)

**What Darex does:** one multi-tenant OS (sense → memory → plan-confirm
→ MCP tools) with industry **packs**, not 40 products.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Dust.tt** — multiplayer company AI, MCP, EU residency, semantic layer | Permissions and “AI operator” UX are years ahead; SOC2/GDPR story is sellable | Not multi-tenant *SaaS for SMBs*; no WhatsApp/RE pack; closed core | [dust.tt](https://dust.tt), GitHub `dust-tt/dust` |
| 2 | **Glean** — permission-aware enterprise search + agents | ACL-correct retrieval; already in Fortune 500 | Search company, not action/confirm/Nango OS | [glean.com/blog/agent-orchestration-platforms-compared](https://www.glean.com/blog/agent-orchestration-platforms-compared) |
| 3 | **OpenFang / Agno AgentOS** — OSS “agent operating system” | Sandbox, MCP, channels, scheduled hands in one runtime | We already have Temporal + atomic-agent + MCP; steal the *shape*, not the rewrite | [RightNow-AI/openfang](https://github.com/RightNow-AI/openfang), [agno-agi/agno](https://github.com/agno-agi/agno) |
| 4 | **Computer-use OS** (Skyvern, Browser Use, OpenHands) | The agent *is* the product: sandbox + confirm + traces | APIs first (`14`); computer-use is Phase 17 last resort | [skyvern-ai/skyvern](https://github.com/skyvern-ai/skyvern); OpenHands MLSys 2026 |
| 5 | **Specialist AI employees** (Sierra CX, 11x SDR, EliseAI leasing) | They win one job 10× deeper than a pack v1 | We stay platform; packs copy their *job design* | Elise vs Funnel (Thesis Driven / Hargreaves 2026) |

**Five things to steal anyway**

1. Dust dual-layer permissions (agent access vs who may invoke) → `12`.
2. Glean: retrieval must honor the same ACL as Drive → `/brain` RLS.
3. OpenFang: scheduled hands + sandbox as OS primitives, not a chatbot.
4. Pack-as-module lives in `03` (Odoo/ERPNext listed **once** there).
5. EliseAI: after-hours inbound *is* the product for RE/PM — WhatsApp 24/7. Memory hierarchy is `10` (Letta listed **once** there).

CoALA (Sumers, Yao, Narasimhan, Griffiths, TMLR 2024) is the academic
name for our six layers. Generative Agents (Park et al. 2023) is the
memory-stream paper. Neither is a product we install.

### Open-source GitHub — this file only (agent-OS metaphors)

Kernel KEEP is in `15` §1. Odoo/ERPNext → `03`. Letta/Mem0 → `10`. Eval → `01`.

| Repo | Similar to | We take |
|------|------------|---------|
| [RightNow-AI/openfang](https://github.com/RightNow-AI/openfang) | Rust agent OS: sandbox, MCP, channels, scheduled hands | Scheduled briefing + sandbox shape |
| [agno-agi/agno](https://github.com/agno-agi/agno) | Multi-tenant AgentOS + control plane | Roster UI; Python-only so not kernel |
| [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | Production software employee | Sandbox + event-source; we do not sell Devin |
| [dust-tt/dust](https://github.com/dust-tt/dust) | Company knowledge + agents + MCP | Dual-layer permissions, operator UX |
| [continuedev/continue](https://github.com/continuedev/continue) | IDE as agent OS | Skill/context files, not a product surface |
| [cline/cline](https://github.com/cline/cline) | Coding agent in the editor | Confirm-before-write UX |
| [block/goose](https://github.com/block/goose) | Local agent runtime (Block) | Recipe/skill layout |
| [skyvern-ai/skyvern](https://github.com/skyvern-ai/skyvern) | Browser workflow OS | Phase 17 last-resort computer-use |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | LLM drives a real browser | Same; APIs first |
| [elizaOS/eliza](https://github.com/elizaOS/eliza) | Multi-character agent OS | Persona YAML, not a social runtime |
| [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | Classic autonomous loop | Bounded goals; never unbounded fan-out |
| [stanfordnlp/dspy](https://github.com/stanfordnlp/dspy) | Program, don’t prompt | Compile classify/plan prompts later |
| [mastra-ai/mastra](https://github.com/mastra-ai/mastra) | TS AgentOS on Next | Patterns only; dual loop = hang class |
