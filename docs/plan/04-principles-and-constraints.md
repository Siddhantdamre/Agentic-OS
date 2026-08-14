# 04 — Principles and constraints

Standing orders for anyone implementing this plan. Restates
[`AGENTS.md`](../../AGENTS.md),
[`docs/future-scope/14-build-principles.md`](../future-scope/14-build-principles.md),
and the keep/reject list in
[`15-open-source-research-landscape.md`](../future-scope/15-open-source-research-landscape.md).

Linked from [README.md](./README.md) and
[00-executive-summary.md](./00-executive-summary.md). Documentation only.

If current-working and future-scope disagree on **what exists**,
current-working wins. If they disagree on **what to build next**,
future-scope (and this plan) wins until `BUILD_STATE.md` records a
deviation.

---

## 1. Read order before writing code

1. `AGENTS.md`
2. `docs/current-working/README.md` + `00-status-at-a-glance.md`
3. `BUILD_STATE.md` (note: some 13 Aug infra bullets are superseded
   by current-working `16`)
4. This file + [02-gap-analysis.md](./02-gap-analysis.md)
5. The workstream and phase you are on
6. Vertical file if the task is RE (`docs/future-scope/05`) or
   another pack (`04`)
7. `docs/future-scope/15` §14 before adding a framework

---

## 2. Product law (never regress)

1. **Multi-tenant:** every table has `org_id`. RLS + `WITH CHECK`
   (migration 008 pattern) on all new tables.
   `getScopedClient()` sets `app.current_org_id` at **session**
   level and resets on release. Never trust `org_id` from JSON body,
   LLM output, or MCP args from the model. The worker binds org from
   the authenticated job context.
2. **Webhooks:** persist, return 200, then Temporal (or fire-and-forget
   direct). Never await the model on the request thread.
3. **Pool:** release DB clients before SSE / long calls (pool `max: 10`
   today). Raise the pool with architecture; do not hold clients.
4. **Honesty:** never fabricate connector or inventory data.
   Disconnected → `status: 'error'`, `connected: false`, `setupUrl`.
5. **Env-driven config:** every URL/key/model is `process.env`. Prod
   fail-fast. No `:-dev` defaults in shipped images. `.env*` stays
   gitignored.
6. **LLM split:** LiteLLM for JSON classify/plan/revise/embed-extract;
   atomic-agent for tool loops. Do not merge those paths (hang class
   documented in `BUILD_STATE.md`). Reasoning off where only the
   final answer matters. Always pass timeouts.
7. **Employees are config.** Do not hardcode a role into shared infra.
8. **Side-effects** are idempotent Temporal activities (or logged
   with the same idempotency if they truly cannot be).
9. **Confirm** `pay` / `sign` / `publish` / destructive `delete`.
   Pack extras (RERA ads, fair housing) are validators in code, not
   “please don’t” in a prompt.
10. **atomic-agent drops `system`.** Ground org facts, retrieved
    memory, and connected channels in the **user** message
    (`buildGroundedUserMessage`).
11. **Cache keys, Temporal workflow ids, Nango connection ids,
    sandbox paths, SSE topics** all include org.
12. **Vector search** always `WHERE org_id = current`. Test with two
    orgs in CI (same query string, no cross hits). Shared ANN indexes
    can leak recall — filter strictly; partition if tests fail.

---

## 3. Clone vs build (do not reopen)

**Clone / self-host:** Nango, Temporal, LiteLLM, Langfuse,
SuperTokens, pgvector, Chatwoot-as-thin-gateway, atomic-agent pin
v0.1.72, Jina, Docker sandbox, Redis, Next.js.

**Build:** kernel glue, dashboard, insight, packs, TypeScript
executors, memory tables, eval-runner, sync/embed workers.

