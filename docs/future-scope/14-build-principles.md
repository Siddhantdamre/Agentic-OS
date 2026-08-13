# 14 — Build principles for future agents

This file is standing orders for any coding agent implementing the
Brain OS. It restates kernel rules and the future-scope contract so
a new session cannot “helpfully” fork the architecture.

---

## 1. Read order before writing code

1. `AGENTS.md`
2. `docs/current-working/README.md` + `00-status-at-a-glance.md`
3. `BUILD_STATE.md`
4. This pack (`docs/future-scope/`), especially `01`, `02`, `12`,
   `15` (libraries/people — so you do not swap the kernel),
   and the phase in `13` you are on
5. Vertical file if the task is RE (`05`) or another pack (`04`)

If current-working and this pack disagree on **what exists**,
current-working wins. If they disagree on **what to build next**,
this pack wins until BUILD_STATE records a deviation.

---

## 2. Invariants (copy of product law)

1. Multi-tenant: `org_id` + RLS + session GUC; never body `org_id`.
2. Webhooks: persist, 200, Temporal; never await the model.
3. Release DB clients before SSE / long calls (pool is small).
4. Never fabricate connector or inventory data. `connected: false`
   + setupUrl.
5. Env-driven config; prod fail-fast; no secret commits.
6. LiteLLM for JSON classify/plan/revise/embed-extract; atomic-agent
   for tool loops; do not merge those paths.
7. Employees are config; do not hardcode roles in the kernel.
8. Side-effects are idempotent Temporal activities (or logged with
   the same idempotency if truly cannot).
9. Confirm `pay` / `sign` / `publish` / destructive `delete`.
10. atomic-agent drops `system` — ground in the **user** message.

---

## 3. Clone vs build (do not reopen)

Clone/self-host: Nango, Temporal, LiteLLM, Langfuse, SuperTokens,
pgvector, Chatwoot-as-thin-gateway, atomic-agent pin.

Build: kernel glue, dashboard, insight, packs, executors, memory,
eval.

Do not: Composio, new agent OS, new OAuth broker, our own MLS, our
own bank, LangGraph revival (`apps/agents/` is legacy).

The long keep/adopt/study/reject list, with people and papers, is
`15-open-source-research-landscape.md`. If you are about to `pnpm
add langgraph` / `mem0ai` / `crewai` / `letta`, read `15` §14 first.

---

## 4. How to add a connector

Follow `06` §15. Registry row, Nango config, module executor, MCP
name, disconnected test, Langfuse span, UI from registry.

Prefer official API. Email the org already received is OK to parse.
Scraping portals is not OK.

---

## 5. How to add a vertical pack

Follow `03` quality bar. YAML employees, entities, workflows,
skills **mounted in the image**, compliance.yaml with a failing test
for a known-bad draft, golden evals, docs.

Do not copy the worker. Do not add `mcp.realestate.*` as a second
server; use `mcp.darex.*` with namespaced tools.

---

## 6. How to add a workflow

Named Temporal workflow, activities with idempotency keys, confirm
signal for irreversible steps, memory retrieve/write-back, event-bus
for UI. Pack YAML references the name.

---

## 7. Documentation hygiene

- Ship code → update `docs/current-working/` and `BUILD_STATE.md`.
- Then mark `Shipped: YYYY-MM-DD` in `01` for closed gaps.
- Do not rewrite this pack into a victory lap; it stays the forward
  map until absorbed.

---

## 8. Explicit non-goals (repeat)

No custom foundation model. No cross-org PII training. No autonomous
contracts. No escrow. No clinical diagnosis. No licensed legal
advice. No child sexual content — illegal; stop. No inventing
listings or prices. No awaiting embeddings in webhooks. No second
runtime.

---

## 9. Definition of done for a future-scope task

- Works for two orgs without leakage.
- Honest when disconnected.
- Traced in Langfuse.
- Eval or check script if user-facing agent behavior.
- Types pass (`tsc --noEmit` on touched workspaces).
- No inline imports (project rule).
- Exhaustive switch on new unions (project rule).

---

## 10. If you are lost

The OS is one loop:

**sense → remember → decide → confirm → act → record → learn**

If your change does not improve one of those for a tenant, it is
probably noise. If it improves one by breaking tenancy, it is a
bug. If it is a realtor feature that cannot be a pack, you are
forking the product — stop and re-read `03`.

---

## 11. Alternatives in the world (instead of these standing orders)

**What Darex does:** invariants in this file. Clone infra, build
packs. Read `15` before adding a framework.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **“Whatever LangChain tutorial says”** | Fast for greenfield | We are not greenfield; hang is documented | BUILD_STATE.md |
| 2 | **Move fast, skip RLS tests** | Demo speed | One leak ends the company | `12`, pgvector multitenancy |
| 3 | **Await model in webhook** (simple) | Less Temporal | Inbox deadlocks; Meta retries storms | `AGENTS.md` rule 2 |
| 4 | **Fabricate listings when MLS is down** | “Helpful” UX | Product law; fair housing/RERA | `05` golden #5 |
| 5 | **Composio + LangGraph revival** | Catalog + graphs | Closed decisions; `15` §14 REJECT | `14` §3 |

**Five things to steal anyway (from research, into *our* code)**

1. Hybrid memory retrieve (`10`).
2. Pack YAML like Odoo manifests (`03`).
3. τ-bench goldens (`08`).
4. Temporal activities around every LLM (`09`).
5. Dust/Glean permission dual-layer (`12`).

### Open-source GitHub

This file is **invariants**, not a shopping list. Kernel KEEP is `15` §1.
Authz extras → `12`. Evals → `01`. Packs → `03`. Do not paste those tables here.
