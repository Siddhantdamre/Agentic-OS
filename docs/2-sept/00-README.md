# Darex — Product Master Docs (2 September)

The **product-level** view of Darex: what it is, what exists in code today, what
is missing, what to build next, and what to take from the open-source world.

Written to be read cold by three audiences without translation:

- a **founder or operator** deciding what to fund next,
- an **engineer or AI agent** picking up work with no prior context,
- a **buyer or investor** trying to understand the category claim.

Everything factual here is grounded in the repository at migration `021`: 45+
tables, 15 Temporal workflows, 50+ tool executors, ~70 API routes, 6 golden eval
suites, 3 packs. Where something is real but blocked on credentials it is marked
**ops-blocked**, never "done"; where a document specifies something unbuilt, it
says **specification, not built** at the top.

---

## Read in this order

### Start here
| # | Doc | Answers |
|---|---|---|
| 01 | [Product overview](01-product-overview.md) | What Darex is, who buys it, why it wins, what it refuses to be |
| 02 | [What we built](02-what-we-built.md) | Complete shipped inventory with file paths and migration numbers |
| 04 | [**Company brain blueprint**](04-company-brain-blueprint.md) | **The core doc** — the gap between a cortex and a brain, and how to close it |
| 09 | [Gaps and what to add](09-gaps-and-what-to-add.md) | The honest missing list, ranked by leverage |
| 10 | [Roadmap](10-roadmap.md) | Phased plan with testable exit criteria |

### How the system works
| # | Doc | Answers |
|---|---|---|
| 03 | [System architecture](03-system-architecture.md) | Topology, request paths, the isolate constraint, sharp edges |
| 05 | [Agent workforce and packs](05-agent-workforce-and-packs.md) | Employees, routing rules, crews, the pack format |
| 06 | [Integrations and actions](06-integrations-and-actions.md) | The catalogue, risk classes, connection honesty, the sandbox |
| 07 | [Memory and knowledge](07-memory-and-knowledge.md) | Four tiers, hybrid indexing, how retrieval ranks, what it must become |
| 08 | [Governance and trust](08-governance-and-trust.md) | Tenancy, the confirm gate, audit, restraint, the honesty doctrine |

### Reference
| # | Doc | Answers |
|---|---|---|
| 14 | [Data model reference](14-data-model-reference.md) | Every table, the rules its columns encode |
| 15 | [Workflow catalog](15-workflow-catalog.md) | All 15 Temporal workflows in detail |
| 16 | [API surface](16-api-surface.md) | Every route and the rule its group enforces |
| 17 | [Operations runbook](17-ops-runbook.md) | Boot, verify, diagnose, recover |
| 18 | [Evals and quality](18-evals-and-quality.md) | The suites, the `negativeOutput` technique, what is untested |

### Design specs — the Tier 1 gaps, made buildable
| # | Doc | Answers |
|---|---|---|
| 21 | [Spec: entity graph](21-spec-entity-graph.md) | Full DDL for entities, facts, conflicts and the predicate vocabulary; extraction, reconciliation, entity resolution, rollout |
| 22 | [Spec: proactivity engine](22-spec-proactivity.md) | Baselines, watchers, signal ranking, the silence budget, the brief |
| 23 | [Spec: procedures](23-spec-procedures.md) | The procedure object, the record and describe compilers, execution, versioning |
| 24 | [Spec: autonomy ladder](24-spec-autonomy.md) | L0–L4 per procedure, promotion gates, automatic demotion, the kill switch |
| 25 | [Security threat model](25-spec-threat-model.md) | Adversaries, shipped vs. specified controls, OWASP LLM Top 10, incident response |
| 26 | [Known issues register](26-known-issues.md) | Every defect and hazard, severity-ranked, with fixes and resolved-issue lessons |

### Strategy
| # | Doc | Answers |
|---|---|---|
| 11 | [Business model and GTM](11-business-model-and-gtm.md) | Pricing, packaging, motion, metrics, risks |
| 12 | [Product principles](12-product-principles.md) | 14 constraints, each with its enforcement mechanism |
| 19 | [Decision log](19-decisions-log.md) | 17 decisions, why, and what would reopen them |
| 20 | [Open source we can take](20-open-source-leverage.md) | What to adopt, study, and refuse — and where OSS is a channel |
| 13 | [Glossary](13-glossary.md) | Shared vocabulary, mapped to code |

---

## Other doc folders

| Folder | Job |
|---|---|
| `docs/current-working/` | Verified state of the running system, page by page, API by API |
| `docs/future-scope/` | Long-form vision essays and the research appendix (`15-open-source-research-landscape.md`) |
| `docs/plan/` | Execution tracker: workstreams, phases, owners |
| `BUILD_STATE.md` | Live source of truth for the last change and its reason |
| `packs/` | The industry packs themselves |
| `infra/evals/` | The golden suites |

---

## The one-paragraph version

Darex is a multi-tenant AI-employee platform. A company connects its real tools —
inbox, calendar, drive, CRM, WhatsApp, billing, database — and gets a roster of
named AI employees that share one memory, one permission model, one action bus,
and one confirmation layer. Ask a question and get an answer grounded in the
company's own data, with citations. Ask for work and get a plan you approve
before anything irreversible happens, executed durably by Temporal, traced end to
end, and audited down to which prompt version produced it and who authorised it.
Every industry is a **pack** — employees, entities, workflows, KPIs, compliance
rules and goldens — not a fork of the product.

## The one-sentence assessment

Darex has an unusually strong **substrate** — RLS tenancy with `FORCE` and
`WITH CHECK`, durable execution split by risk class, hybrid lexical+semantic
memory, honesty enforced by goldens — and an unusually thin **state model**;
building the entity graph (`09` Tier 1.1) is the hinge that turns every
remaining brain capability from a quarter into a few weeks.
