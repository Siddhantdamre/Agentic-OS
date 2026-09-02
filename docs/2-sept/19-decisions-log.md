# 19 — Decision Log

Decisions with lasting consequences, why they were made, and what would have to
change to revisit them. Recorded because the reasoning is worth more than the
diff six months later.

---

### D1 — Postgres RLS for tenancy, not application-level filtering

**Decision:** every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a
policy with both `USING` and `WITH CHECK`, keyed on
`current_setting('app.current_org_id')`. Applications connect as `darex_app`,
never the owner.

**Why:** application-level `WHERE org_id = ?` is one forgotten clause away from
a cross-tenant leak, and the forgotten clause is invisible in review. `FORCE`
closes the owner-bypass hole; `WITH CHECK` closes the cross-tenant *write* hole
that `USING` alone leaves open.

**Cost:** every connection must set the org GUC; a missing GUC yields empty
results rather than an error, which is confusing to debug.

**Revisit if:** never, realistically. Retrofitting this is a rewrite.

---

### D2 — Temporal for anything irreversible

**Decision:** `send | pay | sign | publish | delete` plans execute as
`PlanExecuteWorkflow`; `read | draft` stay on the HTTP SSE path
(`plan-steps.ts`).

**Why:** a dashboard restart mid-send must not drop a live send, and a human
approval can take hours — neither fits a request handler.

**Cost:** two execution paths to maintain, and the risk classification must be
right. Mitigated by failing closed: an unclassified tool with a send-shaped
action name is treated as durable.

---

### D3 — Classification and planning call LiteLLM directly, not the agent loop

**Decision:** `lib/classify.ts`, `lib/plan-generator.ts` and `reviseDraft` use
`lib/litellm-client.ts` instead of atomic-agent's chat completions.

**Why:** the agent loop injects the full GBNF tool grammar and every tool
descriptor. The model then tried to emit real tool calls inside what should be
a plain JSON completion, producing malformed concatenated JSON, a parse/repair
loop, and 90-second hangs.

**Rule generalised:** structured-output call sites get a plain client. Tool
grammars belong only where tools will actually be called.

---

### D4 — Reasoning disabled on structured call sites

**Decision:** `reasoning: { enabled: false }`, `max_tokens` 300 (classify),
800 (plan), 1000 (revise).

**Why:** a reasoning model spent the entire budget on `reasoning_content` and
returned empty `content`; with a large budget it reasoned for minutes.

**Revisit if:** a model demonstrably improves plan quality with reasoning on and
returns content within budget. Measure with goldens plus latency, not vibes.

---

### D5 — Tool allowlist is the union across the org, not one employee

**Decision:**
`union(all active employees' tool_allowlist) ∪ core tools ∪ connected connectors`.

**Why:** the previous fallback did `SELECT ... FROM ai_employees WHERE
status='active' LIMIT 1` and picked an arbitrary employee, blocking tools the
org genuinely owned. The union is the correct semantic: **an org's capability
is the sum of its employees plus its connections.**

**Cost:** an employee can transitively reach a tool another employee owns.
Acceptable at current scale; when per-employee isolation matters, the
per-employee list stays authoritative on that employee's own turns.

---

### D6 — Honesty over graceful degradation

**Decision:** a disconnected connector returns `status:'error'`,
`connected:false`, `setupUrl:'/connectors'`. Never a simulated result.

**Why:** one fabricated success destroys the trust the whole product depends
on. The failure mode of a lie is silent and permanent; the failure mode of an
honest error is a support ticket.

**Enforcement:** goldens with an explicit `negativeOutput`, plus a live module
test. `connected` cannot pass without a recorded fixture.

---

### D7 — Memory is hybrid lexical + semantic from day one

**Decision:** every memory tier carries a generated `body_tsv` with a GIN index
**and** an HNSW cosine index partial on `embedding IS NOT NULL`.

**Why:** exact terms (invoice numbers, unit numbers, names) fail vector search;
paraphrases fail lexical search. The partial index also means rows are
searchable the moment they land, before the embed worker catches up.

**Cost:** two indexes per tier, and a fusion ranking to maintain.

---

### D8 — The graph lives in Postgres

**Decision:** `memory_edges` with polymorphic `from_id`/`to_id`, `rel`, and
`weight`, rather than a dedicated graph database.

