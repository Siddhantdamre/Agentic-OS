# 13 — Glossary

Shared vocabulary. Where a term maps to code or schema, the location is given.

**Action bus** — the layer turning a plan step into a real call: `tool-executor.ts`,
the 50+ tool modules, Nango, the MCP bridge, the sandbox.

**Allowlist** — the enforced set of tools an employee may call
(`ai_employees.tool_allowlist TEXT[]`). Resolved per org as the union of active
employees' lists ∪ core tools ∪ connected connectors.

**Autonomy level (L0–L4)** — per-procedure, per-employee permission to act, from
observe-only to autonomous-within-budget. Specified in `04` §6; not yet built.

**Brain** — the company's durable org-scoped state: memory tiers, edges,
provenance, and (planned) entities and facts. Also the `/brain` inspector.

**BYOK** — bring your own key; the credential model for providers without OAuth
(WhatsApp, Leegality, Razorpay). Form fields are data in
`connector_defs.extra_connect_fields`.

**Commitment** — a promise made in a conversation, tracked as a first-class
object with an owner and a due date. Planned; see `04` §3.2.

**Confirm gate** — the approval step between a generated plan and its execution.
Mandatory when `confirmForRisk(risk)` is true.

**Connector** — a provider integration with its credential and connection state
(`connector_defs`, `org_connectors`). Distinct from a **tool**, which is a
specific action on a connector.

**Core tools** — always-allowed tools independent of employee allowlists:
`web_search`, `web_extract`, `database_query`, `db_query`, `sql_analytics`,
`file_ops`, `file_system`, `workspace_file`, `sandbox`, `code_execution`,
`execute_code`.

**Coverage map** — a planned surface showing what the brain does and does not
know, per source, with freshness. Data already in `knowledge_sources`.

**Crew** — several employees on one job under an explicit contract.
`MAX_CREW_SPAWN = 3`.

**Critic** — the `criticCheck` activity that can block an outbound reply,
recorded as the `critic_blocked` work event.

**Entity** — a modelled thing in the company's world: person, account, asset,
document, transaction, obligation. Today a scope key on `entity_memory`;
planned as a typed graph node.

**Fact** — a typed statement about an entity with confidence, validity window
and provenance. Planned; the central item in `09` Tier 1.1.

**Golden** — an eval case with an expected outcome, in `infra/evals/`. The
regression guard for prompts, tools and packs.

**Honesty doctrine** — the rules in `08` §10 forbidding simulated or overclaimed
results, each with an enforcement mechanism.

**HITL** — human in the loop. `inbound-hitl.ts` gates inbound actions;
`work_items` is the queue.

**Idempotency key** — `idempotency_keys`, org-scoped with expiry. Stops a
Temporal retry from repeating an external side effect.

**Ingestion** — normalise → redact → chunk → hash → embed → index. Driven by
`knowledge_sources` and `ingestion_jobs`; never on a request thread.

**Isolate-safe** — a module importable from a Temporal workflow isolate: no
Node, no `pg`, no `fetch`. `route-employee.ts`, `quiet-hours.ts`,
`crew-contract.ts`, `inbound-hitl.ts`, `plan-steps.ts`.

**MCP** — Model Context Protocol. Darex tools are exposed as `mcp.darex.*`
through the bridge on `:8790`, under the same allowlist and audit rules.

**Memory edge** — a typed relation between memory rows (`memory_edges`):
`inquired_about`, `shown`, `owns`, `employs`, `cites`, with a weight.

**Memory tier** — org / employee / entity / conversation. Each hybrid-indexed
(GIN on `body_tsv` + partial HNSW on `embedding`) and RLS-scoped.

**`negativeOutput`** — the eval convention of writing down the exact plausible
lie a golden must never produce. The technique that makes honesty testable.

**Obligation** — a dated duty from a contract or record: rent, renewal,
compliance deadline, SLA. `pm_charges` is the first concrete instance.

**Ops-blocked** — code complete, waiting on credentials or infrastructure. Never
counted as done.

**Pack** — a versioned industry bundle: manifest, employees, entities, workflow
map, KPIs, compliance, goldens, onboarding. Installed by `InstallPackWorkflow`.

**Plan** — an ordered inspectable list of steps `{id, description, tool, action,
payload, enabled}` persisted in `agent_plans` with a `planId`, a `draft`, and
`reasoning`.

**Playbook promotion** — `org_playbook_promotions`; a user naming a plan that
worked so it can be reused. Ids are namespaced `org.%`.

**Procedure** — the planned successor to hand-written workflows: a versioned,
customer-authorable SOP with triggers, typed parameters, guardrails, success
criteria and goldens.

**Provenance** — `source` + `source_ref` + `content_hash` on a memory row; plus
`model` + `prompt_hash` on an audit event. The chain that makes a citation real.

**Risk class** — `read | draft | send | pay | sign | publish | delete`
(`tools/risk.ts`). Decides the confirm gate *and* the execution path.

**RLS** — Postgres row-level security. Always `ENABLE` + `FORCE` with both
`USING` and `WITH CHECK`.

**Roster key** — `sales | support | ops | research | finance | dispatch | other`;
how the router matches intent to a role rather than to a hardcoded employee id.

**Silence budget** — a planned cap on unsolicited output per user per day. The
brief's equivalent of `MAX_NURTURE_FANOUT`.

**Watcher** — a planned standing condition evaluated on schedule against the
entity graph, producing ranked brief items.

**Work event** — an append-only lifecycle record on a work item
(`inbound_received` … `embed_enqueued`), making "what is the agent doing" a
database query.

**Work item** — a queued task requiring a human (`work_items`), created when an
agent is uncertain, an action needs approval, or routing found no confident
owner.
