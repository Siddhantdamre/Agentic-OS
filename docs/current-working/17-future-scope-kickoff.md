# 17 — Future-scope kickoff (WS-01 hygiene)

Date: **Thursday 13 August 2026**. Branch: `future-scope`.

This file records the first future-scope workstream slice: **WS-01 Hygiene +
CI deny-list**. It does not claim product features that were not shipped.
Phases 0–5 remain as described in [16](./16-updates-2026-08-13.md) and
[00](./00-status-at-a-glance.md). Ask AI, Temporal, connectors, RLS, webhooks,
crew, sandbox, and skills were not rebuilt.

---

## What landed

### AGENTS.md tool count

`services/workflows/src/mcp-bridge.ts` `TOOLS.length` is **62**. The cheat-sheet
previously said 49. Architecture map now reads 62 executors and 62
`mcp.darex.*` tools. Conventions (tenancy, webhook 200-then-Temporal, pool
release, honest `notConnected`, env-driven config, LiteLLM vs atomic-agent,
no body `org_id`) are unchanged.

### CI deny-list + Gitleaks

`.github/workflows/ci.yml` now has:

- **REJECT kernel deny-list** — fails the PR if `package.json` or lockfiles
  add `langgraph`, `mem0ai`, `crewai`, `letta`, `mastra`, or `composio`
  (including scoped names such as `@langchain/langgraph`). Docs may still
  mention them; only manifests/lockfiles are scanned.
- **Gitleaks** — git-history secret scan (`gitleaks/gitleaks:v8.24.3`).
- **App job `DB_USER`** — typecheck/lint/build runs with `DB_USER: darex_app`.
  Isolation still migrates as superuser `darex` (required by `migrate.js`).
- Push trigger includes `future-scope`.

Existing typecheck, lint, build, and multi-tenant isolation steps are
unchanged. `infra/scripts/check-phase0.js`, `check-phase2.js`, and
`check-phase3.js` were **not** edited and are **not** stubbed in CI (they
need the live compose stack).

### Operator runbook

`infra/scripts/OPERATOR_HYGIENE.md` covers, without secrets:

1. `pnpm db:migrate` for 009–011 (superuser `darex`; runtime `darex_app`).
2. Real OAuth client IDs in Nango UI `:3003`.
3. Gmail re-connect after `gmail.compose`.
4. Meta token rotation (expired 2026-06-12) + Console webhook URL.
5. `JINA_API_KEY` for web search/extract.

Missing OAuth/tokens stay honest errors. Do not commit `.env*`.

---

## Explicitly not in this slice

- `docs/plan/**` (plan stays documentation-only).
- `infra/docker-compose.yml`.
- Product/runtime code.
- `BUILD_STATE.md` (coordinator owns it this wave).
- Memory/RAG (M1+), eval stub (A2), catalog UI hints (C2), skills image COPY
  (R1), sandbox landing (I2).

---

## Verify

```bash
# manifests currently have none of the REJECT packages
# CI deny-list job must exit 0 on this tree and fail if one is added

node infra/scripts/check-phase0.js
node infra/scripts/check-phase2.js
node infra/scripts/check-phase3.js
```
