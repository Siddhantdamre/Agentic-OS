# 01 — From today to Brain OS (honest gap)

This document is the bridge between `docs/current-working/` and the vision
in `00-vision-ai-brain-os.md`. Every future phase should be able to point
at a row here and say “this gap closed”.

Snapshot date of “today”: **2026-08-13**. If current-working has moved,
trust `docs/plan/02-gap-analysis.md` for facts and update this gap list.

---

## 1. What is already a Brain OS primitive (keep, do not rebuild)

These are the load-bearing walls. Future scope **extends** them.

| Primitive | Today | Why it is OS-grade |
|-----------|-------|--------------------|
| Multi-tenant RLS | Every table `org_id`; `getScopedClient()` session GUC; WITH CHECK in migration 008 | Without this there is no OS, only a demo |
| SuperTokens + org provisioning | Register/login, onboarding wizard, per-user org | Identity plane |
| Classify → simple stream **or** plan-confirm-execute | Ask AI NDJSON; `agent_plans`; PATCH approve; SSE execute; parallel independent steps | Prefrontal + motor cortex |
| atomic-agent + MCP bridge | v0.1.72, `:8787` / `:8790`, `mcp.darex.*` | Tool-using employee |
| Tool allowlist | Union of active employees + core tools + **connected** channels | Least privilege |
| Honest connectors | Disconnected → `status:error`, `connected:false`, `/connectors` | Never fabricate (Rule 4) |
| Nango OAuth plane | Source of truth for connections | Nervous system auth |
| Temporal `AutonomousAgentWorkflow` | Webhooks + agent/run; 3× retry | Durability |
| Webhook discipline | Persist + 200, then fire-and-forget | Does not deadlock inbox |
| LiteLLM JSON path | classify / plan / revise; reasoning off | Fast structured thought |
| Langfuse traces | Ingestion schema fixed; Ask AI + plan steps | Learning substrate |
| Code sandbox | Docker `sandbox` service (context must be committed) | Safe computation |
| Core Google workspace tools | Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Contacts, Tasks | Knowledge + comms muscles |
| Conversations + SSE inbox | WhatsApp + Chatwoot ingest; `needs_attention` | Perception + owner attention |
| Default employees | Sarah / Emma / Marcus seeded | Roster prototype |

**Do not** replace atomic-agent with LangGraph/Hermes. `apps/agents/` is
legacy. `hermes` route is broken and should be deleted or rewired, not
revived as a second runtime. The 2026 library/people catalog and the
keep/reject list live in `15`. If a gap looks like “we need Mem0 /
CrewAI / Letta,” it is almost certainly a **pattern** to copy into
our tables and YAML, not a kernel swap.

---

## 2. What exists but is incomplete (OS cannot ship on these as-is)

| Area | Today | Gap to OS |
|------|-------|-----------|
| Custom skill playbooks (11 `SKILL.md`) | Files on disk | **Not copied into atomic-agent image** — skills are dead |
| Sandbox image context | Compose service + executor | `infra/docker/sandbox/` not in git |
| Insight page | Rule-based templates | Not an engine; no Temporal-triggered actions |
| Analytics page | Real SQL aggregates | Not Phase 7 insight engine |
| Chatwoot webhook | Ingests to inbox | **Does not invoke the AI agent** |
| WhatsApp outbound | Executor real | `META_ACCESS_TOKEN` expired 2026-06-12 |
| Google Analytics / Chat / Meet / GSC / Business / Cloud | UI catalog | Executor stub / unhandled |
| Realtime SSE | In-process EventEmitter | One Node process; no Redis pub/sub |
| Member invite | Inserts user row | No email |
| Settings webhook URL | UI | Meta URL points at Chatwoot route (bug) |
| Inbox gateway outbound | `{success:true}` | Does not send |
| Langfuse persistence | Ingest 201 | ClickHouse/Redis flaky under shared Redis |
| OAuth providers | 17+ in UI | Several need real client IDs in Nango UI |
| Razorpay | Real keys | Not per-org Nango |
| Billing | — | Phase 9 not started |
| pgvector | Extension enabled | **No RAG pipeline** |
| Terraform | Empty placeholder | No prod shape |
| `darex_app` DB user | Grants exist | App still often runs as superuser `darex` |

These are **near-term OS hygiene**, not glamorous vertical work. A real
estate pack on top of dead skills + no RAG + expired WhatsApp is theater.

---

## 3. What does not exist yet (the actual Brain OS work)

Grouped by the six layers.

### Perception gaps

- Instagram DM, Messenger, SMS (Twilio/MessageBird), Telegram, LINE,
  WeChat (later), Apple Business Chat.
- Voice inbound (Twilio Voice, Exotel, Plivo) + transcription + agent.
- Unified channel object (today WhatsApp/Chatwoot are special-cased).
- Sync workers: CRM incremental sync, Drive watch channels, Gmail push,
  listing portal webhooks, payment webhooks beyond “tool call”.
