# Phase — Immediate (from today)

Concrete work that starts **now**. This is remaining Phase 6
hygiene plus the first slices of memory. It does not include the
real-estate pack.

**Audit 2026-08-14: MOSTLY DONE.** Do not rebuild M1–M3, R1/I2, S1,
A2. Remaining: operator creds (C1, H1, Jina). Parent
`retrieveMemoryActivity` is wired.

Linked from [00-phase-map.md](./00-phase-map.md) and
[../00-executive-summary.md](../00-executive-summary.md).
Documentation only.

Sources: `docs/current-working/14-what-does-not-work.md`,
`16-updates-2026-08-13.md`, future-scope `13` Phase 6.

---

## 1. Goal of this bucket

Leave the product able to: run migrations 009–011; talk to
connectors that have real OAuth; send WhatsApp outbound again;
have skills and sandbox on the default branch; start embedding
and retrieving memory on every agent path.

Do **not** start P3 (RE pack) in this bucket.

---

## 2. Operator track (no product code)

These unblock live tools. Current-working `14` and `16` list them
as ops-blocked, not missing features.

| # | Task | Where | DoD |
|---|------|-------|-----|
| I1 | Apply migrations 009–011 | `pnpm db:migrate` against local/staging Postgres | Tables exist; probes still pass |
| C1 | Paste real OAuth client IDs in Nango UI | Nango `:3003` | Each Wave-A provider used in demos shows a real connect, not `notConnected` for “no client id” |
| C1 | Re-connect Gmail after `gmail.compose` scope | Nango + `/connectors` | Compose sends or returns an honest token error, never a fake success |
| H1 | Rotate Meta token (expired 2026-06-12) + Console webhook | Meta + `META_ACCESS_TOKEN` + settings URL | Inbound WhatsApp persists; outbound send reaches Meta |
| — | Set `JINA_API_KEY` | env | Web search/extract is live or honest-missing, not a silent empty |

---

## 3. Land the working tree (R1, I2, C2)

Current-working `16` says this work exists versus commit `99b5f04`
and may be uncommitted. Treat landing it as a first-class task.

| # | Task | Repo | DoD |
|---|------|------|-----|
| R1 | Commit custom-skills Dockerfile COPY; rebuild atomic-agent after skill edits | `infra/docker/`, atomic-agent image | Image contains `starter-skills`; R4 later proves a playbook changes behavior |
| I2 | Commit `infra/docker/sandbox/` | `infra/docker/sandbox/` | Path is tracked; `code_execution` still sandboxed |
| C2 | Fix UI `catalog_only` hints for GBP/Meet/GA4/GSC/Chat/Cloud | `apps/dashboard` connectors catalog | UI matches executors in current-working `08`/`16` |
| — | Update `AGENTS.md` tool count 49 → 62 | `AGENTS.md` | Cheat-sheet matches MCP list |
| — | Absorb shipped rows into future-scope `01`/`06`/`13` when those docs are next edited | `docs/future-scope/` | Out of this plan’s write set; flag only |

Do not rebuild Chatwoot `fireInboundAgent`, Meta URL split, inbox
outbound forward, or Hermes deletion. Those are absorbed
([../02-gap-analysis.md](../02-gap-analysis.md) §0).

---

## 4. Tenancy start (S1)

| # | Task | Repo | Depends | DoD |
|---|------|------|---------|-----|
| S1 | Run apps as `DB_USER=darex_app` | `infra/db/`, compose, `lib/db.ts` | I1 | App role is not superuser; RLS still holds; existing probes pass |

Phase 8 also lists this. Starting it now prevents memory tables
from being created under a superuser-only habit.

---

## 5. Phase 6 start (M1–M3, R2, A2)

| # | Task | Repo | Depends | DoD |
|---|------|------|---------|-----|
| M1 | `013_memory_rag.sql`: org/employee/entity/conversation memory, `knowledge_sources`, `ingestion_jobs`, RLS + WITH CHECK | `infra/db/migrations/` | S1 preferred | Two-org insert isolation on empty tables |
| M2 | embed-worker via LiteLLM; `EMBEDDING_MODEL` fail-fast; **never** embed on the webhook thread | `services/workflows` or new worker; compose | M1 | Job queue drains after 200; webhook latency unchanged |
| M3 | `retrieveMemory` + prefix | `services/workflows` | M2 | Function returns cited snippets or empty |
| R2 | Extend `buildGroundedUserMessage` with retrieved facts; call from Ask AI simple, complex, and inbound Temporal | `atomic-agent-client.ts`, `ask-ai`, webhook path | M3 | Same prefix on all three paths; atomic-agent still sees facts in the **user** message |
| A2 | Eval-runner stub (Promptfoo or YAML) + returning-contact case | `infra/scripts/` or `evals/` | M3 | CI can fail a run that invents a prior fact |

O1/O2 (work items) **may start** with a no-op retrieve so inbound
unification does not wait on embeddings. They must not block M1.

---

## 6. Explicitly not in this bucket

- P3 real-estate pack (blocked on M6).
- B2 billing.
- I3 Redis bus (near).
- C6 Wave B P0 CRMs (near, after registry).
- Insight engine (A3) — templates stay until Phase 7.
- SSO, marketplace, voice, computer-use.

---

## 7. Exit to “near”

Immediate is **code-complete** except operator items. Tick a box
only when the probe is green on **this** environment:

1. I1 + C1 + H1 operator items are either done or explicitly
   blocked on a named third party (document which).
2. R1 + I2 are on the default branch. **Code: done.**
3. M1 + M2 exist; M3/R2 are merged. **Code: done** (inbound parent
   `retrieveMemoryActivity` now calls `retrieveMemory`).
4. A2 stub exists and can fail closed. **Code: done** (`infra/evals/`).
5. S1 is merged. **Code: done** (`DB_USER=darex_app`).

Then follow [02-phase-near.md](./02-phase-near.md).

Related: [../workstreams/03-memory-rag-brain.md](../workstreams/03-memory-rag-brain.md),
[../execution/03-build-order.md](../execution/03-build-order.md).
