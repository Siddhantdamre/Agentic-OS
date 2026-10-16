# Open-Source Reference Map

> **What this is.** For every subsystem in `gap/10`–`gap/23`, the open-source
> projects that already solve it or something close — repo link, what it
> actually does, and a verdict: **adopt**, **study**, or **skip**.
>
> **Why it exists.** Several things this plan specifies have mature
> open-source answers, and a few of the hardest have none — worth knowing
> before someone spends a sprint discovering it. The honest summary is §16.
>
> **Freshness.** Checked September 2026. Stars and licences move, and at least
> two projects here changed their terms in the last year (§4, §7). The caveats
> matter more than the numbers. **Re-verify licensing before adopting.**

---

## Contents

| § | Subsystem | Our doc |
| :-: | :-- | :-- |
| 1 | Durable execution | `19`, `16` |
| 2 | Durable-execution alternatives | `16` |
| 3 | Agent frameworks | `19` |
| 4 | Agent memory | `20` |
| 5 | Structured output & extraction | `13 §3` |
| 6 | Date & duration parsing | `13 §4` |
| 7 | Observability & evaluation | `14`, `13 §6` |
| 8 | Agent benchmarks | `13 §6` |
| 9 | Prompt injection & guardrails | `18 §1` |
| 10 | Human-in-the-loop | `15 §2`, `17 §2` |
| 11 | Entity resolution | `P3-DEDUP-1` |
| 12 | Connectors & tool routing | `04`, `P5-ROLE-1` |
| 13 | Feature flags & kill switches | `14 §5` |
| 14 | Cost control & routing | `21` |
| 15 | Adjacent products | competitive |
| 16 | What has no OSS answer | `11`, `13`, `14` |
| 17 | Licence primer | — |
| 18 | Reading list & summary | — |

---

## 1. Durable Execution — the runtime we already chose