- Public-data connectors: MLS/IDX, 99acres/MagicBricks-class portals
  (where legally available), county/assessor, GSTN, Companies House,
  Google Business Profile (executor missing), review aggregators.
- File ingest pipeline: PDF/scan → parse → chunk → embed (not just
  `file_ops` on local workspace).

### Memory gaps (largest single hole)

- No `org_memory` / `employee_memory` / `conversation_memory` tables
  with embeddings.
- No embedding provider wired (OpenRouter / Gemini / local).
- No retrieval step before Ask AI or webhook agent.
- No write-back after resolved conversation.
- No contact-level or asset-level memory (property, SKU, project).
- atomic-agent notes/profile memory is **agent-side**, not org RAG.
- No knowledge graph (entities + relations) on top of vectors.
- No memory inspector UI (“what do we know, from which source”).

Until this ships, Darex cannot honestly call itself a brain.

### Reasoning gaps

- No specialist router beyond simple vs complex.
- No multi-agent (planner / critic / researcher / executor).
- No scheduled “owner briefing” workflow.
- No event-triggered plans (deal stage change, listing price drop).
- Plans are Ask-AI-centric; webhook path is a single agent turn.
- No eval harness per vertical (golden conversations).
- Skill playbooks not mounted; employees cannot follow SOP files.
- No long-running “campaign” or “nurture” graphs (Temporal-native).

### Action gaps

- ~49 tools; OS needs a **registry** (id, provider, risk class, confirm
  policy, vertical tags, MCP schema) not a growing switch in
  `tool-executor.ts`.
- No Salesforce, Pipedrive, Zoho, Freshdesk, Linear, Jira, QuickBooks,
  Xero, Tally, Zoho Books, WhatsApp Business Management extras, etc.
- No real-estate CRMs (Follow Up Boss, kvCORE, Sierra, Yardi, AppFolio).
- No DocuSign / Adobe Sign / Leegality as first-class confirm+sign.
- No Maps/Places/geocoding tool.
- Browser-use / computer-use only as explicit last resort (not built).
- Compensating transactions (send email then fail CRM write — undo?).

### Governance gaps

- Confirm exists for Ask AI plans; webhook auto-reply does **not** pause
  for owner on sensitive classes.
- No data-class tags (PII, financial, listing-confidential, PHI-adjacent).
- No per-vertical compliance packs.
- No customer-facing disclosure templates.
- No SSO/SAML for enterprise orgs (SuperTokens can, not wired).
- No SCIM.
- Audit is `channel_logs`; needs queryable “who approved this send”.
- Rate limits per org not specified as a gateway.

### Learning gaps

- Traces exist; no online eval, no prompt registry, no cost budgets per
  org, no auto-promotion of winning plans to playbooks.
- No tenant-level “this employee is drifting” alert.

### Product / GTM gaps

- No vertical onboarding (“I am a realtor” vs “I run an agency”).
- Business type in onboarding is not a pack installer.
- No marketplace of employees/skills.
- No billing, seats, usage meters, connector overage.
- No mobile app; responsive is Phase 9.
- No owner-WhatsApp “text your business”.

---

## 4. Mapping “today’s features” → “OS capabilities”

| Today’s feature | OS capability it should grow into |
|-----------------|-----------------------------------|
| Ask AI | Org-grounded reasoning console (RAG + tools + citations) |
| Plan card | Universal confirmation bus for any irreversible work |
| Employees CRUD | Workforce OS: roles, shifts, coverage, skill versions |
| Integrations page | Connector control plane: sync, scopes, dead letters |
| Conversations | Omnichannel work object (not just chat) |
| Insight templates | Diagnostic engine + one-click Temporal actions |
| Analytics SQL | Vertical KPI warehouse |
| `database_query` | Governed semantic layer (metrics, not raw SQL to the model) |
| `file_ops` | Org knowledge lake + Drive/SharePoint/S3 |
| sandbox | Tenant functions / “if this then that” without shipping code |
| SSE hub | Org event bus (Redis) consumed by UI, workflows, and employees |

---

## 5. Sequencing principle (so we do not drown in catalogs)

Build in this order, even if a customer asks for MLS tomorrow:

1. **Hygiene that unblocks everything:** mount skills, commit sandbox,
   rotate Meta token, Redis realtime, delete/rewire hermes, RAG schema.
2. **Memory & retrieval** (Phase 6) — otherwise every new vertical is
   another amnesiac demo.
3. **Connector registry + 2–3 high-leverage new connectors** (Salesforce
   or Zoho + DocuSign + Google Business Profile for real estate).