**Do not:** Composio; a new agent OS; a new OAuth broker; our own
MLS; our own bank/escrow; LangGraph/Hermes revival; Mem0/Zep Cloud
as tenant memory SoR; a second MCP server per vertical; custom
foundation model; scraping listing portals; awaiting embeddings in
webhooks; body `org_id`; cross-org PII training; autonomous
contracts; clinical diagnosis; licensed legal advice; child sexual
content (illegal; stop).

If you are about to `pnpm add langgraph` / `mem0ai` / `crewai` /
`letta` / `mastra`, stop and read future-scope `15` §14. Steal
patterns into our tables and YAML.

---

## 4. How to add a connector

Follow [`docs/future-scope/06-integrations-catalog.md`](../future-scope/06-integrations-catalog.md)
§15 and [workstreams/04-integrations-and-connectors.md](./workstreams/04-integrations-and-connectors.md):

1. `connector_defs` row (key, nango_key, risk, confirm, vertical
   tags, MCP names).
2. Nango provider config with explicit scopes; seed SQL idempotent.
3. `tools/<provider>.ts` implementing actions; register in MCP
   bridge as `mcp.darex.*`.
4. Honest `notConnected`.
5. Sync cursor if it is a system of record.
6. Webhook signature if inbound.
7. Langfuse span on every call.
8. Eval: one golden path connected + one disconnected.
9. Docs: current-working tools catalog + future-scope `06` status.
10. UI from registry, not a new hardcoded array forever.

Prefer official API. Email the org already received is OK to parse.
Scraping portals is not OK.

---

## 5. How to add a vertical pack

Follow [`03-industry-operating-system.md`](../future-scope/03-industry-operating-system.md)
quality bar and [workstreams/13-vertical-packs.md](./workstreams/13-vertical-packs.md):

- YAML employees, entities, workflows, skills **mounted in the
  image**, `compliance.yaml` with a failing test for a known-bad
  draft, golden evals, pack README.
- Do not copy the worker. Do not add `mcp.realestate.*` as a second
  server; use `mcp.darex.*` with namespaced tools.
- Never invent prices, RERA ids, inventory, or “payment received”
  without a PSP webhook.

---

## 6. How to add a workflow

Named Temporal workflow, activities with idempotency keys, confirm
signal for irreversible steps, memory retrieve/write-back, event-bus
for UI. Pack YAML references the name. Dashboard never embeds
workflow logic.

Ask AI classify/plan stays on LiteLLM. Do not send those jobs
through atomic-agent’s tool grammar.

---

## 7. Documentation hygiene

- Ship code → update `docs/current-working/` and `BUILD_STATE.md`.
- Then mark `Shipped: YYYY-MM-DD` on the matching gap in
  [02-gap-analysis.md](./02-gap-analysis.md) and the workstream.
- Do not rewrite future-scope into a victory lap; it stays the
  forward map until absorbed.
- Do not invent current capabilities that are not in current-working.

---

## 8. Project engineering rules (repo)

- Imports at the top of the module. No inline imports unless a
  documented circular-dependency exception.
- Exhaustive `switch` on discriminated unions: `never` in `default`.
- Types pass (`tsc --noEmit` on touched workspaces).
- `pnpm build` / `pnpm lint` stay green for the workspaces you touch.

---

## 9. Definition of done for any future-scope task

From future-scope `14` §9:

- Works for two orgs without leakage.
- Honest when disconnected.
- Traced in Langfuse.
- Eval or check script if user-facing agent behavior.
- Types pass.
- No inline imports.
- Exhaustive switch on new unions.

Plus this plan: the matching journey in
[execution/00-end-to-end-journeys.md](./execution/00-end-to-end-journeys.md)
has a verification note.

---

## 10. If you are lost

The OS is one loop:

**sense → remember → decide → confirm → act → record → learn**

If the change does not improve one of those for a tenant, it is
probably noise. If it improves one by breaking tenancy, it is a
bug. If it is a realtor feature that cannot be a pack, you are
forking the product — stop and re-read future-scope `03`.