**Why:** graph hops stay inside RLS. A separate graph store would need its own
tenancy model, its own backup story, and a synchronisation problem. The
migration comment names Apache AGE as the escape hatch if traversal depth ever
justifies it.

**Revisit if:** multi-hop traversal becomes a hot path and recursive CTEs stop
performing.

---

### D9 — No KYC in memory tables

**Decision:** `013_memory_rag` explicitly omits KYC / PAN / Aadhaar columns and
documents the omission.

**Why:** the primary vertical handles identity documents. The cheapest way to
never leak them from the vector store is for them never to be in it.

---

### D10 — Verticals are packs, never forks

**Decision:** a pack is `pack.yaml` + employees + entities + workflow map +
KPIs + compliance + goldens + onboarding. `packs.extends` supports inheritance;
`org_packs.is_primary` marks the vertical when several are installed.

**Why:** a fork per industry multiplies maintenance by the number of verticals
and guarantees drift. If a pack needs a platform code change, the platform is
missing a primitive — build the primitive.

---

### D11 — Hard fan-out caps

**Decision:** `MAX_CREW_SPAWN = 3`, `MAX_NURTURE_FANOUT = 3`,
`MAX_STALE_CHASE = 10`.

**Why:** unbounded agent fan-out is the classic way to burn a token budget and
spam a customer's contacts simultaneously. Constants in isolate-safe modules
make the caps testable and visible rather than buried in prompts.

---

### D12 — Sandbox has no network

**Decision:** the code-execution container runs as an unprivileged user with a
hard timeout, **no outbound network and no DB access**.

**Why:** a sandbox with network access is an exfiltration channel, and code
execution is exactly what a prompt injection would target.

**Cost:** code that needs to fetch a URL must be expressed as `web_extract`
plus sandbox, not as one script. Correct trade.

---

### D13 — `completed_with_errors` is a real terminal state

**Decision:** `PlanExecuteStatus` includes it alongside `completed` and
`cancelled`.

**Why:** a four-step plan that fails at step three is neither success nor
failure. Collapsing it into either one is a lie to the user about the state of
their business.

**Open consequence:** there is still no compensation for the steps that already
succeeded. See `09` Tier 2.

---

### D14 — Playbook ids are namespaced `org.%`

**Decision:** `org_playbook_promotions.playbook_id LIKE 'org.%'`, unique per
org, `named_by_user_id ... ON DELETE RESTRICT`.

**Why:** customer-authored playbooks must never collide with or impersonate a
platform or pack playbook, and the author of a live playbook must remain
resolvable. Provenance beats referential convenience.

---

### D15 — Connector catalogue is data, not code

**Decision:** `connector_defs` holds presentation, auth mode, risk class,
confirm policy, scopes, MCP tool names, BYOK form fields, and
`executor_status`.

**Why:** adding a connector to the UI should not require a dashboard deploy,
and `executor_status` prevents advertising a connector whose executor does not
exist. `scopes` in the registry is what makes scope drift detectable rather
than discovered as a 403 in production.

---

### D16 — Webhooks: verify, persist, 200, then process

**Decision:** signature verification first, persist to the webhook inbox,
return 200 immediately, then `fireInboundAgent` asynchronously. Tenant from a
mapping table or site-key hash, never from the body.

**Why:** providers retry aggressively; a slow agent on the request path causes
duplicate deliveries. Trusting a body `org_id` is a cross-tenant write hole.

---

### D17 — Owner approves from WhatsApp

**Decision:** `/api/webhooks/owner-whatsapp` signals `approveWorkItem` /
`rejectWorkItem` on the running workflow.

**Why:** the buyer is an owner or operations head who lives on their phone. An
approval that requires opening a dashboard does not happen, and an approval
that does not happen means the agent stops being useful.

---

## Decisions still open

| Question | Why it is not decided |
|---|---|
| Do facts get their own tables, or extend `entity_memory`? | Depends on whether contradiction handling needs row-level history |
| Where does procedure generalisation happen — planner or a separate compiler? | Unknown until playbook promotion is used in anger |
| Per-employee data scoping: is the org union acceptable at 50 seats? | No customer has hit the scale that forces the answer |
| Workflow versioning strategy for multi-week nurture sequences | Not yet bitten by it; will need Temporal patching |
| Dedicated Redis for Langfuse, or move tracing off the shared instance entirely | Ops cost versus trace reliability |
| Cost budgets: enforce in the tool executor, or at the workflow level | Both have merit; needs a spike |