4. **Event bus + scheduled workflows** — morning brief, stale-lead chase.
5. **First vertical pack: real estate (India-ready + US-ready adapters)**.
6. **Insight engine** using the new events + memory.
7. **More verticals** as packs, not as new apps.
8. **Enterprise:** SSO, residency, dedicated Redis, Terraform, billing.

Skipping to “all integrations” without (1)–(2) produces a directory of
OAuth buttons and an agent that still cannot remember the last showing.

---

## 6. Explicitly deferred (do not start unless a phase says so)

- Training or fine-tuning a custom foundation model.
- Replacing Postgres as system of record.
- Replacing Nango with a custom token vault.
- Multi-region active-active in year one (plan residency later).
- Building our own MLS, our own telephony switch, our own ESP.
- Autonomous contract execution without human confirm.
- Scraping listing portals in violation of ToS — only official APIs,
  licensed feeds, or owner-provided exports.
- Cross-org learning that includes tenant PII.

---

## 7. Definition of “gap closed”

A row in section 2 or 3 is closed when:

- it is implemented in code,
- it is org-scoped + RLS,
- it is documented in `docs/current-working/`,
- it has a verification note in `BUILD_STATE.md`,
- disconnected/missing-data paths remain honest.

Then add `Shipped: YYYY-MM-DD` under the row in this file. Do not rewrite
history.

---

## 8. Alternatives in the world (instead of “close these gaps ourselves”)

**What Darex does:** keep the live kernel; close hygiene + Phase 6
memory ourselves; do not buy a second agent OS.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Mastra + Vercel AI SDK** on Next.js | TS-native agents, memory, MCP, Studio; 1.0 in 2026 | We already left LangGraph for atomic-agent; dual loop = the hang class | Repo listed once in `00` |
| 2 | **Promptfoo / Phoenix / Ragas in CI** as the gap-closer | Fastest honest proof that hygiene + memory work | We still implement tables ourselves; evals do not *be* the brain | This file GitHub list |
| 3 | **Langfuse Cloud** instead of self-host Redis pain | Traces that actually persist | Self-host is the residency story; fix Redis split (Phase 8). Langfuse KEEP in `15` §1 | Langfuse Cloud vs self-host |
| 4 | **Buy a memory SaaS** (hosted Mem0/Zep) to skip Phase 6 | “Returning customer remembers” in a week | Tenant facts must live in *our* RLS tables — details in `10` | `10` |
| 5 | **Skip to RE pack** (Elise/Lofty-shaped) before RAG | Revenue demo faster | Pack on dead skills + no memory + expired WhatsApp is theater (`01` §2) | This file §2; `13` “never skip Phase 6” |

**Five things to steal anyway**

1. Mount `SKILL.md` into the atomic-agent image (Cursor/Claude skill pattern) — hygiene, not a new runtime.
2. Hybrid retrieve lives in `10` — implement in pgvector+FTS, do not paste Mem0 here.
3. Chatwoot → WorkItemWorkflow now (`11`); n8n is a *customer* iPaaS in `06`.
4. Promptfoo / Ragas / Phoenix YAML for golden gaps (this file).
5. Sandbox context into git (OpenHands lesson in `00`).

### Open-source GitHub — this file only (eval / gap-close)

Langfuse KEEP → `15` §1. Memory SDKs → `10`. n8n → `06`. Chatwoot → `11`. Mastra → `00`.

| Repo | Similar to | We take |
|------|------------|---------|
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | Golden eval YAML in CI | Eval-runner for gap close |
| [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) | OSS traces + eval if Langfuse Redis hurts | Optional CI; do not replace Langfuse |
| [explodinggradients/ragas](https://github.com/explodinggradients/ragas) | RAG faithfulness metrics | `/brain` eval, not a product |
| [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | Unit tests for LLM outputs | Golden + disconnected paths |
| [giskard-ai/giskard](https://github.com/giskard-ai/giskard) | LLM red-team / RAG scan | Fair-housing + RERA trap tests (`05`) |
| [openai/evals](https://github.com/openai/evals) | Eval registry format | YAML shape for pack goldens |
| [anthropics/skills](https://github.com/anthropics/skills) | `SKILL.md` mount pattern | Mount into atomic-agent image |
| [traceloop/openllmetry](https://github.com/traceloop/openllmetry) | OTel for LLM apps | Export beside Langfuse (`02` OTel JS) |
| [microsoft/promptflow](https://github.com/microsoft/promptflow) | Prompt graphs + eval | Classify/plan YAML, not a runtime |
| [wandb/weave](https://github.com/wandb/weave) | Trace + eval hosted | WATCH; residency vs Langfuse Cloud |
| [lastmile-ai/aiconfig](https://github.com/lastmile-ai/aiconfig) | Prompts as versioned config | LiteLLM prompt files, not a new loop |
| [stanford-crfm/helm](https://github.com/stanford-crfm/helm) | Holistic eval suite | Pack-level benchmark later |