| Project | Link | What it is |
| :-- | :-- | :-- |
| **Temporal** | [temporalio/temporal](https://github.com/temporalio/temporal) | Durable workflow execution. Already in the stack (`services/workflows`) |
| Temporal AI Cookbook | [docs.temporal.io/ai-cookbook](https://docs.temporal.io/ai-cookbook) | Official agent patterns — including a **human-in-the-loop** recipe using Signals plus durable timers |
| Pydantic AI × Temporal | [temporal.io/blog/…pydantic-ai-and-temporal](https://temporal.io/blog/build-durable-ai-agents-pydantic-ai-and-temporal) | Type-safe agents with native Temporal durability |

**Verdict: adopt the patterns, we already have the runtime.**

The HITL recipe is the same design as `gap/15`'s approval gate — Signal to
resume, durable timer to bound the wait. Read it before building `P1-HITL-2`,
mainly to check signal naming and timeout semantics against the reference.
One constraint the cookbook does not make for you: **timeout must never mean
approve** (`gap/11 §10 Q5`).

The determinism boundary in `gap/19 §2` is a Temporal fundamental, not
something we invented. If anyone disputes that model calls belong in
activities, point at the official docs rather than at our file.

---

## 2. Durable-Execution Alternatives — know them, don't switch

Durable execution stopped being niche in 2025; agentic pipelines, long sagas,
and event-driven jobs all converged on the same primitive. Worth knowing what
else exists, if only to answer "why Temporal?"

| Project | Link | Shape | Note |
| :-- | :-- | :-- | :-- |
| **Hatchet** | [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet) | Postgres-backed task orchestration, Python/TS/Go/Ruby | Explicitly targets "mission-critical AI agents" |
| **DBOS** | [dbos-inc/dbos-transact-py](https://github.com/dbos-inc/dbos-transact-py) | A **library**, not a service — Postgres connection string plus decorators | Lowest operational weight; best when durability and DB are already aligned |
| **Inngest** | [inngest/inngest](https://github.com/inngest/inngest) | Event-driven durable functions | Strong DX, event-first model |
| **Windmill** | [windmill-labs/windmill](https://github.com/windmill-labs/windmill) | Scripts + flows + internal UIs | Broader than orchestration |
| **Trigger.dev** | [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev) | TS-native background jobs | |
| **Restate** | [restatedev/restate](https://github.com/restatedev/restate) | Durable services and handlers | Different abstraction: durable RPC rather than workflows |

**Verdict: skip. We have Temporal, and switching costs exceed any gain.**

The one genuinely interesting comparison is **DBOS**: it runs durability *in
Postgres*, which we already operate with RLS. For a smaller system that would
be a real simplification — one fewer service, and workflow state inside the
same tenancy boundary. We are past that decision point, but it is the honest
answer to "did you consider something lighter?"

---

## 3. Agent Frameworks — what we are not adopting, and why

| Project | Link | Shape |
| :-- | :-- | :-- |
| **LangGraph** | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | Graph state machines, durable execution. Default for stateful production agents in regulated settings; passed CrewAI in stars in early 2026 |
| **Pydantic AI** | [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) | Typed agents; the breakout framework of 2026. Native Temporal support |
| **CrewAI** | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | Role-based multi-agent crews |
| **OpenAI Agents SDK** | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | Model-driven loop, fast to ship |
| **DeepAgents** | [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents) | Planning + subagents + filesystem over LangGraph |
| **Agno** | [agno-agi/agno](https://github.com/agno-agi/agno) | Lightweight, performance-focused |
| **Microsoft Agent Framework** | [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | Graph-based; AutoGen + Semantic Kernel successor |

**Verdict: study, do not adopt.**

We have Temporal + `atomic-agent-client` + `mcp-bridge`, and Temporal covers
the durability these frameworks mostly compete to provide. Adding LangGraph
means two orchestrators, two notions of state, two replay models — a subtle
and permanent tax.

Worth stealing:

- **LangGraph's interrupt/resume** maps almost exactly onto our approval gate.
- **CrewAI's role separation** is our three employees; our
  `MAX_CREW_SPAWN = 3` cap is already the right instinct (`gap/19 §6`).
- **Pydantic AI's typed outputs** is the pattern behind `gap/13 §1` rule 1,
  and it is the one framework here that *composes* with Temporal rather than
  competing. If we ever regret hand-rolling structured output, this is the
  migration target.

The real reason not to adopt: **none of them solve our problem.** They
orchestrate an agent given a goal. Deciding *when* to act with no prompt and
*whether* to ask a human is upstream of everything they do.

---

## 4. Agent Memory — the most mature category here

| Project | Link | Approach | Note |
| :-- | :-- | :-- | :-- |
| **Mem0** | [mem0ai/mem0](https://github.com/mem0ai/mem0) | Extract-and-retrieve; vector + graph + KV. ~47k stars | Best drop-in personalization memory |
| **Graphiti** (Zep) | [getzep/graphiti](https://github.com/getzep/graphiti) | **Temporal knowledge graph** — facts valid over time ranges | 63.8% vs Mem0's 49.0% on LongMemEval. ⚠️ Zep retired self-hosted CE; **Graphiti stays open source** |
| **Letta** (ex-MemGPT) | [letta-ai/letta](https://github.com/letta-ai/letta) | Context as RAM, archival as disk, agent self-manages | Built for agents running for days |
| **Cognee** | [topoteretes/cognee](https://github.com/topoteretes/cognee) | Memory as an ECL pipeline into a graph | |
| **pgvector** | [pgvector/pgvector](https://github.com/pgvector/pgvector) | Vector similarity in Postgres | **Already in our stack** (`013_memory_rag.sql`) |

**Verdict: study Graphiti closely; keep our own stores.**

We ship four scoped memory stores plus `memory_edges` and hybrid retrieval
with citations (`gap/20 §1`), so the build case is weak. But **Graphiti's
bitemporal model targets a real gap of ours.** `gap/20 §3` warns against
"newest wins" for contradictions; Graphiti solves exactly that by making fact
validity time-ranged rather than overwritten. If `fact_conflicts` proves too
coarse, that is the design to copy.

The LongMemEval gap between temporal-graph and extract-and-retrieve is the
best available evidence for `gap/20 §2`'s "structured before prose" rule.

---

## 5. Structured Output & Extraction — `gap/13 §3`

Directly relevant: the obligation extractor is a structured-extraction problem
with an unusually strict grounding requirement.

| Project | Link | Approach |
| :-- | :-- | :-- |
| **Instructor** | [567-labs/instructor](https://github.com/567-labs/instructor) | Pydantic/Zod schemas + runtime validation + retry. Python, TS, Go, Ruby. The safest default; covers the 80% case with almost no learning curve |
| **Outlines** | [dottxt-ai/outlines](https://github.com/dottxt-ai/outlines) | **Finite-state-machine token masking** — invalid tokens cannot be generated, so schema compliance is structural |
| **BAML** | [BoundaryML/baml](https://github.com/BoundaryML/baml) | Contract-first schema DSL with code generation |
| **Guidance** | [guidance-ai/guidance](https://github.com/guidance-ai/guidance) | Constrained generation primitives |

**Verdict: adopt Instructor-style validation-and-retry. Study Outlines.**

`gap/13 §1` rule 1 already mandates schema-constrained output with a hard
failure on violation — that is Instructor's model exactly, and if the
hand-rolled version starts accumulating retry logic, adopt the library rather
than reinventing it.

**Outlines is the interesting one and does not do what we need.** FSM masking
guarantees the *shape* of the output. It cannot guarantee the *content* is
grounded — a schema-valid `quote` field can still be a fabrication. Our
substring check (`gap/13 §3`) is the control for that, and no library in this
table replaces it. Worth knowing so nobody proposes constrained decoding as a
hallucination fix.

---

## 6. Date & Duration Parsing — `gap/13 §4`

Small category, disproportionate impact: `gap/13 §4` resolves due-times in
code precisely because models are unreliable at date arithmetic.

| Project | Link | Note |
| :-- | :-- | :-- |
| **chrono-node** | [wanasit/chrono](https://github.com/wanasit/chrono) | TS/JS natural-language date parser. Handles "next Tuesday", "in 3 weeks", reference dates and timezone offsets |
| **Duckling** | [facebook/duckling](https://github.com/facebook/duckling) | Haskell; probabilistic, multilingual, very strong on durations. Heavy to operate |
| **dateparser** | [scrapinghub/dateparser](https://github.com/scrapinghub/dateparser) | Python; wide language coverage |

**Verdict: adopt chrono-node.**

It matches the stack, and it is the direct implementation of
`resolveDue()`'s `parseAbsolute` / `parseRelative`. Critically, it accepts an
explicit **reference date and timezone** — which is the entire fix for the
late-evening off-by-one-day bug named in `gap/13 §4`. Hand-rolling relative
date parsing is a well-known way to lose a week.

---

## 7. Observability & Evaluation

| Project | Link | Licence | Note |
| :-- | :-- | :-- | :-- |
| **Langfuse** | [langfuse/langfuse](https://github.com/langfuse/langfuse) | **MIT** | Most-adopted OSS LLM observability. Tracing, prompt management, evals, datasets. Self-hosts at production scale. **Integrates LiteLLM**, which we run |
| **Opik** | [comet-ml/opik](https://github.com/comet-ml/opik) | **Apache-2.0** | Tracing + systematic evaluation |
| **Phoenix** | [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) | ⚠️ **Elastic 2.0** | Not OSI open source |
| **promptfoo** | [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | MIT | YAML-driven CLI; side-by-side prompt/model matrix. Ships a **red-teaming engine** covering 50+ vulnerability types |
| **DeepEval** | [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | Apache-2.0 | **pytest-native** — evals as unit tests. G-Eval, faithfulness, hallucination metrics |
| **Ragas** | [explodinggradients/ragas](https://github.com/explodinggradients/ragas) | Apache-2.0 | RAG-specific: faithfulness, context precision |
| **Evidently** | [evidentlyai/evidently](https://github.com/evidentlyai/evidently) | Apache-2.0 | Drift monitoring; closest to `gap/13 §7` calibration |

**Verdict: adopt Langfuse + promptfoo. Consider DeepEval for the fixture gates.**

- **Langfuse** gives prompt versioning (`gap/13 §9`), trace debugging, and a
  dataset harness for the `gap/13 §6` fixtures. LiteLLM integration means low
  wiring cost. Wire it in Phase 1.
- **promptfoo** is the natural home for the `gap/13 §6` gates — a YAML matrix
  asserting stage-1 recall ≥ 0.98 and stage-2 precision ≥ 0.95 in CI is
  exactly its shape. Its red-teaming engine also gives `gap/18 §1` a way to
  *test* injection resistance rather than assert it.
- **DeepEval** if the team prefers evals as pytest — the `gap/13 §9` rule that
  a prompt change failing its gate does not merge is easier to enforce when
  the gate is a test.

**But none of them can produce a single metric from `gap/14 §2`.** Approval
rate, discrepancies per day, suppression rate, obligations per 100 messages —
these are queries over `agent_decision_ledger`, and no LLM observability tool
models a decision ledger with counterfactuals. The split is clean:
**Langfuse observes the model; `gap/14` observes the employee.**

---

## 8. Agent Benchmarks — how the field measures this

| Benchmark | Link | Measures |
| :-- | :-- | :-- |
| **τ²-bench** | [sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench) | Tool-agent-user interaction in real domains. **Treats policy adherence as a first-class metric, separate from task success** |
| **LongMemEval** | [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) | Long-horizon memory and temporal retrieval (the §4 numbers) |
| **AgentBench** | [THUDM/AgentBench](https://github.com/THUDM/AgentBench) | Broad LLM-as-agent evaluation |
| **WorkArena** | [ServiceNow/WorkArena](https://github.com/ServiceNow/WorkArena) | Enterprise knowledge-work tasks |

**Verdict: study τ²-bench closely. It is the closest published analogue to
what we are building.**

Sierra's benchmark is a customer-service agent that must follow
domain-specific policies while using tools across multi-turn dialogue —
which is our Customer Employee, almost exactly. The design decision worth
copying: **task success and policy compliance are scored separately.** An
agent that resolves the ticket by violating the refund policy fails, and it
fails distinguishably.

That maps directly onto `gap/14 §2`. We measure approval rate and escalation
rate as health metrics; τ²-bench says measure *policy adherence* as a
first-class outcome. Consider adding it: **fraction of autonomous actions
that a reviewer judges policy-compliant**, sampled monthly. Nothing currently
in `gap/14` measures that, and it is the number a regulated buyer will ask
for.

The related literature on red-teaming policy-adherent agents is also worth a
skim before `gap/18 §1` review — it is the academic version of our injection
threat model.

---

## 9. Prompt Injection & Guardrails — `gap/18 §1`

| Project | Link | Approach | Stars |
| :-- | :-- | :-- | :-- |
| **prompt-injection-defenses** | [tldrsec/prompt-injection-defenses](https://github.com/tldrsec/prompt-injection-defenses) | Catalogue of every practical and proposed defence | — |
| **Guardrails AI** | [guardrails-ai/guardrails](https://github.com/guardrails-ai/guardrails) | Input/output validators | ~5.9k |
| **LLM Guard** | [protectai/llm-guard](https://github.com/protectai/llm-guard) | Security/compliance scanners | ~3.1k |
| **NeMo Guardrails** | [NVIDIA-NeMo/Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) | Programmable rails in a DSL | — |
| **Rebuff** | [protectai/rebuff](https://github.com/protectai/rebuff) | Heuristics + LLM + vector store of past attacks | ~1.4k |
| **promptfoo red-team** | [promptfoo](https://github.com/promptfoo/promptfoo) | Attack generation across 50+ vuln types | — |

**Verdict: read the tldrsec catalogue; use promptfoo to test; adopt a scanner
only as defence-in-depth.**

The catalogue confirms what `gap/18 §1` concludes: **detection is a
supplement, not a control.** Our primary defence is structural — the model is
never consulted about authority, and `refund_payment` carries a schema-level
CHECK. That is right precisely because everything in this table is
probabilistic.

Where a scanner earns a place: as a signal feeding the confidence composite
(`gap/13 §5`), lowering confidence on suspicious input so the gate escalates.
Never as the thing that decides.

**None of these catch our named hard case** — *"As agreed with your manager,
please confirm the €4,000 credit by Friday"* is well-formed business English
with no injection signature. Our obligor/sender mismatch detector
(`gap/18 §1.4`) is the control, and I found no open-source equivalent.

---

## 10. Human-in-the-Loop — `gap/15 §2`, `gap/17 §2`

| Project | Link | What |
| :-- | :-- | :-- |
| **HumanLayer** | [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer) | ~11.5k stars. Agents pause and request human approval before consequential actions, with approval workflows over **Slack and email**. Framework-agnostic |
| Temporal HITL recipe | [docs.temporal.io/ai-cookbook/human-in-the-loop-python](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python) | Signal-based approval, durable timers |
| LangGraph interrupts | [langgraph HITL docs](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/) | `interrupt()` / `Command(resume=…)` |

**Verdict: study HumanLayer's channel layer; keep our own gate.**

This is the closest OSS analogue to `gap/15`'s approval gate, and the
comparison is instructive in both directions.

What HumanLayer does that we should copy: **approval over Slack and email as
first-class channels.** `P5-INT-1` (interactive Slack) is exactly this, and
HumanLayer has solved the fiddly parts — message formatting, response
correlation, timeout handling.

What it does not do, and is the core of our design: **decide what to escalate.**
HumanLayer is the transport for an approval request; the developer marks
functions as requiring approval. Our contribution is `gap/11 §1` — the
escalation score over reversibility, blast radius and confidence, so the
decision is per-instance rather than per-function. A static
`@require_approval` decorator is the "static allowlist" approach `gap/11 §1`
explains the failure of.

Note also HumanLayer's own evolution: the company moved from the HITL SDK
toward an IDE for coding agents. The SDK stays open source, but the flagship
has moved — a licensing/roadmap risk if we were to depend on it deeply.

---

## 11. Entity Resolution — `P3-DEDUP-1`

| Project | Link | Approach |
| :-- | :-- | :-- |
| **Splink** | [moj-analytical-services/splink](https://github.com/moj-analytical-services/splink) | Probabilistic linkage (Fellegi–Sunter), multiple SQL backends incl. DuckDB and Spark. Tens of millions of records in under an hour |
| **Zingg** | [zinggAI/zingg](https://github.com/zinggAI/zingg) | Active-learning ER on Spark. Latest release August 2026 |
| **dedupe** | [dedupeio/dedupe](https://github.com/dedupeio/dedupe) | Human-trained fuzzy matching in Python |
| **Awesome Entity Resolution** | [OlivierBinette/Awesome-Entity-Resolution](https://github.com/OlivierBinette/Awesome-Entity-Resolution) | Survey |

**Verdict: stay with `pg_trgm`. Revisit Splink if precision becomes the
complaint.**

`gap/16 §6` keeps `pg_trgm` and that remains right: already in Postgres, runs
inside the RLS boundary, no new service. Splink is built for millions of
records; an org's CRM has thousands.

The case for revisiting is **accuracy, not scale**. `pg_trgm` is a string
heuristic; Splink's probabilistic model reasons about *which fields agreeing
means what* — the difference between "Acme Corp"/"Acme Corp." (same) and two
regional entities sharing a name. That second case is literally the example in
our own ledger comment (`gap/12`). If `P3-DEDUP-1` starts producing bad
merges, Splink over DuckDB is the upgrade. The ladder says do not reach for it
first.

---

## 12. Connectors & Tool Routing

| Project | Link | Note |
| :-- | :-- | :-- |
| **Nango** | [NangoHQ/nango](https://github.com/NangoHQ/nango) | OAuth + sync for hundreds of APIs. **Already in our stack** |
| **Composio** | [ComposioHQ/composio](https://github.com/ComposioHQ/composio) | 250+ agent-oriented connectors; abstracts auth, permissions, schemas. **Tool Router**: one MCP endpoint that dynamically loads relevant tools |
| **MCP servers** | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Reference servers; we already bridge MCP |
| **Airbyte** | [airbytehq/airbyte](https://github.com/airbytehq/airbyte) | ELT, not agent tool-calling. Different problem |

**Verdict: keep Nango. Watch Composio's Tool Router.**

62 working connector tools on Nango — no reason to move. But the Tool Router
addresses a problem we will hit: as tool count grows, putting every tool in
every context degrades selection and costs tokens. `gap/15 §1`'s taxonomy and
`P5-ROLE-1`'s role-scoped allowlist are our independently-arrived-at answers
to the same pressure. If tool count triples, dynamic loading is the pattern.

---

## 13. Feature Flags & Kill Switches — `gap/14 §5`

The kill switch and the four-stage rollout need a flag system, and
`gap/14 §5` says test it before Stage 1.

| Project | Link | Note |
| :-- | :-- | :-- |
| **OpenFeature** | [open-feature/spec](https://github.com/open-feature/spec) | CNCF vendor-neutral flag API. Adopt the *interface* even with a trivial backend |
| **Unleash** | [Unleash/unleash](https://github.com/Unleash/unleash) | Mature self-hosted flags with gradual rollout and targeting |
| **Flagsmith** | [Flagsmith/flagsmith](https://github.com/Flagsmith/flagsmith) | Self-hostable, per-segment targeting |

**Verdict: a per-org column is enough at first — but define the interface now.**

`gap/14 §5`'s kill switch is one write to an org row, and that is genuinely
sufficient for one flag. The reason to think about it early: canary orgs
(`gap/18 §2`) and staged rollout need per-org *targeting*, which is where a
hand-rolled column starts growing conditionals. OpenFeature's interface with
a database-backed provider costs nothing now and makes a later swap
mechanical.

---

## 14. Cost Control & Routing — `gap/21`

| Project | Link | Note |
| :-- | :-- | :-- |
| **LiteLLM** | [BerriAI/litellm](https://github.com/BerriAI/litellm) | **Already in our stack.** Routing, fallbacks, per-key budgets, spend tracking |
| **GPTCache** | [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) | Semantic caching of LLM responses |
| **tiktoken** | [openai/tiktoken](https://github.com/openai/tiktoken) | Token counting for budget enforcement |

**Verdict: use LiteLLM's budget features. Skip semantic caching.**

LiteLLM already does the `gap/21 §6` optimisation-4 work — cheap model for
classification, capable model for planning — as configuration. Its per-key
budgets and spend tracking also map onto `gap/21 §5`'s per-org ceilings; check
what it gives before building spend tracking by hand.

**Semantic caching is a poor fit here and worth explaining once.** Our
expensive calls are extraction (per unique message — near-zero cache hit rate)
and planning (per unique situation). A cache that returns a *similar* prior
answer for a *different* customer's situation is not a saving, it is a
correctness bug with a plausible face. Exact-hash caching of stage-1 by
message hash (`gap/13 §8`) is safe and already specified; semantic similarity
is not.

---

## 15. Adjacent Products — the competitive read

| Project | Link | What |
| :-- | :-- | :-- |
| **Chatwoot** | [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot) | OSS omnichannel support desk. **Already integrated.** Ships **Captain**, its own AI agent for automating replies |
| **Dify** | [langgenius/dify](https://github.com/langgenius/dify) | Visual LLM app builder with workflows and RAG |
| **n8n** | [n8n-io/n8n](https://github.com/n8n-io/n8n) | Workflow automation, increasingly agentic |
| **Activepieces** | [activepieces/activepieces](https://github.com/activepieces/activepieces) | OSS Zapier alternative with AI steps |
| **Suna / Open Computer agents** | various | General computer-use agents |

**Verdict: study the boundary. Differentiation is either real here or
imaginary.**

Chatwoot's Captain is the closest competitor inside our own stack, and the
comparison clarifies the thesis: **Captain answers conversations; our Customer
Employee owns unfinished business.** Captain is reactive — message arrives, it
replies. Nothing notices that a promise made Tuesday is unmet Friday, because
there is no obligation state and no durable timer. That is `gap/11 §0` in one
sentence, and it is worth re-checking Captain's roadmap periodically: if it
ships open-loop tracking, our differentiation narrows to Operations and
Growth.

n8n and Dify are the "why not just build this in a workflow tool?" question a
customer will eventually ask. The answer is the four mechanisms: they have
triggers and LLM steps, but no state machines over business obligations, no
autonomy gate, and no decision ledger. Being able to say that crisply is worth
more than any technical comparison.

---

## 16. What Has No Good Open-Source Answer

The genuinely novel parts, where a search returns nothing usable:

| Our thing | Nearest OSS | Gap |
| :-- | :-- | :-- |
| **Obligation extraction** (`gap/13 §3`) | Instructor, generic extraction | Nothing models obligor + due-basis + grounded quote + content-hash idempotency. Hardest ticket **and** least prior art |
| **Instance-scored autonomy gate** (`gap/11 §1`) | HumanLayer, Guardrails, framework interrupts | All binary or per-function. Nothing scores *this instance* on reversibility × blast radius × confidence |
| **Counterfactual decision ledger** (`gap/11 §6`) | Langfuse traces, audit logs | All log what happened. None model "considered and declined, here is why" as a queryable first-class record |
| **Expected-vs-actual generators** (`gap/11 §5`) | Monitoring tools | Those compare metrics to thresholds. Nothing derives an expectation from a promise in a message |
| **Two-sided health metrics** (`gap/14 §2`) | Standard observability | Everything alerts on *too much*. Almost nothing alerts on *suspiciously quiet* |
| **Cross-employee outbound budget** (`gap/11 §8`) | Per-service rate limiters | All limit per sender. None limit per *recipient* across senders |

Two readings, both true. Encouraging — the moat is where nobody has built.
And a warning: **no reference implementation exists to check against, so the
fixture sets (`gap/13 §6`) and acceptance checks (`gap/10`, `gap/23`) are the
only feedback available.** Build them first, not last.

---

## 17. Licence Primer

"Open source" is doing different work across this document. Before adopting
anything, check which:

| Licence | Projects here | Means |
| :-- | :-- | :-- |
| **MIT** | Langfuse core, promptfoo, chrono-node | Do what you like |
| **Apache-2.0** | Opik, DeepEval, Ragas, Temporal, pgvector | Same, plus a patent grant |
| **Elastic 2.0** | Phoenix | **Not OSI open source.** No offering it as a managed service |
| **BSL / source-available** | some orchestration tools | Time-delayed open source; check the conversion date |
| **Open core** | Zep (CE retired), several others | The OSS part can shrink — as it did |

Two patterns worth watching, both illustrated in this document: **Zep retired
its self-hosted Community Edition** (§4), and **HumanLayer's flagship moved
away from the open SDK** (§10). Neither is bad faith; both are why a
dependency on an open-core project's *free tier* is a roadmap risk, not just a
technical choice.

For anything we would embed deeply: prefer MIT/Apache, and prefer projects
where the OSS artifact *is* the product rather than a funnel into one.

---

## 18. Reading List & Summary

**One afternoon, before Phase 1:**

1. [Temporal HITL cookbook](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python) — the approval gate, done officially
2. [tldrsec/prompt-injection-defenses](https://github.com/tldrsec/prompt-injection-defenses) — confirms why `gap/18 §1` is structural
3. [τ²-bench](https://github.com/sierra-research/tau2-bench) — policy adherence as a separate metric; the closest published analogue
4. [Graphiti](https://github.com/getzep/graphiti) — bitemporal facts, our `fact_conflicts` upgrade path
5. [HumanLayer](https://github.com/humanlayer/humanlayer) — what an approval layer looks like, and what it leaves to us
6. [Langfuse docs](https://langfuse.com/docs) — decide whether to wire in Phase 1 (recommended)
7. Chatwoot Captain — know exactly what we differentiate against

**The verdicts:**

| | |
| :-- | :-- |
| **Adopt** | Langfuse (observability, prompt versioning, eval datasets) · promptfoo (the `13 §6` gates + injection red-teaming) · chrono-node (`13 §4` due-time parsing) · Instructor-style validate-and-retry · Temporal's HITL patterns · LiteLLM budget features |
| **Keep** | Temporal · Nango · pgvector · `pg_trgm` · our memory stores · our agent client |
| **Study** | Graphiti's bitemporal model · τ²-bench's policy-compliance metric · HumanLayer's Slack/email approval channels · LangGraph interrupts · Composio Tool Router · Splink as a `pg_trgm` upgrade |
| **Skip** | Every agent framework as an orchestration replacement · durable-execution alternatives · semantic caching · Outlines as a hallucination fix |

Roughly **70% of this build is assembly** of mature, well-understood
components — and this document should be used to avoid rebuilding any of it.
The remaining 30% — obligations, the gate, the ledger, expectation generation,
recipient-scoped budgets — is where nobody has shipped a good answer. That is
both why it is worth building and why it will take longer than it looks.

The single most useful thing to steal from this entire survey is τ²-bench's
scoring split: **task success and policy compliance are different numbers.**
Add policy-compliance sampling to `gap/14 §2` as an eleventh metric.

---

*Verified September 2026. Stars, licences and self-hosting terms change —
re-check before adopting. Maps to the build docs in [`gap/README.md`](./gap/README.md).*
